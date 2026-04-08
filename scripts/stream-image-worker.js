#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// stream-image-worker.js — on-demand chat → image generator daemon
//
// Watches live-session.json for `!image <prompt>` messages and generates an
// image for each. Two backends in parallel:
//
//   1. NVIDIA flux.1-schnell on ai.api.nvidia.com  (HTTP, ~5-10s, fast)
//   2. ComfyUI on the Windows host                  (SDXL, ~15-30s, higher quality)
//
// When 2+ requests are in the queue at once, the worker fires them in
// parallel — first to NVIDIA, second to ComfyUI — so chat sees both styles
// side-by-side. With one request, NVIDIA wins (faster). If ComfyUI is
// unreachable everything goes to NVIDIA.
//
// Output is identical to stream-image-poll.js — image saved to
// public/workshop-images/img_<ts>.jpg, entry prepended to images.json which
// the StreamImageGallery component already polls and renders on stream.
//
// Usage:
//   node stream-image-worker.js                  # daemon
//
// Limitations:
//   - PG-13 keyword filter is dumb but enough for the demo
//   - ComfyUI prompt is a fixed SDXL graph using whatever the first checkpoint
//     is on the host (sd_xl_base_1.0.safetensors as of probe)

"use strict";

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const { spawn } = require("child_process");

const HOME            = process.env.HOME;
const ENV_FILE        = path.join(HOME, ".nemoclaw_env");
const LIVE_SESSION    = path.join(HOME, "netify-dev", "public", "data", "live-session.json");
const GALLERY_DIR     = path.join(HOME, "netify-dev", "public", "workshop-images");
const GALLERY_JSON    = path.join(HOME, "netify-dev", "public", "data", "workshop", "images.json");
const SEEN_FILE       = "/tmp/image-worker-seen.json";
// Token economy + video gallery — winners earn 1 token per 6-7 round, cash
// in 3 for an LTX video. Both files live in the same workshop data dir as
// images.json so the existing static-export flow ships them automatically.
const TOKENS_JSON     = path.join(HOME, "netify-dev", "public", "data", "workshop", "tokens.json");
const VIDEOS_JSON     = path.join(HOME, "netify-dev", "public", "data", "workshop", "videos.json");
const VIDEOS_DIR      = path.join(HOME, "netify-dev", "public", "workshop-videos");
const TOKENS_PER_WIN  = 1;
const TOKENS_PER_VIDEO = 3;
const MAX_VIDEOS      = 20;
// Streak window — consecutive 6-7 wins inside this window stack a
// multiplier (1x, 2x, 3x, capped). Window expires on any miss or timeout.
const STREAK_WINDOW_MS = 180_000;
const STREAK_MAX       = 3;
// Spin lottery — !spin costs this much and rolls a prize on the table below.
// House edge is ~30% so the leaderboard stays meaningful but big wins happen.
const SPIN_COST        = 2;
const SPIN_TABLE = [
  { roll: 0.40, payout: 0,  label: "🥀 busted" },
  { roll: 0.65, payout: 1,  label: "🍪 crumb"  },
  { roll: 0.80, payout: 2,  label: "🎂 even"   },
  { roll: 0.92, payout: 3,  label: "✨ +1"     },
  { roll: 0.97, payout: 5,  label: "💎 +3"     },
  { roll: 0.99, payout: 10, label: "🎰 +8"     },
  // Final 1% slot drains the JACKPOT POOL — payout is dynamic, computed at
  // spin time. The pool is fed by every losing/break-even spin (see handleSpin).
  { roll: 1.00, payout: -1, label: "🌋 POOL DRAIN", drainPool: true },
];

// ── Reaction word game (server-side, fully authoritative) ───────────────────
// Every REACTION_INTERVAL_MS the worker picks a random word, posts it to chat,
// and awards REACTION_PRIZE 🎂 to the first person who types it back inside
// REACTION_WINDOW_MS. Cheap, fast, and constant-engagement filler between 6-7s.
const REACTION_WORDS = [
  "PIXEL", "GHOST", "TURBO", "NEON", "WAFFLE", "ROCKET", "PUDDING", "ORBIT",
  "QUARTZ", "BANANA", "CYBER", "VAPOR", "DOUGH", "GLITCH", "PRISM", "VORTEX",
  "MUFFIN", "LASER", "BISCUIT", "SPECTER", "CHROME", "MELON", "CIRCUIT",
];
const REACTION_INTERVAL_MS = 5 * 60_000;   // new round every 5 min
const REACTION_WINDOW_MS   = 60_000;       // 60s to react
const REACTION_PRIZE       = 2;            // 2 🎂 — twice a 6-7 win, no streak

// ── Achievements ────────────────────────────────────────────────────────────
// Permanent collectibles. Stored on the user record under .achievements as a
// flat array of keys. First-unlock posts a celebratory chat message.
const ACHIEVEMENTS = {
  first_blood:   { icon: "🩸", label: "First Blood",     desc: "win your first round" },
  hat_trick:     { icon: "🎩", label: "Hat Trick",        desc: "hit a 3x streak" },
  spinner:       { icon: "🎰", label: "High Roller",      desc: "spin 5 times" },
  jackpot_lord:  { icon: "🌋", label: "Pool Drainer",     desc: "drain the jackpot pool" },
  film_director: { icon: "🎬", label: "Film Director",    desc: "cash in your first video" },
  big_spender:   { icon: "💸", label: "Big Spender",      desc: "spend 20 🎂 lifetime" },
  veteran:       { icon: "🛡️", label: "Veteran",          desc: "win 10 rounds lifetime" },
  reaction_king: { icon: "⚡", label: "Reaction King",    desc: "win a reaction round" },
};
// ── Token shop ──────────────────────────────────────────────────────────────
// Items chat can buy with !buy <item>. Buffs are stored per-user on the
// "buffs" field in tokens.json and consumed on first qualifying event.
const SHOP_ITEMS = {
  double: { cost: 10, icon: "⚡", label: "2x Boost",    desc: "next earn is doubled",          ttlMs: 10 * 60_000 },
  shield: { cost: 15, icon: "🛡️", label: "Streak Shield", desc: "survive one streak break",   ttlMs: 30 * 60_000 },
  lucky:  { cost:  5, icon: "🍀", label: "Lucky Spin",  desc: "+1 bonus on your next spin",   ttlMs: 10 * 60_000 },
};

const POLL_MS         = 3000;
const MAX_GALLERY     = 40;
const MAX_PROMPT_CHARS = 220;
// Discovered via `ip route show default | awk '{print $3}'` from inside WSL
const COMFY_HOST      = process.env.COMFY_HOST || "172.20.224.1";
const COMFY_PORT      = 8188;
const COMFY_CHECKPOINT = process.env.COMFY_CHECKPOINT || "sd_xl_base_1.0.safetensors";
// ZTurbo (ZImage Turbo) — saved ComfyUI workflow path. Resolved at call
// time inside generateZTurbo() because loadEnvFile() runs *after* the
// module-level constants below — caching it here would always be empty.

// Cheap PG-13 blocklist. Not a real moderation system — anything serious
// should go through a hosted moderation API. This just stops the obvious
// bad inputs.
const BLOCKLIST = /\b(nude|naked|nsfw|porn|sex|loli|cp|child|gore|kill|nazi|swastika|blood|rape)\b/i;

// ── 6-7 game prize ──────────────────────────────────────────────────────────
// First chatter to type "6-7" wins a prize image. Cooldown matches ChatArena
// (5s flash + 20s cooldown = 25s minimum between rounds).
const SIX_SEVEN_RE        = /(?:^|[^0-9])6\s*[-–—]?\s*7(?:[^0-9]|$)|(?:^|\s)67(?:\s|$|!|\?|\.)|\bsix\s*[-–—]?\s*seven\b/i;
const SIX_SEVEN_PROMPT    = "enhanced photograph, polaroid style, beautiful adult woman holding a birthday cake, soft natural lighting, vintage film grain, shallow depth of field";
const SIX_SEVEN_COOLDOWN  = 25_000; // ms between accepted wins
const CHAT_POST_SCRIPT    = path.join(HOME, ".nemoclaw", "source", "scripts", "stream-chat-post.js");

// Last accepted 6-7 winner timestamp — keeps us from re-firing on the same
// message after a worker restart, and from racing if multiple messages match
// in one batch.
let sixSevenLastWinAt = 0;

// ── Reaction game state ─────────────────────────────────────────────────────
// reactionRound is non-null while a round is open. The main loop scans
// fresh chat messages for the target word and awards the first match.
// Persisted to disk so the ChatArena overlay can show a countdown banner.
const REACTION_STATE_JSON = path.join(HOME, "netify-dev", "public", "data", "workshop", "reaction.json");
let reactionRound = null; // { word, startedAt, expiresAt } | null
let reactionLastFiredAt = 0;

function writeReactionState() {
  try {
    fs.mkdirSync(path.dirname(REACTION_STATE_JSON), { recursive: true });
    fs.writeFileSync(REACTION_STATE_JSON, JSON.stringify({
      round:        reactionRound,
      lastFiredAt:  reactionLastFiredAt,
      lastWinner:   reactionLastWinner,
      prize:        REACTION_PRIZE,
    }, null, 2));
  } catch (_e) {
    // silent
  }
}
let reactionLastWinner = null; // { name, word, at }

function startReactionRound() {
  const word = REACTION_WORDS[Math.floor(Math.random() * REACTION_WORDS.length)];
  const now  = Date.now();
  reactionRound = { word, startedAt: now, expiresAt: now + REACTION_WINDOW_MS };
  reactionLastFiredAt = now;
  log(`reaction round: word="${word}"`);
  postToChat(`⚡ REACTION! First to type "${word}" wins ${REACTION_PRIZE}🎂 · ${REACTION_WINDOW_MS / 1000}s`);
  writeReactionState();
}
function endReactionRound(reason) {
  if (!reactionRound) return;
  log(`reaction round ended: ${reason} (word="${reactionRound.word}")`);
  reactionRound = null;
  writeReactionState();
}

function postToChat(text) {
  // Fire-and-forget. stream-chat-post.js handles the YouTube live chat insert.
  try {
    const child = spawn(process.execPath, [CHAT_POST_SCRIPT, text], {
      detached: true, stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    log(`chat post failed: ${err.message}`);
  }
}

async function handleSixSevenWinner(winnerRaw) {
  // YouTube's authorName.simpleText already starts with "@" — strip it so we
  // don't end up with "@@MrBigPipesYT" in the chat post and gallery caption.
  const winner = String(winnerRaw || "anon").replace(/^@+/, "");
  log(`6-7 WIN by @${winner} — generating prize image via ZTurbo`);
  // Chat posts NEVER include the raw prompt — just a friendly message. The
  // surprise is the point; leaking the recipe spoils it.
  postToChat(`🎂 Baking a cake for @${winner}…`);

  // Prize is z-turbo (ZImage Turbo / local ComfyUI) — local GPU, higher
  // quality than NVIDIA flux for portrait work. Falls back to NVIDIA flux
  // if z-turbo is unreachable so the winner still gets *something*.
  let buf = await generateZTurbo(SIX_SEVEN_PROMPT);
  let backend = "zturbo-prize";
  if (!buf) {
    log(`zturbo failed, falling back to NVIDIA flux for @${winner}`);
    buf = await generateNvidia(SIX_SEVEN_PROMPT);
    backend = "nvidia-prize-fallback";
  }
  if (!buf) {
    log(`6-7 prize gen FAILED for @${winner} (both backends down)`);
    postToChat(`Aw @${winner}, the oven flopped this time — next round! 🎂`);
    return;
  }
  // Gallery caption is also user-visible on stream — keep it prompt-free.
  await persistImage(buf, `🎂 Cake for @${winner}`, winner, backend);
  // Award token AFTER the image is safely persisted — if the gen failed
  // earlier we already returned, so reaching here means a real win.
  const r = awardTokens(winner, TOKENS_PER_WIN);
  const streakTag = r.mult > 1 ? ` 🔥 ${r.streak}x STREAK!` : "";
  postToChat(`🎂 Cake for @${winner}! +${r.gained} 🎂 (bal ${r.balance})${streakTag} — 3🎂 = !video, 2🎂 = !spin, !top for leaderboard`);
}

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnvFile();

function log(msg) {
  console.log(`[image-worker] ${new Date().toISOString()} ${msg}`);
}

// ── Seen-ts persistence ─────────────────────────────────────────────────────
function loadSeen() {
  try {
    const s = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    return typeof s.lastTs === "number" ? s.lastTs : 0;
  } catch (_e) { return 0; }
}
function saveSeen(ts) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify({ lastTs: ts })); } catch (_e) {
    // silent
  }
}

// ── Sanitize chat input ─────────────────────────────────────────────────────
function sanitizePrompt(raw) {
  let p = String(raw || "").trim();
  // Strip newlines, control chars, prompt-injection markers
  p = p.replace(/[\n\r\t]+/g, " ").replace(/[`<>{}]/g, "").replace(/===/g, "");
  // Cap length
  if (p.length > MAX_PROMPT_CHARS) p = p.slice(0, MAX_PROMPT_CHARS);
  // Block obvious bad words
  if (BLOCKLIST.test(p)) return null;
  return p;
}

// ── NVIDIA flux.1-schnell ──────────────────────────────────────────────────
function generateNvidia(prompt) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) {
    log("NVIDIA_API_KEY missing — cannot use NVIDIA backend");
    return Promise.resolve(null);
  }
  const body = JSON.stringify({
    text_prompts: [{ text: prompt, weight: 1.0 }],
    seed:         Math.floor(Math.random() * 1_000_000),
    steps:        4,
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "ai.api.nvidia.com",
      path:     "/v1/genai/black-forest-labs/flux.1-schnell",
      method:   "POST",
      headers:  {
        "Authorization":  `Bearer ${key}`,
        "Accept":         "application/json",
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          log(`nvidia HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          return resolve(null);
        }
        try {
          const json = JSON.parse(data);
          const b64 = json?.artifacts?.[0]?.base64;
          if (!b64) return resolve(null);
          resolve(Buffer.from(b64, "base64"));
        } catch (_e) { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(60000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── ComfyUI helpers ─────────────────────────────────────────────────────────
// All requests are HTTP (not HTTPS) and to the Windows host. We do plain
// JSON POST + GET; no Auth.
function comfyRequest(method, pathStr, body) {
  return new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: COMFY_HOST,
      port:     COMFY_PORT,
      path:     pathStr,
      method,
      headers:  data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        // Image responses (binary) skip JSON parse
        if ((res.headers["content-type"] || "").startsWith("image/")) {
          return resolve({ status: res.statusCode, body: buf });
        }
        try { resolve({ status: res.statusCode, body: JSON.parse(buf.toString("utf8")) }); }
        catch (_e) { resolve({ status: res.statusCode, body: buf.toString("utf8") }); }
      });
    });
    req.on("error", (err) => resolve({ status: 0, body: null, error: err.message }));
    req.setTimeout(120000, () => { req.destroy(); resolve({ status: 0, body: null, error: "timeout" }); });
    if (data) req.write(data);
    req.end();
  });
}

async function isComfyAlive() {
  const r = await comfyRequest("GET", "/system_stats");
  return r.status === 200 && r.body && r.body.system;
}

// Build a minimal SDXL prompt graph for the ComfyUI API. The node IDs are
// arbitrary strings — they only need to match the cross-references inside.
function buildComfyGraph(prompt) {
  const seed = Math.floor(Math.random() * 1_000_000);
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: COMFY_CHECKPOINT } },
    "5": { class_type: "EmptyLatentImage",       inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode",         inputs: { text: prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode",         inputs: { text: "blurry, low quality, watermark, text, ugly, deformed", clip: ["4", 1] } },
    "3": { class_type: "KSampler",               inputs: {
      seed,
      steps:        18,
      cfg:          7,
      sampler_name: "euler",
      scheduler:    "normal",
      denoise:      1,
      model:        ["4", 0],
      positive:     ["6", 0],
      negative:     ["7", 0],
      latent_image: ["5", 0],
    } },
    "8": { class_type: "VAEDecode",  inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage",  inputs: { filename_prefix: "stream", images: ["8", 0] } },
  };
}

async function generateComfy(prompt) {
  // 1. Submit prompt
  const submit = await comfyRequest("POST", "/prompt", { prompt: buildComfyGraph(prompt) });
  if (submit.status !== 200 || !submit.body?.prompt_id) {
    log(`comfy submit failed: status=${submit.status} err=${submit.error || JSON.stringify(submit.body).slice(0, 200)}`);
    return null;
  }
  const promptId = submit.body.prompt_id;

  // 2. Poll history until done (cap at 90s)
  const deadline = Date.now() + 90000;
  let history = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const h = await comfyRequest("GET", `/history/${promptId}`);
    if (h.status === 200 && h.body && h.body[promptId]) {
      history = h.body[promptId];
      if (history.outputs && Object.keys(history.outputs).length > 0) break;
    }
  }
  if (!history?.outputs) {
    log(`comfy timed out waiting on ${promptId}`);
    return null;
  }

  // 3. Find the SaveImage output (node 9)
  const out = history.outputs["9"]?.images?.[0];
  if (!out) {
    log(`comfy no images in output: ${JSON.stringify(history.outputs).slice(0, 200)}`);
    return null;
  }

  // 4. Download
  const view = await comfyRequest("GET",
    `/view?filename=${encodeURIComponent(out.filename)}&subfolder=${encodeURIComponent(out.subfolder || "")}&type=${encodeURIComponent(out.type || "output")}`);
  if (view.status !== 200 || !Buffer.isBuffer(view.body)) {
    log(`comfy view failed: status=${view.status}`);
    return null;
  }
  return view.body;
}

// ── ZImage Turbo (z-turbo) ──────────────────────────────────────────────────
// Loads the saved ComfyUI workflow at ZTURBO_WORKFLOW_PATH, patches the
// prompt + seed + filename_prefix, submits, polls history. Mirrors the
// discord-bridge implementation so prizes look identical to bridge gens.
// eslint-disable-next-line complexity
async function generateZTurbo(prompt) {
  const wfPath = process.env.ZTURBO_WORKFLOW_PATH || "";
  if (!wfPath || !fs.existsSync(wfPath)) {
    log(`ZTURBO_WORKFLOW_PATH missing or unreadable (${wfPath})`);
    return null;
  }
  // Free comfy memory first — prevents OOM if a previous job left a model loaded
  await comfyRequest("POST", "/free", { unload_models: true, free_memory: true }).catch(() => {});

  let workflow;
  try {
    workflow = JSON.parse(fs.readFileSync(wfPath, "utf-8"));
  } catch (err) {
    log(`zturbo workflow parse failed: ${err.message}`);
    return null;
  }

  // Patch nodes the same way discord-bridge does
  const today = new Date();
  const dateStr = `${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, "0")}_${String(today.getDate()).padStart(2, "0")}`;
  if (workflow["9"]?.inputs)   workflow["9"].inputs.filename_prefix = `ZImage/${dateStr}/ZI-stream`;
  if (workflow["6"]?.inputs)   workflow["6"].inputs.text  = prompt;
  if (workflow["307"]?.inputs) workflow["307"].inputs.value = Math.floor(Math.random() * 1_000_000);

  // Submit
  const submit = await comfyRequest("POST", "/prompt", { prompt: workflow, client_id: "stream-image-worker" });
  if (submit.status !== 200 || !submit.body?.prompt_id) {
    log(`zturbo submit failed: status=${submit.status} err=${submit.error || JSON.stringify(submit.body).slice(0, 200)}`);
    return null;
  }
  const promptId = submit.body.prompt_id;
  log(`zturbo submitted: ${promptId}`);

  // Poll history (up to 2 min — ZImage is usually 8-15s, but allow headroom)
  const deadline = Date.now() + 120_000;
  let imageInfo = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2500));
    const h = await comfyRequest("GET", `/history/${promptId}`);
    if (h.status !== 200 || !h.body?.[promptId]) continue;
    const entry = h.body[promptId];
    if (entry.status?.status_str === "error") {
      log(`zturbo render error for ${promptId}`);
      return null;
    }
    if (entry.status?.completed) {
      for (const [, out] of Object.entries(entry.outputs || {})) {
        const images = out.images || [];
        if (images.length > 0) { imageInfo = images[0]; break; }
      }
      if (imageInfo) break;
    }
  }
  if (!imageInfo) {
    log(`zturbo timed out waiting on ${promptId}`);
    return null;
  }

  // Download
  const view = await comfyRequest("GET",
    `/view?filename=${encodeURIComponent(imageInfo.filename)}&subfolder=${encodeURIComponent(imageInfo.subfolder || "")}&type=${encodeURIComponent(imageInfo.type || "output")}`);
  if (view.status !== 200 || !Buffer.isBuffer(view.body)) {
    log(`zturbo view failed: status=${view.status}`);
    return null;
  }
  return view.body;
}

// ── Token store ─────────────────────────────────────────────────────────────
// Flat JSON: { "MrBigPipesYT": { tokens: 5, wins: 5, spent: 0 } }. We
// re-read on every write so the worker plays nice with any other process
// (e.g. a future admin tool) that might also touch the file.
function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_JSON)) return {};
    const j = JSON.parse(fs.readFileSync(TOKENS_JSON, "utf8"));
    return (j && typeof j === "object") ? j : {};
  } catch (_e) { return {}; }
}
function saveTokens(store) {
  try {
    fs.mkdirSync(path.dirname(TOKENS_JSON), { recursive: true });
    fs.writeFileSync(TOKENS_JSON, JSON.stringify(store, null, 2));
  } catch (err) {
    log(`tokens write failed: ${err.message}`);
  }
}
// ── Jackpot pool ────────────────────────────────────────────────────────────
// A community-fed prize pool. Stored on a special key "__pool" in tokens.json
// so it ships through the same static-export pipeline. Spinner losses feed it,
// the rare "POOL DRAIN" spin slot empties it.
function getPool(store) {
  if (!store.__pool || typeof store.__pool !== "object") store.__pool = { jackpot: 0, drainedBy: null, drainedAt: 0 };
  return store.__pool;
}
function feedPool(store, amount) {
  const pool = getPool(store);
  pool.jackpot = (pool.jackpot || 0) + amount;
}
function drainPool(store, winner) {
  const pool = getPool(store);
  const won = pool.jackpot || 0;
  pool.jackpot = 0;
  pool.drainedBy = winner;
  pool.drainedAt = Date.now();
  return won;
}

// ── Achievements ────────────────────────────────────────────────────────────
// Returns the list of newly-unlocked achievement keys for this user. Caller
// is responsible for posting chat announcements + saving the store.
function unlockAchievement(rec, key) {
  if (!rec.achievements) rec.achievements = [];
  if (rec.achievements.includes(key)) return false;
  rec.achievements.push(key);
  return true;
}
// eslint-disable-next-line complexity
function checkAchievements(rec, ctx = {}) {
  const unlocked = [];
  if (rec.wins >= 1                       && unlockAchievement(rec, "first_blood"))   unlocked.push("first_blood");
  if (rec.wins >= 10                      && unlockAchievement(rec, "veteran"))       unlocked.push("veteran");
  if ((rec.streak || 0) >= 3              && unlockAchievement(rec, "hat_trick"))     unlocked.push("hat_trick");
  if ((rec.spent || 0) >= 20              && unlockAchievement(rec, "big_spender"))   unlocked.push("big_spender");
  if ((rec.spinCount || 0) >= 5           && unlockAchievement(rec, "spinner"))       unlocked.push("spinner");
  if (ctx.pool_drained                    && unlockAchievement(rec, "jackpot_lord"))  unlocked.push("jackpot_lord");
  if (ctx.video_cashed                    && unlockAchievement(rec, "film_director")) unlocked.push("film_director");
  if (ctx.reaction_won                    && unlockAchievement(rec, "reaction_king")) unlocked.push("reaction_king");
  return unlocked;
}
function announceAchievements(name, keys) {
  for (const key of keys) {
    const a = ACHIEVEMENTS[key];
    if (!a) continue;
    postToChat(`🏆 @${name} UNLOCKED ${a.icon} ${a.label} — "${a.desc}"`);
  }
}

function awardTokens(name, amount, ctx = {}) {
  const store = loadTokens();
  if (!store[name]) store[name] = { tokens: 0, wins: 0, spent: 0, streak: 0, lastWinAt: 0, achievements: [], buffs: {} };
  if (!store[name].buffs) store[name].buffs = {};
  const rec = store[name];
  const now = Date.now();

  // Streak: if the last win was inside the streak window, bump the counter,
  // otherwise reset to 1. Shield buff absorbs one streak break.
  const inStreak = rec.lastWinAt && (now - rec.lastWinAt) < STREAK_WINDOW_MS;
  if (inStreak) {
    rec.streak = Math.min((rec.streak || 1) + 1, STREAK_MAX);
  } else {
    const shieldActive = rec.buffs.shield && rec.buffs.shield.expiresAt > now;
    if (shieldActive && (rec.streak || 0) > 1) {
      // Shield consumed — streak stays, buff gone
      delete rec.buffs.shield;
      postToChat(`🛡️ @${name}'s Streak Shield activated! Streak preserved.`);
    } else {
      rec.streak = 1;
    }
  }
  rec.lastWinAt = now;

  // Double buff doubles the base amount before streak multiplier
  let base = amount;
  if (rec.buffs.double && rec.buffs.double.expiresAt > now) {
    base = amount * 2;
    delete rec.buffs.double;
    ctx.buff_double_used = true;
  }
  // Lucky buff adds +1 to spins (ctx flag set by handleSpin)
  if (ctx.spin_lucky && rec.buffs.lucky && rec.buffs.lucky.expiresAt > now) {
    delete rec.buffs.lucky;
    ctx.buff_lucky_used = true;
  }

  const mult   = rec.streak;
  const gained = base * mult;
  rec.tokens += gained;
  rec.wins   += 1;

  // Hot streak announcement at 5, 10, 15 … (once per threshold)
  if (rec.streak >= 5 && rec.streak % 5 === 0) {
    postToChat(`🔥 @${name} is on a ${rec.streak}-WIN STREAK! ${mult}x multiplier burning!`);
  }

  const newAchievements = checkAchievements(rec, ctx);
  saveTokens(store);
  if (newAchievements.length > 0) announceAchievements(name, newAchievements);
  return { balance: rec.tokens, gained, mult, streak: rec.streak };
}
function spendTokens(name, amount) {
  const store = loadTokens();
  if (!store[name] || store[name].tokens < amount) return null;
  store[name].tokens -= amount;
  store[name].spent  += amount;
  saveTokens(store);
  return store[name].tokens;
}

// ── LTX Video (cash-in prize) ───────────────────────────────────────────────
// Loads the same T2V workflow discord-bridge uses (~/nemoclaw-persist/
// ltx23-t2v-workflow.json) and patches the prompt + seed + duration the
// same way generateVideoWithComfyUI() at discord-bridge.js:1886 does.
// Returns the video bytes (mp4) on success, null on any failure.
const LTX_T2V_WORKFLOW = path.join(HOME, "nemoclaw-persist", "ltx23-t2v-workflow.json");
const VIDEO_DURATION_SEC = 6; // shorter than discord default to keep render < 5min

// eslint-disable-next-line complexity
async function generateLtxVideo(prompt) {
  if (!fs.existsSync(LTX_T2V_WORKFLOW)) {
    log(`LTX_T2V_WORKFLOW missing at ${LTX_T2V_WORKFLOW}`);
    return null;
  }
  // Free comfy memory — LTX wants ~12GB VRAM, can't share with another model
  await comfyRequest("POST", "/free", { unload_models: true, free_memory: true }).catch(() => {});

  let workflow;
  try {
    workflow = JSON.parse(fs.readFileSync(LTX_T2V_WORKFLOW, "utf-8"));
  } catch (err) {
    log(`ltx workflow parse failed: ${err.message}`);
    return null;
  }
  // Patch the same nodes discord-bridge does
  if (workflow["121"]?.inputs) workflow["121"].inputs.text = prompt;
  if (workflow["115"]?.inputs) workflow["115"].inputs.noise_seed = Math.floor(Math.random() * 2147483647);
  if (workflow["196"]?.inputs) {
    workflow["196"].inputs.Xi = VIDEO_DURATION_SEC;
    workflow["196"].inputs.Xf = VIDEO_DURATION_SEC;
  }

  const submit = await comfyRequest("POST", "/prompt", { prompt: workflow, client_id: "stream-image-worker-ltx" });
  if (submit.status !== 200 || !submit.body?.prompt_id) {
    log(`ltx submit failed: status=${submit.status} err=${submit.error || JSON.stringify(submit.body).slice(0, 200)}`);
    return null;
  }
  const promptId = submit.body.prompt_id;
  log(`ltx submitted: ${promptId} (${VIDEO_DURATION_SEC}s clip)`);

  // LTX is slow — allow 10 minutes
  const deadline = Date.now() + 600_000;
  let videoFile = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const h = await comfyRequest("GET", `/history/${promptId}`);
    if (h.status !== 200 || !h.body?.[promptId]) continue;
    const entry = h.body[promptId];
    if (entry.status?.status_str === "error") {
      log(`ltx render error for ${promptId}`);
      return null;
    }
    if (entry.status?.completed) {
      // SaveAnimatedWEBP / VHS_VideoCombine / SaveVideo all output under "gifs" or "videos"
      for (const [, out] of Object.entries(entry.outputs || {})) {
        const vids = out.gifs || out.videos || [];
        if (vids.length > 0) { videoFile = vids[0]; break; }
      }
      if (videoFile) break;
    }
  }
  if (!videoFile) {
    log(`ltx timed out waiting on ${promptId}`);
    return null;
  }

  const view = await comfyRequest("GET",
    `/view?filename=${encodeURIComponent(videoFile.filename)}&subfolder=${encodeURIComponent(videoFile.subfolder || "")}&type=${encodeURIComponent(videoFile.type || "output")}`);
  if (view.status !== 200 || !Buffer.isBuffer(view.body)) {
    log(`ltx view failed: status=${view.status}`);
    return null;
  }
  return { bytes: view.body, filename: videoFile.filename };
}

// ── Token commands (chat-facing) ────────────────────────────────────────────
// !balance / !bal  — post caller's current tokens
// !top             — post top 3 leaderboard
// !spin            — burn SPIN_COST tokens, roll on SPIN_TABLE
// Also enforces per-user cooldowns to keep one person from spamming chat.
const cmdCooldown = new Map(); // key: `${user}:${cmd}` → lastTs
function onCooldown(user, cmd, ms) {
  const key = `${user}:${cmd}`;
  const last = cmdCooldown.get(key) || 0;
  if (Date.now() - last < ms) return true;
  cmdCooldown.set(key, Date.now());
  return false;
}

function handleBalance(userRaw) {
  const user = String(userRaw || "anon").replace(/^@+/, "");
  if (onCooldown(user, "balance", 15_000)) return;
  const store = loadTokens();
  const rec = store[user];
  if (!rec) {
    postToChat(`@${user} you haven't won anything yet — type 6-7 in a fresh round to start earning 🎂!`);
    return;
  }
  const streakBit = rec.streak > 1 && (Date.now() - (rec.lastWinAt || 0)) < STREAK_WINDOW_MS
    ? ` · 🔥${rec.streak}x streak live`
    : "";
  postToChat(`@${user} bal ${rec.tokens}🎂 · ${rec.wins} wins · ${rec.spent} spent${streakBit}`);
}

function handleTop(userRaw) {
  const user = String(userRaw || "anon").replace(/^@+/, "");
  if (onCooldown(user, "top", 20_000)) return;
  const store = loadTokens();
  const list = Object.entries(store)
    .map(([name, r]) => ({ name, ...r }))
    .sort((a, b) => (b.tokens - a.tokens) || (b.wins - a.wins))
    .slice(0, 3);
  if (list.length === 0) {
    postToChat(`Leaderboard is empty — type 6-7 to start earning 🎂!`);
    return;
  }
  const medals = ["🥇", "🥈", "🥉"];
  const parts = list.map((r, i) => `${medals[i]} @${r.name} ${r.tokens}🎂 (${r.wins}w)`);
  postToChat(`👑 TOP: ${parts.join(" · ")}`);
}

function handleSpin(userRaw) {
  const user = String(userRaw || "anon").replace(/^@+/, "");
  if (onCooldown(user, "spin", 8_000)) {
    postToChat(`@${user} easy on the spin — 8s cooldown`);
    return;
  }
  const store = loadTokens();
  const rec = store[user];
  if (!rec || rec.tokens < SPIN_COST) {
    postToChat(`@${user} need ${SPIN_COST}🎂 to !spin (you have ${rec?.tokens || 0}). Win a 6-7 round first!`);
    return;
  }
  // Burn cost first — house always collects
  rec.tokens -= SPIN_COST;
  rec.spent  += SPIN_COST;
  rec.spinCount = (rec.spinCount || 0) + 1;
  // Roll
  const roll  = Math.random();
  const prize = SPIN_TABLE.find((p) => roll <= p.roll) || SPIN_TABLE[0];
  let payout  = prize.payout;
  let label   = prize.label;
  const ctx   = {};
  if (prize.drainPool) {
    payout = drainPool(store, user);
    label  = `🌋 POOL DRAIN +${payout}`;
    ctx.pool_drained = true;
  }
  // Lucky buff adds +1 to payout before pool calc
  if (!rec.buffs) rec.buffs = {};
  if (rec.buffs.lucky && rec.buffs.lucky.expiresAt > Date.now()) {
    payout += 1;
    delete rec.buffs.lucky;
    label += " 🍀";
  }
  rec.tokens += payout;
  // Losing/break-even spins feed the jackpot pool. The pool fills slowly so a
  // chat with active spinning has something real to chase.
  if (payout < SPIN_COST) feedPool(store, SPIN_COST - payout);
  const newAchievements = checkAchievements(rec, ctx);
  saveTokens(store);
  if (newAchievements.length > 0) announceAchievements(user, newAchievements);
  const net = payout - SPIN_COST;
  const netTag = net > 0 ? `+${net}` : `${net}`;
  const poolNow = (store.__pool?.jackpot || 0);
  postToChat(`🎰 @${user} spins… ${label} (${netTag}🎂, bal ${rec.tokens}) · pool ${poolNow}🎂`);
}

function handleShop(userRaw) {
  const user = String(userRaw || "anon").replace(/^@+/, "");
  if (onCooldown(user, "shop", 10_000)) return;
  const store = loadTokens();
  const rec = store[user];
  const bal = rec?.tokens || 0;
  const items = Object.entries(SHOP_ITEMS)
    .map(([key, s]) => `${s.icon} !buy ${key} (${s.cost}🎂) ${s.label}`)
    .join(" · ");
  postToChat(`🛒 @${user} [${bal}🎂] Shop: ${items}`);
}

function handleBuy(userRaw, itemKey) {
  const user = String(userRaw || "anon").replace(/^@+/, "");
  if (onCooldown(user, `buy_${itemKey}`, 5_000)) return;
  const item = SHOP_ITEMS[itemKey];
  if (!item) {
    postToChat(`@${user} unknown item. Try: !buy ${Object.keys(SHOP_ITEMS).join(" | !buy ")}`);
    return;
  }
  const store = loadTokens();
  if (!store[user]) {
    postToChat(`@${user} you have no tokens yet! Win a 6-7 round first.`);
    return;
  }
  if (!store[user].buffs) store[user].buffs = {};
  const rec = store[user];
  if (rec.tokens < item.cost) {
    postToChat(`@${user} need ${item.cost}🎂 for ${item.icon} ${item.label} (you have ${rec.tokens})`);
    return;
  }
  // Prevent buying a buff already active
  const existing = rec.buffs[itemKey];
  if (existing && existing.expiresAt > Date.now()) {
    const secsLeft = Math.ceil((existing.expiresAt - Date.now()) / 1000);
    postToChat(`@${user} ${item.icon} ${item.label} already active (${secsLeft}s left)`);
    return;
  }
  rec.tokens -= item.cost;
  rec.spent  += item.cost;
  rec.buffs[itemKey] = { expiresAt: Date.now() + item.ttlMs };
  const newAch = checkAchievements(rec, {});
  saveTokens(store);
  if (newAch.length > 0) announceAchievements(user, newAch);
  postToChat(`✅ @${user} bought ${item.icon} ${item.label}! ${item.desc}. Bal ${rec.tokens}🎂`);
}

function handleGift(userRaw, targetRaw, amountStr) {
  const user   = String(userRaw   || "anon").replace(/^@+/, "");
  const target = String(targetRaw || "").replace(/^@+/, "").trim();
  if (onCooldown(user, "gift", 30_000)) {
    postToChat(`@${user} gift cooldown active (30s)`);
    return;
  }
  const amount = parseInt(amountStr, 10);
  if (!target || isNaN(amount) || amount < 1) {
    postToChat(`@${user} usage: !gift @username <amount>`);
    return;
  }
  const store = loadTokens();
  if (!store[user] || store[user].tokens < amount) {
    postToChat(`@${user} not enough tokens to gift ${amount}🎂`);
    return;
  }
  if (!store[target]) store[target] = { tokens: 0, wins: 0, spent: 0, streak: 0, lastWinAt: 0, achievements: [], buffs: {} };
  store[user].tokens   -= amount;
  store[target].tokens += amount;
  saveTokens(store);
  postToChat(`🎁 @${user} gifted ${amount}🎂 to @${target}! [${user}: ${store[user].tokens}] [${target}: ${store[target].tokens}]`);
}

// ── Cash-in handler ─────────────────────────────────────────────────────────
// Serialized — only one video render at a time globally. Second cash-in
// while one is in flight gets a "wait your turn" reply.
let videoInFlight = false;

function appendVideoEntry(entry) {
  try {
    fs.mkdirSync(path.dirname(VIDEOS_JSON), { recursive: true });
    let list = [];
    if (fs.existsSync(VIDEOS_JSON)) {
      try { list = JSON.parse(fs.readFileSync(VIDEOS_JSON, "utf8")) || []; } catch (_e) {
    // silent
  }
      if (!Array.isArray(list)) list = [];
    }
    list.unshift(entry);
    if (list.length > MAX_VIDEOS) list = list.slice(0, MAX_VIDEOS);
    fs.writeFileSync(VIDEOS_JSON, JSON.stringify(list, null, 2));
  } catch (err) {
    log(`videos write failed: ${err.message}`);
  }
}

async function handleVideoCashIn(requesterRaw, rawPrompt) {
  const requester = String(requesterRaw || "anon").replace(/^@+/, "");
  const prompt    = sanitizePrompt(rawPrompt);
  if (!prompt) {
    postToChat(`@${requester} that prompt is empty or blocked — try again with something else!`);
    return;
  }

  // Check balance first WITHOUT spending. Spend only if we can actually
  // start the render — otherwise users would lose tokens to a busy worker.
  const store = loadTokens();
  const balance = store[requester]?.tokens || 0;
  if (balance < TOKENS_PER_VIDEO) {
    postToChat(`@${requester} you need ${TOKENS_PER_VIDEO} 🎂 tokens for a video (you have ${balance}). Win more 6-7 rounds!`);
    return;
  }
  if (videoInFlight) {
    postToChat(`@${requester} a video is already rendering — try again in a few minutes!`);
    return;
  }

  // Spend now (race-safe inside this single-process worker since handleVideoCashIn
  // is the only spender and we set videoInFlight before the await chain).
  videoInFlight = true;
  const newBalance = spendTokens(requester, TOKENS_PER_VIDEO);
  if (newBalance == null) {
    videoInFlight = false;
    postToChat(`@${requester} balance check raced — try again!`);
    return;
  }

  log(`VIDEO CASH-IN by @${requester}: "${prompt.slice(0, 60)}" (balance now ${newBalance})`);
  postToChat(`🎬 Cooking a video for @${requester}… this takes ~5 min, hang tight!`);

  try {
    const result = await generateLtxVideo(prompt);
    if (!result) {
      // Refund on failure — they shouldn't lose tokens to a render error
      const store2 = loadTokens();
      if (store2[requester]) {
        store2[requester].tokens += TOKENS_PER_VIDEO;
        store2[requester].spent  -= TOKENS_PER_VIDEO;
        saveTokens(store2);
      }
      postToChat(`@${requester} oof, the video render flopped — your ${TOKENS_PER_VIDEO} tokens are refunded!`);
      return;
    }

    // Persist the bytes
    fs.mkdirSync(VIDEOS_DIR, { recursive: true });
    const ts = Date.now();
    const ext = (result.filename.match(/\.(mp4|webm|webp|gif)$/i) || [".mp4"])[0];
    const destName = `vid_${ts}_${requester.replace(/[^a-zA-Z0-9_-]/g, "")}${ext}`;
    fs.writeFileSync(path.join(VIDEOS_DIR, destName), result.bytes);

    appendVideoEntry({
      id:        `vid_${ts}`,
      src:       `/workshop-videos/${destName}`,
      caption:   `🎬 Video for @${requester}`,
      requester,
      prompt:    prompt.slice(0, 200),
      bytes:     result.bytes.length,
      createdAt: new Date(ts).toISOString(),
    });
    log(`saved video: ${destName} (${(result.bytes.length / 1024 / 1024).toFixed(1)}MB)`);
    postToChat(`🎬 @${requester}'s video is ready — watch it on stream!`);
    // Re-load + check achievements (spending happened earlier, so wins/spent are current)
    const store3 = loadTokens();
    if (store3[requester]) {
      const newAchievements = checkAchievements(store3[requester], { video_cashed: true });
      if (newAchievements.length > 0) {
        saveTokens(store3);
        announceAchievements(requester, newAchievements);
      }
    }
  } finally {
    videoInFlight = false;
  }
}

// ── Gallery write ───────────────────────────────────────────────────────────
function appendGalleryEntry(entry) {
  try {
    fs.mkdirSync(path.dirname(GALLERY_JSON), { recursive: true });
    let list = [];
    if (fs.existsSync(GALLERY_JSON)) {
      try { list = JSON.parse(fs.readFileSync(GALLERY_JSON, "utf8")) || []; } catch (_e) {
    // silent
  }
      if (!Array.isArray(list)) list = [];
    }
    list.unshift(entry);
    if (list.length > MAX_GALLERY) list = list.slice(0, MAX_GALLERY);
    fs.writeFileSync(GALLERY_JSON, JSON.stringify(list, null, 2));
  } catch (err) {
    log(`gallery write failed: ${err.message}`);
  }
}

async function persistImage(buf, prompt, requester, backend) {
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
  const ts = Date.now() + Math.floor(Math.random() * 1000);
  const destName = `img_${ts}_${backend}.jpg`;
  const dest = path.join(GALLERY_DIR, destName);
  try { fs.writeFileSync(dest, buf); }
  catch (err) { log(`write failed: ${err.message}`); return; }

  appendGalleryEntry({
    id:         `img_${ts}`,
    src:        `/workshop-images/${destName}`,
    prompt,
    requester,
    backend,
    chatCount:  1,
    chatSample: [{ name: requester, text: prompt.slice(0, 100) }],
    createdAt:  new Date(ts).toISOString(),
  });
  log(`saved (${backend}): ${destName} — "${prompt.slice(0, 60)}"`);
}

// ── Main loop ───────────────────────────────────────────────────────────────
async function processBatch(batch) {
  if (batch.length === 0) return;
  log(`processing batch of ${batch.length}`);

  // Decide which backend each request goes to. With 2+ requests AND ComfyUI
  // up, alternate between NVIDIA and Comfy so chat sees both styles. With 1
  // request, always NVIDIA (faster). With Comfy down, always NVIDIA.
  const comfyUp = !!(await isComfyAlive());
  log(`comfy reachable: ${comfyUp}`);

  const jobs = batch.map((req, i) => {
    let backend;
    if (!comfyUp) backend = "nvidia";
    else if (batch.length === 1) backend = "nvidia";
    else backend = i % 2 === 0 ? "nvidia" : "comfy";
    return { ...req, backend };
  });

  // Fire all jobs in parallel
  await Promise.all(jobs.map(async (job) => {
    log(`gen[${job.backend}] for @${job.requester}: "${job.prompt.slice(0, 60)}"`);
    const buf = job.backend === "comfy"
      ? await generateComfy(job.prompt)
      : await generateNvidia(job.prompt);
    if (!buf) {
      log(`gen[${job.backend}] FAILED for "${job.prompt.slice(0, 40)}"`);
      // If comfy failed, retry on NVIDIA as a fallback
      if (job.backend === "comfy") {
        log(`falling back to nvidia for "${job.prompt.slice(0, 40)}"`);
        const fb = await generateNvidia(job.prompt);
        if (fb) await persistImage(fb, job.prompt, job.requester, "nvidia-fallback");
      }
      return;
    }
    await persistImage(buf, job.prompt, job.requester, job.backend);
  }));
}

// eslint-disable-next-line complexity
async function main() {
  log("starting");
  let lastTs = loadSeen();
  log(`resume from lastTs=${lastTs}`);

  for (;;) {
    let session;
    try { session = JSON.parse(fs.readFileSync(LIVE_SESSION, "utf8")); }
    catch (_e) { session = null; }

    if (session?.active && Array.isArray(session.chatHistory)) {
      const fresh = session.chatHistory.filter((m) => (m.ts || 0) > lastTs);

      // ── Reaction game scheduler + winner detection ─────────────────────
      // Start a new round every REACTION_INTERVAL_MS if none is active.
      // Expire active rounds whose window has elapsed without a winner.
      if (!reactionRound && Date.now() - reactionLastFiredAt > REACTION_INTERVAL_MS) {
        startReactionRound();
      }
      if (reactionRound) {
        if (Date.now() > reactionRound.expiresAt) {
          postToChat(`⚡ Reaction round expired — nobody typed "${reactionRound.word}". Next round in ~5min!`);
          endReactionRound("timeout");
        } else {
          const targetUpper = reactionRound.word.toUpperCase();
          const re = new RegExp(`(?:^|[^A-Z])${targetUpper}(?:[^A-Z]|$)`, "i");
          for (const m of fresh) {
            if (re.test(String(m.text || ""))) {
              const winner = String(m.name || "anon").replace(/^@+/, "");
              const word = reactionRound.word;
              endReactionRound(`win:${winner}`);
              const r = awardTokens(winner, REACTION_PRIZE, { reaction_won: true });
              reactionLastWinner = { name: winner, word, at: Date.now() };
              writeReactionState();
              const streakTag = r.mult > 1 ? ` 🔥${r.streak}x` : "";
              postToChat(`⚡ @${winner} reacted "${word}" first! +${r.gained}🎂 (bal ${r.balance})${streakTag}`);
              break;
            }
          }
        }
      }

      // ── 6-7 prize detection — first matching message in this batch wins,
      // but only if we're past the cooldown since the last accepted win.
      for (const m of fresh) {
        if (Date.now() - sixSevenLastWinAt < SIX_SEVEN_COOLDOWN) break;
        const text = String(m.text || "");
        if (SIX_SEVEN_RE.test(text)) {
          sixSevenLastWinAt = Date.now();
          // Fire and forget — don't block the !image command pump
          handleSixSevenWinner(m.name || "anon").catch((e) => log(`6-7 handler error: ${e.message}`));
          break;
        }
      }

      // ── Token commands — !balance / !bal / !top / !spin / !shop / !buy / !gift
      // These are cheap chat posts, no rate-limited backends, so handle
      // every matching message in the batch (per-user cooldown guards spam).
      for (const m of fresh) {
        const text = String(m.text || "").trim().toLowerCase();
        const raw  = String(m.text || "").trim(); // case-preserved for names
        if (text === "!balance" || text === "!bal" || text === "!tokens") {
          handleBalance(m.name);
        } else if (text === "!top" || text === "!leaderboard") {
          handleTop(m.name);
        } else if (text === "!spin") {
          handleSpin(m.name);
        } else if (text === "!shop") {
          handleShop(m.name);
        } else if (text.startsWith("!buy ")) {
          const itemKey = text.slice(5).trim();
          handleBuy(m.name, itemKey);
        } else if (text.startsWith("!gift ")) {
          // !gift @target amount
          const parts = raw.slice(6).trim().split(/\s+/);
          const target = parts[0] || "";
          const amount = parts[1] || "";
          handleGift(m.name, target, amount);
        }
      }

      // ── Video cash-in detection — !video <prompt> — first match per
      // batch wins, the in-flight flag prevents a second one from racing.
      for (const m of fresh) {
        const text = String(m.text || "").trim();
        const lower = text.toLowerCase();
        if (!lower.startsWith("!video ") && lower !== "!video") continue;
        const raw = text.slice("!video".length).trim();
        if (!raw) {
          postToChat(`@${(m.name||"anon").replace(/^@+/,"")} usage: !video <your video prompt> (costs ${TOKENS_PER_VIDEO} 🎂 tokens)`);
          continue;
        }
        // Fire and forget — the handler awaits the LTX render itself
        handleVideoCashIn(m.name, raw).catch((e) => log(`cash-in error: ${e.message}`));
        break;
      }

      const cmds = [];
      for (const m of fresh) {
        const text = String(m.text || "").trim();
        const lower = text.toLowerCase();
        if (!lower.startsWith("!image ") && lower !== "!image") continue;
        const raw = text.slice("!image".length).trim();
        const prompt = sanitizePrompt(raw);
        if (!prompt) {
          log(`skipped (empty/blocked) from @${m.name}: "${raw.slice(0, 60)}"`);
          continue;
        }
        cmds.push({ requester: m.name || "anon", prompt, ts: m.ts || 0 });
      }
      if (fresh.length > 0) {
        lastTs = Math.max(lastTs, ...fresh.map((m) => m.ts || 0));
        saveSeen(lastTs);
      }
      if (cmds.length > 0) {
        // Process the batch but don't await in the main loop — let multiple
        // batches overlap so a slow Comfy gen doesn't block new NVIDIA gens.
        processBatch(cmds).catch((e) => log(`batch error: ${e.message}`));
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error("[image-worker] fatal:", e.message);
  process.exit(1);
});
