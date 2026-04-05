#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Discord → NemoClaw bridge.
 *
 * Messages in the allowed channel are forwarded to the OpenClaw agent
 * running inside the sandbox. Responses are sent back to the same channel.
 *
 * Env:
 *   DISCORD_BOT_TOKEN   — from Discord Developer Portal
 *   NVIDIA_API_KEY      — for inference
 *   SANDBOX_NAME        — sandbox name (default: my-assistant)
 *   DISCORD_GUILD_ID    — server/guild ID to accept messages from
 *   DISCORD_CHANNEL_ID  — channel ID to listen and respond in
 */

const { Client, GatewayIntentBits, Partials, AttachmentBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionType,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require(
  require("path").resolve(__dirname, "../node_modules/discord.js")
);
const { registerCommands } = require("./slash-commands");
const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const os    = require("os");

// ── Telemetry counters (lightweight JSON file, no perf impact) ───────────────
const TELEMETRY_COUNTERS_PATH = path.join(os.homedir(), ".nemoclaw/telemetry-counters.json");
function bumpCounter(key, amount = 1) {
  try {
    let counters = {};
    if (fs.existsSync(TELEMETRY_COUNTERS_PATH)) {
      counters = JSON.parse(fs.readFileSync(TELEMETRY_COUNTERS_PATH, "utf8"));
    }
    counters[key] = (counters[key] || 0) + amount;
    fs.writeFileSync(TELEMETRY_COUNTERS_PATH, JSON.stringify(counters));
  } catch (_) { /* non-critical */ }
}

// Load .nemoclaw_env if present (pm2 doesn't source shell profiles)
const _envFile = path.join(os.homedir(), ".nemoclaw_env");
if (fs.existsSync(_envFile)) {
  for (const line of fs.readFileSync(_envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && (!process.env[m[1]] || process.env[m[1]] === "")) process.env[m[1]] = m[2];
  }
}
// ── Retry helper for server.listen (survives EADDRINUSE during rapid restarts) ──
function listenWithRetry(server, port, host, label, maxRetries = 5, delayMs = 2000) {
  let attempt = 0;
  function tryListen() {
    server.listen(port, host, () => {
      console.log(`[${label}] listening on :${port}`);
    });
  }
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && attempt < maxRetries) {
      attempt++;
      console.warn(`[${label}] port ${port} in use, retry ${attempt}/${maxRetries} in ${delayMs}ms...`);
      setTimeout(tryListen, delayMs);
    } else {
      console.warn(`[${label}] failed to start: ${e.message}`);
    }
  });
  tryListen();
}

const { execFileSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");
const trends = require("./trends");
const bu = require("./lib/bridge-utils");
const gdrive = require("./google-drive");
const { generateSuno, generateVideoForClip, generateLyrics: generateSunoLyrics, downloadAudio: downloadSunoAudio } = require("./suno");
const { getStore } = require("@netlify/blobs");
const { execSync } = require("child_process");

// ── Static.app deploy helpers ───────────────────────────────
const STATICAPP_KEY = process.env.STATICAPP_API_KEY || "";
const STATICAPP_SITE_ID = 154864;
const SITE_DATA_DIR = path.join(os.homedir(), ".nemoclaw", "site-data");
const POSTS_FILE = path.join(SITE_DATA_DIR, "posts.json");

function loadPosts() {
  try { return JSON.parse(fs.readFileSync(POSTS_FILE, "utf8")); } catch { return []; }
}

function savePosts(posts) {
  if (!fs.existsSync(SITE_DATA_DIR)) fs.mkdirSync(SITE_DATA_DIR, { recursive: true });
  const json = JSON.stringify(posts, null, 2);
  fs.writeFileSync(POSTS_FILE, json);
  // Keep public/data and out/data in sync so next build doesn't overwrite with stale data
  try { const pd = "/tmp/netify-build/public/data"; if (!fs.existsSync(pd)) fs.mkdirSync(pd, { recursive: true }); fs.writeFileSync(path.join(pd, "posts.json"), json); } catch {}
  try { const od = "/tmp/netify-build/out/data"; if (fs.existsSync(od)) fs.writeFileSync(path.join(od, "posts.json"), json); } catch {}
}

async function deployToFirebase() {
  // Deploy posts.json update to Firebase Hosting (drivenemo.web.app)
  // Skips Next.js rebuild — just updates data file and re-deploys the existing out/ dir.
  const buildDir = "/tmp/netify-build/out";
  if (!fs.existsSync(buildDir)) { console.warn("[firebase] no build dir at " + buildDir); return false; }
  try {
    // Inject updated posts.json into the existing static export
    const dataDir = path.join(buildDir, "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(POSTS_FILE, path.join(dataDir, "posts.json"));
    console.log("[firebase] posts.json updated in out/data/");
    // Deploy to Firebase Hosting (project: drivenemo)
    execSync(
      "/home/nemoclaw/.local/bin/firebase deploy --only hosting --project drivenemo",
      { cwd: "/tmp/netify-build", timeout: 60000, stdio: "pipe" }
    );
    console.log("[firebase] deploy complete → https://drivenemo.web.app");
    return true;
  } catch (e) {
    console.error("[firebase] deploy failed:", e.message);
    return false;
  }
}

// ── Auto-backup generated media to Google Drive ─────────────
const MEDIA_FOLDER_ID = process.env.GDRIVE_MEDIA_FOLDER_ID || process.env.GDRIVE_FOLDER_ID || "";
function backupMedia(buf, fileName, mimeType) {
  if (!MEDIA_FOLDER_ID || !buf || buf.length < 1024) return;
  const tmpPath = `/tmp/gdrive-upload-${Date.now()}-${fileName}`;
  try {
    fs.writeFileSync(tmpPath, buf);
    gdrive.uploadToDrive(tmpPath, mimeType, fileName, MEDIA_FOLDER_ID)
      .then(r => { console.log(`[gdrive] backed up ${fileName} → ${r.webViewLink}`); try { fs.unlinkSync(tmpPath); } catch {} })
      .catch(e => { console.warn(`[gdrive] backup failed for ${fileName}: ${e.message}`); try { fs.unlinkSync(tmpPath); } catch {} });
  } catch (e) { console.warn(`[gdrive] write failed: ${e.message}`); }
}

const OPENSHELL = resolveOpenshell();
let lastInputBuffer = null; // last image buffer from user message, for I2V video
let lastInputBuffers = []; // all image buffers from user message (for combi first/last frame)
let lastVideoBuffer = null; // last video buffer uploaded by user or generated by ComfyUI
let lastVideoSetAt = 0; // timestamp — prevents stale reuse by agents
let lastImageSetAt = 0;
const MEDIA_TTL = 30 * 60 * 1000; // 30 min
// Recover video buffer from disk if recent
try { if (fs.existsSync("/tmp/input_video.mp4")) { const _age = Date.now() - fs.statSync("/tmp/input_video.mp4").mtimeMs; if (_age < MEDIA_TTL) { lastVideoBuffer = fs.readFileSync("/tmp/input_video.mp4"); lastVideoSetAt = Date.now(); lastVideoSetAt = Date.now(); console.log(`[startup] recovered lastVideoBuffer (${(lastVideoBuffer.length/1048576).toFixed(1)}MB, ${(_age/60000|0)}m old)`); } else { console.log(`[startup] skipped stale input_video.mp4 (${(_age/60000|0)}m old)`); } } } catch {}
try { if (!lastVideoBuffer && fs.existsSync("/tmp/last_generated_video.mp4")) { const _age = Date.now() - fs.statSync("/tmp/last_generated_video.mp4").mtimeMs; if (_age < MEDIA_TTL) { lastVideoBuffer = fs.readFileSync("/tmp/last_generated_video.mp4"); lastVideoSetAt = Date.now(); lastVideoSetAt = Date.now(); console.log(`[startup] recovered lastVideoBuffer (${(lastVideoBuffer.length/1048576).toFixed(1)}MB, ${(_age/60000|0)}m old)`); } else { console.log(`[startup] skipped stale last_generated_video.mp4 (${(_age/60000|0)}m old)`); } } } catch {}
let lastVideoMime   = null;
let lastGeneratedImageBuffer = null; // last image generated by the bot (pulled from sandbox)
// Expire stale media every 5 min so agents don't reuse hours-old buffers
setInterval(() => {
  if (lastVideoBuffer && (Date.now() - lastVideoSetAt >= MEDIA_TTL)) {
    console.log(`[media-ttl] expiring lastVideoBuffer (${((Date.now() - lastVideoSetAt)/60000|0)}m stale)`);
    lastVideoBuffer = null; lastVideoMime = null;
  }
  if (lastGeneratedImageBuffer && (Date.now() - lastImageSetAt >= MEDIA_TTL)) {
    console.log(`[media-ttl] expiring lastGeneratedImageBuffer (${((Date.now() - lastImageSetAt)/60000|0)}m stale)`);
    lastGeneratedImageBuffer = null;
  }
}, 5 * 60 * 1000);
let lastPrompt = ""; // last generation prompt (for regenerate button)
let lastRatio = "1:1"; // last aspect ratio used
// ── Diagnostic logger — structured JSONL for debugging message issues ──
// Separate from main log. Append-only, auto-rotates at 5MB.
const DIAG_LOG = path.join(os.homedir(), ".nemoclaw", "logs", "bridge-diag.jsonl");
const DIAG_MAX = 5 * 1024 * 1024; // 5MB
(function ensureDiagDir() { const d = path.dirname(DIAG_LOG); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); })();

function diag(event, data = {}) {
  try {
    const entry = JSON.stringify({ t: new Date().toISOString(), e: event, ...data }) + "\n";
    // Rotate if too large
    try { if (fs.statSync(DIAG_LOG).size > DIAG_MAX) fs.renameSync(DIAG_LOG, DIAG_LOG + ".prev"); } catch {}
    fs.appendFileSync(DIAG_LOG, entry);
  } catch {} // never crash for logging
}

// ── Message pipeline timer ──
class MsgTimer {
  constructor(msgId, userId, content) {
    this.msgId = msgId;
    this.userId = userId;
    this.content = (content || "").slice(0, 80);
    this.t0 = Date.now();
    this.marks = {};
  }
  mark(stage) { this.marks[stage] = Date.now() - this.t0; }
  finish(status) {
    this.mark("done");
    if (status === "ok") health.msgOk++;
    else if (status === "error") health.msgErr++;
    diag("msg", { id: this.msgId, user: this.userId, status, ms: this.marks, q: agentQueue.size, txt: this.content });
  }
}

// ── Health metrics ──────────────────────────────────────────────
const startedAt = Date.now();
const health = {
  msgIn: 0,        // messages received from Discord (past filters)
  msgOk: 0,        // messages successfully processed (agent replied)
  msgErr: 0,       // messages that hit an error
  agentCalls: 0,   // total agent invocations
  agentFails: 0,   // agent calls that errored or returned empty
  lastAgentOk: 0,  // timestamp of last successful agent response
  dedups: 0,       // dedup filter hits
  rejections: 0,   // unhandled rejections caught
};

const processedMessages = new Set(); // dedup guard
// Persistent dedup: load recent message IDs from disk so restarts don't replay messages
const DEDUP_FILE = path.join(os.homedir(), ".nemoclaw", "logs", "processed-msgs.log");
try {
  if (fs.existsSync(DEDUP_FILE)) {
    const lines = fs.readFileSync(DEDUP_FILE, "utf8").trim().split("\n").filter(Boolean);
    // Only keep last 500 IDs (roughly 2-3 hours of traffic)
    const recent = lines.slice(-500);
    for (const id of recent) processedMessages.add(id);
    // Rewrite file with only recent IDs to prevent unbounded growth
    if (lines.length > 500) fs.writeFileSync(DEDUP_FILE, recent.join("\n") + "\n");
    console.log(`[dedup] loaded ${recent.length} message IDs from disk`);
  }
} catch (e) { console.warn(`[dedup] load failed: ${e.message}`); }
// Content-based dedup: survives restarts by persisting content hashes with timestamps
const CONTENT_DEDUP_FILE = path.join(os.homedir(), ".nemoclaw", "logs", "content-dedup.json");
global._contentDedup = new Map();
try {
  if (fs.existsSync(CONTENT_DEDUP_FILE)) {
    const entries = JSON.parse(fs.readFileSync(CONTENT_DEDUP_FILE, "utf8"));
    const cutoff = Date.now() - 300000; // 5 min
    for (const [k, v] of entries) { if (v > cutoff) global._contentDedup.set(k, v); }
    console.log(`[dedup] loaded ${global._contentDedup.size} content keys from disk`);
  }
} catch {}
const lastGifTime = new Map(); // per-user GIF cooldown (prevent Discord API rate limits)
const generationContext = new Map(); // msgId → { prompt, ratio, imageBuf, videoBuf, type }
const pendingMp4 = new Map();        // `${guildId}-${userId}` → { mp4Buf, ts } — awaiting audio upload to combine
const pendingGrokImg2X = new Map();  // `${channelId}-${userId}` → { action: "img2img"|"img2vid", prompt, replyMsgId }

// ── Edit queue — per-user media accumulator for /edit-add + /edit-go ──────
const editQueues = new Map(); // userId → { images: Buffer[], videos: Buffer[], audios: Buffer[], updatedAt: number }
const EDIT_QUEUE_EXPIRY = 30 * 60 * 1000; // 30 min

function getEditQueue(userId) {
  let q = editQueues.get(userId);
  if (!q || Date.now() - q.updatedAt > EDIT_QUEUE_EXPIRY) {
    q = { images: [], videos: [], audios: [], updatedAt: Date.now() };
    editQueues.set(userId, q);
  }
  return q;
}

function clearEditQueue(userId) { editQueues.delete(userId); }

function editQueueSummary(q) {
  const parts = [];
  if (q.images.length) parts.push(`${q.images.length} image${q.images.length > 1 ? "s" : ""}`);
  if (q.videos.length) parts.push(`${q.videos.length} video${q.videos.length > 1 ? "s" : ""}`);
  if (q.audios.length) parts.push(`${q.audios.length} audio`);
  return parts.length ? parts.join(", ") : "empty";
}

// ── Agent queue — serialize agent calls per user to prevent sandbox session locks ──
const agentQueue = new Map(); // userId → Promise chain
function enqueueAgent(userId, fn) {
  const prev = agentQueue.get(userId) || Promise.resolve();
  const queued = prev !== Promise.resolve(); // was there already a pending call?
  if (queued) diag("queue", { user: userId, depth: agentQueue.size });
  const next = prev.then(fn, fn); // run fn after previous resolves (or rejects)
  agentQueue.set(userId, next);
  next.finally(() => { if (agentQueue.get(userId) === next) agentQueue.delete(userId); });
  return next;
}

// ── ComfyUI queue status ─────────────────────────────────────────
async function getComfyQueueStatus() {
  try {
    const res = await comfyRequest("GET", "/queue");
    const data = JSON.parse(res.body.toString());
    const running = (data.queue_running || []).length;
    const pending = (data.queue_pending || []).length;
    return { running, pending, total: running + pending };
  } catch { return { running: 0, pending: 0, total: 0 }; }
}

// ── Button builders ──────────────────────────────────────────────
// ── Grok image grid buttons (shown after 4-image generation) ─────────────────
function grokGridButtons(msgId, count = 4) {
  const nums = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];
  const selBtns = Array.from({ length: count }, (_, i) =>
    new ButtonBuilder().setCustomId(`btn_groksel${i}_${msgId}`).setLabel(nums[i]).setStyle(ButtonStyle.Primary)
  );
  selBtns.push(
    new ButtonBuilder().setCustomId(`btn_grokregen_${msgId}`).setLabel("🔄 Regen All").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_grokimg2img_${msgId}`).setLabel("🖼️ Img2Img").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btn_grokimg2vid_${msgId}`).setLabel("🎬 Img2Vid").setStyle(ButtonStyle.Secondary),
  );
  return [new ActionRowBuilder().addComponents(...selBtns), row2];
}

// ── Grok single-image buttons (shown after selecting one image) ───────────────
// Index is encoded in the action name (grokedit0, grokvid1, etc.) to avoid parser conflicts
function grokSingleButtons(msgId, idx) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`btn_grokedit${idx}_${msgId}`).setLabel("✏️ Edit Prompt").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`btn_grokvid${idx}_${msgId}`).setLabel("🎬 Make Video").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`btn_grokpost${idx}_${msgId}`).setLabel("📱 Post to IG").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`btn_grokback_${msgId}`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function imageButtons(msgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_video_${msgId}`).setLabel("🎬 Make Video").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`btn_enhance_${msgId}`).setLabel("✨ Enhance & Video").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`btn_post_${msgId}`).setLabel("📱 Post to IG").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`btn_website_${msgId}`).setLabel("🌐 Post to Website").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`btn_regen_${msgId}`).setLabel("🔄 Regenerate").setStyle(ButtonStyle.Secondary),
  );
}

function videoButtons(msgId) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_chain_${msgId}`).setLabel("🔗 Auto Chain").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`btn_chainprompt_${msgId}`).setLabel("🔗 Chain + Prompt").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`btn_chainenhance_${msgId}`).setLabel("✨ Chain + Enhance").setStyle(ButtonStyle.Primary),
  );
  const segs = storySegments.get(msgId);
  const row2Items = [
    new ButtonBuilder().setCustomId(`btn_gif_${msgId}`).setLabel("🎞️ Make GIF").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btn_post_vid_${msgId}`).setLabel("📱 Post to IG").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`btn_save_${msgId}`).setLabel("💾 Save to Drive").setStyle(ButtonStyle.Secondary),
  ];
  if (segs && segs.length >= 2) {
    row2Items.push(
      new ButtonBuilder().setCustomId(`btn_stitch_${msgId}`).setLabel(`🎬 Stitch All (${segs.length})`).setStyle(ButtonStyle.Danger),
    );
  }
  const row2 = new ActionRowBuilder().addComponents(...row2Items);
  return [row1, row2];
}

// ── Grok video buttons (Extend / Upscale — Grok-specific, shown after grok video posts) ──
function grokVideoButtons(msgId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_grokextend_${msgId}`).setLabel("➕ Extend").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`btn_grokupscale_${msgId}`).setLabel("⬆️ Upscale").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`btn_gif_${msgId}`).setLabel("🎞️ Make GIF").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btn_post_vid_${msgId}`).setLabel("📱 Post to IG").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`btn_save_${msgId}`).setLabel("💾 Save to Drive").setStyle(ButtonStyle.Secondary),
  )];
}

// LTX Video prompt enhancer — rewrites a simple prompt into a production-ready LTX prompt
const LTX_ENHANCE_SYSTEM = `You are a video prompt enhancer for LTX Video 2.3. Rewrite the user's simple prompt into a detailed, production-ready video prompt following these rules:

1. ESTABLISH THE SHOT: Use cinematography terms (close-up, wide shot, medium shot, etc.)
2. SET THE SCENE: Describe lighting, color palette, textures, atmosphere
3. DESCRIBE THE ACTION: Write as a continuous temporal arc — what moves first, what follows, how it settles. Use present tense and sequential connective language ("begins moving", "slowly transitions to", "gradually reveals", "eases into", "comes to rest")
4. DEFINE CHARACTERS: Include age, hairstyle, clothing, distinguishing features. Express emotion through PHYSICAL CUES not abstract labels
5. CAMERA MOVEMENT: Specify how and when the camera moves (slow dolly in, handheld tracking, pans across, etc.) and what it reveals after the movement
6. TEMPORAL FLOW: The last 3-4 seconds must explicitly wind down — describe the motion easing, the subject settling, the camera slowing to a natural resting position. Never end mid-action.
7. DESCRIBE AUDIO: Ambient sounds, music — brief

CRITICAL RULES:
- Write as a SINGLE flowing paragraph in present tense
- 5-8 descriptive sentences — long prompts outperform short ones for 10s videos
- Focus on MOTION and ACTION, not static elements (static details are already in the image)
- Use explicit transition language: "gradually transitions", "smoothly reveals", "slowly eases into", "seamlessly shifts to", "comes to rest at"
- Do NOT use internal emotional states (sad, confused) — use posture, gesture, facial expression instead
- Do NOT include text/logos
- Do NOT overload with multiple characters or complex physics (no jumping, juggling)
- The video is EXACTLY 10 seconds at 24fps. One main action + smooth landing is ideal
- Output ONLY the enhanced prompt, nothing else`;

// Generate a continuation prompt + target frame description for chain mode
const CHAIN_CONTINUE_SYSTEM = `You are a video story continuator for LTX Video 2.3. Given the previous segment's prompt, write TWO things:

1. NEXT_PROMPT: A detailed LTX Video 2.3 prompt for the next EXACTLY 10 seconds. Structure it as a complete temporal arc:
   - Opening (seconds 0-3): Describe the motion beginning from the previous segment's final pose — use "begins", "starts to", "slowly initiates"
   - Middle (seconds 3-7): The main action — one clear movement, camera shift, or scene development
   - Landing (seconds 7-10): Explicitly wind down — use "gradually slows", "gently comes to rest", "eases into a still position", "the camera settles on", "smoothly transitions to rest at"
   The last 3-4 seconds MUST describe the motion easing to a natural stop that logically arrives at the END_FRAME. Never end mid-action.
   Follow LTX 2.3 rules: single flowing paragraph, present tense, 5-8 sentences, cinematography terms, focus on motion not static elements.
   Use transition connectors: "then", "as", "while", "gradually", "slowly", "seamlessly", "before finally".

2. END_FRAME: A concise still-photograph description of the FINAL FRAME — a natural resting pose the video eases INTO, not a freeze-frame of action. Must feel like a logical, settled endpoint.

IMPORTANT: The video is 10 seconds at 24fps. One main action with a smooth 3-4 second landing is ideal. Long prompts outperform short ones — do not write fewer than 5 sentences.

Output EXACTLY in this format (no other text):
NEXT_PROMPT: <your detailed video prompt here>
END_FRAME: <your still image description here>`;

async function generateChainContinuation(previousPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "gemini-3.1-flash-lite-preview",
      messages: [
        { role: "system", content: CHAIN_CONTINUE_SYSTEM },
        { role: "user", content: `Previous segment prompt: "${previousPrompt}"` },
      ],
      max_tokens: 600,
      temperature: 0.8,
    });
    const req = http.request({
      hostname: "localhost", port: 9340, path: "/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          const text = r.choices?.[0]?.message?.content?.trim() || "";
          const nextMatch = text.match(/NEXT_PROMPT:\s*([\s\S]*?)(?=END_FRAME:|$)/i);
          const endMatch = text.match(/END_FRAME:\s*([\s\S]*?)$/i);
          resolve({
            nextPrompt: nextMatch ? nextMatch[1].trim() : text,
            endFrameDesc: endMatch ? endMatch[1].trim() : "",
          });
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function enhanceVideoPrompt(simplePrompt) {
  // Use the Gemini proxy to enhance the prompt
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "gemini-3.1-flash-lite-preview",
      messages: [
        { role: "system", content: LTX_ENHANCE_SYSTEM },
        { role: "user", content: simplePrompt },
      ],
      max_tokens: 500,
      temperature: 0.7,
    });
    const req = http.request({
      hostname: "localhost", port: 9340, path: "/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          const enhanced = r.choices?.[0]?.message?.content?.trim();
          if (enhanced) resolve(enhanced);
          else reject(new Error("No enhanced prompt returned"));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

// Strip exec/python/path/command artifacts from any string
const stripCommands = bu.stripCommands;

async function rewriteTitle(originalTitle) {
  originalTitle = stripCommands(originalTitle) || "Untitled";
  const MODELS = ["gemini-3.1-flash-lite-preview"];
  const SYSTEM = "You are a creative title writer. Given a description of art, write ONE short cryptic title (under 10 words). Mysterious, philosophical, poetic. Output ONLY the title text — no code, no commands, no file paths, no python, no exec, no explanations. Just the title.";

  for (const model of MODELS) {
    try {
      const result = await new Promise((resolve, reject) => {
        const body = JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: `Write a cryptic art title inspired by: ${originalTitle}` },
          ],
          max_tokens: 150,
          temperature: 0.9,
        });
        const req = http.request({
          hostname: "localhost", port: 9340, path: "/v1/chat/completions", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, res => {
          let d = ""; res.on("data", c => d += c);
          res.on("end", () => {
            try {
              const r = JSON.parse(d);
              if (r.error) return reject(new Error(`${r.error.code}: ${r.error.message?.slice(0, 60)}`));
              let rewritten = r.choices?.[0]?.message?.content?.trim();
              if (!rewritten) return reject(new Error("empty response"));
              // Strip any commands/paths that leaked into the response
              rewritten = stripCommands(rewritten);
              // Take last non-empty line (the actual title, not any preamble)
              const lines = rewritten.split("\n").map(l => l.trim()).filter(Boolean);
              rewritten = lines[lines.length - 1] || rewritten;
              rewritten = rewritten.replace(/^["']|["']$/g, "").slice(0, 80);
              if (rewritten && rewritten.length > 2) resolve(rewritten);
              else reject(new Error("empty after cleanup"));
            } catch (e) { reject(e); }
          });
        });
        req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", reject);
        req.end(body);
      });
      console.log(`[title] "${originalTitle.slice(0, 30)}" → "${result}" (${model})`);
      return result;
    } catch (e) {
      console.warn(`[title] ${model} failed: ${e.message} — trying next`);
    }
  }
  console.warn(`[title] all models failed, using original: "${originalTitle}"`);
  return originalTitle;
}

async function rewriteQuote(prompt) {
  prompt = stripCommands(prompt) || "Untitled";
  const MODELS = ["gemini-3.1-flash-lite-preview"];
  const SYSTEM = "You are a poetic AI artist. Given an image description, write a short evocative quote (1-2 sentences) that captures the mood or story behind the art. Dreamy, introspective, sometimes playful. Output ONLY the quote text — no code, no commands, no file paths, no python, no exec. Just the poetic quote. No quotation marks. No attribution.";

  for (const model of MODELS) {
    try {
      const result = await new Promise((resolve, reject) => {
        const body = JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: `Write a poetic quote inspired by this art: ${prompt}` },
          ],
          max_tokens: 200,
          temperature: 1.0,
        });
        const req = http.request({
          hostname: "localhost", port: 9340, path: "/v1/chat/completions", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, res => {
          let d = ""; res.on("data", c => d += c);
          res.on("end", () => {
            try {
              const r = JSON.parse(d);
              if (r.error) return reject(new Error(`${r.error.code}: ${r.error.message?.slice(0, 60)}`));
              let text = r.choices?.[0]?.message?.content?.trim();
              if (!text) return reject(new Error("empty response"));
              // Strip any commands/paths that leaked into the response
              text = stripCommands(text);
              // Take last meaningful line(s) — skip any command preamble
              const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
              text = lines[lines.length - 1] || text;
              text = text.replace(/^["']|["']$/g, "").slice(0, 150);
              if (text && text.length > 5) resolve(text);
              else reject(new Error("empty after cleanup"));
            } catch (e) { reject(e); }
          });
        });
        req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", reject);
        req.end(body);
      });
      console.log(`[quote] "${prompt.slice(0, 30)}" → "${result}" (${model})`);
      return result;
    } catch (e) {
      console.warn(`[quote] ${model} failed: ${e.message}`);
    }
  }
  return "";
}

function musicButtons(msgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_suno_video_${msgId}`).setLabel("🎬 Make Video").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`btn_post_music_${msgId}`).setLabel("📱 Post to IG").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`btn_save_${msgId}`).setLabel("💾 Save to Drive").setStyle(ButtonStyle.Secondary),
  );
}

function mp4Buttons(ctxKey) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_postigimg_${ctxKey}`).setLabel("📷 IG Post").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`btn_postigreel_${ctxKey}`).setLabel("🎬 IG Reel").setStyle(ButtonStyle.Primary),
  );
}

function gifButtons(msgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_loopgif_${msgId}`).setLabel("🔁 Perfect Loop").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`btn_giftomp4_${msgId}`).setLabel("🎥 Make MP4").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`btn_postigimg_${msgId}`).setLabel("📷 IG Post").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`btn_postigreel_${msgId}`).setLabel("🎬 IG Reel").setStyle(ButtonStyle.Secondary),
  );
}

function extractUserGifUrl(msg) {
  // GIF file attachment
  for (const att of msg.attachments.values()) {
    if (att.contentType === "image/gif" || /\.gif$/i.test(att.name || ""))
      return att.url;
  }
  // Discord GIF picker — sends a "gifv" embed with video.url = .mp4 and thumbnail = still
  // The embed.url is the tenor/giphy page link; use video.url for the actual media
  for (const embed of (msg.embeds || [])) {
    if (embed.type === "gifv") {
      // Prefer the actual GIF/video URL; tenor video.url is the c.tenor.com mp4
      const url = embed.video?.url || embed.thumbnail?.url || embed.url || "";
      if (url) { console.log(`[gif-buttons] gifv embed: ${url}`); return url; }
    }
  }
  // Rich/image embed with a Discord CDN URL
  for (const embed of (msg.embeds || [])) {
    const url = embed.thumbnail?.url || embed.image?.url || embed.url || "";
    if (/discordapp\.(net|com)/i.test(url)) return url;
  }
  // Tenor or giphy embed link
  for (const embed of (msg.embeds || [])) {
    if (embed.url && /tenor\.com|giphy\.com/i.test(embed.url)) return embed.url;
  }
  // Discord GIF picker sends tenor URL as plain message content (embeds arrive late)
  const tenorMatch = (msg.content || "").match(/https?:\/\/tenor\.com\/view\/\S+/i);
  if (tenorMatch) return tenorMatch[0];
  // Giphy direct .gif URL in message text
  const giphyMatch = (msg.content || "").match(
    /https?:\/\/(?:media\.giphy\.com|giphy\.com)\/\S+\.gif\S*/i);
  if (giphyMatch) return giphyMatch[0];
  return null;
}

if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const TOKEN      = process.env.DISCORD_BOT_TOKEN;
const API_KEY    = process.env.NVIDIA_API_KEY;
const SANDBOX    = process.env.SANDBOX_NAME    || "my-assistant";
const BLOCKED_USERS = new Set((process.env.DISCORD_BLOCKED_USERS || "").split(",").filter(Boolean));
// Supports multiple guild:channel pairs, comma-separated
// e.g. DISCORD_CHANNELS="guildA:chanA,guildB:chanB,guildC:chanC:mention"
const ALLOWED_CHANNELS = (process.env.DISCORD_CHANNELS || "")
  .split(",").filter(Boolean).map((s) => {
    const parts = s.trim().split(":");
    const entry = { guildId: parts[0], channelId: parts[1] };
    if (parts[2] === "mention") entry.mentionOnly = true;
    return entry;
  });

try { validateName(SANDBOX, "SANDBOX_NAME"); } catch (e) { console.error(e.message); process.exit(1); }

if (!TOKEN)    { console.error("DISCORD_BOT_TOKEN required"); process.exit(1); }
if (!API_KEY)  { console.error("NVIDIA_API_KEY required");    process.exit(1); }

// ── SSH helpers — ephemeral known_hosts to survive container restarts (#768) ──
function sshArgs(confPath) {
  return ["-T", "-F", confPath,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10"];
}

// ── Push input image to sandbox for img2img ──────────────────────

function pushImageToSandbox(imageBuffer) {
  return new Promise((resolve) => {
    const fs = require("fs");
    let sshConfig;
    try { sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" }); }
    catch { return resolve(false); }
    const confDir  = fs.mkdtempSync("/tmp/nemoclaw-img-push-");
    const confPath = `${confDir}/config`;
    fs.writeFileSync(confPath, sshConfig, { mode: 0o600 });
    const proc = spawn("ssh", [...sshArgs(confPath), `openshell-${SANDBOX}`,
      "base64 -d > /tmp/input_image.png"], {
      timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin.write(imageBuffer.toString("base64"));
    proc.stdin.end();
    proc.on("close", (code) => {
      try { require("fs").unlinkSync(confPath); require("fs").rmdirSync(confDir); } catch {}
      resolve(code === 0);
    });
    proc.on("error", () => {
      try { require("fs").unlinkSync(confPath); require("fs").rmdirSync(confDir); } catch {}
      resolve(false);
    });
  });
}

// ── Imagen 3 proxy for sandbox ───────────────────────────────────
// The sandbox proxy blocks generativelanguage.googleapis.com, so we proxy
// Imagen 3 requests through the host. The sandbox calls
// http://host.openshell.internal:9339/imagen3 and we forward to Google.

const IMAGEN3_PORT = 9339;
const GOOGLE_VERTEX_KEY = process.env.GOOGLE_VERTEX_KEY || "";

// Imagen proxy — routes through Vertex AI Cloud billing with OAuth2
// Sandbox calls http://host.openshell.internal:9339/imagen3
// Proxy forwards to aiplatform.googleapis.com with SA OAuth token
{
  const imagen3Server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/imagen3")) {
      res.writeHead(404); res.end("not found"); return;
    }
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      // Try OAuth first (Cloud billing), fall back to API key (AI Studio)
      const oauthToken = typeof getVertexToken === "function" ? await getVertexToken() : null;
      const authHeaders = oauthToken
        ? { "Authorization": `Bearer ${oauthToken}` }
        : { "x-goog-api-key": GOOGLE_VERTEX_KEY };
      if (!oauthToken) console.warn(`[imagen] OAuth failed, using API key fallback (AI Studio billing)`);
      else console.log(`[imagen] using OAuth (Cloud billing)`);

      const gReq = https.request({
        hostname: "aiplatform.googleapis.com",
        path: `/v1/projects/drivenemo/locations/global/publishers/google/models/imagen-4.0-fast-generate-001:predict`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...authHeaders },
      }, gRes => {
        let gBody = "";
        gRes.on("data", c => gBody += c);
        gRes.on("end", () => {
          res.writeHead(gRes.statusCode, { "Content-Type": "application/json" });
          res.end(gBody);
        });
      });
      gReq.on("error", e => {
        res.writeHead(502); res.end(JSON.stringify({ error: e.message }));
      });
      gReq.end(body);
    });
  });
  listenWithRetry(imagen3Server, IMAGEN3_PORT, "0.0.0.0", "imagen");
}

// ── Gemini Vertex AI proxy (Cloud billing, OAuth2) ───────────────
// Translates OpenAI chat/completions → Vertex AI generateContent.
// Uses service account OAuth2 Bearer token on project-scoped endpoint.
// Bills to drivenemo Cloud project ($300 credits).
// Supports streaming (SSE) and full tool calling with thought signatures.

const GEMINI_PROXY_PORT = 9340;
const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";
const _thoughtSignatureCache = new Map(); // callId → signature

// OAuth2 token for Vertex AI (separate from Drive token, uses cloud-platform scope)
let _vertexToken = { token: null, exp: 0 };
async function getVertexToken() {
  if (_vertexToken.token && Date.now() < _vertexToken.exp) return _vertexToken.token;
  try {
    const saKey = JSON.parse(fs.readFileSync(
      process.env.GDRIVE_SA_KEY || path.resolve(__dirname, "../../secrets/gdrive-service-account.json"), "utf8"));
    const crypto = require("crypto");
    const now = Math.floor(Date.now() / 1000);
    const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = b64url(Buffer.from(JSON.stringify({
      iss: saKey.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600, iat: now,
    })));
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const sig = b64url(sign.sign(saKey.private_key));
    const jwt = `${header}.${payload}.${sig}`;

    return new Promise((resolve) => {
      const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
      const req = https.request({
        hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": body.length },
      }, res => {
        let raw = ""; res.on("data", c => raw += c);
        res.on("end", () => {
          try {
            const d = JSON.parse(raw);
            if (d.access_token) {
              _vertexToken = { token: d.access_token, exp: Date.now() + 55 * 60 * 1000 };
              console.log(`[gemini-proxy] Vertex OAuth2 token refreshed (55m TTL)`);
              resolve(d.access_token);
            } else {
              console.error(`[gemini-proxy] token error: ${raw.slice(0, 200)}`);
              resolve(null);
            }
          } catch { resolve(null); }
        });
      });
      req.on("error", () => resolve(null));
      req.write(body); req.end();
    });
  } catch (e) {
    console.error(`[gemini-proxy] SA key error: ${e.message}`);
    return null;
  }
}

// ── Vertex AI Search (Agent Builder) ─────────────────────────────
// Queries the PIPEBOX Knowledge Base datastore for grounded answers.
// Uses the $1000 GenAI App Builder credits (separate from Gemini API).
const VERTEX_SEARCH_ENGINE = "pipebox-search-v3";
const VERTEX_SEARCH_PROJECT = "drivenemo";
const VERTEX_SEARCH_LOCATION = "global";

async function vertexSearch(query, pageSize = 3) {
  const token = await getVertexToken();
  if (!token) return null;
  const searchPath = `/v1/projects/${VERTEX_SEARCH_PROJECT}/locations/${VERTEX_SEARCH_LOCATION}/collections/default_collection/engines/${VERTEX_SEARCH_ENGINE}/servingConfigs/default_search:search`;
  const searchBody = JSON.stringify({
    query,
    pageSize,
    contentSearchSpec: {
      snippetSpec: { returnSnippet: true },
      summarySpec: { summaryResultCount: pageSize, includeCitations: true },
    },
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "discoveryengine.googleapis.com",
      path: searchPath,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(searchBody),
      },
    }, res => {
      let raw = ""; res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const d = JSON.parse(raw);
          if (d.error) { console.warn(`[vertex-search] error:`, d.error.message?.slice(0, 200)); resolve(null); return; }
          const snippets = (d.results || []).flatMap(r =>
            (r.document?.derivedStructData?.snippets || []).map(s => s.snippet)
          ).filter(Boolean);
          const summary = d.summary?.summaryText || null;
          if (snippets.length || summary) {
            console.log(`[vertex-search] "${query.slice(0, 40)}" → ${snippets.length} snippets, summary: ${summary ? "yes" : "no"}`);
          } else {
            console.log(`[vertex-search] "${query.slice(0, 40)}" → no results`);
          }
          resolve({ snippets, summary });
        } catch (e) { console.warn(`[vertex-search] parse error:`, e.message); resolve(null); }
      });
    });
    req.on("error", e => { console.warn(`[vertex-search] req error:`, e.message); resolve(null); });
    req.write(searchBody); req.end();
  });
}

// ── Vertex AI Context Cache ───────────────────────────────────────
// Caches the static prefix (system instruction + tools) on Vertex AI.
// Subsequent requests reference the cache ID instead of re-sending ~15K tokens.
// Cache has a 30-minute TTL, auto-recreated on expiry.

// Pre-compiled hallucination filter patterns — module-level so RegExp objects
// are constructed once at startup, not on every response.
const _HALLUCINATION_PATTERNS = [
  /local.aggregator mode/i, /sovereignty engine/i, /algorithm hacking protocol/i,
  /architect.s final command/i, /architect in.*state/i, /architect in.*mode/i,
  /maintenance mode.*build/i, /maintenance mode.*safe/i, /idling mode/i,
  /reactor into.*mode/i, /system status.*architect/i, /manually ingested/i,
  /data pipeline error/i, /trends.simulated/i, /trends.*bridge.*throwing/i,
  /channel is required.*error/i, /automated bridge is.*offline/i, /bypassing the bridge/i,
  /pipeline is set:/i, /nemoclaw orchestration/i, /production sequence/i,
  /no bridge.*no middleware/i, /100% local protocol/i, /source of truth.*trend/i,
  /the reactor is hot/i, /reactor is at \d+%/i, /the reactor is yours/i,
  /cybernetic factory/i, /cybernetic infrastructure/i, /bluegrass factory/i,
  /factory floor/i, /vision.agent driver/i, /vision.sync module/i, /vision-sync/i,
  /camera.*module/i, /camera.*sync/i, /hid.bridge.*hands/i, /sovereign protocol/i,
  /scrcpy.*ocr/i, /ocr.*vision.buffer/i, /catch you on the flip side/i,
  /skill\.md.*sets the rules/i, /scrape\.py.*multiline/i,
  /lookahead regex.*rejoin/i, /row.boundary issue/i, /80% higher retention/i,
  /telemetry analysis/i, /neural.sync.*march 2026/i, /neural.acoustic hybrid/i,
  /audio.to.latent sync/i, /staging environment/i, /ltx.*audio.*latent/i,
  /flip the switch.*stream/i,
];
const _DRAMATIC_CLOSER_RE = /reactor|factory floor|cybernetic|flip side|execution sequence|idling|maintenance mode|low.power|architect.*state|workspace is secured|infrastructure.*waiting/i;
const _INVENTED_MODULE_RE = /module|pipeline|protocol|engine|framework|bridge|sync|system/i;
const _KNOWN_REAL_RE = /agent gallery|webnovel|memory|social media|youtube|suno|pipebox|grok|zturbo|z-turbo|zimage/i;

let _contextCache = { id: null, exp: 0, hash: null }; // { id, exp, hash of content }

async function getOrCreateContextCache(systemInstruction, geminiTools, toolConfig, model) {
  // Hash the static content to detect changes
  const crypto = require("crypto");
  const hashInput = JSON.stringify({ systemInstruction, geminiTools, toolConfig });
  const hash = crypto.createHash("md5").update(hashInput).digest("hex");

  // Return existing cache if valid and content unchanged
  if (_contextCache.id && Date.now() < _contextCache.exp && _contextCache.hash === hash) {
    return _contextCache.id;
  }

  const token = await getVertexToken();
  if (!token) return null;

  const cacheBody = JSON.stringify({
    model: `publishers/google/models/${model}`,
    displayName: "mrbigpipes-system-cache",
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(geminiTools ? { tools: geminiTools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ttl: "1800s", // 30 minutes
  });

  return new Promise((resolve) => {
    const gReq = https.request({
      hostname: "aiplatform.googleapis.com",
      path: "/v1/projects/drivenemo/locations/global/cachedContents",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(cacheBody),
      },
    }, gRes => {
      let raw = ""; gRes.on("data", c => raw += c);
      gRes.on("end", () => {
        try {
          const resp = JSON.parse(raw);
          if (resp.name) {
            _contextCache = { id: resp.name, exp: Date.now() + 25 * 60 * 1000, hash }; // refresh at 25 min
            console.log(`[gemini-cache] ✅ cache created: ${resp.name} (TTL 30m, ~${Math.round(hashInput.length/4)} tokens)`);
            resolve(resp.name);
          } else {
            console.warn(`[gemini-cache] creation failed: ${raw.slice(0, 500)}`);
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    gReq.on("error", () => resolve(null));
    gReq.end(cacheBody);
  });
}

{
  const geminiProxy = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      console.log(`[gemini-proxy] ${req.method} ${req.url} (${body.length} bytes)`);

      // Log tool definitions if present (debug)
      if (req.url.includes("/chat/completions") && body.length > 0) {
        try {
          const peek = JSON.parse(body);
          if (peek.tools) console.log(`[gemini-proxy] tools: ${peek.tools.length} functions: ${peek.tools.map(t => t.function?.name || t.name).join(", ")}`);
          if (peek.tool_choice) console.log(`[gemini-proxy] tool_choice: ${JSON.stringify(peek.tool_choice)}`);
        } catch {}
      }

      if (req.url.includes("/chat/completions") && req.method === "POST") {
        try {
          const oai = JSON.parse(body);
          const model = oai.model || GEMINI_DEFAULT_MODEL;
          const wantStream = oai.stream === true;

          // Convert OpenAI messages → Gemini contents
          const contents = [];
          let systemInstruction = null;
          // Convert OpenAI messages → Gemini contents
          // Key rule: consecutive tool messages must be merged into a single
          // "user" turn with multiple functionResponse parts (Gemini requires
          // the count to match the function calls in the preceding model turn)
          let pendingToolParts = []; // accumulate tool responses
          const flushToolParts = () => {
            if (pendingToolParts.length > 0) {
              contents.push({ role: "user", parts: pendingToolParts });
              pendingToolParts = [];
            }
          };
          // Cap history to last 20 non-system messages — prevents context bloat
          // without losing recent turns. System message always preserved.
          // IMPORTANT: after trimming, walk forward until the first user turn so we
          // never start mid-sequence with a tool/assistant turn (Gemini 400 error).
          const _rawMsgs = oai.messages || [];
          const _histCap = 20;
          const _sysMsgs = _rawMsgs.filter(m => m.role === "system");
          const _nonSys = _rawMsgs.filter(m => m.role !== "system");
          let _trimmed = _nonSys.length > _histCap ? _nonSys.slice(-_histCap) : _nonSys;
          // Drop leading non-user turns to ensure sequence starts on a user turn
          const _firstUser = _trimmed.findIndex(m => m.role === "user");
          if (_firstUser > 0) _trimmed = _trimmed.slice(_firstUser);
          const _cappedMsgs = [..._sysMsgs, ..._trimmed];
          for (const msg of _cappedMsgs) {
            if (msg.role === "system") {
              flushToolParts();
              const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
              systemInstruction = { parts: [{ text }] };
            } else if (msg.role === "assistant" && msg.tool_calls) {
              flushToolParts();
              // Assistant message with tool calls → Gemini functionCall parts
              const parts = [];
              if (msg.content) parts.push({ text: msg.content });
              for (const tc of msg.tool_calls) {
                const fcPart = { functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") } };
                const sig = _thoughtSignatureCache.get(tc.id) || _thoughtSignatureCache.get(`fn:${tc.function.name}`);
                if (sig) fcPart.thoughtSignature = sig;
                parts.push(fcPart);
              }
              contents.push({ role: "model", parts });
            } else if (msg.role === "tool") {
              // Accumulate tool responses — will be flushed as one turn
              pendingToolParts.push({ functionResponse: { name: msg.name || "tool", response: { result: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) } } });
            } else {
              flushToolParts();
              const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
              contents.push({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text }] });
            }
          }
          flushToolParts(); // flush any remaining tool responses

          // Convert OpenAI tools → Gemini function declarations
          // Tools that conflict with SOUL.md custom workflows — rewritten at response time.
          const BLOCKED_TOOLS = new Set(["canvas", "browser"]);
          let geminiTools = undefined;
          let toolConfig = undefined;
          if (oai.tools && oai.tools.length > 0) {
            const functionDeclarations = oai.tools
              .filter(t => t.type === "function" && t.function && !BLOCKED_TOOLS.has(t.function.name))
              .map(t => {
                const fn = t.function;
                const decl = { name: fn.name, description: fn.description || "" };
                if (fn.parameters && Object.keys(fn.parameters).length > 0) {
                  // Deep-clean JSON Schema for Gemini (strip all unsupported fields recursively)
                  const cleanSchema = (obj) => {
                    if (!obj || typeof obj !== "object") return obj;
                    if (Array.isArray(obj)) return obj.map(cleanSchema);
                    const cleaned = {};
                    const skip = new Set(["additionalProperties", "patternProperties", "$schema", "default", "examples", "title", "$ref", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "minimum", "maximum", "pattern", "const"]);
                    for (const [k, v] of Object.entries(obj)) {
                      if (!skip.has(k)) cleaned[k] = cleanSchema(v);
                    }
                    return cleaned;
                  };
                  decl.parameters = cleanSchema(fn.parameters);
                }
                return decl;
              });
            console.log(`[gemini-proxy] filtered tools: ${functionDeclarations.length} (blocked: ${BLOCKED_TOOLS.size}): ${functionDeclarations.map(d => d.name).join(", ")}`);
            if (functionDeclarations.length > 0) {
              geminiTools = [{ functionDeclarations }];
              // Set tool_config based on OpenAI tool_choice
              if (oai.tool_choice === "required" || oai.tool_choice === "any") {
                toolConfig = { functionCallingConfig: { mode: "ANY" } };
              } else if (oai.tool_choice === "none") {
                toolConfig = { functionCallingConfig: { mode: "NONE" } };
              } else if (typeof oai.tool_choice === "object" && oai.tool_choice.function) {
                toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [oai.tool_choice.function.name] } };
              } else {
                toolConfig = { functionCallingConfig: { mode: "AUTO" } };
              }
            }
          }

          // Inject tool guidance into system instruction
          if (systemInstruction) {
            const toolHint = "\n\nCRITICAL TOOL RULES:\n" +
              "- To generate images: emit [ZTURBO: prompt=\"...\" style=\"...\"] in your response. The bridge handles it — do NOT use exec for image gen.\n" +
              "- Fallback cloud image only if ZTurbo explicitly fails: exec python3 /sandbox/.openclaw-data/workspace/skills/nvidia-image-router/scripts/generate_image.py \"<prompt>\" \"<aspect_ratio>\"\n" +
              "- To post a GIF: include [GIF: search query] in your text response. Do NOT use the message tool for GIFs.\n" +
              "- To convert a video to GIF: [MAKE_GIF] (4s from start), [MAKE_GIF:N] (4s from Ns), or [MAKE_GIF:start:duration]. Max 30s. Do NOT run ffmpeg yourself.\n" +
              "- You CAN make GIFs from videos. Never say you can't. Just output [MAKE_GIF] and the bridge does it.\n" +
              "- After you create a GIF, buttons appear automatically: '🔁 Perfect Loop' makes a seamless ping-pong loop, '📱 Post to IG' posts it as a Reel. Tell the user to click those buttons.\n" +
              "- To generate music with ACE-Step (local, fast): [ACESTEP: tags=\"genre, mood, instruments\" lyrics=\"verse 1\\nchorus\\n...\" duration=60]\n" +
              "- To generate music with Suno AI (cloud, high quality): [SUNO: prompt=\"song description\" tags=\"genre, mood\" lyrics=\"verse 1\\nchorus\\n...\" title=\"Song Title\"]\n" +
              "- For Suno: if the user provides specific lyrics, use the lyrics= param. prompt= is for a general description when you want Suno to write lyrics. tags= sets genre/style. All params are optional except prompt= or lyrics=.\n" +
              "- If the user asks for Suno specifically, use [SUNO:]. Otherwise default to [ACESTEP:] for music.\n" +
              "- The message tool is for sending text to other agents, NOT for Discord messages.\n";
            if (typeof systemInstruction === "string") {
              systemInstruction = systemInstruction + toolHint;
            } else if (systemInstruction.parts) {
              systemInstruction.parts.push({ text: toolHint });
            }
          }
          // Implicit caching: Gemini 2.5+/3.1 auto-caches repeated prefixes >2048 tokens.
          // System instruction + tools = ~15K tokens, so cache should be active.
          const geminiBody = JSON.stringify({
            contents,
            ...(systemInstruction ? { systemInstruction } : {}),
            ...(geminiTools ? { tools: geminiTools } : {}),
            ...(toolConfig ? { toolConfig } : {}),
            generationConfig: {
              ...(oai.max_tokens ? { maxOutputTokens: oai.max_tokens } : {}),
              ...(oai.temperature != null ? { temperature: oai.temperature } : {}),
              ...(oai.top_p != null ? { topP: oai.top_p } : {}),
              thinkingConfig: { thinkingBudget: 0 },
            },
          });

          // Get OAuth2 token for Cloud billing, fall back to API key
          const oauthToken = await getVertexToken();
          const authHeaders = oauthToken
            ? { "Authorization": `Bearer ${oauthToken}` }
            : { "x-goog-api-key": GOOGLE_VERTEX_KEY };
          if (!oauthToken) console.warn(`[gemini-proxy] OAuth failed, using API key fallback`);

          const gReq = https.request({
            hostname: "aiplatform.googleapis.com",
            path: `/v1/projects/drivenemo/locations/global/publishers/google/models/${model}:generateContent`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(geminiBody),
              ...authHeaders,
            },
          }, gRes => {
            const chunks = [];
            gRes.on("data", c => chunks.push(c));
            gRes.on("end", () => {
              try {
                const geminiResp = JSON.parse(Buffer.concat(chunks).toString());
                if (geminiResp.error) {
                  console.error(`[gemini-proxy] API error:`, JSON.stringify(geminiResp.error).slice(0, 300));
                  res.writeHead(geminiResp.error.code || 500, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: geminiResp.error }));
                  return;
                }
                const candidate = (geminiResp.candidates || [])[0] || {};
                const parts = (candidate.content || {}).parts || [];
                const completionId = `chatcmpl-${Date.now()}`;
                const ts = Math.floor(Date.now() / 1000);
                const cached = geminiResp.usageMetadata?.cachedContentTokenCount || 0;
                const promptTk = geminiResp.usageMetadata?.promptTokenCount || 0;
                const usage = {
                  prompt_tokens: promptTk,
                  completion_tokens: geminiResp.usageMetadata?.candidatesTokenCount || 0,
                  total_tokens: geminiResp.usageMetadata?.totalTokenCount || 0,
                  cached_tokens: cached,
                };
                if (cached > 0) {
                  console.log(`[gemini-proxy] 💰 CACHE HIT: ${cached}/${promptTk} tokens cached (${Math.round(cached/promptTk*100)}% savings)`);
                } else {
                  console.log(`[gemini-proxy] tokens: ${promptTk} prompt, ${usage.completion_tokens} output, 0 cached`);
                }

                // Check if response contains function calls
                let functionCalls = parts.filter(p => p.functionCall);
                // canvas/browser are filtered before reaching Gemini — no rewrite needed
                // Extract text — handle both {text:"..."} parts and raw strings
                const textParts = parts.filter(p => p.text != null).map(p => typeof p.text === "string" ? p.text : JSON.stringify(p.text)).join("");
                // Debug: log if parts look unusual
                if (parts.length > 0 && !textParts && functionCalls.length === 0) {
                  console.log(`[gemini-proxy] unusual parts:`, JSON.stringify(parts).slice(0, 300));
                }

                let finishReason;
                if (functionCalls.length > 0) {
                  finishReason = "tool_calls";
                } else {
                  finishReason = candidate.finishReason === "STOP" ? "stop" : (candidate.finishReason || "stop").toLowerCase();
                }

                // Build OpenAI response
                const message = { role: "assistant", content: textParts || null };
                if (functionCalls.length > 0) {
                  message.tool_calls = functionCalls.map((fc, i) => {
                    const callId = `call_${completionId}_${i}`;
                    // Cache thought signature for round-trip
                    if (fc.thoughtSignature) {
                      _thoughtSignatureCache.set(callId, fc.thoughtSignature);
                      // Also cache by function name as fallback
                      _thoughtSignatureCache.set(`fn:${fc.functionCall.name}`, fc.thoughtSignature);
                    }
                    return {
                      id: callId,
                      type: "function",
                      function: {
                        name: fc.functionCall.name,
                        arguments: JSON.stringify(fc.functionCall.args || {}),
                      },
                    };
                  });
                  console.log(`[gemini-proxy] tool_calls: ${message.tool_calls.map(t => t.function.name).join(", ")}`);
                }

                if (wantStream) {
                  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
                  const delta = { role: "assistant" };
                  if (textParts) delta.content = textParts;
                  if (message.tool_calls) delta.tool_calls = message.tool_calls;
                  res.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: ts, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
                  res.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: ts, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })}\n\n`);
                  res.write("data: [DONE]\n\n");
                  res.end();
                } else {
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ id: completionId, object: "chat.completion", created: ts, model,
                    choices: [{ index: 0, message, finish_reason: finishReason }], usage }));
                }
              } catch (e) {
                console.error(`[gemini-proxy] parse error:`, e.message);
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: { message: `Parse error: ${e.message}` } }));
              }
            });
          });
          gReq.on("error", e => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: e.message } }));
          });
          gReq.end(geminiBody);
        } catch (e) {
          console.error(`[gemini-proxy] request error:`, e.message);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      } else if (req.url.includes("/models") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: GEMINI_DEFAULT_MODEL, object: "model" }] }));
      } else {
        res.writeHead(404); res.end("not found");
      }
    });
  });
  listenWithRetry(geminiProxy, GEMINI_PROXY_PORT, "0.0.0.0", "gemini-proxy");
}

// ── Instagram Graph API direct posting (replaces Buffer.com) ─────

const IG_USER_ID    = process.env.IG_USER_ID    || "";
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_APP_ID     = process.env.FB_APP_ID     || "";
const FB_APP_SECRET = process.env.FB_APP_SECRET;

async function graphApiRequest(path, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ ...params, access_token: FB_PAGE_TOKEN }).toString();
    const req = https.request({
      hostname: "graph.facebook.com",
      path: `/v21.0${path}?${qs}`,
      method: "POST",
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve({ raw: d }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// Refresh page token if it's within 7 days of expiry
async function refreshPageTokenIfNeeded() {
  if (!FB_APP_ID || !FB_APP_SECRET || !FB_PAGE_TOKEN) return;
  try {
    const res = await new Promise((resolve, reject) => {
      const qs = new URLSearchParams({ input_token: FB_PAGE_TOKEN, access_token: `${FB_APP_ID}|${FB_APP_SECRET}` }).toString();
      https.get(`https://graph.facebook.com/v21.0/debug_token?${qs}`, res => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => resolve(JSON.parse(d)));
      }).on("error", reject);
    });
    const exp = res?.data?.expires_at;
    if (exp && exp > 0) {
      const daysLeft = (exp - Date.now() / 1000) / 86400;
      if (daysLeft < 7) console.warn(`[ig] Page token expires in ${daysLeft.toFixed(1)} days — refresh soon`);
    }
  } catch (e) {
    console.warn("[ig] token check failed:", e.message);
  }
}

// Normalize media to Instagram-safe aspect ratios using ffmpeg.
// Images: padded to 1:1 square (1080x1080) — safe for all IG feed posts.
// Videos: padded to 9:16 (1080x1920) — required for Reels.
async function normalizeForInstagram(fileBuffer, mimeType) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    console.warn("[ig-norm] ffmpeg not found, skipping normalization");
    return fileBuffer;
  }
  const isVideo = mimeType?.startsWith("video/");
  const tmpIn   = `/tmp/ig-norm-in-${Date.now()}.${isVideo ? "mp4" : "jpg"}`;
  const tmpOut  = `/tmp/ig-norm-out-${Date.now()}.${isVideo ? "mp4" : "jpg"}`;
  try {
    fs.writeFileSync(tmpIn, fileBuffer);
    if (isVideo) {
      // Pad to 9:16 (1080x1920) with black bars — required for Reels
      execFileSync(ffmpeg, [
        "-y", "-i", tmpIn,
        "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
        "-c:v", "libx264", "-crf", "23", "-preset", "fast",
        "-c:a", "aac", "-b:a", "128k",
        tmpOut
      ], { timeout: 120000 });
    } else {
      // Pad to 1:1 square (1080x1080) with black bars — safe for all IG posts
      execFileSync(ffmpeg, [
        "-y", "-i", tmpIn,
        "-vf", "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black",
        tmpOut
      ], { timeout: 30000 });
    }
    const result = fs.readFileSync(tmpOut);
    console.log(`[ig-norm] normalized ${isVideo ? "video" : "image"}: ${fileBuffer.length} → ${result.length} bytes`);
    return result;
  } catch (e) {
    console.warn(`[ig-norm] normalization failed: ${e.message} — using original`);
    return fileBuffer;
  } finally {
    try { fs.unlinkSync(tmpIn);  } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// Upload media to a public host and return a direct URL for Buffer.
// Images → Imgur. Videos → litterbox.catbox.moe (free, up to 1GB, 72h TTL).
async function getPublicMediaUrl(fileBuffer, mimeType) {
  const isVideo = mimeType?.startsWith("video/");

  if (isVideo) {
    // Catbox Litterbox — free anonymous video hosting, 72h TTL
    const boundary = `CatboxBoundary${Date.now()}`;
    const ext      = mimeType === "video/mp4" ? "mp4" : "mp4";
    const head     = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="upload.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const mid      = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n72h\r\n--${boundary}--\r\n`);
    const body     = Buffer.concat([head, fileBuffer, mid]);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "litterbox.catbox.moe", path: "/resources/internals/api.php", method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
      }, res => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => {
          const url = d.trim();
          if (!url.startsWith("https://")) return reject(new Error(`Catbox error: ${url.slice(0, 100)}`));
          console.log(`[buffer] video hosted at: ${url}`);
          resolve(url);
        });
      });
      req.on("error", reject); req.write(body); req.end();
    });
  }

  // Images → Imgur anonymous upload
  const base64 = fileBuffer.toString("base64");
  const body   = `image=${encodeURIComponent(base64)}&type=base64`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.imgur.com", path: "/3/image", method: "POST",
      headers: { "Authorization": "Client-ID 546c25a59c58ad7", "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (!j.success) throw new Error(j.data?.error || "Imgur upload failed");
          console.log(`[buffer] image hosted at: ${j.data.link}`);
          resolve(j.data.link);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

// Post to Instagram via Facebook Graph API
async function postToBuffer({ text, mediaBuffer, mimeType, channels = ["instagram"] }) {
  if (!FB_PAGE_TOKEN) throw new Error("FB_PAGE_TOKEN not set");

  const isVideo = mimeType?.startsWith("video/");

  // Upload media to Google Drive and get public URL
  let mediaUrl = null;
  if (mediaBuffer) {
    try {
      console.log(`[ig] uploading ${isVideo ? "video" : "image"} to Google Drive...`);
      const fileName = `ig-${Date.now()}.${isVideo ? "mp4" : "png"}`;
      const tmpPath = `/tmp/${fileName}`;
      fs.writeFileSync(tmpPath, mediaBuffer);
      const folderId = MEDIA_FOLDER_ID;
      const driveResult = await gdrive.uploadToDrive(tmpPath, mimeType || "image/png", fileName, folderId);
      try { fs.unlinkSync(tmpPath); } catch {}
      const fileId = driveResult.id;

      // Make file publicly readable so Instagram can fetch it
      const token = await gdrive._getDriveToken();
      const permBody = JSON.stringify({ role: "reader", type: "anyone" });
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "www.googleapis.com",
          path: `/drive/v3/files/${fileId}/permissions`,
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(permBody) },
        }, res => {
          let d = ""; res.on("data", c => d += c);
          res.on("end", () => resolve(d));
        });
        req.on("error", reject);
        req.write(permBody);
        req.end();
      });

      // Images: lh3 CDN serves directly. Videos: GDrive uc URL fails for large files
      // (virus scan interstitial), so use Catbox for a direct .mp4 URL Instagram can fetch
      if (isVideo) {
        try {
          const catboxUrl = await getPublicMediaUrl(mediaBuffer, "video/mp4");
          mediaUrl = catboxUrl;
          console.log(`[ig] using Catbox for video: ${mediaUrl}`);
        } catch (catErr) {
          console.warn(`[ig] Catbox failed, falling back to GDrive:`, catErr.message);
          mediaUrl = `https://drive.google.com/uc?export=download&confirm=1&id=${fileId}`;
        }
      } else {
        mediaUrl = `https://lh3.googleusercontent.com/d/${fileId}`;
      }
      console.log(`[ig] Drive public URL: ${mediaUrl}`);
    } catch (e) {
      console.warn(`[ig] Drive hosting failed:`, e.message);
    }
  }

  const results = [];

  if (channels.includes("instagram")) {
    try {
      // Step 1: Create media container
      const containerParams = {
        caption: text || "",
        ...(isVideo ? { media_type: "REELS", video_url: mediaUrl, share_to_feed: "true" } : { image_url: mediaUrl }),
      };
      console.log(`[ig] creating ${isVideo ? "reel" : "image"} container...`);
      const container = await graphApiRequest(`/${IG_USER_ID}/media`, containerParams);
      if (container.error) throw new Error(container.error.message);
      const creationId = container.id;
      console.log(`[ig] container id: ${creationId}`);

      // Poll until container is ready (images AND videos need this with Drive URLs)
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, isVideo ? 5000 : 3000));
        const status = await new Promise((resolve, reject) => {
          const qs = new URLSearchParams({ fields: "status_code", access_token: FB_PAGE_TOKEN }).toString();
          https.get(`https://graph.facebook.com/v21.0/${creationId}?${qs}`, res => {
            let d = ""; res.on("data", c => d += c);
            res.on("end", () => resolve(JSON.parse(d)));
          }).on("error", reject);
        });
        console.log(`[ig] container status: ${status.status_code}`);
        if (status.status_code === "FINISHED") break;
        if (status.status_code === "ERROR") throw new Error("Instagram container processing failed");
      }

      // Step 2: Publish
      console.log(`[ig] publishing...`);
      const publish = await graphApiRequest(`/${IG_USER_ID}/media_publish`, { creation_id: creationId });
      if (publish.error) throw new Error(publish.error.message);
      console.log(`[ig] published: ${publish.id}`);
      results.push({ channelId: "instagram", postId: publish.id, status: "published" });
    } catch (e) {
      console.error(`[ig] failed:`, e.message);
      results.push({ channelId: "instagram", error: e.message });
    }
  }

  return results;
}

// ── ACE-Step music generation via local ComfyUI ───────────────────

const ACEMUSIC_WORKFLOW = path.join(os.homedir(), "nemoclaw-persist", "acemusic-workflow.json");

async function generateMusicWithAceStep(tags, lyrics, durationSec = 60) {
  await freeComfyMemory(); // unload LTX (or anything else) before loading ACE-Step
  const workflow = JSON.parse(fs.readFileSync(ACEMUSIC_WORKFLOW, "utf-8"));
  workflow["4"].inputs.caption  = tags;
  workflow["3"].inputs.lyrics   = lyrics;
  workflow["2"].inputs.duration = durationSec;
  workflow["2"].inputs.seed     = Math.floor(Math.random() * 2147483647);
  workflow["2"].inputs.vocal_language = "en";
  // If no lyrics provided, force instrumental so empty lyrics don't cause gibberish vocals
  workflow["2"].inputs.instrumental = !lyrics.trim();

  console.log(`[music] submitting to ComfyUI: "${tags.slice(0, 60)}" ${durationSec}s`);
  console.log(`[music] lyrics preview: ${lyrics.slice(0, 120).replace(/\n/g, "↵") || "(empty — will be instrumental)"}`);
  if (!lyrics.trim()) console.warn("[music] WARNING: no lyrics provided, model will generate instrumental");
  const promptId = await submitComfyWorkflow(workflow);
  console.log(`[music] prompt_id: ${promptId}`);
  const fileInfo = await waitForComfyAudio(promptId);
  console.log(`[music] done: ${fileInfo.filename}`);
  return await downloadComfyFile(fileInfo);
}

async function waitForComfyAudio(promptId, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    const res   = await comfyRequest("GET", `/history/${promptId}`);
    const hist  = JSON.parse(res.body.toString());
    const entry = hist[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") throw new Error("ComfyUI music render error");
    if (entry.status?.completed) {
      // Prefer output-type audio (SaveAudioMP3) over temp-type (PreviewAudio)
      let found = null;
      for (const out of Object.values(entry.outputs || {})) {
        const files = out.audio || [];
        for (const f of files) {
          if (f.type === "output") return f;           // SaveAudioMP3 — ideal
          if (!found)             found = f;           // temp fallback
        }
      }
      if (found) return found;
    }
  }
  throw new Error("ComfyUI music: timed out after 5 minutes");
}


// ── ComfyUI video generation (LTX 2.3) ───────────────────────────

const COMFY_AV_WORKFLOW    = path.join(os.homedir(), "nemoclaw-persist", "ltx23-av-workflow.json"); // I2V (legacy, unused)
const COMFY_I2V_WORKFLOW   = path.join(os.homedir(), "nemoclaw-persist", "ltx23-i2v-workflow.json"); // I2V dedicated (combi 1.1)
const COMFY_T2V_WORKFLOW   = path.join(os.homedir(), "nemoclaw-persist", "ltx23-t2v-workflow.json"); // T2V dedicated
const COMFY_COMBI_WORKFLOW = path.join(os.homedir(), "nemoclaw-persist", "ltx23-combi-workflow.json"); // First+Last frame

// comfyQueueAvailable: true if the queue proxy on localhost:5002 is up.
// Checked once at startup, then cached. Falls back to direct ComfyUI if proxy is down.
let _comfyQueueAvailable = null;
async function checkComfyQueue() {
  if (_comfyQueueAvailable !== null) return _comfyQueueAvailable;
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: "localhost", port: 5002, path: "/health", timeout: 2000 }, res => {
        let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d));
      });
      req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
    const health = JSON.parse(r);
    _comfyQueueAvailable = health.redis === "ok";
    if (_comfyQueueAvailable) console.log("[comfy] Queue proxy available on localhost:5002 — using job queue");
    else console.log("[comfy] Queue proxy unhealthy — falling back to direct ComfyUI");
  } catch {
    _comfyQueueAvailable = false;
    console.log("[comfy] Queue proxy not running — using direct ComfyUI");
  }
  return _comfyQueueAvailable;
}

function getComfyHost() {
  // If queue proxy is confirmed available, use it; otherwise direct.
  // _comfyQueueAvailable is set async — before it resolves we use direct (safe fallback).
  if (_comfyQueueAvailable === true) return "localhost";
  if (process.env.COMFYUI_HOST) return process.env.COMFYUI_HOST;
  try {
    const m = fs.readFileSync("/etc/resolv.conf", "utf-8").match(/^nameserver\s+(\S+)/m);
    return m ? m[1] : "172.20.224.1";
  } catch { return "172.20.224.1"; }
}

function getComfyPort() {
  // Queue proxy is on 5002; direct ComfyUI is on 8188
  return _comfyQueueAvailable === true ? 5002 : 8188;
}

async function freeComfyMemory() {
  try {
    await comfyRequest("POST", "/free", JSON.stringify({ unload_models: true, free_memory: true }));
    console.log("[comfy] VRAM freed");
  } catch (e) {
    console.warn("[comfy] free failed (non-fatal):", e.message);
  }
}

function comfyRequest(method, urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
    const opts = {
      hostname: getComfyHost(), port: getComfyPort(), path: urlPath, method,
      headers: {},
    };
    if (data) {
      opts.headers["Content-Type"]   = contentType || "application/json";
      opts.headers["Content-Length"] = data.length;
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function uploadImageToComfyUI(imageBuffer, filename = "input.jpg") {
  const boundary = `----Boundary${Date.now().toString(16)}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, imageBuffer, footer]);
  const res = await comfyRequest("POST", "/upload/image", body, `multipart/form-data; boundary=${boundary}`);
  const result = JSON.parse(res.body.toString());
  if (!result.name) throw new Error(`ComfyUI upload failed: ${res.body.toString().slice(0, 200)}`);
  return result.name;
}

async function submitComfyWorkflow(workflow) {
  const payload = JSON.stringify({ prompt: workflow, client_id: "nemoclaw-bridge" });
  const res = await comfyRequest("POST", "/prompt", payload);
  const result = JSON.parse(res.body.toString());
  if (!result.prompt_id) throw new Error(`ComfyUI submit failed: ${res.body.toString().slice(0, 300)}`);
  return result.prompt_id;
}

async function waitForComfyResult(promptId, timeoutMs = 900000) { // 15 min default
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await comfyRequest("GET", `/history/${promptId}`);
    const hist = JSON.parse(res.body.toString());
    const entry = hist[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") throw new Error(`ComfyUI render error`);
    if (entry.status?.completed) {
      let videoFile = null;
      let lastFrameFile = null;
      for (const [nodeId, out] of Object.entries(entry.outputs || {})) {
        const videos = out.gifs || out.videos || [];
        if (videos.length > 0 && !videoFile) videoFile = videos[0];
        // Node 210 "Save Last Frame Image" outputs images
        const images = out.images || [];
        if (images.length > 0) lastFrameFile = images[images.length - 1];
      }
      if (videoFile) {
        videoFile._lastFrame = lastFrameFile; // attach last frame info if available
        return videoFile;
      }
    }
  }
  throw new Error("ComfyUI: timed out after 15 minutes");
}

async function downloadComfyFile(fileInfo) {
  const { filename, subfolder = "", type = "output" } = fileInfo;
  const qs = new URLSearchParams({ filename, subfolder, type });
  const res = await comfyRequest("GET", `/view?${qs}`);
  if (res.status !== 200) throw new Error(`ComfyUI download failed: HTTP ${res.status}`);
  return res.body;
}

// ── ZImage Turbo (local ComfyUI image gen) ───────────────────────────────────

const ZTURBO_WORKFLOW_PATH = process.env.ZTURBO_WORKFLOW_PATH || "";

const ZTURBO_STYLES = {
  "none":              null,
  "80s-dark-fantasy":  "80s dark fantasy photo, dramatic cinematic lighting, gothic atmosphere, rich contrast",
  "synthwave":         "synthwave photo, neon grid horizon, retrowave aesthetic, purple and cyan palette",
  "witchcore":         "witchcore photo, mystical dark feminine aesthetic, candles, botanicals, occult mood",
  "light-painting":    "light painting long exposure photography, glowing light trails on dark background",
  "kawaii-pop":        "kawaii pop photo, bright pastel colors, cheerful playful Japanese aesthetic, confetti",
  "spotlight-stage":   "spotlight stage photo, dramatic theatrical single light beam, performer silhouette",
  "post-processed":    "post-processed digital artistry, heavy stylized editing, surreal composite",
  "low-poly":          "low-poly 3D render, geometric faceted angular style, clean vertices",
  "ink-draw":          "detailed ink drawing, fine pen and ink linework, crosshatching, black and white",
  "shadow-fantasy":    "shadow fantasy illustration, dramatic silhouette art, high contrast, ethereal",
  "gothic-engraving":  "gothic engraving style, woodcut print, intricate fine lines, aged paper",
  "folk-art-mosaic":   "folk art mosaic, decorative colorful tile pattern, handcrafted texture",
  "paper-cut":         "paper-cut diorama, layered paper craft art, depth shadows, delicate",
  "risograph":         "risograph print, limited two-color offset printing aesthetic, grain texture",
  "ukiyo-e":           "modern ukiyo-e woodblock print style, Japanese waves, bold outlines, flat color",
  "vintage-polaroid":  "vintage polaroid photo, faded warm tones, light leak, retro analog film",
  "glass-advertising": "glass encased vintage advertising illustration, art nouveau poster style",
  "vintage-vga":       "vintage VGA monitor CRT display aesthetic, scanlines, phosphor glow, 90s computer",
};

async function waitForComfyImage(promptId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await comfyRequest("GET", `/history/${promptId}`);
    const hist = JSON.parse(res.body.toString());
    const entry = hist[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") throw new Error("ZTurbo render error");
    if (entry.status?.completed) {
      for (const [, out] of Object.entries(entry.outputs || {})) {
        const images = out.images || [];
        if (images.length > 0) return images[0];
      }
    }
  }
  throw new Error("ZTurbo: timed out after 2 minutes");
}

async function generateImageWithZTurbo(prompt, seed, style = "none") {
  await freeComfyMemory();
  const workflow = JSON.parse(fs.readFileSync(ZTURBO_WORKFLOW_PATH, "utf-8"));
  const styleSuffix = ZTURBO_STYLES[style] || null;
  const finalPrompt = styleSuffix ? `${prompt}, ${styleSuffix}` : prompt;
  // Update date in SaveImage prefix so files sort correctly
  const today = new Date();
  const dateStr = `${today.getFullYear()}_${String(today.getMonth()+1).padStart(2,"0")}_${String(today.getDate()).padStart(2,"0")}`;
  workflow["9"].inputs.filename_prefix = `ZImage/${dateStr}/ZI`;
  // Override CLIPTextEncode directly — bypasses style-selector node chain
  workflow["6"].inputs.text = finalPrompt;
  workflow["307"].inputs.value = seed;
  console.log(`[zturbo] "${finalPrompt.slice(0, 80)}" seed:${seed} style:${style}`);
  const promptId = await submitComfyWorkflow(workflow);
  console.log(`[zturbo] submitted: ${promptId}`);
  const fileInfo = await waitForComfyImage(promptId, 120000);
  console.log(`[zturbo] done: ${fileInfo.filename}`);
  bumpCounter("images");
  return await downloadComfyFile(fileInfo);
}

// ── CapCut API composition (primary) ─────────────────────────────────────────
const CAPCUT_API_BASE = "http://localhost:30000/openapi/capcut-mate/v1";
const CAPCUT_DRAFT_FOLDER = process.env.CAPCUT_DRAFT_FOLDER || "";
const CAPCUT_EXPORT_FOLDER = process.env.CAPCUT_EXPORT_FOLDER || "";

const CAPCUT_TRANSITIONS = {
  cinematic: "Dissolve",
  vibrant:   "RGB_Glitch",
  moody:     "Black_Fade",
  vintage:   "Vintage_Screening",
  clean:     "Dissolve_1",
  warm:      "Burn",
  cool:      "Horizontal_Blur",
  dreamy:    "Blur",
  dark:      "Black_smoke",
  bright:    "White_Flash",
};

async function capCutApiPost(endpoint, body) {
  const res = await fetch(`${CAPCUT_API_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`CapCut API ${endpoint}: ${json.message || "unknown error"}`);
  return json;
}

async function composeVideoWithCapCutAPI({ videoPaths = [], style = "cinematic", textOverlay = null, musicPath = null }) {
  // CapCut API creates drafts but can't render without paid API key.
  // Use the video-editor FFmpeg pipeline for actual rendering.
  const { editVideo } = require("./lib/video-editor");
  const videos = videoPaths.map(p => fs.readFileSync(p));
  let audioBuffer = null;
  if (musicPath) { try { audioBuffer = fs.readFileSync(musicPath); } catch {} }
  const { videoBuffer } = await editVideo({
    images: [], videos, audioBuffer,
    preset: "short", style,
    caption: textOverlay,
  });
  return videoBuffer;
}

// ── Candy's Video Composition Engine (FFmpeg fallback) ────────────────────────
// Fully local, no external accounts. Concat + transitions + color + text + music.

const FFMPEG_BIN = (() => {
  const candidates = [
    "/home/nemoclaw/.local/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return "ffmpeg";
})();

const FFPROBE_BIN = FFMPEG_BIN.replace(/ffmpeg$/, "ffprobe");

const STYLE_FFMPEG_FILTERS = {
  cinematic: "curves=vintage,colorbalance=rs=-0.05:gs=0:bs=0.05:rm=0:gm=0:bm=0:rh=0.05:gh=0:bh=-0.05,eq=contrast=1.1:brightness=-0.02:saturation=0.85",
  vibrant:   "eq=contrast=1.05:brightness=0.02:saturation=1.4,hue=s=1.2",
  moody:     "curves=darker,colorbalance=rs=-0.1:gs=-0.05:bs=0.1,eq=contrast=1.2:saturation=0.7",
  vintage:   "curves=vintage,hue=h=10:s=0.8,vignette=PI/4",
  clean:     "eq=contrast=1.02:brightness=0.01:saturation=1.05,unsharp=3:3:0.5",
  warm:      "colorbalance=rs=0.1:gs=0.05:bs=-0.1:rm=0.05:gm=0:bm=-0.05,eq=saturation=1.1",
  cool:      "colorbalance=rs=-0.1:gs=0:bs=0.15,eq=saturation=0.95",
  dreamy:    "gblur=sigma=0.8,eq=contrast=0.95:brightness=0.03:saturation=1.1,curves=lighter",
  dark:      "curves=darker,eq=contrast=1.3:brightness=-0.05:saturation=0.8",
  bright:    "eq=contrast=1.0:brightness=0.06:saturation=1.15,curves=lighter",
};

async function composeVideoWithFFmpeg({ videoPaths = [], style = "cinematic", textOverlay = null, musicPath = null, width = 1080, height = 1920 }) {
  const { execSync } = require("child_process");
  const ts = Date.now();
  const tmpDir = `/tmp/candy-compose-${ts}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const colorFilter = STYLE_FFMPEG_FILTERS[style] || STYLE_FFMPEG_FILTERS.cinematic;

    // Normalize each clip: scale to target res, apply color grade, strip audio
    const normalizedPaths = [];
    for (let i = 0; i < videoPaths.length; i++) {
      const out = `${tmpDir}/norm_${i}.mp4`;
      const scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,${colorFilter}`;
      execSync(`"${FFMPEG_BIN}" -y -i "${videoPaths[i]}" -vf "${scaleFilter}" -c:v libx264 -preset fast -crf 18 -an "${out}"`, { timeout: 120000 });
      normalizedPaths.push(out);
      console.log(`[candy-compose] normalized clip ${i + 1}/${videoPaths.length}`);
    }

    let composedPath;
    if (normalizedPaths.length === 1) {
      composedPath = normalizedPaths[0];
    } else {
      // Concat with xfade dissolve transitions
      composedPath = `${tmpDir}/composed.mp4`;
      const fadeDur = 0.5;
      const durations = normalizedPaths.map(p => {
        try {
          const out = execSync(`"${FFMPEG_BIN}" -i "${p}" 2>&1 || true`, { encoding: "utf-8", timeout: 10000 });
          const dm = out.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
          if (dm) return parseInt(dm[1]) * 3600 + parseInt(dm[2]) * 60 + parseInt(dm[3]) + parseInt(dm[4]) / 100;
          return 6;
        } catch { return 6; }
      });
      const inputs = normalizedPaths.map(p => `-i "${p}"`).join(" ");
      let filterComplex = "";
      let prevLabel = "[0:v]";
      let offset = durations[0] - fadeDur;
      for (let i = 1; i < normalizedPaths.length; i++) {
        const nextLabel = i < normalizedPaths.length - 1 ? `[v${i}]` : "[vout]";
        filterComplex += `${prevLabel}[${i}:v]xfade=transition=dissolve:duration=${fadeDur}:offset=${offset.toFixed(3)}${nextLabel};`;
        prevLabel = nextLabel;
        offset += durations[i] - fadeDur;
      }
      execSync(`"${FFMPEG_BIN}" -y ${inputs} -filter_complex "${filterComplex.replace(/;$/, "")}" -map "[vout]" -c:v libx264 -preset fast -crf 18 "${composedPath}"`, { timeout: 300000 });
      console.log(`[candy-compose] ${normalizedPaths.length} clips xfade-composed`);
    }

    // Add text overlay (bottom 15%, first 4s)
    let withTextPath = composedPath;
    if (textOverlay) {
      withTextPath = `${tmpDir}/withtext.mp4`;
      const safeText = textOverlay.replace(/[':]/g, " ").slice(0, 100);
      const textFilter = `drawtext=text='${safeText}':fontsize=52:fontcolor=white:borderw=3:bordercolor=black@0.8:x=(w-text_w)/2:y=h*0.85:enable='between(t,0,4)'`;
      execSync(`"${FFMPEG_BIN}" -y -i "${composedPath}" -vf "${textFilter}" -c:v libx264 -preset fast -crf 18 -an "${withTextPath}"`, { timeout: 120000 });
      console.log(`[candy-compose] text overlay added`);
    }

    // Mix in music at 35% volume if provided
    const outputPath = `${tmpDir}/final.mp4`;
    if (musicPath && fs.existsSync(musicPath)) {
      execSync(`"${FFMPEG_BIN}" -y -i "${withTextPath}" -i "${musicPath}" -filter_complex "[1:a]volume=0.35,apad[music]" -map 0:v -map "[music]" -shortest -c:v copy -c:a aac "${outputPath}"`, { timeout: 120000 });
      console.log(`[candy-compose] music mixed`);
    } else {
      fs.copyFileSync(withTextPath, outputPath);
    }

    const result = fs.readFileSync(outputPath);
    console.log(`[candy-compose] done — ${(result.length / 1024 / 1024).toFixed(1)}MB`);
    return result;
  } finally {
    try { require("child_process").execSync(`rm -rf "${tmpDir}"`); } catch {}
  }
}

async function generateVideoWithComfyUI(prompt, imageBuffer = null, durationSec = 10) {
  await freeComfyMemory();
  const seed = Math.floor(Math.random() * 2147483647);
  const dur = Math.max(2, Math.min(30, durationSec || 10)); // clamp 2-30s

  if (imageBuffer) {
    // I2V mode — use the dedicated I2V workflow (combi 1.1)
    const workflow = JSON.parse(fs.readFileSync(COMFY_I2V_WORKFLOW, "utf-8"));
    workflow["121"].inputs.text = prompt; // CLIPTextEncode positive
    workflow["115"].inputs.noise_seed = seed;
    if (workflow["196"]) { workflow["196"].inputs.Xi = dur; workflow["196"].inputs.Xf = dur; }
    const uploadedName = await uploadImageToComfyUI(imageBuffer);
    workflow["149"].inputs.image = uploadedName; // LoadImage node
    console.log(`[video] I2V mode (combi 1.1), image: ${uploadedName}, seed: ${seed}, duration: ${dur}s`);
    const promptId = await submitComfyWorkflow(workflow);
    console.log(`[video] submitted: ${promptId}`);
    const fileInfo = await waitForComfyResult(promptId, 900000);
    console.log(`[video] done: ${fileInfo.filename}`);
    bumpCounter("videos");
    return await downloadComfyFile(fileInfo);
  } else {
    // T2V mode — use the new dedicated T2V workflow
    const workflow = JSON.parse(fs.readFileSync(COMFY_T2V_WORKFLOW, "utf-8"));
    workflow["121"].inputs.text = prompt; // CLIPTextEncode positive
    workflow["115"].inputs.noise_seed = seed;
    if (workflow["196"]) { workflow["196"].inputs.Xi = dur; workflow["196"].inputs.Xf = dur; }
    console.log(`[video] T2V mode (dedicated workflow), seed: ${seed}, duration: ${dur}s`);
    const promptId = await submitComfyWorkflow(workflow);
    console.log(`[video] submitted: ${promptId}`);
    const fileInfo = await waitForComfyResult(promptId, 900000);
    console.log(`[video] done: ${fileInfo.filename}`);
    bumpCounter("videos");
    return await downloadComfyFile(fileInfo);
  }
}

// ── Extract last frame from video using ffmpeg ───────────────────

async function extractLastFrameFromVideo(videoBuf) {
  const ts = Date.now();
  const tmpIn = `/tmp/nemoclaw-chain-in-${ts}.mp4`;
  const tmpOut = `/tmp/nemoclaw-chain-frame-${ts}.jpg`;
  fs.writeFileSync(tmpIn, videoBuf);
  try {
    const { execSync } = require("child_process");
    // Get duration via ffmpeg -i (no separate ffprobe binary)
    let duration = "5";
    try {
      const probeOut = execSync(`"${FFMPEG_BIN}" -i "${tmpIn}" 2>&1 || true`, { encoding: "utf-8", timeout: 15000 });
      const dm = probeOut.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (dm) duration = String(parseInt(dm[1]) * 3600 + parseInt(dm[2]) * 60 + parseInt(dm[3]) + parseInt(dm[4]) / 100);
    } catch (e) { console.warn(`[chain] duration probe failed: ${e.message}`); }
    const lastSec = Math.max(0, parseFloat(duration) - 0.1);
    console.log(`[chain] extracting last frame at ${lastSec}s from ${(videoBuf.length / 1024).toFixed(0)}KB video`);
    execSync(`"${FFMPEG_BIN}" -y -ss ${lastSec} -i "${tmpIn}" -frames:v 1 -q:v 2 "${tmpOut}"`, { timeout: 20000, stdio: ["pipe", "pipe", "pipe"] });
    const frameBuf = fs.readFileSync(tmpOut);
    console.log(`[chain] extracted last frame (${frameBuf.length} bytes) at ${lastSec}s`);
    return frameBuf;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ── FFmpeg video stitching ────────────────────────────────────────
// Concatenates multiple video segments into one final video.
// Segments stored per-message for the Stitch button.

const storySegments = new Map(); // msgId → [Buffer, Buffer, ...]

function findFfmpeg() {
  const { execSync } = require("child_process");
  try { execSync("which ffmpeg", { encoding: "utf-8", timeout: 3000 }); return "ffmpeg"; } catch {}
  // Return UNQUOTED paths — execFileSync handles spaces natively, shell quotes cause ENOENT
  const paths = [
    "/mnt/c/Program Files/Shotcut/ffmpeg.exe",
    "/mnt/c/Program Files/SVP 4/utils/ffmpeg.exe",
    "/mnt/c/Program Files/Krita (x64)/bin/ffmpeg.exe",
  ];
  for (const p of paths) {
    try { execSync(`"${p}" -version`, { encoding: "utf-8", timeout: 5000 }); return p; } catch {}
  }
  return null;
}

function addSegment(msgId, videoBuf) {
  if (!storySegments.has(msgId)) storySegments.set(msgId, []);
  storySegments.get(msgId).push(videoBuf);
  console.log(`[stitch] segment added for ${msgId} (total: ${storySegments.get(msgId).length})`);
}

async function stitchVideoSegments(segmentBuffers) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg not found");
  const { execSync } = require("child_process");
  const ts = Date.now();
  const tmpDir = `/tmp/nemoclaw-stitch-${ts}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Write each segment to a temp file
    const segFiles = [];
    for (let i = 0; i < segmentBuffers.length; i++) {
      const segPath = `${tmpDir}/seg_${i}.mp4`;
      fs.writeFileSync(segPath, segmentBuffers[i]);
      segFiles.push(segPath);
    }

    // Write concat list file
    const listPath = `${tmpDir}/concat.txt`;
    fs.writeFileSync(listPath, segFiles.map(f => `file '${f}'`).join("\n"));

    // Stitch with ffmpeg concat demuxer (no re-encoding)
    const outPath = `${tmpDir}/final.mp4`;
    execSync(`"${ffmpeg}" -y -f concat -safe 0 -i "${listPath}" -c copy "${outPath}"`, {
      timeout: 60000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const result = fs.readFileSync(outPath);
    console.log(`[stitch] ${segmentBuffers.length} segments → ${(result.length / 1024 / 1024).toFixed(1)}MB`);
    return result;
  } finally {
    // Cleanup temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Generate target frame image via Imagen 4 Fast (bridge-side) ──

async function generateTargetFrameWithImagen(prompt) {
  const token = typeof getVertexToken === "function" ? await getVertexToken() : null;
  const authHeaders = token
    ? { "Authorization": `Bearer ${token}` }
    : { "x-goog-api-key": GOOGLE_VERTEX_KEY };
  const payload = JSON.stringify({
    instances: [{ prompt: `A single photographic still frame: ${prompt}. Cinematic composition, sharp focus, high detail.` }],
    parameters: { sampleCount: 1, aspectRatio: "16:9", personGeneration: "allow_all" },
  });
  return new Promise((resolve, reject) => {
    const gReq = https.request({
      hostname: "aiplatform.googleapis.com",
      path: "/v1/projects/drivenemo/locations/global/publishers/google/models/imagen-4.0-fast-generate-001:predict",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...authHeaders },
    }, gRes => {
      const chunks = [];
      gRes.on("data", c => chunks.push(c));
      gRes.on("end", () => {
        try {
          const resp = JSON.parse(Buffer.concat(chunks).toString());
          const b64 = resp.predictions?.[0]?.bytesBase64Encoded;
          if (!b64) { reject(new Error(`Imagen: no image — ${JSON.stringify(resp).slice(0, 200)}`)); return; }
          console.log(`[chain-imagen] generated target frame (${b64.length} b64 chars)`);
          resolve(Buffer.from(b64, "base64"));
        } catch (e) { reject(e); }
      });
    });
    gReq.on("error", reject);
    gReq.end(payload);
  });
}

// ── Chained narrative video generation ───────────────────────────
// Takes an array of segment prompts, generates each sequentially,
// chaining by using the last frame of segment N as I2V input for N+1.

async function generateChainedVideo(segments, inputBuffers, msgReplyFn) {
  // inputBuffers: array of user-attached images [firstFrame, lastFrameForSeg1?, ...]
  const results = []; // array of { videoBuf, segmentIndex }
  let currentFirstFrame = (inputBuffers && inputBuffers[0]) || null;
  // If user provided 2 images, second is the target last frame for segment 1
  let currentLastFrame = (inputBuffers && inputBuffers[1]) || null;

  for (let i = 0; i < segments.length; i++) {
    const prompt = segments[i];
    const isLastSegment = (i === segments.length - 1);

    // Generate target last frame via Imagen 4 if we don't have one
    // (skip for segment 1 if user provided both images, skip for last segment)
    if (!currentLastFrame && !isLastSegment) {
      try {
        if (msgReplyFn) await msgReplyFn(`🎨 Generating target frame for segment ${i + 1} with **Imagen 4 Fast**...`);
        currentLastFrame = await generateTargetFrameWithImagen(segments[i + 1]);
        console.log(`[chain] Imagen target frame for segment ${i + 1} end (${currentLastFrame.length} bytes)`);
      } catch (e) {
        console.warn(`[chain] Imagen target frame failed: ${e.message}, using I2V instead`);
        currentLastFrame = null;
      }
    }

    if (msgReplyFn) await msgReplyFn(`🎬 Segment ${i + 1}/${segments.length}: *"${prompt.slice(0, 60)}"* — rendering...`);

    let videoBuf;
    if (currentFirstFrame && currentLastFrame) {
      // COMBI mode: first frame + last frame → best continuity
      console.log(`[chain] segment ${i + 1} COMBI mode (first+last frame)`);
      videoBuf = await generateCombiVideoWithComfyUI(prompt, currentFirstFrame, currentLastFrame);
    } else if (currentFirstFrame) {
      // I2V mode: only first frame available
      console.log(`[chain] segment ${i + 1} I2V mode (first frame only)`);
      videoBuf = await generateVideoWithComfyUI(prompt, currentFirstFrame);
    } else {
      // T2V mode: no images at all
      console.log(`[chain] segment ${i + 1} T2V mode`);
      videoBuf = await generateVideoWithComfyUI(prompt, null);
    }

    results.push({ videoBuf, index: i });
    console.log(`[chain] segment ${i + 1}/${segments.length} done (${videoBuf.length} bytes)`);

    // Extract last frame for next segment's first frame
    if (!isLastSegment) {
      currentFirstFrame = null;
      currentLastFrame = null;

      // Try 1: ComfyUI saved last frame (combi workflow node 210)
      // The combi workflow saves it; standard workflow doesn't
      // For now, try ffmpeg extraction which works for both
      try {
        currentFirstFrame = await extractLastFrameFromVideo(videoBuf);
        console.log(`[chain] extracted last frame for segment ${i + 2} (${currentFirstFrame.length} bytes)`);
      } catch (e) {
        console.warn(`[chain] frame extraction failed: ${e.message}, next segment will be T2V`);
        currentFirstFrame = null;
      }
    }
  }

  return results;
}

// ── ComfyUI First/Last Frame video generation (LTX 2.3 Combi) ────

async function generateCombiVideoWithComfyUI(prompt, firstImageBuffer, lastImageBuffer, durationSec = 10) {
  await freeComfyMemory();
  const workflow = JSON.parse(fs.readFileSync(COMFY_COMBI_WORKFLOW, "utf-8"));
  const seed = Math.floor(Math.random() * 2147483647);
  const dur = Math.max(2, Math.min(30, durationSec || 10));

  // Set prompt
  workflow["121"].inputs.text = prompt;
  // Set seed
  workflow["115"].inputs.noise_seed = seed;
  // Set duration
  if (workflow["196"]) { workflow["196"].inputs.Xi = dur; workflow["196"].inputs.Xf = dur; }

  // Upload first frame image
  const firstName = await uploadImageToComfyUI(firstImageBuffer, "first_frame.jpg");
  workflow["685"].inputs.image = firstName;
  console.log(`[combi-video] first frame: ${firstName}`);

  // Upload last frame image
  const lastName = await uploadImageToComfyUI(lastImageBuffer, "last_frame.jpg");
  workflow["698"].inputs.image = lastName;
  console.log(`[combi-video] last frame: ${lastName}, seed: ${seed}`);

  const promptId = await submitComfyWorkflow(workflow);
  console.log(`[combi-video] submitted: ${promptId}`);
  const fileInfo = await waitForComfyResult(promptId, 720000); // 12 min
  console.log(`[combi-video] done: ${fileInfo.filename}`);
  bumpCounter("videos");
  return await downloadComfyFile(fileInfo);
}

// ── NVIDIA asset upload for img2img ──────────────────────────────

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function uploadImageToNvidiaAssets(imageBuffer, contentType = "image/jpeg") {
  const key = process.env.NVIDIA_KONTEXT_KEY || process.env.NVIDIA_API_KEY;

  // Step 1: create asset record
  const createBody = JSON.stringify({ contentType, description: "discord-input" });
  const createRes = await httpsRequest({
    hostname: "api.nvcf.nvidia.com",
    path: "/v2/nvcf/assets",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(createBody),
    },
  }, createBody);

  if (createRes.status < 200 || createRes.status >= 300) {
    throw new Error(`Asset create failed (${createRes.status}): ${createRes.body.toString().slice(0, 200)}`);
  }
  const asset = JSON.parse(createRes.body.toString());
  if (!asset.assetId || !asset.uploadUrl) {
    throw new Error(`Asset create bad response: ${createRes.body.toString().slice(0, 200)}`);
  }

  // Step 2: upload image bytes to S3 presigned URL
  const uploadUrl = new URL(asset.uploadUrl);
  const uploadRes = await httpsRequest({
    hostname: uploadUrl.hostname,
    path: uploadUrl.pathname + uploadUrl.search,
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": imageBuffer.length,
    },
  }, imageBuffer);

  if (uploadRes.status < 200 || uploadRes.status >= 300) {
    throw new Error(`S3 upload failed: HTTP ${uploadRes.status}`);
  }

  console.log(`[img2img] asset uploaded: ${asset.assetId} (${imageBuffer.length} bytes, ${contentType})`);
  return { assetId: asset.assetId, contentType };
}

// ── Vision: describe images before passing to agent ──────────────

// Extract N evenly-spaced frames from a GIF buffer, return as base64 PNG strings
async function extractGifFrames(gifBuf, numFrames = 4) {
  const { execSync } = require("child_process");
  const fs = require("fs");
  const tag = Date.now();
  const tmpIn = `/tmp/gifframes-in-${tag}.gif`;
  const tmpOut = `/tmp/gifframes-out-${tag}`;
  fs.mkdirSync(tmpOut, { recursive: true });
  fs.writeFileSync(tmpIn, gifBuf);
  try {
    const script = `
import io, os
from PIL import Image
img = Image.open("${tmpIn}")
frames = []
try:
  while True:
    frames.append(img.copy().convert("RGB"))
    img.seek(img.tell() + 1)
except EOFError:
  pass
n = ${numFrames}
if not frames:
  raise SystemExit(1)
indices = [int(i * (len(frames)-1) / max(n-1,1)) for i in range(min(n, len(frames)))]
for i, idx in enumerate(indices):
  frames[idx].save(os.path.join("${tmpOut}", f"{i:02d}.png"))
print(len(indices))
`;
    execSync(`python3 -c "${script.replace(/"/g, '\\"')}"`, { timeout: 15000 });
    const files = fs.readdirSync(tmpOut).sort();
    const b64frames = files.map(f => fs.readFileSync(`${tmpOut}/${f}`).toString("base64"));
    return b64frames;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.rmSync(tmpOut, { recursive: true }); } catch {}
  }
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NemoClaw/1.0)",
        "Referer": "https://discord.com/",
      },
    };
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function describeImageUrl(imageUrl) {
  let b64;
  if (imageUrl.startsWith("data:")) {
    // Already a data URI — extract base64 part
    b64 = imageUrl.split(",")[1];
  } else {
    try {
      const buf = await fetchBuffer(imageUrl);
      if (buf.length > 8 * 1024 * 1024) return "[image too large to describe]";
      b64 = buf.toString("base64");
    } catch {
      return "[could not download image]";
    }
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: "meta/llama-3.2-90b-vision-instruct",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
          { type: "text", text: "Describe this image in detail." },
        ],
      }],
      max_tokens: 512,
    });

    const req = https.request({
      hostname: "integrate.api.nvidia.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try {
          const data = JSON.parse(buf);
          resolve(data.choices?.[0]?.message?.content || "[no description]");
        } catch {
          resolve("[vision API error]");
        }
      });
    });
    req.on("error", () => resolve("[vision request failed]"));
    req.write(body);
    req.end();
  });
}

async function buildMessageWithImages(msg) {
  const imageUrls = [];

  // If Discord sent the message as a text file (long message → message.txt), read it
  let msgContent = msg.content.trim();
  for (const att of msg.attachments.values()) {
    if (att.name === "message.txt" || (att.contentType?.startsWith("text/plain") && att.size < 32768)) {
      try {
        const textBuf = await fetchBuffer(att.url);
        const extracted = textBuf.toString("utf-8").trim();
        if (extracted) {
          msgContent = extracted + (msgContent ? `\n${msgContent}` : "");
          console.log(`[long-msg] read ${extracted.length} chars from ${att.name}`);
        }
      } catch (e) {
        console.warn(`[long-msg] failed to read text attachment: ${e.message}`);
      }
    }
  }

  // Collect GIFs from Discord embeds (tenor/giphy posted via GIF picker)
  // Discord converts GIFs to mp4 for video playback, but keeps a static thumbnail.
  // Prefer thumbnail (static image Gemini can describe) over video (mp4 it can't).
  for (const embed of (msg.embeds || [])) {
    // embed.url is the full GIF URL (e.g. media.discordapp.net with ?width=&height=)
    // thumbnail.url also works; proxyURL may be truncated — use url directly
    const url = embed.thumbnail?.url || embed.image?.url || embed.url;
    if (url && /discordapp\.net|discordapp\.com/i.test(url) && !imageUrls.find(e => e.url === url)) {
      imageUrls.push({ url, contentType: "image/png", isGif: true });
      console.log(`[img] GIF thumbnail from embed: ${url.slice(0, 120)}`);
    }
  }

  // Collect image attachments — GIFs go through vision but not img2img
  let hasGifAttachment = false;
  for (const att of msg.attachments.values()) {
    const isGif = att.contentType === "image/gif" || /\.gif$/i.test(att.name || "");
    if (isGif) {
      hasGifAttachment = true;
      // Still send to vision for description, just mark as GIF
      imageUrls.push({ url: att.url, contentType: att.contentType || "image/gif", isGif: true });
      console.log(`[img] GIF attachment: ${att.name} (vision only, not img2img)`);
      continue;
    }
    if (att.contentType?.startsWith("image/") || /\.(png|jpg|jpeg|webp)$/i.test(att.name || "")) {
      imageUrls.push({ url: att.url, contentType: att.contentType || "image/png" });
    }
  }

  // Collect image URLs embedded in message text (Discord CDN + tenor/giphy GIFs)
  const cdnPattern = /https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/\S+\.(?:png|jpg|jpeg|gif|webp)\S*/gi;
  for (const match of (msgContent.match(cdnPattern) || [])) {
    if (!imageUrls.find((e) => e.url === match)) {
      const isGifUrl = /\.gif/i.test(match);
      imageUrls.push({ url: match, contentType: isGifUrl ? "image/gif" : "image/png", isGif: isGifUrl });
    }
  }

  // Tenor GIFs — Discord embeds these as tenor.com/view/... links
  // Fetch the actual GIF URL from tenor's API via the embed page
  const tenorPattern = /https:\/\/tenor\.com\/view\/\S+/gi;
  for (const match of (msgContent.match(tenorPattern) || [])) {
    if (!imageUrls.find((e) => e.url === match)) {
      imageUrls.push({ url: match, contentType: "image/gif", isGif: true, isTenor: true });
      console.log(`[img] Tenor GIF link detected: ${match}`);
    }
  }

  // Giphy GIFs
  const giphyPattern = /https:\/\/(?:media\.giphy\.com|giphy\.com)\S+\.gif\S*/gi;
  for (const match of (msgContent.match(giphyPattern) || [])) {
    if (!imageUrls.find((e) => e.url === match)) {
      imageUrls.push({ url: match, contentType: "image/gif", isGif: true });
    }
  }

  if (imageUrls.length === 0) {
    return msgContent;
  }

  // Resolve tenor page URLs to actual GIF media URLs
  for (const e of imageUrls) {
    if (e.isTenor) {
      try {
        const html = (await fetchBuffer(e.url)).toString("utf-8");
        // Tenor embeds the gif URL in og:image or a c.tenor.com URL
        const gifMatch = html.match(/https:\/\/c\.tenor\.com\/[^"'\s]+\.gif/);
        if (gifMatch) { e.url = gifMatch[0]; e.isTenor = false; console.log(`[tenor] resolved to: ${e.url}`); }
        else { console.warn(`[tenor] could not extract GIF URL from page`); }
      } catch (err) { console.warn(`[tenor] fetch failed: ${err.message}`); }
    }
  }

  // Fetch all image buffers once, use for both description and asset upload
  const buffers = await Promise.all(imageUrls.map(async (e) => {
    try { return await fetchBuffer(e.url); } catch { return null; }
  }));

  // Describe images for agent context
  const descriptions = await Promise.all(buffers.map(async (buf, i) => {
    if (!buf) return "[could not download image]";
    if (buf.length > 8 * 1024 * 1024) return "[image too large to describe]";

    // For GIFs, extract multiple frames and describe motion
    if (imageUrls[i]?.isGif && buf.length > 500) {
      try {
        const frames = await extractGifFrames(buf, 6);
        if (frames.length > 1) {
          const frameDescs = await Promise.all(
            frames.map((f) => describeImageUrl(`data:image/png;base64,${f}`).catch(() => null))
          );
          const valid = frameDescs.map((d, i) => d ? `Frame ${i+1}: ${d}` : null).filter(Boolean);
          if (valid.length > 1) {
            return `[Animated GIF — ${valid.length} frames sampled to show motion:\n${valid.join("\n")}\nDescribe what motion or action is happening across these frames.]`;
          }
        }
      } catch (e) {
        console.warn(`[gif-frames] extraction failed: ${e.message}`);
      }
    }

    const b64 = buf.toString("base64");
    return describeImageUrl(`data:${imageUrls[i].contentType};base64,${b64}`).catch(() => "[vision error]");
  }));

  // Push first non-GIF image to sandbox for img2img
  let assetBlock = "";
  const nonGifBuffers = buffers.filter((b, i) => b != null && !imageUrls[i]?.isGif);
  const firstNonGifIdx = imageUrls.findIndex(e => !e.isGif);
  if (firstNonGifIdx >= 0 && buffers[firstNonGifIdx]) {
    try {
      const pushed = await pushImageToSandbox(buffers[firstNonGifIdx]);
      if (pushed) {
        if (nonGifBuffers.length >= 2) {
          // Two images = first frame + last frame for combi video workflow
          assetBlock = `\n[INPUT_IMAGES: 2 images attached — FIRST FRAME and LAST FRAME for a first/last-frame video.\nThe bridge has both images cached and ready for the LTX combi workflow.\nAcknowledge both images briefly. If the user wants a video between these frames, output: [COMFYUI_COMBI: <detailed cinematic video prompt>]\nDo NOT use [COMFYUI_VIDEO:] — that only uses one image. Use [COMFYUI_COMBI:] to get both frames wired in.\nIf they want something else (image edit, post, etc.), handle normally using /tmp/input_image.png as the first image.]`;
          console.log(`[img2img] 2 images — combi mode primed, pushed first to sandbox`);
        } else {
          assetBlock = `\n[INPUT_IMAGE: /tmp/input_image.png — The user attached an image. First, use the vision description above to comment on what you see (be genuine, brief, conversational). Then ask what they'd like you to do with it. Options you can mention: edit/remix it, use it as a reference for a new image, turn it into a video, or post it. Do NOT automatically generate anything — always ask first. If they want to edit/generate, exec: python3 /sandbox/.openclaw-data/workspace/skills/nvidia-image-router/scripts/generate_image.py "<prompt>" "<ratio>" /tmp/input_image.png]`;
          console.log(`[img2img] pushed input image to sandbox (${buffers[firstNonGifIdx].length} bytes)`);
        }
      } else {
        console.error("[img2img] push to sandbox failed");
      }
    } catch (e) {
      console.error("[img2img] push failed:", e.message);
    }
  }

  // Cache first buffer for potential I2V video generation
  lastInputBuffer = buffers[0] || null;
  lastInputBuffers = buffers.filter(b => b != null); // cache all images for combi video

  // Also detect and cache video attachments separately (awaited so buffer is ready before agent call)
  let videoBlock = "";
  console.log(`[attach-debug] ${msg.attachments.size} attachments: ${[...msg.attachments.values()].map(a => `${a.name} (${a.contentType})`).join(", ") || "none"}`);
  for (const att of msg.attachments.values()) {
    if (att.contentType?.startsWith("video/") || /\.(mp4|mov|webm|avi)$/i.test(att.name || "")) {
      try {
        const vidBuf = await fetchBuffer(att.url);
        lastVideoBuffer = vidBuf; lastVideoSetAt = Date.now();
        lastVideoMime   = att.contentType || "video/mp4";
        lastGeneratedImageBuffer = null; // clear so video takes priority
        console.log(`[video-attach] cached ${lastVideoBuffer.length} bytes (${att.name})`);
        // Write to disk so agent can use ffmpeg on it
        fs.writeFileSync("/tmp/input_video.mp4", vidBuf);
        videoBlock = `\n[ATTACHED_VIDEO: saved to /tmp/input_video.mp4 (${(vidBuf.length / 1024 / 1024).toFixed(1)}MB) — The user uploaded a video. First, comment on what you see (be genuine, brief, conversational). Then ask what they'd like you to do with it — e.g. make a GIF, post to IG, or something else. Do NOT automatically do anything — always ask first. If they want a GIF, respond with [MAKE_GIF] for a GIF from the start, or [MAKE_GIF:N] to start at N seconds (e.g. [MAKE_GIF:2] starts at 2s). The bridge makes a 4-second GIF from that point. Do NOT try to run ffmpeg yourself. To post to IG: output a BUFFER_POST token with media=/tmp/input_video.mp4.]`;
      } catch (e) {
        console.warn(`[video-attach] failed to fetch: ${e.message}`);
      }
      break; // only cache first video
    }
  }

  const imageBlock = descriptions.map((d, i) => `[Image ${i + 1}: ${d}]`).join("\n");
  // If only GIFs (no static images), add a note — can't img2img but can comment
  let gifNote = "";
  if (hasGifAttachment && firstNonGifIdx < 0 && !assetBlock) {
    gifNote = `\n[The user attached a GIF. Use the vision description above to comment on it (be genuine, brief, conversational). Then ask what they'd like you to do. Note: GIFs can't be used for image editing — if they want edits, ask them to attach a static image (PNG/JPG) instead.]`;
  }
  const base = msgContent ? `${imageBlock}\n\n${msgContent}` : imageBlock;
  return base + assetBlock + gifNote + videoBlock;
}

// ── Grok img2img/img2vid via upload flow ─────────────────────────
function runGrokImg2X(imageBuffer, prompt, mode) {
  // mode: "img2img" | "img2vid"
  const endpoint = mode === "img2vid" ? "/generate-video" : "/generate-img2img";
  const bodyObj = mode === "img2vid"
    ? { imageBase64: imageBuffer.toString("base64"), videoPrompt: prompt }
    : { imageBase64: imageBuffer.toString("base64"), prompt };
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = require("http").request(
      { hostname: "127.0.0.1", port: 3091, path: endpoint, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 300000 },
      (res) => {
        let data = "";
        res.on("data", d => data += d);
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (j.path) resolve({ type: "video", path: j.path });
            else if (j.paths) resolve({ type: "images", paths: j.paths });
            else reject(new Error(j.error || "no output"));
          } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("grok-server timeout")); });
    req.write(body); req.end();
  });
}

// ── Run Grok Aurora image generation ─────────────────────────────

function runGrokImagine(prompt) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ prompt });
    const req = require("http").request(
      { hostname: "127.0.0.1", port: 3091, path: "/generate", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 180000 },
      (res) => {
        let data = "";
        res.on("data", d => data += d);
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.paths && json.paths.length > 0) {
              const valid = json.paths.filter(p => require("fs").existsSync(p));
              resolve(valid.length > 0 ? valid : null);
            } else {
              console.error("[grok] server error:", json.error);
              resolve(null);
            }
          } catch (e) { console.error("[grok] parse error:", e.message); resolve(null); }
        });
      }
    );
    req.on("error", (e) => { console.error("[grok] server request error:", e.message); resolve(null); });
    req.on("timeout", () => { console.error("[grok] server request timed out"); req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Run agent inside sandbox ──────────────────────────────────────

// Tokens that should never be shown in partial/streaming updates
const _STREAM_STRIP_RE = /\[(?:BUFFER_POST|NETIFY_POST|SITE_EDIT|REMEMBER|GDRIVE_SAVE|ZTURBO|CAPCUT_COMPOSE|COMFYUI_VIDEO|COMFYUI_COMBI|MAKE_GIF|GIF:|YT_SEARCH|TRENDS:|CREW_PLAN|CLAUDE_QUERY|ACESTEP|SUNO)[^\]]{0,600}\]/gi;

function runAgentInSandbox(message, sessionId, onProgress) {
  return new Promise((resolve) => {
    const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });

    const confDir  = require("fs").mkdtempSync("/tmp/nemoclaw-dc-ssh-");
    const confPath = `${confDir}/config`;
    require("fs").writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
    const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY || "";
    const cmd = `export NVIDIA_API_KEY=${shellQuote(API_KEY)} BRAVE_API_KEY=${shellQuote(BRAVE_KEY)} BRAVE_SEARCH_API_KEY=${shellQuote(BRAVE_KEY)} BRAVE_ANSWERS_API_KEY=${shellQuote(BRAVE_KEY)} NODE_OPTIONS='--require /sandbox/dns-proxy-patch.js' && openclaw agent --agent main --local -m ${shellQuote(message)} --session-id ${shellQuote("dc-" + safeSessionId)}`;

    health.agentCalls++;
    const proc = spawn("ssh", [...sshArgs(confPath), `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let lastProgressEmit = 0;
    const PROGRESS_INTERVAL = 1500; // ms between Discord edits

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (!onProgress) return;
      const now = Date.now();
      if (now - lastProgressEmit < PROGRESS_INTERVAL) return;
      // Apply same line filter as final processing
      const lines = stdout.split("\n");
      let clean = lines.filter(l =>
        !l.startsWith("Setting up NemoClaw") && !l.startsWith("[plugins]") &&
        !l.startsWith("(node:") && !l.includes("NemoClaw ready") &&
        !l.includes("NemoClaw registered") && !l.includes("openclaw agent") &&
        !l.includes("┌─") && !l.includes("│ ") && !l.includes("└─") && l.trim() !== ""
      ).join("\n").trim().replace(_STREAM_STRIP_RE, "").trim();
      // Strip raw JSON array wrapper from Gemini responses e.g. [{"text":"...","type":"text"}]
      if (clean.startsWith('[{"text":')) {
        try {
          const parsed = JSON.parse(clean);
          if (Array.isArray(parsed)) clean = parsed.map(p => p.text || "").join("").trim();
        } catch {
          clean = clean.replace(/^\[?\{"text":\s*"/,'').replace(/",?\s*"type"\s*:\s*"[^"]*"\s*\}?\]?$/,'').replace(/\\n/g,'\n').replace(/\\"/g,'"').trim();
        }
      }
      if (clean.length > 15) {
        lastProgressEmit = now;
        onProgress(clean);
      }
    });
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { require("fs").unlinkSync(confPath); require("fs").rmdirSync(confDir); } catch {}

      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("┌─") &&
          !l.includes("│ ") &&
          !l.includes("└─") &&
          l.trim() !== "",
      );

      const response = responseLines.join("\n").trim();

      if (response) {
        health.lastAgentOk = Date.now();
        resolve(response);
      } else if (code !== 0) {
        health.agentFails++;
        const errText = stderr.trim();
        diag("agent_fail", { code, session: sessionId, err: errText.slice(0, 300) });
        // Auto-recover from stale session lock — clear locks and retry once
        if (errText.includes("session file locked") || errText.includes("lock")) {
          console.warn("[agent] session lock detected — clearing locks and retrying...");
          try {
            const sshCfg2 = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });
            const confDir2  = require("fs").mkdtempSync("/tmp/nemoclaw-dc-ssh-");
            const confPath2 = `${confDir2}/config`;
            require("fs").writeFileSync(confPath2, sshCfg2, { mode: 0o600 });
            require("child_process").execSync(
              `ssh -T -F ${confPath2} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null openshell-${SANDBOX} 'find /sandbox/.openclaw-data -name "*.lock" -delete'`,
              { timeout: 8000 }
            );
            require("fs").unlinkSync(confPath2);
            require("fs").rmdirSync(confDir2);
          } catch (e) {
            console.warn("[agent] lock clear failed:", e.message);
          }
          // Retry the agent call once after clearing
          resolve(runAgentInSandbox(message, sessionId + "-retry"));
        } else {
          resolve(`Agent exited with code ${code}. ${errText.slice(0, 500)}`);
        }
      } else {
        health.agentFails++;
        diag("agent_empty", { session: sessionId, stderrLen: stderr.length });
        resolve("(no response)");
      }
    });

    proc.on("error", (err) => resolve(`Error: ${err.message}`));
  });
}

// ── Pull generated images out of sandbox ─────────────────────────

function pullImageFromSandbox(remotePath) {
  return new Promise((resolve) => {
    const fs = require("fs");
    const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });
    const confDir = fs.mkdtempSync("/tmp/nemoclaw-img-ssh-");
    const confPath = `${confDir}/config`;
    fs.writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const localPath = `/tmp/nemoclaw-img-${Date.now()}.png`;
    // Use ssh + base64 to transfer binary file without needing scp
    const proc = spawn("ssh", [...sshArgs(confPath), `openshell-${SANDBOX}`,
      `base64 ${shellQuote(remotePath)} 2>/dev/null`], {
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let b64 = "";
    proc.stdout.on("data", (d) => (b64 += d.toString()));
    proc.on("close", (code) => {
      try { fs.unlinkSync(confPath); fs.rmdirSync(confDir); } catch {}
      if (code === 0 && b64.trim()) {
        try {
          fs.writeFileSync(localPath, Buffer.from(b64.trim(), "base64"));
          resolve(localPath);
        } catch { resolve(null); }
      } else resolve(null);
    });
    proc.on("error", () => resolve(null));
  });
}

const extractImagePaths = bu.extractImagePaths;
const extractModelName = bu.extractModelName;

// ── Video rate limiter ────────────────────────────────────────────
// Owner (mrbigpipesyt) has unlimited generations. Everyone else: 7 videos/hour.
const OWNER_ID_GLOBAL = process.env.DISCORD_OWNER_ID || "";
const VIDEO_RATE_LIMIT = 7;
const VIDEO_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const _videoUsage = new Map(); // userId → [timestamp, ...]

function checkVideoRateLimit(userId) {
  if (userId === OWNER_ID_GLOBAL) return { allowed: true };
  const now = Date.now();
  const cutoff = now - VIDEO_RATE_WINDOW_MS;
  const timestamps = (_videoUsage.get(userId) || []).filter(t => t > cutoff);
  if (timestamps.length >= VIDEO_RATE_LIMIT) {
    const oldest = timestamps[0];
    const resetIn = Math.ceil((oldest + VIDEO_RATE_WINDOW_MS - now) / 60000);
    return { allowed: false, resetIn };
  }
  timestamps.push(now);
  _videoUsage.set(userId, timestamps);
  return { allowed: true, used: timestamps.length, limit: VIDEO_RATE_LIMIT };
}

// ── Discord client ────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", async () => {
  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Discord Bridge                            │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      ${(client.user.tag + "                         ").slice(0, 40)}│`);
  console.log(`  │  Sandbox:  ${(SANDBOX    + "                         ").slice(0, 40)}│`);
  ALLOWED_CHANNELS.forEach(({ guildId, channelId }) => {
    console.log(`  │  Channel:  ${(guildId + "/" + channelId + "                         ").slice(0, 40)}│`);
  });
  console.log("  │                                                     │");
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox.                               │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  // Register slash commands
  await registerCommands(TOKEN, client.user.id);
});

// ── Slash command & button interaction handler ───────────────────

client.on("interactionCreate", async (interaction) => {
  try {
    // ── Button interactions ──────────────────────────────────────
    if (interaction.isButton()) {
      const [, action, msgId] = interaction.customId.match(/^btn_(\w+)_(.+)$/) || [];
      if (!action) return;
      // Look up context by button's msgId, the interaction message ID, or the referenced message
      const ctx = generationContext.get(msgId)
        || generationContext.get(interaction.message?.id)
        || generationContext.get(interaction.message?.reference?.messageId)
        || {};
      // rootId persists across the entire chain for segment accumulation
      const rootId = ctx.rootId || msgId;
      console.log(`[btn] ${action} msgId=${msgId} rootId=${rootId} ctx.prompt="${(ctx.prompt || "").slice(0, 40)}" segs=${(storySegments.get(rootId)||[]).length}`);

      // ── Grok image selection (groksel0..3) ──────────────────────────────────
      if (action.startsWith("groksel")) {
        const idx = parseInt(action.replace("groksel", "")) || 0;
        const buf = ctx.imageBufs?.[idx] || ctx.imageBuf;
        if (!buf) { await interaction.reply({ content: "⚠️ Image data not found.", ephemeral: true }); return; }
        const fname = `grok-select-${idx + 1}.png`;
        await interaction.reply({
          content: `**Image ${idx + 1}** — *"${(ctx.prompt || "").slice(0, 80)}"*`,
          files: [new AttachmentBuilder(buf, { name: fname })],
          components: grokSingleButtons(msgId, idx),
        });
        // Store selected image buf under the new message id for downstream buttons
        const replyId = (await interaction.fetchReply()).id;
        generationContext.set(replyId, { ...ctx, imageBuf: buf, selectedIdx: idx });
        lastGeneratedImageBuffer = buf; lastImageSetAt = Date.now();
        return;
      }

      // ── Grok back to grid ────────────────────────────────────────────────────
      if (action === "grokback") {
        const bufs = ctx.imageBufs;
        if (!bufs?.length) { await interaction.reply({ content: "⚠️ Grid context lost.", ephemeral: true }); return; }
        const ts = Date.now();
        const tmpPaths = bufs.map((buf, i) => { const p = `/tmp/grok-back-${ts}-${i}.png`; fs.writeFileSync(p, buf); return p; });
        await interaction.reply({
          content: `🤖 *"${(ctx.prompt || "").slice(0, 80)}"* — **Grok Aurora** — pick an image:`,
          files: tmpPaths.map(p => new AttachmentBuilder(p)),
          components: grokGridButtons(msgId, bufs.length),
        });
        tmpPaths.forEach(p => fs.unlink(p, () => {}));
        return;
      }

      // ── Grok regen all ───────────────────────────────────────────────────────
      if (action === "grokregen") {
        await interaction.deferReply();
        const prompt = ctx.prompt || "a beautiful image";
        await interaction.editReply(`🔄 Regenerating: *"${prompt.slice(0, 60)}"*...`);
        const localPaths = await runGrokImagine(prompt);
        if (!localPaths?.length) { await interaction.editReply("⚠️ Grok regeneration failed."); return; }
        const imageBufs = localPaths.map(p => fs.readFileSync(p));
        lastGeneratedImageBuffer = imageBufs[0]; lastImageSetAt = Date.now();
        backupMedia(imageBufs[0], `grok-${Date.now()}.png`, "image/png");
        await interaction.editReply({
          content: `🔄 *"${prompt.slice(0, 80)}"* — **Grok Aurora** — pick an image:`,
          files: localPaths.map(p => new AttachmentBuilder(p)),
          components: grokGridButtons(interaction.message.id, localPaths.length),
        });
        generationContext.set(interaction.message.id, { prompt, type: "grok", imageBufs, imageBuf: imageBufs[0] });
        localPaths.forEach(p => fs.unlink(p, () => {}));
        return;
      }

      // ── Grok img2img / img2vid buttons — show modal for prompt, then ask for image ──
      if (action === "grokimg2img" || action === "grokimg2vid") {
        const isVid = action === "grokimg2vid";
        const modal = new ModalBuilder()
          .setCustomId(`modal_grokimg2x_${isVid ? "vid" : "img"}_${msgId}`)
          .setTitle(isVid ? "🎬 Grok Img2Vid" : "🖼️ Grok Img2Img")
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("grokimg2x_prompt")
              .setLabel(isVid ? "Describe the motion / animation" : "Describe the desired output")
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder(isVid ? "e.g. slow zoom in, waves crashing, cinematic" : "e.g. same style but at sunset, oil painting")
              .setRequired(true)
              .setMaxLength(500)
          ));
        await interaction.showModal(modal);
        return;
      }

      // ── Grok edit prompt (grokedit0..3) — show modal ─────────────────────────
      if (action.startsWith("grokedit")) {
        const idx = parseInt(action.replace("grokedit", "")) || 0;
        const modal = new ModalBuilder()
          .setCustomId(`modal_grokedit_${idx}_${msgId}`)
          .setTitle("✏️ Edit Grok Prompt")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("grok_prompt")
                .setLabel("New prompt")
                .setStyle(TextInputStyle.Paragraph)
                .setValue(ctx.prompt || "")
                .setRequired(true)
                .setMaxLength(500)
            )
          );
        await interaction.showModal(modal);
        return;
      }

      // ── Grok make video (grokvid0..3) — use Grok's own video generation ────
      if (action.startsWith("grokvid")) {
        const idx = parseInt(action.replace("grokvid", "")) || 0;
        const imagePrompt = ctx.prompt || "a beautiful image";

        // Show modal to collect video prompt
        const modal = new ModalBuilder()
          .setCustomId(`modal_grokvid_${idx}_${msgId}`)
          .setTitle("🎬 Grok Video Prompt")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("grok_vidprompt")
                .setLabel("Describe the motion / animation")
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder("e.g. slow zoom in, dramatic lighting, cinematic motion")
                .setRequired(true)
                .setMaxLength(500)
            )
          );
        await interaction.showModal(modal);
        return;
      }

      // ── Grok extend / upscale video — show modal for prompt first ────────────
      if (action === "grokextend" || action === "grokupscale") {
        const videoAction = action === "grokextend" ? "extend" : "upscale";
        const modal = new ModalBuilder()
          .setCustomId(`modal_grokvact_${videoAction}_${msgId}`)
          .setTitle(videoAction === "extend" ? "➕ Extend Video" : "⬆️ Upscale Video")
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("grok_vact_prompt")
              .setLabel(videoAction === "extend" ? "Describe the extension (optional)" : "Upscale instructions (optional)")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder(videoAction === "extend" ? "e.g. continue the motion, fade out" : "e.g. sharpen details, enhance quality")
              .setRequired(false)
              .setMaxLength(300)
          ));
        await interaction.showModal(modal);
        return;
      }

      // ── Grok post to IG (grokpost0..3) ─────────────────────────────────────
      if (action.startsWith("grokpost")) {
        const OWNER_ID = OWNER_ID_GLOBAL;
        if (interaction.user.id !== OWNER_ID) {
          await interaction.reply({ content: "⚠️ Only the bot owner can post to Instagram.", ephemeral: true }); return;
        }
        const idx = parseInt(action.replace("grokpost", "")) || 0;
        const buf = ctx.imageBufs?.[idx] || ctx.imageBuf || lastGeneratedImageBuffer;
        if (!buf) { await interaction.reply({ content: "⚠️ Image not found.", ephemeral: true }); return; }
        lastGeneratedImageBuffer = buf; lastImageSetAt = Date.now();
        await interaction.deferReply({ ephemeral: true });
        const rawPrompt = (ctx.prompt || lastPrompt || "AI Generated Content").replace(/\bexec\s*\([\s\S]*?\)/gi, "").replace(/python3?\s+\S+/gi, "").replace(/\/\S+\.\w{2,4}/g, "").trim().slice(0, 100) || "AI Content";
        const [title, quote] = await Promise.all([rewriteTitle(rawPrompt), rewriteQuote(rawPrompt)]);
        const caption = `${title}\n\n${quote}\n\n🤖 #AI #SlopFactory9000 #GenerativeArt`;
        const results = await postToBuffer({ text: caption, mediaBuffer: buf, mimeType: "image/png", channels: ["instagram"] });
        const ok = results.filter(r => !r.error);
        await interaction.editReply(ok.length ? "✅ Posted to Instagram!" : `⚠️ Failed: ${results.map(r => r.error).join(", ")}`);
        return;
      }

      // Recover image from Discord attachment if context was cleared (e.g. after restart)
      if (!ctx.imageBuf && !lastGeneratedImageBuffer && (action === "video" || action === "enhance")) {
        const imgAtt = interaction.message?.attachments?.find(a =>
          /\.(png|jpg|jpeg|webp)$/i.test(a.name || "") || (a.contentType || "").startsWith("image/"));
        if (imgAtt?.url) {
          try {
            const imgBuf = await fetch(imgAtt.url).then(r => r.arrayBuffer()).then(b => Buffer.from(b));
            lastGeneratedImageBuffer = imgBuf; lastImageSetAt = Date.now();
            console.log(`[btn-${action}] recovered image from Discord attachment (${imgBuf.length} bytes)`);
          } catch (e) {
            console.warn(`[btn-${action}] image recovery failed: ${e.message}`);
          }
        }
      }

      if ((action === "video" || action === "enhance") && !interaction.customId.includes("_dur_")) {
        // Show duration modal instead of generating immediately
        const mode = action === "enhance" ? "enhance" : "video";
        const modal = new ModalBuilder()
          .setCustomId(`modal_i2v_dur_${mode}_${msgId}`)
          .setTitle(mode === "enhance" ? "✨ Enhance & Video" : "🎬 Make Video")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("i2v_duration")
                .setLabel("Duration in seconds (2-30, default 10)")
                .setStyle(TextInputStyle.Short)
                .setPlaceholder("10")
                .setRequired(false)
                .setMaxLength(2)
            ),
          );
        await interaction.showModal(modal);
        return;
      }

      if (action === "video" && (ctx.imageBuf || lastGeneratedImageBuffer)) {
        // Video generation can take 5+ minutes — use followUp instead of editReply
        // to avoid the 15-min interaction token timeout
        await interaction.deferReply();
        const queue = await getComfyQueueStatus();
        await interaction.editReply(`🎬 Making video from image... ${queue.total > 0 ? `(${queue.total} in queue)` : ""}`);
        try {
          const buf = ctx.imageBuf || lastGeneratedImageBuffer;
          const videoBuf = await generateVideoWithComfyUI(ctx.prompt || "cinematic motion, smooth camera movement", buf);
          lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4"; try { fs.writeFileSync("/tmp/last_generated_video.mp4", videoBuf); } catch {} backupMedia(videoBuf, `vid-${Date.now()}.mp4`, "video/mp4");
          addSegment(rootId, videoBuf);
          generationContext.set(interaction.message.id, { ...ctx, videoBuf, type: "video", rootId });
          const tmpVid = `/tmp/nemoclaw-btn-vid-${Date.now()}.mp4`;
          fs.writeFileSync(tmpVid, videoBuf);
          await interaction.followUp({ content: "Generated with **LTX Video 2.3**", files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(rootId) }).catch(() =>
            interaction.editReply({ content: "Generated with **LTX Video 2.3**", files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(rootId) })
          );
          fs.unlinkSync(tmpVid);
        } catch (e) {
          await interaction.followUp(`Video render failed: ${e.message.slice(0, 200)}`).catch(() =>
            interaction.editReply(`Video render failed: ${e.message.slice(0, 200)}`)
          );
        }
      } else if (action === "suno_video") {
        // Generate video for a Suno track
        const clipId = ctx.clipId;
        if (!clipId) {
          await interaction.reply({ content: "⚠️ No clip ID found — re-generate the song first.", ephemeral: true });
          return;
        }
        await interaction.deferReply();
        await interaction.editReply(`🎬 Generating video for **${ctx.trackTitle || "track"}**... (takes ~30s)`);
        try {
          const videoUrl = await generateVideoForClip(clipId);
          const videoBuf = await downloadSunoAudio(videoUrl); // reuse downloader, works for mp4
          const tmpMp4   = `/tmp/nemoclaw-suno-video-${Date.now()}.mp4`;
          fs.writeFileSync(tmpMp4, videoBuf);
          const vidCtxKey = `suno-vid-${Date.now()}`;
          const videoRow  = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`btn_post_vid_${vidCtxKey}`).setLabel("📱 Post to IG").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`btn_save_${vidCtxKey}`).setLabel("💾 Save to Drive").setStyle(ButtonStyle.Secondary),
          );
          await interaction.editReply({
            content: `🎬 **${ctx.trackTitle || ctx.prompt?.slice(0, 60) || "Song"}** — video ready!`,
            files: [new AttachmentBuilder(tmpMp4, { name: "suno-video.mp4" })],
            components: [videoRow],
          });
          generationContext.set(vidCtxKey, { prompt: ctx.prompt, videoBuf, type: "suno_video" });
          try { fs.unlinkSync(tmpMp4); } catch {}
          backupMedia(videoBuf, `suno-video-${clipId}.mp4`, "video/mp4");
        } catch (e) {
          console.error(`[suno/video] failed: ${e.message}`);
          await interaction.editReply(`⚠️ Video generation failed: ${e.message.slice(0, 200)}`);
        }
      } else if (action === "post" || action === "post_vid" || action === "post_music") {
        // Only owner can post to Instagram
        const OWNER_ID = OWNER_ID_GLOBAL;
        if (interaction.user.id !== OWNER_ID) {
          await interaction.reply({ content: "⚠️ Only the bot owner can post to Instagram.", ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        const mediaBuf = action === "post_vid" ? (ctx.videoBuf || lastVideoBuffer) : action === "post_music" ? (ctx.audioBuf) : (ctx.imageBuf || lastGeneratedImageBuffer);
        const mime = action === "post_vid" ? "video/mp4" : action === "post_music" ? "audio/mpeg" : "image/png";

        // Generate enhanced title and poetic quote instead of using raw prompt
        const rawPrompt = (ctx.prompt || lastPrompt || "AI Generated Content").replace(/\bexec\s*\([\s\S]*?\)/gi, "").replace(/python3?\s+\S+/gi, "").replace(/\/\S+\.\w{2,4}/g, "").trim().slice(0, 100) || "AI Content";
        const [title, quote] = await Promise.all([rewriteTitle(rawPrompt), rewriteQuote(rawPrompt)]);
        const caption = `${title}\n\n${quote}\n\n🤖 #AI #SlopFactory9000 #GenerativeArt`;

        if (mediaBuf) {
          const results = await postToBuffer({ text: caption, mediaBuffer: mediaBuf, mimeType: mime, channels: ["instagram"] });
          const ok = results.filter(r => !r.error);
          await interaction.editReply(ok.length ? "✅ Posted to Instagram!" : `⚠️ Failed: ${results.map(r => r.error).join(", ")}`);
        } else {
          await interaction.editReply("⚠️ No media to post. Generate something first.");
        }
      } else if (action === "website") {
        // Post image to Pipes_AI Atelier via Static.app
        await interaction.deferReply({ ephemeral: true });
        try {
          let imgBuf = ctx.imageBuf || lastGeneratedImageBuffer;
          if (!imgBuf) {
            const imgAtt = interaction.message?.attachments?.find(a =>
              /\.(png|jpg|jpeg|webp)$/i.test(a.name || "") || (a.contentType || "").startsWith("image/"));
            if (imgAtt?.url) imgBuf = Buffer.from(await fetch(imgAtt.url).then(r => r.arrayBuffer()));
          }
          if (!imgBuf) {
            await interaction.editReply("⚠️ No image found. Generate something first.");
            return;
          }
          const section = "gallery";
          const timestamp = new Date().toISOString();
          const postId = `${section}-${Date.now()}`;
          const rawTitle = (ctx.prompt || lastPrompt || "AI Generated Art").replace(/\bexec\s*\([\s\S]*?\)/gi, "").replace(/python3?\s+\S+/gi, "").replace(/\/\S+\.\w{2,4}/g, "").trim().slice(0, 80) || "AI Generated Art";
          const [title, quote] = await Promise.all([rewriteTitle(rawTitle), rewriteQuote(rawTitle)]);
          const post = {
            section, timestamp, id: postId, title,
            description: quote || "",
            imageData: imgBuf.toString("base64"),
            imageMime: "image/png",
          };
          // Save to local posts.json and deploy to Static.app
          const posts = loadPosts();
          posts.unshift(post);
          if (posts.length > 50) posts.length = 50;
          savePosts(posts);
          await interaction.editReply("⏳ Deploying to drivenemo.web.app...");
          const ok = await deployToFirebase();
          if (ok) {
            console.log(`[firebase] posted to ${section}: ${title}`);
            await interaction.editReply(`✅ Posted to **Pipes_AI Atelier** → **${section}**\nhttps://drivenemo.web.app`);
          } else {
            await interaction.editReply("⚠️ Post saved locally but deploy failed. Will retry on next post.");
          }
        } catch (e) {
          console.error(`[firebase] button-post failed: ${e.message}`);
          await interaction.editReply(`⚠️ Website post failed: ${e.message.slice(0, 200)}`);
        }
      } else if (action === "gif") {
        // Show modal to pick start time and duration before creating GIF
        const vidBuf = ctx.videoBuf || lastVideoBuffer;
        if (!vidBuf) { await interaction.reply({ content: "⚠️ No video found. Generate a video first.", ephemeral: true }); return; }
        const modal = new ModalBuilder()
          .setCustomId(`modal_gifclip_${msgId}`)
          .setTitle("🎞️ Create GIF")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("gif_start")
                .setLabel("Start time (seconds, decimals OK)")
                .setStyle(TextInputStyle.Short)
                .setPlaceholder("e.g. 0  or  2.5")
                .setValue("0")
                .setRequired(true)
                .setMaxLength(8)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("gif_duration")
                .setLabel("Duration (seconds, decimals OK)")
                .setStyle(TextInputStyle.Short)
                .setPlaceholder("e.g. 4  or  3.5")
                .setValue("4")
                .setRequired(true)
                .setMaxLength(8)
            )
          );
        await interaction.showModal(modal);

      } else if (action === "loopgif") {
        // Perfect loop: ping-pong (forward + reversed = seamless)
        await interaction.deferReply();
        try {
          const ffmpeg = findFfmpeg();
          if (!ffmpeg) { await interaction.editReply("⚠️ ffmpeg not found."); return; }
          // Get GIF from context or Discord attachment
          let gifBuf = ctx.gifBuf;
          if (!gifBuf) {
            const gifAtt = interaction.message?.attachments?.find(a =>
              a.contentType === "image/gif" || /\.gif$/i.test(a.name || ""));
            if (gifAtt?.url) gifBuf = await fetchBuffer(gifAtt.url);
          }
          if (!gifBuf) { await interaction.editReply("⚠️ No GIF found."); return; }
          const tag = Date.now();
          const tmpIn = `/tmp/nemoclaw-loop-in-${tag}.gif`;
          const tmpOut = `/tmp/nemoclaw-loop-${tag}.gif`;
          fs.writeFileSync(tmpIn, gifBuf);
          // Ping-pong: split → reverse → concat → seamless loop
          execSync(`"${ffmpeg}" -y -i ${tmpIn} -filter_complex "[0:v]split[fwd][copy];[copy]reverse[rev];[fwd][rev]concat=n=2:v=1[out]" -map "[out]" -loop 0 ${tmpOut}`, { timeout: 30000 });
          const loopBuf = fs.readFileSync(tmpOut);
          const sizeMB = (loopBuf.length / 1024 / 1024).toFixed(1);
          // Update context so Post to IG uses looped version
          generationContext.set(msgId, { ...ctx, gifBuf: loopBuf, type: "gif" });
          await interaction.editReply({
            content: `🔁 **Perfect Loop** (${sizeMB} MB — ping-pong)`,
            files: [new AttachmentBuilder(tmpOut, { name: "loop.gif" })],
            components: [gifButtons(msgId)],
          });
          try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); } catch {}
          console.log(`[loopgif] created ${sizeMB}MB ping-pong loop`);
        } catch (e) {
          console.error(`[loopgif] failed: ${e.message}`);
          await interaction.editReply(`⚠️ Loop failed: ${e.message.slice(0, 200)}`);
        }

      } else if (action === "postigimg") {
        // Post first frame of GIF or MP4 as Instagram image post
        const OWNER_ID = OWNER_ID_GLOBAL;
        if (interaction.user.id !== OWNER_ID) {
          await interaction.reply({ content: "⚠️ Only the bot owner can post to Instagram.", ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        try {
          const ffmpeg = findFfmpeg();
          if (!ffmpeg) { await interaction.editReply("⚠️ ffmpeg not found."); return; }
          const tag    = Date.now();
          const tmpJpg = `/tmp/nemoclaw-igimg-${tag}.jpg`;
          if (ctx.gifMp4Buf) {
            // Extract first frame from mp4
            const tmpIn = `/tmp/nemoclaw-igimg-in-${tag}.mp4`;
            fs.writeFileSync(tmpIn, ctx.gifMp4Buf);
            execSync(`"${ffmpeg}" -y -i ${tmpIn} -vf "select=eq(n\\,0),scale=1080:-2:flags=lanczos" -frames:v 1 -q:v 2 ${tmpJpg}`, { timeout: 15000 });
            try { fs.unlinkSync(tmpIn); } catch {}
          } else {
            let gifBuf = ctx.gifBuf;
            if (!gifBuf) {
              const gifAtt = interaction.message?.attachments?.find(a =>
                a.contentType === "image/gif" || /\.gif$/i.test(a.name || ""));
              if (gifAtt?.url) gifBuf = await fetchBuffer(gifAtt.url);
            }
            if (!gifBuf) { await interaction.editReply("⚠️ No GIF or MP4 found."); return; }
            const tmpGif = `/tmp/nemoclaw-igimg-in-${tag}.gif`;
            fs.writeFileSync(tmpGif, gifBuf);
            execSync(`"${ffmpeg}" -y -i ${tmpGif} -vf "select=eq(n\\,0),scale=1080:-2:flags=lanczos" -frames:v 1 -q:v 2 ${tmpJpg}`, { timeout: 15000 });
            try { fs.unlinkSync(tmpGif); } catch {}
          }
          const jpgBuf = fs.readFileSync(tmpJpg);
          try { fs.unlinkSync(tmpJpg); } catch {}
          await interaction.editReply("⏳ Uploading to Instagram as image...");
          const results = await postToBuffer({ text: "#AI #GenerativeArt #Loop", mediaBuffer: jpgBuf, mimeType: "image/jpeg", channels: ["instagram"] });
          const ok = results.filter(r => !r.error);
          await interaction.editReply(ok.length ? "✅ Posted to Instagram!" : `⚠️ Failed: ${results.map(r => r.error).join(", ")}`);
        } catch (e) {
          console.error(`[postigimg] failed: ${e.message}`);
          await interaction.editReply(`⚠️ IG post failed: ${e.message.slice(0, 200)}`);
        }

      } else if (action === "postigreel" || action === "postigv") {
        // Post GIF as MP4 Reel — scale to min 540px wide, loop to ≥5s, CRF 26
        const OWNER_ID = OWNER_ID_GLOBAL;
        if (interaction.user.id !== OWNER_ID) {
          await interaction.reply({ content: "⚠️ Only the bot owner can post to Instagram.", ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        try {
          const ffmpeg = findFfmpeg();
          if (!ffmpeg) { await interaction.editReply("⚠️ ffmpeg not found."); return; }
          let gifBuf = ctx.gifBuf;
          if (!gifBuf) {
            const gifAtt = interaction.message?.attachments?.find(a =>
              a.contentType === "image/gif" || /\.gif$/i.test(a.name || ""));
            if (gifAtt?.url) gifBuf = await fetchBuffer(gifAtt.url);
          }
          // Prefer source MP4 for better quality
          if (ctx.gifMp4Buf) {
            const tag = Date.now();
            const tmpIn  = `/tmp/nemoclaw-reel-in-${tag}.mp4`;
            const tmpOut = `/tmp/nemoclaw-reel-${tag}.mp4`;
            fs.writeFileSync(tmpIn, ctx.gifMp4Buf);
            const ss = ctx.gifStartSec > 0 ? `-ss ${ctx.gifStartSec}` : "";
            // Only apply duration limit for gif-sourced mp4s (gifDurSec set); real mp4s post full length
            const durFlag = ctx.gifDurSec ? `-t ${ctx.gifDurSec}` : "";
            // Scale to min 540px wide (IG Reels minimum), ensure even dims
            execSync(`"${ffmpeg}" -y ${ss} ${durFlag} -i ${tmpIn} -vf "scale='max(540,iw)':-2:flags=lanczos,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -movflags +faststart ${tmpOut}`, { timeout: 60000 });
            const mp4Buf = fs.readFileSync(tmpOut);
            try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); } catch {}
            const sizeMB = (mp4Buf.length / 1024 / 1024).toFixed(1);
            console.log(`[postigreel] prepared mp4 (${sizeMB}MB) for IG`);
            await interaction.editReply("⏳ Uploading to Instagram as Reel...");
            const results = await postToBuffer({ text: "🎬 #AI #GenerativeArt #Reel", mediaBuffer: mp4Buf, mimeType: "video/mp4", channels: ["instagram"] });
            const ok = results.filter(r => !r.error);
            await interaction.editReply(ok.length ? "✅ Posted to Instagram as Reel!" : `⚠️ Failed: ${results.map(r => r.error).join(", ")}`);
          } else if (gifBuf) {
            // GIF → MP4: scale to 540px wide, loop 20× then cut at 10s (ensures ≥5s for Reels)
            const tag = Date.now();
            const tmpGif = `/tmp/nemoclaw-reel-gif-${tag}.gif`;
            const tmpOut = `/tmp/nemoclaw-reel-${tag}.mp4`;
            fs.writeFileSync(tmpGif, gifBuf);
            // IG Reels require ≥23fps; scale to min 540px wide; loop GIF to reach 10s
            execSync(`"${ffmpeg}" -y -stream_loop 20 -i ${tmpGif} -vf "scale='max(540,iw)':-2:flags=lanczos,fps=30" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -t 10 -movflags +faststart ${tmpOut}`, { timeout: 30000 });
            const mp4Buf = fs.readFileSync(tmpOut);
            try { fs.unlinkSync(tmpGif); fs.unlinkSync(tmpOut); } catch {}
            const sizeMB = (mp4Buf.length / 1024 / 1024).toFixed(1);
            console.log(`[postigreel] converted GIF → MP4 (${sizeMB}MB)`);
            await interaction.editReply("⏳ Uploading to Instagram as Reel...");
            const results = await postToBuffer({ text: "🎬 #AI #GenerativeArt #Reel", mediaBuffer: mp4Buf, mimeType: "video/mp4", channels: ["instagram"] });
            const ok = results.filter(r => !r.error);
            await interaction.editReply(ok.length ? "✅ Posted to Instagram as Reel!" : `⚠️ Failed: ${results.map(r => r.error).join(", ")}`);
          } else {
            await interaction.editReply("⚠️ No GIF or source video found.");
          }
        } catch (e) {
          console.error(`[postigreel] failed: ${e.message}`);
          await interaction.editReply(`⚠️ IG Reel post failed: ${e.message.slice(0, 200)}`);
        }

      } else if (action === "giftomp4") {
        // Convert GIF → MP4, reply with IG buttons, and register pending audio combine
        await interaction.deferReply();
        try {
          const ffmpeg = findFfmpeg();
          if (!ffmpeg) { await interaction.editReply("⚠️ ffmpeg not found."); return; }

          let mp4Buf = null;

          // Tenor gifv — already have the mp4, no conversion needed
          if (ctx.gifMp4Buf) {
            mp4Buf = ctx.gifMp4Buf;
          } else {
            let gifBuf = ctx.gifBuf;
            if (!gifBuf) {
              const gifAtt = interaction.message?.attachments?.find(a =>
                a.contentType === "image/gif" || /\.gif$/i.test(a.name || ""));
              if (gifAtt?.url) gifBuf = await fetchBuffer(gifAtt.url);
            }
            if (!gifBuf) { await interaction.editReply("⚠️ No GIF found."); return; }

            const tag   = Date.now();
            const tmpIn = `/tmp/nemoclaw-mp4-in-${tag}.gif`;
            const tmpOut = `/tmp/nemoclaw-mp4-${tag}.mp4`;
            fs.writeFileSync(tmpIn, gifBuf);
            execSync(
              `"${ffmpeg}" -y -i ${tmpIn} -vf "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos" ` +
              `-c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -movflags +faststart ${tmpOut}`,
              { timeout: 60000 }
            );
            mp4Buf = fs.readFileSync(tmpOut);
            try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); } catch {}
          }

          const sizeMB  = (mp4Buf.length / 1024 / 1024).toFixed(1);
          const ctxKey  = `mp4-${Date.now()}`;
          generationContext.set(ctxKey, { gifMp4Buf: mp4Buf, type: "mp4" });
          generationContext.set(msgId,  { ...ctx, gifMp4Buf: mp4Buf });

          // Register pending audio combine — uploading audio in this channel combines it with this mp4
          const pendingKey = `${interaction.guildId}-${interaction.user.id}`;
          pendingMp4.set(pendingKey, { mp4Buf, ts: Date.now() });
          setTimeout(() => { if (pendingMp4.get(pendingKey)?.ts === pendingMp4.get(pendingKey)?.ts) pendingMp4.delete(pendingKey); }, 10 * 60 * 1000);

          await interaction.editReply({
            content: `🎥 **MP4** (${sizeMB} MB) — upload an audio file to auto-combine`,
            files: [new AttachmentBuilder(mp4Buf, { name: "animation.mp4" })],
            components: [mp4Buttons(ctxKey)],
          });
          console.log(`[giftomp4] mp4 ready (${sizeMB}MB), pending audio combine registered`);
        } catch (e) {
          console.error(`[giftomp4] failed: ${e.message}`);
          await interaction.editReply(`⚠️ MP4 conversion failed: ${e.message.slice(0, 200)}`);
        }

      } else if (action === "enhance") {
        // Enhance prompt with LTX guide, then generate video from the image
        await interaction.deferReply();
        const originalPrompt = ctx.prompt || lastPrompt || "cinematic scene";
        try {
          await interaction.editReply(`✨ Enhancing prompt for LTX Video...`);
          const enhanced = await enhanceVideoPrompt(originalPrompt);
          console.log(`[enhance] "${originalPrompt.slice(0, 40)}" → "${enhanced.slice(0, 80)}"`);
          const queue = await getComfyQueueStatus();
          await interaction.editReply(`✨ Enhanced prompt:\n> *${enhanced.slice(0, 200)}*\n\n🎬 Rendering... ${queue.total > 0 ? `(${queue.total} in queue)` : ""}`);
          const buf = ctx.imageBuf || lastGeneratedImageBuffer;
          const videoBuf = await generateVideoWithComfyUI(enhanced, buf);
          lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4"; try { fs.writeFileSync("/tmp/last_generated_video.mp4", videoBuf); } catch {} backupMedia(videoBuf, `vid-${Date.now()}.mp4`, "video/mp4");
          addSegment(rootId, videoBuf);
          generationContext.set(interaction.message.id, { ...ctx, prompt: enhanced, videoBuf, type: "video", rootId });
          const tmpVid = `/tmp/nemoclaw-enhance-vid-${Date.now()}.mp4`;
          fs.writeFileSync(tmpVid, videoBuf);
          await interaction.followUp({ content: `✨ Enhanced with **LTX Video 2.3**\n> *${enhanced.slice(0, 150)}*`, files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(rootId) }).catch(() =>
            interaction.editReply({ content: `✨ Enhanced with **LTX Video 2.3**`, files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(rootId) })
          );
        } catch (e) {
          await interaction.followUp(`Enhance+Video failed: ${e.message.slice(0, 200)}`).catch(() =>
            interaction.editReply(`Enhance+Video failed: ${e.message.slice(0, 200)}`)
          );
        }
      } else if (action === "regen") {
        await interaction.deferReply();
        // Use ONLY the context from this specific message — never fall back to global lastPrompt
        if (!ctx.prompt) {
          await interaction.editReply("⚠️ Lost the original prompt for this image. Please generate a new one.");
          return;
        }
        const prompt = ctx.prompt;
        // ZTurbo regen — run local workflow instead of sandbox agent
        if (ctx.type === "zturbo") {
          const seed = Math.floor(Math.random() * 2147483647);
          const style = ctx.style || "none";
          const styleLabel = style !== "none" ? ` — *${style.replace(/-/g, " ")}*` : "";
          await interaction.editReply(`🔄 Regenerating ZTurbo${styleLabel}: *"${prompt.slice(0, 60)}"*...`);
          try {
            const imgBuf = await generateImageWithZTurbo(prompt, seed, style);
            const tmpPath = `/tmp/zturbo-regen-${Date.now()}.png`;
            fs.writeFileSync(tmpPath, imgBuf);
            lastGeneratedImageBuffer = imgBuf; lastImageSetAt = Date.now();
            await interaction.editReply({ content: `🔄 *"${prompt.slice(0, 80)}"*${styleLabel} *(ZImage Turbo)*`, files: [new AttachmentBuilder(tmpPath, { name: "zturbo.png" })], components: [imageButtons(interaction.message.id)] });
            generationContext.set(interaction.message.id, { prompt, style, seed, imageBuf: imgBuf, type: "zturbo" });
            fs.unlinkSync(tmpPath);
          } catch (e) {
            await interaction.editReply(`❌ ZTurbo regen failed: ${e.message.slice(0, 200)}`);
          }
          return;
        }
        const ratio = ctx.ratio || "1:1";
        await interaction.editReply(`🔄 Regenerating: *"${prompt.slice(0, 60)}"*...`);
        const agentMsg = `generate image: ${prompt} ${ratio}`;
        const response = await runAgentInSandbox(agentMsg, `dc-${interaction.user.id}-${Date.now().toString(36)}`);
        let imagePaths = extractImagePaths(response);
        if (imagePaths.length === 0) imagePaths = ["/tmp/generated_image.png"];
        if (imagePaths.length > 0) {
          const localPath = await pullImageFromSandbox(imagePaths[0]);
          if (localPath) {
            const imgBuf = fs.readFileSync(localPath);
            if (imgBuf.length < 20 * 1024) {
              console.warn(`[regen] skipping tiny image (${imgBuf.length} bytes) — likely stale/error`);
              fs.unlinkSync(localPath);
              await interaction.editReply("⚠️ Image generation failed or was filtered. Try a different prompt.");
            } else {
              lastGeneratedImageBuffer = imgBuf; lastImageSetAt = Date.now();
              await interaction.editReply({ content: `🔄 Regenerated`, files: [new AttachmentBuilder(localPath)], components: [imageButtons(interaction.message.id)] });
              generationContext.set(interaction.message.id, { prompt, ratio, imageBuf: lastGeneratedImageBuffer, type: "image" });
              fs.unlinkSync(localPath);
            }
          }
        } else {
          await interaction.editReply(response.slice(0, 1900) || "Regeneration failed.");
        }
      } else if (action === "chainprompt" || action === "chainenhance") {
        // Show modal for custom prompt input
        const enhance = action === "chainenhance";
        const modal = new ModalBuilder()
          .setCustomId(`modal_chain_${enhance ? "enhance" : "raw"}_${msgId}`)
          .setTitle(enhance ? "✨ Chain + Enhance Prompt" : "🔗 Chain with Custom Prompt")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("chain_prompt")
                .setLabel(enhance ? "Prompt (will be enhanced for LTX)" : "Video prompt for next segment")
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder("Describe what happens next...")
                .setRequired(true)
                .setMaxLength(1000)
            )
          );
        await interaction.showModal(modal);
      } else if (action === "chain") {
        await interaction.deferReply();
        const originalPrompt = ctx.prompt || lastPrompt || "cinematic scene";
        try {
          // Step 1: Generate continuation prompt + end frame description
          await interaction.editReply(`🔗 **Chain Next** — generating continuation from: *"${originalPrompt.slice(0, 50)}"*...`);
          const { nextPrompt, endFrameDesc } = await generateChainContinuation(originalPrompt);
          console.log(`[chain-btn] next: "${nextPrompt.slice(0, 60)}" | end: "${endFrameDesc.slice(0, 60)}"`);

          // Step 2: Extract last frame from current video
          // Priority: ctx.videoBuf > Discord attachment > lastVideoBuffer (stale fallback)
          let firstFrame = null;
          let vidBuf = ctx.videoBuf || null;

          // Always try Discord attachment if no ctx (avoids stale lastVideoBuffer from hours ago)
          if (!vidBuf) {
            const msgAttachments = interaction.message?.attachments;
            const videoAtt = msgAttachments?.find(a => /\.(mp4|mov|webm)$/i.test(a.name || "") || (a.contentType || "").startsWith("video/"));
            if (videoAtt?.url) {
              try {
                console.log(`[chain-btn] downloading video from Discord attachment: ${videoAtt.url}`);
                await interaction.editReply(`🔗 **Chain Next** — downloading video from Discord...`);
                vidBuf = await fetch(videoAtt.url).then(r => r.arrayBuffer()).then(b => Buffer.from(b));
                lastVideoBuffer = vidBuf; lastVideoSetAt = Date.now();
                if (!storySegments.has(rootId) || storySegments.get(rootId).length === 0) {
                  addSegment(rootId, vidBuf);
                }
                console.log(`[chain-btn] downloaded video from Discord (${vidBuf.length} bytes)`);
              } catch (e) {
                console.warn(`[chain-btn] Discord video download failed: ${e.message}`);
              }
            }
          }

          // Last resort: stale global buffer
          if (!vidBuf && lastVideoBuffer) {
            console.log(`[chain-btn] using lastVideoBuffer fallback (${lastVideoBuffer.length} bytes)`);
            vidBuf = lastVideoBuffer;
          }

          if (vidBuf) {
            try {
              firstFrame = await extractLastFrameFromVideo(vidBuf);
              console.log(`[chain-btn] extracted last frame (${firstFrame.length} bytes)`);
            } catch (e) {
              console.warn(`[chain-btn] frame extraction failed: ${e.message}`);
            }
          }

          if (!firstFrame) {
            await interaction.editReply("⚠️ Couldn't extract last frame from video. Try generating a new video first.");
            return;
          }

          // Step 3: Generate target end-frame with Imagen 4
          let targetFrame = null;
          if (endFrameDesc) {
            try {
              await interaction.editReply(`🔗 Generating target end-frame with **Imagen 4 Fast**...\n> *${nextPrompt.slice(0, 100)}*`);
              targetFrame = await generateTargetFrameWithImagen(endFrameDesc);
              console.log(`[chain-btn] Imagen target frame (${targetFrame.length} bytes)`);
            } catch (e) {
              console.warn(`[chain-btn] Imagen target failed: ${e.message}, using I2V instead`);
            }
          }

          // Step 4: Render video
          const queue = await getComfyQueueStatus();
          await interaction.editReply(`🔗 Rendering continuation... ${queue.total > 0 ? `(${queue.total} in queue)` : ""}\n> *${nextPrompt.slice(0, 120)}*`);

          let videoBuf;
          if (firstFrame && targetFrame) {
            // Best quality: combi workflow with both frames
            console.log(`[chain-btn] COMBI mode (first+last frame)`);
            videoBuf = await generateCombiVideoWithComfyUI(nextPrompt, firstFrame, targetFrame);
          } else {
            // Fallback: I2V with just the first frame
            console.log(`[chain-btn] I2V mode (first frame only)`);
            videoBuf = await generateVideoWithComfyUI(nextPrompt, firstFrame);
          }

          lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4"; try { fs.writeFileSync("/tmp/last_generated_video.mp4", videoBuf); } catch {} backupMedia(videoBuf, `vid-${Date.now()}.mp4`, "video/mp4");
          lastGeneratedImageBuffer = null;
          // Track segment BEFORE building buttons so stitch count is current
          addSegment(rootId, videoBuf);
          generationContext.set(interaction.message.id, { prompt: nextPrompt, videoBuf, type: "video", rootId });

          const tmpVid = `/tmp/nemoclaw-chain-btn-${Date.now()}.mp4`;
          fs.writeFileSync(tmpVid, videoBuf);
          await interaction.followUp({
            content: `🔗 **Chained** with **LTX Video 2.3**\n> *${nextPrompt.slice(0, 150)}*`,
            files: [new AttachmentBuilder(tmpVid, { name: "chain-video.mp4" })],
            components: videoButtons(rootId),
          }).catch(() =>
            interaction.editReply({
              content: `🔗 **Chained** with **LTX Video 2.3**`,
              files: [new AttachmentBuilder(tmpVid, { name: "chain-video.mp4" })],
              components: videoButtons(rootId),
            })
          );
          fs.unlinkSync(tmpVid);
        } catch (e) {
          console.error("[chain-btn] failed:", e.message);
          await interaction.followUp(`Chain failed: ${e.message.slice(0, 200)}`).catch(() =>
            interaction.editReply(`Chain failed: ${e.message.slice(0, 200)}`)
          );
        }
      } else if (action === "stitch") {
        // Stitch all accumulated segments into one video
        await interaction.deferReply();
        const segs = storySegments.get(msgId);
        if (!segs || segs.length < 2) {
          await interaction.editReply("⚠️ Need at least 2 segments to stitch. Chain more videos first.");
          return;
        }
        try {
          await interaction.editReply(`🎬 Stitching ${segs.length} segments with FFmpeg...`);
          const stitched = await stitchVideoSegments(segs);
          lastVideoBuffer = stitched; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4";
          const tmpVid = `/tmp/nemoclaw-stitched-${Date.now()}.mp4`;
          fs.writeFileSync(tmpVid, stitched);
          await interaction.followUp({
            content: `🎬 **Stitched!** ${segs.length} segments → ${(stitched.length / 1024 / 1024).toFixed(1)}MB final video`,
            files: [new AttachmentBuilder(tmpVid, { name: "final-story.mp4" })],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`btn_post_vid_${msgId}`).setLabel("📱 Post to IG").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`btn_save_${msgId}`).setLabel("💾 Save to Drive").setStyle(ButtonStyle.Secondary),
            )],
          }).catch(() => interaction.editReply({
            content: `🎬 **Stitched!** ${segs.length} segments`,
            files: [new AttachmentBuilder(tmpVid, { name: "final-story.mp4" })],
          }));
          // Update context with stitched video
          generationContext.set(msgId, { ...ctx, videoBuf: stitched, type: "video" });
          fs.unlinkSync(tmpVid);
        } catch (e) {
          console.error("[stitch] failed:", e.message);
          await interaction.followUp(`Stitch failed: ${e.message.slice(0, 200)}`).catch(() =>
            interaction.editReply(`Stitch failed: ${e.message.slice(0, 200)}`)
          );
        }
      } else if (action === "save") {
        await interaction.deferReply({ ephemeral: true });
        const buf = ctx.videoBuf || ctx.imageBuf || ctx.audioBuf || lastVideoBuffer || lastGeneratedImageBuffer;
        if (buf) {
          const ext = ctx.videoBuf || lastVideoBuffer ? "mp4" : ctx.audioBuf ? "mp3" : "png";
          const tmpFile = `/tmp/nemoclaw-save-${Date.now()}.${ext}`;
          fs.writeFileSync(tmpFile, buf);
          try {
            const result = await gdrive.uploadToDrive(tmpFile, ext === "mp4" ? "video/mp4" : ext === "mp3" ? "audio/mpeg" : "image/png", `mrbigpipes-${Date.now()}.${ext}`);
            await interaction.editReply(`💾 Saved to Drive: ${result.webViewLink || "uploaded"}`);
          } catch (e) {
            await interaction.editReply(`💾 Drive upload failed: ${e.message.slice(0, 200)}`);
          }
          fs.unlinkSync(tmpFile);
        } else {
          await interaction.editReply("⚠️ Nothing to save.");
        }
      }
      return;
    }

    // ── Select menu interactions ──────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      // ── /create top-level type menu ──────────────────────────────
      if (interaction.customId === "create_type") {
        const type = interaction.values[0];
        if (type === "image") {
          const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("create_image_model")
              .setPlaceholder("Choose image model…")
              .addOptions([
                { label: "Grok txt2img",  value: "grok_txt2img",  description: "Text → image via Grok Aurora (xAI)",          emoji: "✨" },
                { label: "Grok img2img",  value: "grok_img2img",  description: "Image + prompt → variation via Grok Aurora",  emoji: "🖼️" },
                { label: "ZImage Turbo",  value: "zturbo",        description: "Fast local GPU image (ComfyUI)",              emoji: "⚡" },
                { label: "Imagine",       value: "imagine",       description: "Text → image via Imagen 4 Fast",              emoji: "🎨" },
              ])
          );
          await interaction.update({ content: "🎨 **Image** — pick a model:", components: [row] });
        } else if (type === "video") {
          const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("create_video_model")
              .setPlaceholder("Choose video model…")
              .addOptions([
                { label: "Text-to-Video",       value: "video",        description: "Text → video clip (LTX 2.3, adjustable duration)", emoji: "🎬" },
                { label: "Image-to-Video",      value: "i2v",          description: "Animate an image (LTX 2.3, adjustable duration)", emoji: "🖼️" },
                { label: "First/Last Frame",    value: "combi",        description: "Animate between two images",                      emoji: "🎞️" },
                { label: "Story Video",         value: "story",        description: "Multi-segment narrative video (20-40s)",           emoji: "📖" },
                { label: "Grok img2vid",        value: "grok_img2vid", description: "Animate an image with Grok Aurora",               emoji: "🌀" },
              ])
          );
          await interaction.update({ content: "🎬 **Video** — pick a model:", components: [row] });
        } else if (type === "edit") {
          const row1 = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("create_edit_preset")
              .setPlaceholder("Choose video format…")
              .addOptions([
                { label: "Short (14s, 9:16)",          value: "short",         description: "YouTube Short / TikTok / Reel",        emoji: "📱" },
                { label: "Vertical (60s, 9:16)",       value: "vertical",      description: "60s vertical video",                   emoji: "📱" },
                { label: "Vertical Long (120s, 9:16)", value: "vertical-long", description: "2-min vertical video",                 emoji: "📱" },
                { label: "Full (60s, 16:9)",           value: "full",          description: "Standard landscape video",              emoji: "🖥️" },
                { label: "Long (120s, 16:9)",          value: "full-long",     description: "2-min landscape video",                 emoji: "🖥️" },
              ])
          );
          await interaction.update({ content: "✂️ **Edit** — pick a format:", components: [row1] });
        } else if (type === "audio") {
          const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("create_audio_model")
              .setPlaceholder("Choose audio model…")
              .addOptions([
                { label: "ACE-Step Music",  value: "music",  description: "Generate a song with tags + lyrics",  emoji: "🎵" },
                { label: "Suno AI",         value: "suno",   description: "Generate a song with Suno AI",        emoji: "🎶" },
              ])
          );
          await interaction.update({ content: "🎵 **Audio** — pick a model:", components: [row] });
        }
        return;
      }

      // ── /create edit preset selected → show style picker ──────────
      if (interaction.customId === "create_edit_preset") {
        const preset = interaction.values[0];
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`create_edit_style:${preset}`)
            .setPlaceholder("Choose a visual style…")
            .addOptions([
              { label: "Cinematic",  value: "cinematic",  emoji: "🎬" },
              { label: "Vibrant",    value: "vibrant",    emoji: "🌈" },
              { label: "Moody",      value: "moody",      emoji: "🌙" },
              { label: "Vintage",    value: "vintage",    emoji: "📼" },
              { label: "Dark",       value: "dark",       emoji: "🖤" },
              { label: "Dreamy",     value: "dreamy",     emoji: "☁" },
              { label: "Brainslop",  value: "brainslop",  emoji: "🧠", description: "Jumpcuts, beat-synced chaos" },
              { label: "Ludicrous",  value: "ludicrous",  emoji: "🔥", description: "Pure rapid-fire brain slop" },
            ])
        );
        await interaction.update({ content: `✂️ **Edit** *(${preset})* — pick a style:`, components: [row] });
        return;
      }

      // ── /create edit style selected → show media summary + confirm ─
      if (interaction.customId.startsWith("create_edit_style:")) {
        const preset = interaction.customId.split(":")[1];
        const style = interaction.values[0];

        // Scan edit queue + recent generationContext for media
        const images = [], videos = [], audios = [];
        const q = editQueues.get(interaction.user.id);
        if (q && Date.now() - q.updatedAt < EDIT_QUEUE_EXPIRY) {
          images.push(...q.images); videos.push(...q.videos); audios.push(...q.audios);
        }
        const contextEntries = [...generationContext.entries()].reverse();
        for (const [, ctx] of contextEntries) {
          if (ctx.imageBuf && images.length < 10) images.push(ctx.imageBuf);
          if (ctx.videoBuf && videos.length < 10) videos.push(ctx.videoBuf);
          if (ctx.audioBuf && (ctx.type === "music" || ctx.type === "suno") && audios.length === 0) audios.push(ctx.audioBuf);
        }
        if (images.length === 0 && lastGeneratedImageBuffer) images.push(lastGeneratedImageBuffer);
        if (videos.length === 0 && lastVideoBuffer) videos.push(lastVideoBuffer);

        if (images.length === 0 && videos.length === 0) {
          await interaction.update({
            content: "❌ No media found.\n\nUse `/edit-add` to queue files, generate media (`/imagine`, `/video`, `/music`), or use `/edit` to attach directly.",
            components: [],
          });
          return;
        }

        const mediaList = [
          images.length && `${images.length} image${images.length > 1 ? "s" : ""}`,
          videos.length && `${videos.length} video${videos.length > 1 ? "s" : ""}`,
          audios.length && `1 audio track`,
        ].filter(Boolean).join(", ");

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`create_edit_go:${preset}:${style}`).setLabel("Compose").setStyle(1).setEmoji("🎬"),
          new ButtonBuilder().setCustomId("create_edit_cancel").setLabel("Cancel").setStyle(2),
        );
        await interaction.update({
          content: `🎞 **Edit preview** — *${preset}, ${style}*\n\nFound: **${mediaList}**\n\nHit **Compose** to render, or use \`/edit\` to attach specific files.`,
          components: [row],
        });
        return;
      }

      // ── /create edit cancel ───────────────────────────────────────
      if (interaction.customId === "create_edit_cancel") {
        await interaction.update({ content: "Cancelled.", components: [] });
        return;
      }

      // ── /create edit confirmed → render ──────────���────────────────
      if (interaction.customId.startsWith("create_edit_go:")) {
        const [, preset, style] = interaction.customId.split(":");
        await interaction.update({ content: `🎬 Composing **${preset}** video *(${style})*…`, components: [] });

        const images = [], videos = [], audios = [];
        // Pull from edit queue first
        const q = editQueues.get(interaction.user.id);
        if (q && Date.now() - q.updatedAt < EDIT_QUEUE_EXPIRY) {
          images.push(...q.images); videos.push(...q.videos); audios.push(...q.audios);
          clearEditQueue(interaction.user.id);
        }
        // Then from recent generations
        const contextEntries = [...generationContext.entries()].reverse();
        for (const [, ctx] of contextEntries) {
          if (ctx.imageBuf && images.length < 10) images.push(ctx.imageBuf);
          if (ctx.videoBuf && videos.length < 10) videos.push(ctx.videoBuf);
          if (ctx.audioBuf && (ctx.type === "music" || ctx.type === "suno") && audios.length === 0) audios.push(ctx.audioBuf);
        }
        if (images.length === 0 && lastGeneratedImageBuffer) images.push(lastGeneratedImageBuffer);
        if (videos.length === 0 && lastVideoBuffer) videos.push(lastVideoBuffer);

        try {
          const { editVideo } = require("./lib/video-editor");
          const result = await editVideo({ images, videos, audioBuffer: audios[0] || null, preset, style });
          const tmpOut = `/tmp/edit-out-${Date.now()}.mp4`;
          fs.writeFileSync(tmpOut, result.videoBuffer);
          const sizeMB = (result.videoBuffer.length / 1024 / 1024).toFixed(1);
          const durStr = result.totalDurationSec.toFixed(1);
          await interaction.editReply({
            content: `🎬 **Edited** — ${durStr}s ${preset} *(${style}, ${sizeMB}MB)*`,
            files: [new AttachmentBuilder(tmpOut, { name: `edit-${preset}.mp4` })],
            components: videoButtons(interaction.id),
          });
          lastVideoBuffer = result.videoBuffer; lastVideoSetAt = Date.now();
          lastVideoMime = "video/mp4";
          generationContext.set(interaction.id, { type: "video", videoBuf: result.videoBuffer, prompt: `${preset} ${style} edit` });
          try { fs.unlinkSync(tmpOut); } catch {}
        } catch (e) {
          console.error("[edit/create] failed:", e);
          await interaction.editReply(`❌ Edit failed: ${e.message.slice(0, 300)}`);
        }
        return;
      }

      // ── /create image model selected → show prompt modal ─────────
      if (interaction.customId === "create_image_model") {
        const model = interaction.values[0];
        if (model === "grok_img2img" || model === "grok_img2vid") {
          // img2img/img2vid needs an attachment — redirect to dedicated slash command
          const isVid = model === "grok_img2vid";
          await interaction.update({
            content: `📎 Use **/${isVid ? "grok-img2vid" : "grok-img2img"}** to upload your source image along with a prompt.`,
            components: [],
          });
          return;
        }
        const labels = {
          grok_txt2img: ["✨ Grok txt2img", "Describe the image you want", "e.g. a lone astronaut on a neon-lit alien market"],
          zturbo:       ["⚡ ZImage Turbo", "Describe the image you want", "e.g. a cyberpunk city at night, oil painting"],
          imagine:      ["🎨 Imagine",      "Describe the image you want", "e.g. golden hour portrait of a wolf in the forest"],
        };
        const [title, label, placeholder] = labels[model] || ["Generate", "Prompt", ""];
        const modal = new ModalBuilder()
          .setCustomId(`modal_create_img_${model}`)
          .setTitle(title)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("create_prompt")
              .setLabel(label)
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder(placeholder)
              .setRequired(true)
              .setMaxLength(500)
          ));
        await interaction.showModal(modal);
        return;
      }

      // ── /create video model selected → show prompt modal ─────────
      if (interaction.customId === "create_video_model") {
        const model = interaction.values[0];
        if (model === "combi") {
          await interaction.update({
            content: "📎 Use **/combi** and attach 2 images (first + last frame) along with your prompt.",
            components: [],
          });
          return;
        }
        if (model === "grok_img2vid") {
          await interaction.update({
            content: "📎 Use **/grok-img2vid** to upload your source image along with a prompt.",
            components: [],
          });
          return;
        }
        if (model === "i2v") {
          const modal = new ModalBuilder()
            .setCustomId("modal_create_vid_i2v")
            .setTitle("🖼️ Image-to-Video (LTX 2.3)")
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("create_prompt")
                  .setLabel("Describe the motion / scene")
                  .setStyle(TextInputStyle.Paragraph)
                  .setPlaceholder("e.g. camera slowly zooms in, hair blowing in the wind")
                  .setRequired(true)
                  .setMaxLength(500)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("create_duration")
                  .setLabel("Duration in seconds (2-30, default 10)")
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder("10")
                  .setRequired(false)
                  .setMaxLength(2)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("create_image_url")
                  .setLabel("Image URL (or leave blank to use last generated)")
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder("https://... or leave blank")
                  .setRequired(false)
                  .setMaxLength(500)
              ),
            );
          await interaction.showModal(modal);
          return;
        }
        const labels = {
          video: ["🎬 Text-to-Video", "Describe the video scene",          "e.g. slow pan over a misty mountain lake at dawn"],
          story: ["📖 Story Video",   "Describe the full story arc",        "e.g. a knight discovers a dragon who just wants to bake"],
        };
        const [title, label, placeholder] = labels[model] || ["Generate", "Prompt", ""];
        const modal = new ModalBuilder()
          .setCustomId(`modal_create_vid_${model}`)
          .setTitle(title)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("create_prompt")
                .setLabel(label)
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder(placeholder)
                .setRequired(true)
                .setMaxLength(500)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("create_duration")
                .setLabel("Duration in seconds (2-30, default 10)")
                .setStyle(TextInputStyle.Short)
                .setPlaceholder("10")
                .setRequired(false)
                .setMaxLength(2)
            ),
          );
        await interaction.showModal(modal);
        return;
      }

      // ── /create audio model selected → show prompt modal ─────────
      if (interaction.customId === "create_audio_model") {
        const model = interaction.values[0];
        if (model === "music") {
          const modal = new ModalBuilder()
            .setCustomId("modal_create_aud_music")
            .setTitle("🎵 ACE-Step Music")
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("create_tags")
                  .setLabel("Style tags (genre, tempo, instruments, vocals)")
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder("e.g. lo-fi hip hop, chill, piano, rain, female vocal")
                  .setRequired(true)
                  .setMaxLength(200)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("create_lyrics")
                  .setLabel("Lyrics (use [verse] [chorus] markers)")
                  .setStyle(TextInputStyle.Paragraph)
                  .setPlaceholder("[verse]\nWalking through the city lights...\n[chorus]\nWe are alive tonight...")
                  .setRequired(true)
                  .setMaxLength(1500)
              )
            );
          await interaction.showModal(modal);
        } else if (model === "suno") {
          const modal = new ModalBuilder()
            .setCustomId("modal_create_aud_suno")
            .setTitle("🎶 Suno AI")
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("create_prompt")
                  .setLabel("Prompt (describe the song)")
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder("e.g. a love song about rainy nights in Tokyo")
                  .setRequired(true)
                  .setMaxLength(300)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("create_style")
                  .setLabel("Style / Tags (genre, mood, instruments)")
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder("e.g. dreamy indie pop, piano, female vocals, 90 BPM")
                  .setRequired(false)
                  .setMaxLength(200)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("create_lyrics")
                  .setLabel("Lyrics (leave blank for Suno to write)")
                  .setStyle(TextInputStyle.Paragraph)
                  .setPlaceholder("[Verse 1]\nYour lyrics here...\n\n[Chorus]\n...")
                  .setRequired(false)
                  .setMaxLength(1500)
              ),
            );
          await interaction.showModal(modal);
        }
        return;
      }

      return;
    }

    // ── Modal submit interactions (chain with custom prompt) ──────
    if (interaction.isModalSubmit()) {
      // ── /create image modals ──────────────────────────────────────────────
      const createImgMatch = interaction.customId.match(/^modal_create_img_(\w+)$/);
      if (createImgMatch) {
        const model = createImgMatch[1];
        const prompt = interaction.fields.getTextInputValue("create_prompt").trim();
        await interaction.deferReply();
        lastPrompt = prompt;
        if (model === "grok_txt2img") {
          const localPaths = await runGrokImagine(prompt);
          if (!localPaths || localPaths.length === 0) { await interaction.editReply("⚠️ Grok generation failed."); return; }
          const imageBufs = localPaths.map(p => fs.readFileSync(p));
          lastGeneratedImageBuffer = imageBufs[0]; lastImageSetAt = Date.now();
          backupMedia(imageBufs[0], `grok-${Date.now()}.png`, "image/png");
          const replyMsg = await interaction.editReply({
            content: `✨ *"${prompt.slice(0, 80)}"* — **Grok Aurora** — pick an image:`,
            files: localPaths.map(p => new AttachmentBuilder(p)),
            components: grokGridButtons(interaction.id, localPaths.length),
          });
          generationContext.set(interaction.id, { prompt, type: "grok", imageBufs, imageBuf: imageBufs[0] });
          localPaths.forEach(p => fs.unlink(p, () => {}));
        } else if (model === "zturbo") {
          const imgBuf = await generateImageWithZTurbo(prompt, undefined, "none");
          const tmpPath = `/tmp/create-zturbo-${Date.now()}.png`;
          fs.writeFileSync(tmpPath, imgBuf);
          lastGeneratedImageBuffer = imgBuf; lastImageSetAt = Date.now();
          backupMedia(imgBuf, `zturbo-${Date.now()}.png`, "image/png");
          const replyMsg = await interaction.editReply({
            content: `⚡ *"${prompt.slice(0, 80)}"* — **ZImage Turbo**`,
            files: [new AttachmentBuilder(tmpPath, { name: "zturbo.png" })],
            components: [imageButtons(interaction.id)],
          });
          generationContext.set(interaction.id, { prompt, type: "image", imageBuf: imgBuf });
          fs.unlink(tmpPath, () => {});
        } else if (model === "imagine") {
          const uniqueToken = `[gen-${Date.now().toString(36)}]`;
          const agentMsg = `generate image: ${prompt} 1:1 ${uniqueToken}`;
          const response = await runAgentInSandbox(agentMsg, `dc-${interaction.user.id}-${Date.now().toString(36)}`);
          let imagePaths = extractImagePaths(response).filter(p => { try { return (Date.now() - fs.statSync(p).mtimeMs) < 30000; } catch { return false; } });
          if (imagePaths.length > 0) {
            const localPath = await pullImageFromSandbox(imagePaths[0]);
            if (localPath) {
              lastGeneratedImageBuffer = fs.readFileSync(localPath); lastImageSetAt = Date.now();
              const modelName = extractModelName(response);
              const replyMsg = await interaction.editReply({ content: `🎨 *"${prompt.slice(0, 80)}"* — **${modelName}**`, files: [new AttachmentBuilder(localPath)], components: [imageButtons(interaction.id)] });
              generationContext.set(interaction.id, { prompt, imageBuf: lastGeneratedImageBuffer, type: "image" });
              fs.unlinkSync(localPath);
              return;
            }
          }
          await interaction.editReply(`❌ Imagine generation failed.`);
        }
        return;
      }

      // ── /create video modals ──────────────────────────────────────────────
      const createVidMatch = interaction.customId.match(/^modal_create_vid_(\w+)$/);
      if (createVidMatch) {
        const model = createVidMatch[1];
        const prompt = interaction.fields.getTextInputValue("create_prompt").trim();
        const durStr = (interaction.fields.getTextInputValue("create_duration") || "").trim();
        const durationSec = durStr ? parseInt(durStr, 10) || 10 : 10;
        const _rlV = checkVideoRateLimit(interaction.user.id);
        if (!_rlV.allowed) { await interaction.reply({ content: `⏳ Video limit hit. Try again in **${_rlV.resetIn} min**.`, ephemeral: true }); return; }
        await interaction.deferReply();
        lastPrompt = prompt;
        if (model === "video") {
          const queue = await getComfyQueueStatus();
          await interaction.editReply(`🎬 Rendering ${durationSec}s: *"${prompt.slice(0, 60)}"*... ${queue.total > 0 ? `(${queue.total} in queue)` : ""}`);
          const videoBuf = await generateVideoWithComfyUI(prompt, null, durationSec);
          lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4"; lastGeneratedImageBuffer = null;
          backupMedia(videoBuf, `vid-${Date.now()}.mp4`, "video/mp4");
          addSegment(interaction.id, videoBuf);
          generationContext.set(interaction.id, { prompt, videoBuf, type: "video", rootId: interaction.id });
          const tmpVid = `/tmp/create-vid-${Date.now()}.mp4`;
          fs.writeFileSync(tmpVid, videoBuf);
          await interaction.editReply({ content: `🎬 *"${prompt.slice(0, 60)}"* — **LTX Video 2.3**`, files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(interaction.id) });
          fs.unlink(tmpVid, () => {});
        } else if (model === "i2v") {
          // Image-to-Video from /create
          let imageBuf = lastGeneratedImageBuffer;
          const imageUrl = (interaction.fields.getTextInputValue("create_image_url") || "").trim();
          if (imageUrl) {
            try { imageBuf = await fetch(imageUrl).then(r => r.arrayBuffer()).then(b => Buffer.from(b)); } catch (e) {
              await interaction.editReply(`⚠️ Could not download image: ${e.message.slice(0, 100)}`); return;
            }
          }
          if (!imageBuf) { await interaction.editReply("⚠️ No image available — generate an image first or provide a URL."); return; }
          const queue = await getComfyQueueStatus();
          await interaction.editReply(`🎬 I2V ${durationSec}s: *"${prompt.slice(0, 60)}"*... ${queue.total > 0 ? `(${queue.total} in queue)` : ""}`);
          const videoBuf = await generateVideoWithComfyUI(prompt, imageBuf, durationSec);
          lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4";
          backupMedia(videoBuf, `vid-${Date.now()}.mp4`, "video/mp4");
          addSegment(interaction.id, videoBuf);
          generationContext.set(interaction.id, { prompt, videoBuf, imageBuf, type: "video", rootId: interaction.id });
          const tmpVid = `/tmp/create-i2v-${Date.now()}.mp4`;
          fs.writeFileSync(tmpVid, videoBuf);
          await interaction.editReply({ content: `🎬 I2V ${durationSec}s — **LTX Video 2.3**\n> *${prompt.slice(0, 100)}*`, files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(interaction.id) });
          fs.unlink(tmpVid, () => {});
        } else if (model === "story") {
          const segments = 2;
          await interaction.editReply(`📖 Planning story: *"${prompt.slice(0, 60)}"*...`);
          const agentMsg = `Break this story into ${segments} segments of 10 seconds each for video generation. Output ONLY the [COMFYUI_STORY:] token with segment prompts. Story: ${prompt}`;
          const response = await runAgentInSandbox(agentMsg, `dc-${interaction.user.id}-${Date.now().toString(36)}`);
          const storyMatch = response.match(/\[COMFYUI_STORY:\s*([\s\S]*?)\]/i);
          const segRegex = /segment_\d+\s*=\s*"([\s\S]*?)"/gi;
          const segs = [];
          let sm;
          if (storyMatch) while ((sm = segRegex.exec(storyMatch[1])) !== null) segs.push(sm[1].trim());
          if (segs.length < 2) { await interaction.editReply("⚠️ Could not parse story segments."); return; }
          await interaction.editReply(`📖 Rendering ${segs.length} segments...`);
          const results = await generateChainedVideo(segs, [], async (text) => { await interaction.followUp(text).catch(() => {}); });
          for (const { videoBuf, index } of results) {
            const tmpVid = `/tmp/create-story-${Date.now()}-${index}.mp4`;
            fs.writeFileSync(tmpVid, videoBuf);
            await interaction.followUp({ content: `**Segment ${index + 1}/${results.length}**`, files: [new AttachmentBuilder(tmpVid, { name: `segment-${index + 1}.mp4` })] });
            fs.unlink(tmpVid, () => {});
          }
          if (results.length > 0) {
            for (const { videoBuf } of results) addSegment(interaction.id, videoBuf);
            lastVideoBuffer = results[results.length - 1].videoBuf; lastVideoSetAt = Date.now();
            await interaction.followUp({ content: `✅ **Story complete!** Click **Stitch All** to combine.`, components: videoButtons(interaction.id) });
          }
        }
        return;
      }

      // ── /create audio modals ──────────────────────────────────────────────
      if (interaction.customId === "modal_create_aud_music") {
        const tags   = interaction.fields.getTextInputValue("create_tags").trim();
        const lyrics = interaction.fields.getTextInputValue("create_lyrics").trim();
        await interaction.deferReply();
        const queue = await getComfyQueueStatus();
        await interaction.editReply(`🎵 Composing: *"${tags.slice(0, 60)}"*... ${queue.total > 0 ? `(${queue.total} in queue)` : ""}`);
        const audioBuf = await generateMusicWithAceStep(tags, lyrics.replace(/\\n/g, "\n"), 60);
        const tmpMp3 = `/tmp/create-music-${Date.now()}.mp3`;
        fs.writeFileSync(tmpMp3, audioBuf);
        await interaction.editReply({ content: `🎵 *"${tags.slice(0, 60)}"* — **ACE-Step**`, files: [new AttachmentBuilder(tmpMp3, { name: "song.mp3" })], components: [musicButtons(interaction.id)] });
        generationContext.set(interaction.id, { prompt: tags, audioBuf, type: "music" });
        fs.unlink(tmpMp3, () => {});
        return;
      }
      if (interaction.customId === "modal_create_aud_suno") {
        const prompt = interaction.fields.getTextInputValue("create_prompt").trim();
        const style  = (interaction.fields.getTextInputValue("create_style") || "").trim();
        const lyrics = (interaction.fields.getTextInputValue("create_lyrics") || "").trim();
        await interaction.deferReply();
        const displayText = prompt.slice(0, 80) + (style ? ` [${style.slice(0, 40)}]` : "");
        await interaction.editReply(`🎶 Generating with **Suno AI**: *"${displayText}"*...`);
        const sunoOpts = {};
        if (style)  sunoOpts.tags = style;
        if (lyrics) sunoOpts.lyrics = lyrics;
        const tracks = await generateSuno(prompt, sunoOpts);
        if (!tracks || tracks.length === 0) { await interaction.editReply("❌ Suno generation failed."); return; }
        for (const track of tracks) {
          const audioBuf = await downloadSunoAudio(track.audioUrl);
          const tmpMp3 = `/tmp/create-suno-${Date.now()}.mp3`;
          fs.writeFileSync(tmpMp3, audioBuf);
          await interaction.followUp({ content: `🎶 *"${(track.title || prompt).slice(0, 80)}"* — **Suno AI**`, files: [new AttachmentBuilder(tmpMp3, { name: "suno.mp3" })] });
          fs.unlink(tmpMp3, () => {});
        }
        return;
      }

      // ── I2V / Enhance duration modal ───────────────────────────────────────
      const i2vDurMatch = interaction.customId.match(/^modal_i2v_dur_(video|enhance)_(.+)$/);
      if (i2vDurMatch) {
        const mode = i2vDurMatch[1];
        const origMsgId = i2vDurMatch[2];
        const ctx = generationContext.get(origMsgId) || {};
        const durStr = (interaction.fields.getTextInputValue("i2v_duration") || "").trim();
        const durationSec = durStr ? parseInt(durStr, 10) || 10 : 10;

        // Recover image from context or Discord attachment
        let buf = ctx.imageBuf || lastGeneratedImageBuffer;
        if (!buf) {
          const imgAtt = interaction.message?.attachments?.find(a =>
            /\.(png|jpg|jpeg|webp)$/i.test(a.name || "") || (a.contentType || "").startsWith("image/"));
          if (imgAtt?.url) {
            try { buf = await fetch(imgAtt.url).then(r => r.arrayBuffer()).then(b => Buffer.from(b)); } catch {}
          }
        }
        if (!buf) { await interaction.reply({ content: "⚠️ Image not found — generate a new one.", ephemeral: true }); return; }

        const _rlV = checkVideoRateLimit(interaction.user.id);
        if (!_rlV.allowed) { await interaction.reply({ content: `⏳ Video limit hit. Try again in **${_rlV.resetIn} min**.`, ephemeral: true }); return; }

        await interaction.deferReply();
        const rootId = ctx.rootId || origMsgId;

        if (mode === "enhance") {
          const originalPrompt = ctx.prompt || lastPrompt || "cinematic scene";
          try {
            await interaction.editReply(`✨ Enhancing prompt for LTX Video (${durationSec}s)...`);
            const enhanced = await enhanceVideoPrompt(originalPrompt);
            console.log(`[enhance] "${originalPrompt.slice(0, 40)}" → "${enhanced.slice(0, 80)}" (${durationSec}s)`);
            const queue = await getComfyQueueStatus();
            await interaction.editReply(`✨ Enhanced:\n> *${enhanced.slice(0, 200)}*\n\n🎬 Rendering ${durationSec}s... ${queue.total > 0 ? `(${queue.total} in queue)` : ""}`);
            const videoBuf = await generateVideoWithComfyUI(enhanced, buf, durationSec);
            lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4"; try { fs.writeFileSync("/tmp/last_generated_video.mp4", videoBuf); } catch {} backupMedia(videoBuf, `vid-${Date.now()}.mp4`, "video/mp4");
            addSegment(rootId, videoBuf);
            generationContext.set(interaction.message.id, { ...ctx, prompt: enhanced, videoBuf, type: "video", rootId });
            const tmpVid = `/tmp/nemoclaw-enhance-vid-${Date.now()}.mp4`;
            fs.writeFileSync(tmpVid, videoBuf);
            await interaction.followUp({ content: `✨ Enhanced ${durationSec}s — **LTX Video 2.3**\n> *${enhanced.slice(0, 150)}*`, files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(rootId) }).catch(() =>
              interaction.editReply({ content: `✨ Enhanced ${durationSec}s — **LTX Video 2.3**`, files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(rootId) })
            );
            fs.unlinkSync(tmpVid);
          } catch (e) {
            await interaction.followUp(`Enhance+Video failed: ${e.message.slice(0, 200)}`).catch(() =>
              interaction.editReply(`Enhance+Video failed: ${e.message.slice(0, 200)}`)
            );
          }
        } else {
          // video mode
          try {
            const queue = await getComfyQueueStatus();
            await interaction.editReply(`🎬 Making ${durationSec}s video from image... ${queue.total > 0 ? `(${queue.total} in queue)` : ""}`);
            const videoBuf = await generateVideoWithComfyUI(ctx.prompt || "cinematic motion, smooth camera movement", buf, durationSec);
            lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4"; try { fs.writeFileSync("/tmp/last_generated_video.mp4", videoBuf); } catch {} backupMedia(videoBuf, `vid-${Date.now()}.mp4`, "video/mp4");
            addSegment(rootId, videoBuf);
            generationContext.set(interaction.message.id, { ...ctx, videoBuf, type: "video", rootId });
            const tmpVid = `/tmp/nemoclaw-btn-vid-${Date.now()}.mp4`;
            fs.writeFileSync(tmpVid, videoBuf);
            await interaction.followUp({ content: `🎬 ${durationSec}s — **LTX Video 2.3**`, files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(rootId) }).catch(() =>
              interaction.editReply({ content: `🎬 ${durationSec}s — **LTX Video 2.3**`, files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(rootId) })
            );
            fs.unlinkSync(tmpVid);
          } catch (e) {
            await interaction.followUp(`Video render failed: ${e.message.slice(0, 200)}`).catch(() =>
              interaction.editReply(`Video render failed: ${e.message.slice(0, 200)}`)
            );
          }
        }
        return;
      }

      // ── GIF clip modal (start time + duration) ────────────────────────────
      const gifClipMatch = interaction.customId.match(/^modal_gifclip_(.+)$/);
      if (gifClipMatch) {
        const origMsgId = gifClipMatch[1];
        const ctx = generationContext.get(origMsgId) || {};
        const vidBuf = ctx.videoBuf || lastVideoBuffer;
        if (!vidBuf) { await interaction.reply({ content: "⚠️ Video no longer in memory.", ephemeral: true }); return; }
        const startRaw    = interaction.fields.getTextInputValue("gif_start").trim();
        const durationRaw = interaction.fields.getTextInputValue("gif_duration").trim();
        const startSec    = Math.max(0, parseFloat(startRaw) || 0);
        const durSec      = Math.min(Math.max(0.5, parseFloat(durationRaw) || 4), 30);
        await interaction.deferReply();
        try {
          const ffmpeg = findFfmpeg();
          if (!ffmpeg) { await interaction.editReply("⚠️ ffmpeg not found."); return; }
          const tag = Date.now();
          const tmpIn      = `/tmp/nemoclaw-gif-in-${tag}.mp4`;
          const tmpPalette = `/tmp/nemoclaw-palette-${tag}.png`;
          const tmpOut     = `/tmp/nemoclaw-gif-${tag}.gif`;
          fs.writeFileSync(tmpIn, vidBuf);
          execSync(`"${ffmpeg}" -y -ss ${startSec} -t ${durSec} -i ${tmpIn} -vf "fps=10,scale=320:-1:flags=lanczos,palettegen=stats_mode=diff" ${tmpPalette}`, { timeout: 15000 });
          execSync(`"${ffmpeg}" -y -ss ${startSec} -t ${durSec} -i ${tmpIn} -i ${tmpPalette} -lavfi "fps=10,scale=320:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" ${tmpOut}`, { timeout: 30000 });
          const gifBuf = fs.readFileSync(tmpOut);
          const sizeMB = (gifBuf.length / 1024 / 1024).toFixed(1);
          const replyMsg = await interaction.editReply({
            content: `🎞️ **GIF** (${sizeMB} MB, ${durSec}s @ 10fps, start ${startSec}s)`,
            files: [new AttachmentBuilder(tmpOut, { name: "animation.gif" })],
          });
          const replyId = replyMsg.id;
          generationContext.set(replyId, { ...ctx, gifBuf, gifStartSec: startSec, gifDurSec: durSec, type: "gif" });
          try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpPalette); fs.unlinkSync(tmpOut); } catch {}
          console.log(`[gif] created ${sizeMB}MB GIF from ${startSec}s for ${durSec}s`);
        } catch (e) {
          console.error(`[gif] failed: ${e.message}`);
          await interaction.editReply(`⚠️ GIF creation failed: ${e.message.slice(0, 200)}`);
        }
        return;
      }

      // ── Grok edit prompt modal ─────────────────────────────────────────────
      const grokEditMatch = interaction.customId.match(/^modal_grokedit_(\d+)_(.+)$/);
      if (grokEditMatch) {
        const idx = parseInt(grokEditMatch[1]);
        const origMsgId = grokEditMatch[2];
        const ctx = generationContext.get(origMsgId) || generationContext.get(interaction.message?.id) || {};
        const newPrompt = interaction.fields.getTextInputValue("grok_prompt");
        await interaction.deferReply();
        await interaction.editReply(`🎨 Regenerating image ${idx + 1}: *"${newPrompt.slice(0, 60)}"*...`);
        try {
          const localPaths = await runGrokImagine(newPrompt);
          if (!localPaths?.length) { await interaction.editReply("⚠️ Grok generation failed."); return; }
          const imageBufs = localPaths.map(p => fs.readFileSync(p));
          lastGeneratedImageBuffer = imageBufs[0]; lastImageSetAt = Date.now();
          backupMedia(imageBufs[0], `grok-${Date.now()}.png`, "image/png");
          await interaction.editReply({
            content: `🤖 *"${newPrompt.slice(0, 80)}"* — **Grok Aurora** — pick an image:`,
            files: localPaths.map(p => new AttachmentBuilder(p)),
            components: grokGridButtons(origMsgId, localPaths.length),
          });
          generationContext.set(origMsgId, { prompt: newPrompt, type: "grok", imageBufs, imageBuf: imageBufs[0] });
          localPaths.forEach(p => fs.unlink(p, () => {}));
        } catch (e) { await interaction.editReply(`⚠️ Error: ${e.message.slice(0, 200)}`); }
        return;
      }

      // ── Grok video prompt modal ────────────────────────────────────────────
      const grokVidMatch = interaction.customId.match(/^modal_grokvid_(\d+)_(.+)$/);
      if (grokVidMatch) {
        const idx = parseInt(grokVidMatch[1]);
        const origMsgId = grokVidMatch[2];
        const ctx = generationContext.get(origMsgId) || generationContext.get(interaction.message?.id) || {};
        const videoPrompt = interaction.fields.getTextInputValue("grok_vidprompt");
        // Use the actual selected image buffer — no regeneration needed
        const imageBuf = ctx.imageBufs?.[idx] || ctx.imageBuf;
        if (!imageBuf) { await interaction.reply({ content: "⚠️ Image data not found — try selecting the image again.", ephemeral: true }); return; }
        await interaction.deferReply();
        await interaction.editReply(`🎬 Generating Grok video for image ${idx + 1}... (this takes 1-3 min)`);
        try {
          const body = JSON.stringify({ imageBase64: imageBuf.toString("base64"), videoPrompt });
          const videoPath = await new Promise((resolve, reject) => {
            const req = require("http").request(
              { hostname: "127.0.0.1", port: 3091, path: "/generate-video", method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
                timeout: 300000 },
              (res) => {
                let data = "";
                res.on("data", d => data += d);
                res.on("end", () => {
                  try {
                    const j = JSON.parse(data);
                    if (j.path) resolve(j.path); else reject(new Error(j.error || "no video"));
                  } catch (e) { reject(e); }
                });
              }
            );
            req.on("error", reject);
            req.on("timeout", () => { req.destroy(); reject(new Error("grok-server timeout")); });
            req.write(body); req.end();
          });
          if (!videoPath || !fs.existsSync(videoPath)) { await interaction.editReply("⚠️ Grok video generation failed."); return; }
          const videoBuf = fs.readFileSync(videoPath);
          lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4";
          backupMedia(videoBuf, `grok-vid-${Date.now()}.mp4`, "video/mp4");
          const replyId = (await interaction.fetchReply()).id;
          generationContext.set(replyId, { prompt: videoPrompt, videoBuf, type: "grok_video" });
          await interaction.editReply({
            content: `🎬 *"${videoPrompt.slice(0, 60)}"* — **Grok Video**`,
            files: [new AttachmentBuilder(videoPath, { name: "grok-video.mp4" })],
            components: grokVideoButtons(replyId),
          });
          fs.unlink(videoPath, () => {});
        } catch (e) { await interaction.editReply(`⚠️ Grok video error: ${e.message.slice(0, 200)}`); }
        return;
      }

      // ── Grok img2img / img2vid modal — prompt collected, now ask user for image ──
      const grokImg2XMatch = interaction.customId.match(/^modal_grokimg2x_(img|vid)_(.+)$/);
      if (grokImg2XMatch) {
        const isVid = grokImg2XMatch[1] === "vid";
        const prompt = interaction.fields.getTextInputValue("grokimg2x_prompt");
        const key = `${interaction.channelId}-${interaction.user.id}`;
        pendingGrokImg2X.set(key, { action: isVid ? "img2vid" : "img2img", prompt, channelId: interaction.channelId });
        // Clean up after 5 minutes if user doesn't send an image
        setTimeout(() => pendingGrokImg2X.delete(key), 5 * 60 * 1000);
        await interaction.reply({
          content: `📎 Got it! Now **send your source image** in this channel (as an attachment in your next message) and I'll ${isVid ? "animate" : "generate variations of"} it with:\n> *"${prompt.slice(0, 100)}"*`,
          ephemeral: true,
        });
        return;
      }

      // ── Grok extend/upscale modal ──────────────────────────────────────────
      const grokVActMatch = interaction.customId.match(/^modal_grokvact_(extend|upscale)_(.+)$/);
      if (grokVActMatch) {
        const videoAction = grokVActMatch[1];
        const origMsgId = grokVActMatch[2];
        const ctx = generationContext.get(origMsgId) || generationContext.get(interaction.message?.id) || {};
        const actionPrompt = interaction.fields.getTextInputValue("grok_vact_prompt") || "";
        await interaction.deferReply();
        await interaction.editReply(`${videoAction === "extend" ? "➕" : "⬆️"} Running Grok **${videoAction}**... (1-3 min)`);
        try {
          const body = JSON.stringify({ action: videoAction, prompt: actionPrompt });
          const videoPath = await new Promise((resolve, reject) => {
            const req = require("http").request(
              { hostname: "127.0.0.1", port: 3091, path: "/video-action", method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
                timeout: 300000 },
              (res) => {
                let data = "";
                res.on("data", d => data += d);
                res.on("end", () => {
                  try { const j = JSON.parse(data); if (j.path) resolve(j.path); else reject(new Error(j.error || "no video")); }
                  catch (e) { reject(e); }
                });
              }
            );
            req.on("error", reject);
            req.on("timeout", () => { req.destroy(); reject(new Error("grok-server timeout")); });
            req.write(body); req.end();
          });
          if (!videoPath || !fs.existsSync(videoPath)) { await interaction.editReply(`⚠️ Grok ${videoAction} failed.`); return; }
          const videoBuf = fs.readFileSync(videoPath);
          lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4";
          backupMedia(videoBuf, `grok-${videoAction}-${Date.now()}.mp4`, "video/mp4");
          const replyId = (await interaction.fetchReply()).id;
          generationContext.set(replyId, { prompt: ctx.prompt, videoBuf, type: "grok_video" });
          await interaction.editReply({
            content: `${videoAction === "extend" ? "➕" : "⬆️"} **${videoAction.charAt(0).toUpperCase() + videoAction.slice(1)}ed** — **Grok Video**`,
            files: [new AttachmentBuilder(videoPath, { name: `grok-${videoAction}.mp4` })],
            components: grokVideoButtons(replyId),
          });
          fs.unlink(videoPath, () => {});
        } catch (e) {
          const msg = e.message.includes("no longer on screen")
            ? `⚠️ **${videoAction.charAt(0).toUpperCase() + videoAction.slice(1)} failed** — video session expired.\nUse ➕ Extend or ⬆️ Upscale immediately after generating, before any other Grok commands.`
            : `⚠️ Grok ${videoAction} error: ${e.message.slice(0, 200)}`;
          await interaction.editReply(msg);
        }
        return;
      }

      const modalMatch = interaction.customId.match(/^modal_chain_(enhance|raw)_(.+)$/);
      if (modalMatch) {
        const enhance = modalMatch[1] === "enhance";
        const origMsgId = modalMatch[2];
        const ctx = generationContext.get(origMsgId)
          || generationContext.get(interaction.message?.id) || {};
        const modalRootId = ctx.rootId || origMsgId;
        let userPrompt = interaction.fields.getTextInputValue("chain_prompt");

        await interaction.deferReply();
        try {
          // Enhance if requested
          if (enhance) {
            await interaction.editReply(`✨ Enhancing prompt for LTX Video...`);
            userPrompt = await enhanceVideoPrompt(userPrompt);
            console.log(`[chain-custom] enhanced: "${userPrompt.slice(0, 60)}"`);
          }

          // Extract last frame
          // Priority: ctx.videoBuf > Discord attachment > lastVideoBuffer (stale fallback)
          let firstFrame = null;
          let vidBuf = ctx.videoBuf || null;

          // Always try Discord attachment if no ctx (avoids stale lastVideoBuffer)
          if (!vidBuf) {
            const msgAttachments = interaction.message?.attachments;
            const videoAtt = msgAttachments?.find(a => /\.(mp4|mov|webm)$/i.test(a.name || "") || (a.contentType || "").startsWith("video/"));
            if (videoAtt?.url) {
              try {
                console.log(`[chain-custom] downloading video from Discord: ${videoAtt.url}`);
                vidBuf = await fetch(videoAtt.url).then(r => r.arrayBuffer()).then(b => Buffer.from(b));
                lastVideoBuffer = vidBuf; lastVideoSetAt = Date.now();
                if (!storySegments.has(modalRootId) || storySegments.get(modalRootId).length === 0) {
                  addSegment(modalRootId, vidBuf);
                }
                console.log(`[chain-custom] downloaded video from Discord (${vidBuf.length} bytes)`);
              } catch (e) {
                console.warn(`[chain-custom] Discord video download failed: ${e.message}`);
              }
            }
          }

          // Last resort: stale global buffer
          if (!vidBuf && lastVideoBuffer) {
            console.log(`[chain-custom] using lastVideoBuffer fallback (${lastVideoBuffer.length} bytes)`);
            vidBuf = lastVideoBuffer;
          }

          if (vidBuf) {
            try {
              firstFrame = await extractLastFrameFromVideo(vidBuf);
              console.log(`[chain-custom] extracted last frame (${firstFrame.length} bytes)`);
            } catch (e) {
              console.warn(`[chain-custom] frame extraction failed: ${e.message}`);
            }
          }
          if (!firstFrame) {
            await interaction.editReply("⚠️ Couldn't extract last frame. Generate a video first.");
            return;
          }

          // Generate target end-frame with Imagen 4
          let targetFrame = null;
          try {
            await interaction.editReply(`🎨 Generating target end-frame...\n> *${userPrompt.slice(0, 100)}*`);
            // Generate a "what does the end look like" description
            const endDesc = `Final frame of: ${userPrompt.slice(0, 200)}. Still photograph, cinematic composition.`;
            targetFrame = await generateTargetFrameWithImagen(endDesc);
          } catch (e) {
            console.warn(`[chain-custom] Imagen target failed: ${e.message}`);
          }

          // Render
          const queue = await getComfyQueueStatus();
          await interaction.editReply(`🔗 Rendering${enhance ? " (enhanced)" : ""}... ${queue.total > 0 ? `(${queue.total} in queue)` : ""}\n> *${userPrompt.slice(0, 120)}*`);

          let videoBuf;
          if (firstFrame && targetFrame) {
            videoBuf = await generateCombiVideoWithComfyUI(userPrompt, firstFrame, targetFrame);
          } else {
            videoBuf = await generateVideoWithComfyUI(userPrompt, firstFrame);
          }

          lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4"; try { fs.writeFileSync("/tmp/last_generated_video.mp4", videoBuf); } catch {} backupMedia(videoBuf, `vid-${Date.now()}.mp4`, "video/mp4");
          lastGeneratedImageBuffer = null;
          const tmpVid = `/tmp/nemoclaw-chain-custom-${Date.now()}.mp4`;
          fs.writeFileSync(tmpVid, videoBuf);

          addSegment(modalRootId, videoBuf);
          generationContext.set(origMsgId, { prompt: userPrompt, videoBuf, type: "video", rootId: modalRootId });
          await interaction.followUp({
            content: `🔗 **Chained${enhance ? " + Enhanced" : ""}** — **LTX Video 2.3**\n> *${userPrompt.slice(0, 150)}*`,
            files: [new AttachmentBuilder(tmpVid, { name: "chain-video.mp4" })],
            components: videoButtons(modalRootId),
          }).catch(() =>
            interaction.editReply({
              content: `🔗 **Chained** — **LTX Video 2.3**`,
              files: [new AttachmentBuilder(tmpVid, { name: "chain-video.mp4" })],
              components: videoButtons(modalRootId),
            })
          );
          fs.unlinkSync(tmpVid);
        } catch (e) {
          console.error("[chain-custom] failed:", e.message);
          await interaction.followUp(`Chain failed: ${e.message.slice(0, 200)}`).catch(() =>
            interaction.editReply(`Chain failed: ${e.message.slice(0, 200)}`)
          );
        }
      }
      return;
    }

    // ── Slash command interactions ────────────────────────────────
    if (!interaction.isChatInputCommand()) return;

    const cmd = interaction.commandName;

    // /help
    if (cmd === "help") {
      await interaction.reply({
        content: `🤖 **Pipes_AI — Commands**

🎨 **Image & Video**
\`/grok <prompt>\` — Generate an image (Grok Aurora / xAI)
\`/imagine <prompt>\` — Generate an image (Imagen 4 Fast)
\`/video <prompt>\` — Text-to-video (LTX 2.3, ~10s)
\`/combi <prompt>\` — First→last frame video (attach 2 images)
\`/story <plot>\` — Multi-segment story video (20-40s)
\`/music <tags> <lyrics>\` — Generate a song (ACE-Step)

📱 **Social**
\`/post\` — Post last generation to Instagram

🔍 **YouTube**
\`/yt <channel>\` — Search channel's recent videos
\`/transcript <url>\` — Summarize a video
\`/analyze <channel>\` — Batch analyze streams

💬 **Other**
\`/chat <message>\` — Talk to me
\`/ask <query>\` — Search Netify/PipeBox docs (AI-grounded)
\`/model\` — Show active models
\`/queue\` — Show render queue status
\`/help\` — This message

💡 **Tip:** After any generation, use the buttons to make a video, post to IG, regenerate, or save to Drive.

👥 **Team:** You work with **Candy** (Social Media Expert) — she handles trend analysis, content strategy, and social insights. You're the visual specialist for the team.`,
        ephemeral: true,
      });
      return;
    }

    // /model
    if (cmd === "model") {
      await interaction.reply({
        content: `🤖 **Active Models**
💬 Chat: **Gemini 3.1 Flash Lite** (Vertex AI)
🎨 Image: **Imagen 4 Fast** (Vertex AI Cloud)
🎬 Video: **LTX Video 2.3** (ComfyUI, RTX 5080)
🎵 Music: **ACE-Step** (ComfyUI)`,
        ephemeral: true,
      });
      return;
    }

    // /queue
    if (cmd === "queue") {
      const q = await getComfyQueueStatus();
      await interaction.reply({
        content: q.total === 0
          ? "✅ ComfyUI queue is **empty** — ready to render!"
          : `🎬 ComfyUI Queue: **${q.running}** rendering, **${q.pending}** waiting (${q.total} total)`,
        ephemeral: true,
      });
      return;
    }

    // /grok-img2img and /grok-img2vid
    if (cmd === "grok-img2img" || cmd === "grok-img2vid") {
      const isVid = cmd === "grok-img2vid";
      const att = interaction.options.getAttachment("image");
      const prompt = interaction.options.getString("prompt");
      if (!att) { await interaction.reply({ content: "⚠️ Please attach an image.", ephemeral: true }); return; }
      await interaction.deferReply();
      console.log(`[${cmd}] started: prompt="${prompt.slice(0, 60)}" attachment=${att.name} (${att.size} bytes)`);
      await interaction.editReply(`${isVid ? "🎬" : "🖼️"} Processing your image with Grok... (1-3 min)`);
      try {
        const imgBuf = Buffer.from(await fetch(att.url).then(r => r.arrayBuffer()));
        const result = await runGrokImg2X(imgBuf, prompt, isVid ? "img2vid" : "img2img");
        if (result.type === "video") {
          if (!fs.existsSync(result.path)) throw new Error("video file missing");
          const videoBuf = fs.readFileSync(result.path);
          lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4";
          backupMedia(videoBuf, `grok-img2vid-${Date.now()}.mp4`, "video/mp4");
          const replyId = (await interaction.fetchReply()).id;
          generationContext.set(replyId, { prompt, videoBuf, type: "grok_video" });
          await interaction.editReply({ content: `🎬 *"${prompt.slice(0, 60)}"* — **Grok Img2Vid**`, files: [new AttachmentBuilder(result.path, { name: "grok-img2vid.mp4" })], components: grokVideoButtons(replyId) });
          fs.unlink(result.path, () => {});
        } else {
          const imageBufs = result.paths.map(p => { const b = fs.readFileSync(p); fs.unlink(p, () => {}); return b; });
          lastGeneratedImageBuffer = imageBufs[0]; lastImageSetAt = Date.now();
          backupMedia(imageBufs[0], `grok-img2img-${Date.now()}.png`, "image/png");
          const replyId = (await interaction.fetchReply()).id;
          generationContext.set(replyId, { prompt, type: "grok", imageBufs, imageBuf: imageBufs[0] });
          const tmpPaths = imageBufs.map((b, i) => { const p = `/tmp/grok-img2img-slash-${Date.now()}-${i}.png`; fs.writeFileSync(p, b); return p; });
          await interaction.editReply({ content: `🖼️ *"${prompt.slice(0, 80)}"* — **Grok Img2Img** — pick an image:`, files: tmpPaths.map(p => new AttachmentBuilder(p)), components: grokGridButtons(replyId, imageBufs.length) });
          tmpPaths.forEach(p => fs.unlink(p, () => {}));
        }
      } catch (e) {
        console.error(`[${cmd}] error:`, e.message);
        await interaction.editReply(`⚠️ Grok error: ${e.message.slice(0, 200)}`);
      }
      return;
    }

    // /grok
    if (cmd === "grok") {
      const prompt = interaction.options.getString("prompt");
      await interaction.deferReply();
      lastPrompt = prompt;
      try {
        const localPaths = await runGrokImagine(prompt);
        if (!localPaths || localPaths.length === 0) {
          await interaction.editReply("⚠️ Grok generation failed — check logs for details.");
          return;
        }
        // Use first image as the "primary" for backup/buttons, post all as attachments
        const imgBuf = fs.readFileSync(localPaths[0]);
        lastGeneratedImageBuffer = imgBuf; lastImageSetAt = Date.now();
        backupMedia(imgBuf, `grok-${Date.now()}.png`, "image/png");
        const imageBufs = localPaths.map(p => fs.readFileSync(p));
        const files = localPaths.map(p => new AttachmentBuilder(p));
        const replyMsg = await interaction.editReply({
          content: `🤖 *"${prompt.slice(0, 80)}"* — **Grok Aurora** — pick an image:`,
          files,
          components: grokGridButtons(interaction.id, localPaths.length),
        });
        generationContext.set(interaction.id, { prompt, type: "grok", imageBufs, imageBuf: imageBufs[0] });
        localPaths.forEach(p => fs.unlink(p, () => {}));
      } catch (e) {
        console.error("[grok] slash handler error:", e.message);
        await interaction.editReply(`⚠️ Grok error: ${e.message.slice(0, 200)}`);
      }
      return;
    }

    // /imagine
    if (cmd === "imagine") {
      const prompt = interaction.options.getString("prompt");
      const ratio = interaction.options.getString("ratio") || "1:1";
      await interaction.deferReply();
      lastPrompt = prompt; lastRatio = ratio;
      // Add unique token to force fresh generation (prevents sandbox agent cache reuse)
      const uniqueToken = `[gen-${Date.now().toString(36)}]`;
      const agentMsg = `generate image: ${prompt} ${ratio} ${uniqueToken}`;
      const response = await runAgentInSandbox(agentMsg, `dc-${interaction.user.id}-${Date.now().toString(36)}`);
      // Extract only paths generated in THIS session (filter out paths from old messages)
      let imagePaths = extractImagePaths(response);
      // Verify the image was actually modified recently (last 30 seconds)
      const now = Date.now();
      imagePaths = imagePaths.filter(path => {
        try {
          const stats = fs.statSync(path);
          return (now - stats.mtimeMs) < 30000; // Image modified within last 30 seconds
        } catch {
          return false;
        }
      });
      if (imagePaths.length > 0) {
        const localPath = await pullImageFromSandbox(imagePaths[0]);
        if (localPath) {
          lastGeneratedImageBuffer = fs.readFileSync(localPath); lastImageSetAt = Date.now();
          const modelName = extractModelName(response);
          const reply = await interaction.editReply({ content: `🎨 *"${prompt.slice(0, 80)}"* — **${modelName}**`, files: [new AttachmentBuilder(localPath)], components: [imageButtons(interaction.id)] });
          generationContext.set(interaction.id, { prompt, ratio, imageBuf: lastGeneratedImageBuffer, type: "image" });
          fs.unlinkSync(localPath);
          return;
        }
      }
      // Fallback: send text response with model info
      const modelName = extractModelName(response);
      const clean = response.replace(/\/tmp\/[\w\-./]+\.(?:png|jpg|jpeg|gif|webp)/gi, "").trim();
      const errorMsg = clean.slice(0, 1900) || "Image generation failed.";

      // If we know which model failed, include it
      const displayMsg = modelName && modelName !== "Image Generation"
        ? `❌ ${modelName} failed: ${errorMsg}`
        : `❌ ${errorMsg}`;

      await interaction.editReply(displayMsg);
      console.log(`[imagine] generation failed for "${prompt.slice(0, 60)}" — ${modelName || "unknown model"}`);
      return;
    }

    // /zturbo
    if (cmd === "zturbo") {
      const prompt = interaction.options.getString("prompt");
      const style = interaction.options.getString("style") || "none";
      await interaction.deferReply();
      const seed = Math.floor(Math.random() * 2147483647);
      const styleLabel = style !== "none" ? ` — *${style.replace(/-/g, " ")}*` : "";
      await interaction.editReply(`⚡ Generating with ZTurbo${styleLabel}: *"${prompt.slice(0, 60)}"*...`);
      try {
        const imgBuf = await generateImageWithZTurbo(prompt, seed, style);
        const tmpPath = `/tmp/zturbo-${Date.now()}.png`;
        fs.writeFileSync(tmpPath, imgBuf);
        lastGeneratedImageBuffer = imgBuf; lastImageSetAt = Date.now();
        await interaction.editReply({
          content: `⚡ *"${prompt.slice(0, 80)}"*${styleLabel} *(ZImage Turbo)*`,
          files: [new AttachmentBuilder(tmpPath, { name: "zturbo.png" })],
          components: [imageButtons(interaction.id)],
        });
        generationContext.set(interaction.id, { prompt, style, seed, imageBuf: imgBuf, type: "zturbo" });
        fs.unlinkSync(tmpPath);
      } catch (e) {
        console.error("[zturbo] failed:", e.message);
        await interaction.editReply(`❌ ZTurbo failed: ${e.message.slice(0, 200)}`);
      }
      return;
    }

    // /video
    if (cmd === "video") {
      const _rlV = checkVideoRateLimit(interaction.user.id);
      if (!_rlV.allowed) { await interaction.reply({ content: `⏳ You've hit the video limit (${VIDEO_RATE_LIMIT}/hour). Try again in **${_rlV.resetIn} min**.`, ephemeral: true }); return; }
      const prompt = interaction.options.getString("prompt");
      await interaction.deferReply();
      const queue = await getComfyQueueStatus();
      await interaction.editReply(`🎬 Rendering T2V: *"${prompt.slice(0, 60)}"*... ${queue.total > 0 ? `(${queue.total} in queue)` : ""}`);
      try {
        const videoBuf = await generateVideoWithComfyUI(prompt, null);
        lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4"; try { fs.writeFileSync("/tmp/last_generated_video.mp4", videoBuf); } catch {} backupMedia(videoBuf, `vid-${Date.now()}.mp4`, "video/mp4"); lastGeneratedImageBuffer = null;
        addSegment(interaction.id, videoBuf);
        generationContext.set(interaction.id, { prompt, videoBuf, type: "video", rootId: interaction.id });
        const tmpVid = `/tmp/nemoclaw-slash-vid-${Date.now()}.mp4`;
        fs.writeFileSync(tmpVid, videoBuf);
        await interaction.editReply({ content: `🎬 *"${prompt.slice(0, 60)}"* — **LTX Video 2.3**`, files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(interaction.id) });
        fs.unlinkSync(tmpVid);
      } catch (e) {
        await interaction.editReply(`Video render failed: ${e.message.slice(0, 200)}`);
      }
      return;
    }

    // /combi
    if (cmd === "combi") {
      const _rlC = checkVideoRateLimit(interaction.user.id);
      if (!_rlC.allowed) { await interaction.reply({ content: `⏳ You've hit the video limit (${VIDEO_RATE_LIMIT}/hour). Try again in **${_rlC.resetIn} min**.`, ephemeral: true }); return; }
      const prompt = interaction.options.getString("prompt");
      await interaction.deferReply();
      if (lastInputBuffers.length < 2) {
        await interaction.editReply(`⚠️ First/Last frame video needs **2 images** attached to a recent message. I only have ${lastInputBuffers.length} image(s) cached.\n\nSend a message with 2 images attached first, then run \`/combi\`.`);
        return;
      }
      try {
        await interaction.editReply(`🎬 Rendering First→Last frame: *"${prompt.slice(0, 80)}"* — this takes a minute...`);
        const videoBuf = await generateCombiVideoWithComfyUI(prompt, lastInputBuffers[0], lastInputBuffers[1]);
        lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now();
        lastVideoMime = "video/mp4";
        lastGeneratedImageBuffer = null;
        const tmpVid = `/tmp/nemoclaw-combi-${Date.now()}.mp4`;
        fs.writeFileSync(tmpVid, videoBuf);
        addSegment(interaction.id, videoBuf);
        generationContext.set(interaction.id, { prompt, videoBuf, type: "video", rootId: interaction.id });
        const DISCORD_LIMIT = 8 * 1024 * 1024;
        if (videoBuf.length > DISCORD_LIMIT) {
          let videoUrl;
          try {
            videoUrl = await getPublicMediaUrl(videoBuf, "video/mp4");
          } catch (uploadErr) {
            videoUrl = null;
            console.warn("[combi-slash] Catbox upload failed:", uploadErr.message);
          }
          fs.unlinkSync(tmpVid);
          if (videoUrl) {
            await interaction.editReply({ content: `🎬 First→Last frame complete! (video too large for Discord — hosted at Catbox)\n${videoUrl}`, components: videoButtons(interaction.id) });
          } else {
            await interaction.editReply({ content: `🎬 First→Last frame complete! (video too large to upload — ${(videoBuf.length / 1024 / 1024).toFixed(1)}MB)` });
          }
        } else {
          await interaction.editReply({ content: `🎬 First→Last frame complete!`, files: [new AttachmentBuilder(tmpVid, { name: "combi-video.mp4" })], components: videoButtons(interaction.id) });
          fs.unlinkSync(tmpVid);
        }
      } catch (e) {
        console.error("[combi-slash] failed:", e.message, e.stack);
        await interaction.editReply(`First/Last frame video failed: ${e.message}`);
      }
      return;
    }

    // /story
    if (cmd === "story") {
      const _rlS = checkVideoRateLimit(interaction.user.id);
      if (!_rlS.allowed) { await interaction.reply({ content: `⏳ You've hit the video limit (${VIDEO_RATE_LIMIT}/hour). Try again in **${_rlS.resetIn} min**.`, ephemeral: true }); return; }
      const plot = interaction.options.getString("plot");
      const segments = interaction.options.getInteger("segments") || 3;
      await interaction.deferReply();
      // Use agent to break the plot into segments
      const agentMsg = `Break this story into ${segments} segments of 10 seconds each for video generation. Output ONLY the [COMFYUI_STORY:] token with segment prompts. Story: ${plot}`;
      await interaction.editReply(`🎬 Planning ${segments}-segment story: *"${plot.slice(0, 60)}"*...`);
      const response = await runAgentInSandbox(agentMsg, `dc-${interaction.user.id}-${Date.now().toString(36)}`);
      // The response should contain [COMFYUI_STORY:...] which the existing handler will process
      // For slash commands, we need to handle it here
      const storyMatch = response.match(/\[COMFYUI_STORY:\s*([\s\S]*?)\]/i);
      if (storyMatch) {
        const segRegex = /segment_\d+\s*=\s*"([\s\S]*?)"/gi;
        const segs = [];
        let m;
        while ((m = segRegex.exec(storyMatch[1])) !== null) segs.push(m[1].trim());
        if (segs.length >= 2) {
          const queue = await getComfyQueueStatus();
          await interaction.editReply(`🎬 **Chained Narrative** — ${segs.length} segments, ~${segs.length * 10}s total. ${queue.total > 0 ? `(${queue.total} in queue)` : ""}\nRendering...`);
          try {
            const results = await generateChainedVideo(segs, lastInputBuffers.length > 0 ? lastInputBuffers : [], async (text) => {
              await interaction.followUp(text).catch(() => {});
            });
            for (const { videoBuf, index } of results) {
              const tmpVid = `/tmp/nemoclaw-story-slash-${Date.now()}-seg${index}.mp4`;
              fs.writeFileSync(tmpVid, videoBuf);
              await interaction.followUp({ content: `**Segment ${index + 1}/${results.length}**`, files: [new AttachmentBuilder(tmpVid, { name: `segment-${index + 1}.mp4` })] });
              fs.unlinkSync(tmpVid);
            }
            if (results.length > 0) {
              lastVideoBuffer = results[results.length - 1].videoBuf; lastVideoSetAt = Date.now();
              lastVideoMime = "video/mp4";
              // Store all segments for stitching
              for (const { videoBuf } of results) addSegment(interaction.id, videoBuf);
            }
            await interaction.followUp({ content: `✅ **Story complete!** ${results.length} segments rendered. Click **Stitch All** to combine into one video.`, components: videoButtons(interaction.id) });
          } catch (e) {
            await interaction.followUp(`Story render failed: ${e.message.slice(0, 200)}`);
          }
        } else {
          await interaction.editReply(`Agent couldn't break the story into segments. Try being more specific about the plot.`);
        }
      } else {
        await interaction.editReply(response.slice(0, 1900) || "Story planning failed.");
      }
      return;
    }

    // /music
    if (cmd === "music") {
      const tags = interaction.options.getString("tags");
      const lyrics = interaction.options.getString("lyrics");
      const duration = interaction.options.getInteger("duration") || 60;
      await interaction.deferReply();
      const queue = await getComfyQueueStatus();
      await interaction.editReply(`🎵 Composing: *"${tags.slice(0, 60)}"*... ${queue.total > 0 ? `(${queue.total} in queue)` : ""}`);
      try {
        const audioBuf = await generateMusicWithAceStep(tags, lyrics.replace(/\\n/g, "\n"), duration);
        const tmpMp3 = `/tmp/nemoclaw-slash-music-${Date.now()}.mp3`;
        fs.writeFileSync(tmpMp3, audioBuf);
        await interaction.editReply({ content: `🎵 *"${tags.slice(0, 60)}"* — **ACE-Step**`, files: [new AttachmentBuilder(tmpMp3, { name: "song.mp3" })], components: [musicButtons(interaction.id)] });
        generationContext.set(interaction.id, { prompt: tags, audioBuf, type: "music" });
        fs.unlinkSync(tmpMp3);
      } catch (e) {
        await interaction.editReply(`Music generation failed: ${e.message.slice(0, 200)}`);
      }
      return;
    }

    // /suno
    if (cmd === "suno") {
      const prompt       = interaction.options.getString("prompt");
      const tags         = interaction.options.getString("tags") || "";
      const instrumental = interaction.options.getBoolean("instrumental") || false;
      let   lyrics       = interaction.options.getString("lyrics") || "";
      const genLyrics    = interaction.options.getBoolean("gen_lyrics") || false;
      const model        = interaction.options.getString("model") || "chirp-fenix";
      await interaction.deferReply();

      // Auto-generate lyrics if requested
      if (genLyrics && !lyrics) {
        await interaction.editReply(`✍️ Generating lyrics for *"${prompt.slice(0, 60)}"*...`);
        try {
          const generated = await generateSunoLyrics(prompt);
          lyrics = generated.text;
          await interaction.editReply(`✍️ Lyrics ready — composing song...`);
        } catch (e) {
          await interaction.editReply(`⚠️ Lyrics generation failed: ${e.message.slice(0, 200)}`);
          return;
        }
      } else {
        await interaction.editReply(`🎵 Generating with **Suno AI**: *"${prompt.slice(0, 80)}"*...`);
      }

      try {
        const tracks = await generateSuno(prompt, { tags, instrumental, lyrics: lyrics || undefined, model });
        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          console.log(`[suno] track ${i + 1}: ${track.title} — ${track.audioUrl}`);
          const audioBuf = await downloadSunoAudio(track.audioUrl);
          const tmpMp3   = `/tmp/nemoclaw-suno-${Date.now()}.mp3`;
          fs.writeFileSync(tmpMp3, audioBuf);
          const label = tracks.length > 1 ? ` (${i + 1}/${tracks.length})` : "";
          const content = `🎵 **${track.title || prompt.slice(0, 60)}**${label}${track.tags ? ` — *${track.tags.slice(0, 60)}*` : ""}`;
          const ctxKey  = `suno-${Date.now()}-${i}`;
          const replyFn = i === 0 ? interaction.editReply.bind(interaction) : interaction.followUp.bind(interaction);
          await replyFn({ content, files: [new AttachmentBuilder(tmpMp3, { name: "suno.mp3" })], components: [musicButtons(ctxKey)] });
          generationContext.set(ctxKey, { prompt, audioBuf, type: "suno", clipId: track.id, trackTitle: track.title });
          try { fs.unlinkSync(tmpMp3); } catch {}
          backupMedia(audioBuf, `suno-${Date.now()}.mp3`, "audio/mpeg");
        }
      } catch (e) {
        console.error(`[suno] failed: ${e.message}`);
        await interaction.editReply(`⚠️ Suno generation failed: ${e.message.slice(0, 200)}`);
      }
      return;
    }

    // /combine — replace video audio with uploaded audio file
    if (cmd === "combine") {
      const videoAtt = interaction.options.getAttachment("video");
      const audioAtt = interaction.options.getAttachment("audio");
      await interaction.deferReply();
      try {
        const ts     = Date.now();
        const vidExt = (videoAtt.name || "video.mp4").match(/\.\w+$/)?.[0] || ".mp4";
        const audExt = (audioAtt.name || "audio.mp3").match(/\.\w+$/)?.[0] || ".mp3";
        const tmpVid = `/tmp/combine-vid-${ts}${vidExt}`;
        const tmpAud = `/tmp/combine-aud-${ts}${audExt}`;
        const tmpOut = `/tmp/combine-out-${ts}.mp4`;

        const [vidBuf, audBuf] = await Promise.all([
          fetchBuffer(videoAtt.url),
          fetchBuffer(audioAtt.url),
        ]);
        fs.writeFileSync(tmpVid, vidBuf);
        fs.writeFileSync(tmpAud, audBuf);

        const { execSync } = require("child_process");
        let ffmpeg = "/home/nemoclaw/.local/bin/ffmpeg";
        try { execSync("which ffmpeg", { encoding: "utf-8", timeout: 3000 }); ffmpeg = "ffmpeg"; } catch {}

        // -stream_loop -1 loops audio so it always covers the full video length
        // -shortest cuts output to whichever stream ends first (video length wins)
        // -c:v copy keeps video quality intact, re-encodes audio to aac for compatibility
        execSync(
          `"${ffmpeg}" -y -i "${tmpVid}" -stream_loop -1 -i "${tmpAud}" ` +
          `-map 0:v:0 -map 1:a:0 -shortest -c:v copy -c:a aac -b:a 192k "${tmpOut}"`,
          { timeout: 120000 }
        );

        const outBuf  = fs.readFileSync(tmpOut);
        const outName = (videoAtt.name || "combined").replace(/\.\w+$/, "") + "-combined.mp4";
        [tmpVid, tmpAud, tmpOut].forEach(f => { try { fs.unlinkSync(f); } catch {} });

        await interaction.editReply({
          content: `🎬🎵 Audio replaced — video length preserved`,
          files: [new AttachmentBuilder(outBuf, { name: outName })],
        });
        console.log(`[combine] done: ${outBuf.length} bytes`);
      } catch (e) {
        console.error(`[combine] failed: ${e.message}`);
        await interaction.editReply(`⚠️ Combine failed: ${e.message.slice(0, 200)}`);
      }
      return;
    }

    // /post
    if (cmd === "post") {
      const OWNER_ID = OWNER_ID_GLOBAL;
      if (interaction.user.id !== OWNER_ID) {
        await interaction.reply({ content: "⚠️ Only the bot owner can post to social media.", ephemeral: true });
        return;
      }
      const caption = interaction.options.getString("caption") || "Fresh AI content 🤖 #AI #SlopFactory9000 #GenerativeArt";
      const channel = interaction.options.getString("channel") || "instagram";
      await interaction.deferReply();
      const mediaBuf = lastVideoBuffer || lastGeneratedImageBuffer;
      const mime = lastVideoBuffer ? "video/mp4" : "image/png";
      if (!mediaBuf) {
        await interaction.editReply("⚠️ Nothing to post. Generate something first with `/imagine` or `/video`.");
        return;
      }
      try {
        const results = await postToBuffer({ text: caption, mediaBuffer: mediaBuf, mimeType: mime, channels: channel.split(",") });
        const ok = results.filter(r => !r.error).map(r => r.channelId === BUFFER_IG_ID ? "Instagram" : "YouTube");
        const bad = results.filter(r => r.error);
        let statusMsg = ok.length ? `✅ Posted to ${ok.join(" + ")}!` : "";
        if (bad.length) statusMsg += ` ⚠️ Failed: ${bad.map(r => r.error).join(", ")}`;
        await interaction.editReply(statusMsg || "Done.");
      } catch (e) {
        await interaction.editReply(`Post failed: ${e.message.slice(0, 200)}`);
      }
      return;
    }

    // /yt
    if (cmd === "yt") {
      const channel = interaction.options.getString("channel");
      const type = interaction.options.getString("type") || "all";
      const max = interaction.options.getInteger("max") || 5;
      await interaction.deferReply();
      const agentMsg = `python3 /sandbox/.openclaw-data/workspace/skills/youtube-watcher/scripts/search_channel.py "${channel}" --type ${type} --max ${max}`;
      const response = await runAgentInSandbox(agentMsg, `dc-${interaction.user.id}-${Date.now().toString(36)}`);
      await interaction.editReply(response.slice(0, 1900) || "No results found.");
      return;
    }

    // /transcript
    if (cmd === "transcript") {
      const url = interaction.options.getString("url");
      await interaction.deferReply();
      // Pipe through head -c to cap transcript at ~12K chars before it enters context.
      // Full transcripts can be 100K+ chars for long videos — most of that is waste.
      const agentMsg = `Run this command and summarize the output: python3 /sandbox/.openclaw-data/workspace/skills/youtube-watcher/scripts/get_transcript.py "${url}" 2>&1 | head -c 12000`;
      const response = await runAgentInSandbox(agentMsg, `dc-${interaction.user.id}-${Date.now().toString(36)}`);
      for (let i = 0; i < response.length; i += 1900) {
        if (i === 0) await interaction.editReply(response.slice(i, i + 1900));
        else await interaction.followUp(response.slice(i, i + 1900));
      }
      return;
    }

    // /analyze
    if (cmd === "analyze") {
      const channel = interaction.options.getString("channel");
      const count = interaction.options.getInteger("count") || 10;
      const type = interaction.options.getString("type") || "all";
      await interaction.deferReply();
      await interaction.editReply(`📊 Analyzing ${count} ${type === "live" ? "livestreams" : "videos"} from **${channel}**... (this may take a minute)`);
      // Cap batch transcript output at ~40K chars — enough for 10-video analysis
      // without flooding the context window with raw transcript text.
      const agentMsg = `Run this command, then analyze ALL the transcripts and provide a detailed report:\npython3 /sandbox/.openclaw-data/workspace/skills/youtube-watcher/scripts/batch_transcripts.py "${channel}" --type ${type} --max ${count} 2>&1 | head -c 40000`;
      const response = await runAgentInSandbox(agentMsg, `dc-${interaction.user.id}-${Date.now().toString(36)}`);
      for (let i = 0; i < response.length; i += 1900) {
        if (i === 0) await interaction.editReply(response.slice(i, i + 1900));
        else await interaction.followUp(response.slice(i, i + 1900));
      }
      return;
    }

    // /chat
    // /ask — Vertex AI Search grounded answer
    if (cmd === "ask") {
      const query = interaction.options.getString("query");
      await interaction.deferReply();
      try {
        const vToken = await getVertexToken();
        if (!vToken) throw new Error("Failed to get Vertex AI token");
        const body = JSON.stringify({
          query: { text: query },
          answerGenerationSpec: {
            modelSpec: { modelVersion: "gemini-2.0-flash" },
            includeCitations: true,
          },
        });
        const result = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: "discoveryengine.googleapis.com",
            path: "/v1/projects/drivenemo/locations/global/collections/default_collection/engines/netify-kb-engine/servingConfigs/default_search:answer",
            method: "POST",
            headers: {
              Authorization: `Bearer ${vToken}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          }, res => {
            let raw = ""; res.on("data", c => raw += c);
            res.on("end", () => {
              try { resolve(JSON.parse(raw)); } catch { reject(new Error(raw.slice(0, 300))); }
            });
          });
          req.on("error", reject);
          req.write(body); req.end();
        });

        // Parse the answer
        let answerText = result.answer?.answerText || result.answer?.answer || "";
        if (!answerText && result.error) throw new Error(result.error.message || "Search API error");
        if (!answerText) answerText = "No grounded answer found for that query.";

        // Extract cited sources
        const citations = [];
        const refs = result.answer?.citations || [];
        for (const cite of refs) {
          for (const src of (cite.sources || [])) {
            const docName = src.referenceId || src.document || "";
            if (docName && !citations.includes(docName)) citations.push(docName);
          }
        }

        let reply = `**Q:** ${query}\n\n${answerText}`;
        if (citations.length > 0) {
          reply += `\n\n📚 **Sources:** ${citations.map(c => `\`${c}\``).join(", ")}`;
        }

        // Split if long
        for (let i = 0; i < reply.length; i += 1900) {
          if (i === 0) await interaction.editReply(reply.slice(i, i + 1900));
          else await interaction.followUp(reply.slice(i, i + 1900));
        }
      } catch (e) {
        await interaction.editReply(`Grounded search failed: ${e.message.slice(0, 300)}`);
      }
      return;
    }

    if (cmd === "chat") {
      const message = interaction.options.getString("message");
      await interaction.deferReply();
      const response = await runAgentInSandbox(
        `[Discord User: @${interaction.user.username} (ID: ${interaction.user.id})]\n${message}`,
        `dc-${interaction.user.id}-${Date.now().toString(36)}`
      );
      const clean = response.replace(/\b\d{17,19}\b/g, "[user]");
      for (let i = 0; i < clean.length; i += 1900) {
        if (i === 0) await interaction.editReply(clean.slice(i, i + 1900));
        else await interaction.followUp(clean.slice(i, i + 1900));
      }
      return;
    }

    // /edit-add — add media to the per-user edit queue
    if (cmd === "edit-add") {
      const q = getEditQueue(interaction.user.id);
      const slots = ["media1", "media2", "media3", "media4", "media5"];
      let added = 0;
      for (const slot of slots) {
        const att = interaction.options.getAttachment(slot);
        if (!att) continue;
        try {
          const buf = Buffer.from(await fetch(att.url).then(r => r.arrayBuffer()));
          const mime = (att.contentType || "").toLowerCase();
          if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(att.name || "")) q.audios.push(buf);
          else if (mime.startsWith("video/") || /\.(mp4|mov|webm|avi|mkv)$/i.test(att.name || "")) q.videos.push(buf);
          else q.images.push(buf);
          added++;
        } catch (e) { console.error(`[edit-add] fetch failed: ${att.name}`, e.message); }
      }
      q.updatedAt = Date.now();
      const total = q.images.length + q.videos.length + q.audios.length;
      await interaction.reply({ content: `📥 Added **${added}** file${added !== 1 ? "s" : ""}. Queue: **${editQueueSummary(q)}** (${total} total)\n\nUse \`/edit-add\` for more, \`/edit-go\` to render, \`/edit-queue\` to preview.`, ephemeral: true });
      return;
    }

    // /edit-queue — show queue contents
    if (cmd === "edit-queue") {
      const q = editQueues.get(interaction.user.id);
      if (!q || (q.images.length === 0 && q.videos.length === 0 && q.audios.length === 0)) {
        await interaction.reply({ content: "📭 Your edit queue is empty. Use `/edit-add` to add files.", ephemeral: true });
        return;
      }
      const age = Math.round((Date.now() - q.updatedAt) / 60000);
      const total = q.images.length + q.videos.length + q.audios.length;
      const expireMin = Math.max(0, 30 - age);
      await interaction.reply({ content: `📋 **Edit Queue** — ${editQueueSummary(q)} (${total} files)\nLast updated: ${age}m ago (expires in ${expireMin}m)\n\nUse \`/edit-go\` to render or \`/edit-clear\` to reset.`, ephemeral: true });
      return;
    }

    // /edit-clear — clear the queue
    if (cmd === "edit-clear") {
      clearEditQueue(interaction.user.id);
      await interaction.reply({ content: "🗑️ Edit queue cleared.", ephemeral: true });
      return;
    }

    // /edit-go — render everything in the queue
    if (cmd === "edit-go") {
      const q = editQueues.get(interaction.user.id);
      if (!q || (q.images.length === 0 && q.videos.length === 0 && q.audios.length === 0)) {
        await interaction.reply({ content: "📭 Queue is empty. Use `/edit-add` to add files first.", ephemeral: true });
        return;
      }
      const preset = interaction.options.getString("preset") || "short";
      const style = interaction.options.getString("style") || "cinematic";
      const caption = interaction.options.getString("caption") || null;
      await interaction.deferReply();

      const images = [...q.images];
      const videos = [...q.videos];
      const audios = [...q.audios];
      clearEditQueue(interaction.user.id);

      const mediaDesc = [images.length && `${images.length} img`, videos.length && `${videos.length} vid`, audios.length && `🎵`].filter(Boolean).join(" + ");
      await interaction.editReply(`🎬 Composing **${preset}** video *(${style})* — ${mediaDesc}...`);

      try {
        const { editVideo } = require("./lib/video-editor");
        const result = await editVideo({ images, videos, audioBuffer: audios[0] || null, preset, style, caption });
        const tmpOut = `/tmp/edit-queue-${Date.now()}.mp4`;
        fs.writeFileSync(tmpOut, result.videoBuffer);
        const sizeMB = (result.videoBuffer.length / 1024 / 1024).toFixed(1);
        const durStr = result.totalDurationSec.toFixed(1);
        await interaction.editReply({
          content: `🎬 **Edited** — ${durStr}s ${preset} *(${style}, ${sizeMB}MB)*`,
          files: [new AttachmentBuilder(tmpOut, { name: `edit-${preset}.mp4` })],
          components: videoButtons(interaction.id),
        });
        lastVideoBuffer = result.videoBuffer; lastVideoSetAt = Date.now();
        lastVideoMime = "video/mp4";
        generationContext.set(interaction.id, { type: "video", videoBuf: result.videoBuffer, prompt: caption || `${preset} ${style} edit` });
        try { fs.unlinkSync(tmpOut); } catch {}
      } catch (e) {
        console.error("[edit-go] failed:", e);
        await interaction.editReply(`❌ Edit failed: ${e.message.slice(0, 300)}`);
      }
      return;
    }

    // /edit — compose video from images, clips, and music
    if (cmd === "edit") {
      await interaction.deferReply();
      const preset  = interaction.options.getString("preset") || "short";
      const style   = interaction.options.getString("style") || "cinematic";
      const caption = interaction.options.getString("caption") || null;

      // Collect media from attachments
      const attachments = ["media1", "media2", "media3", "media4", "audio"]
        .map(k => interaction.options.getAttachment(k)).filter(Boolean);

      const images = [], videos = [], audios = [];
      for (const att of attachments) {
        const buf = await fetchBuffer(att.url);
        const mime = (att.contentType || "").toLowerCase();
        if (mime.startsWith("image/")) images.push(buf);
        else if (mime.startsWith("video/")) videos.push(buf);
        else if (mime.startsWith("audio/")) audios.push(buf);
      }

      // Fallback to previously generated media
      if (images.length === 0 && lastGeneratedImageBuffer) images.push(lastGeneratedImageBuffer);
      if (videos.length === 0 && lastVideoBuffer) videos.push(lastVideoBuffer);
      if (audios.length === 0) {
        for (const [, ctx] of generationContext) {
          if (ctx.audioBuf && (ctx.type === "music" || ctx.type === "suno")) { audios.push(ctx.audioBuf); break; }
        }
      }

      if (images.length === 0 && videos.length === 0) {
        await interaction.editReply("❌ No media found. Attach files or generate images/videos first with `/imagine`, `/video`, `/music`.");
        return;
      }

      const mediaDesc = [images.length && `${images.length} img`, videos.length && `${videos.length} vid`, audios.length && `🎵`].filter(Boolean).join(" + ");
      await interaction.editReply(`🎬 Composing **${preset}** video *(${style})* — ${mediaDesc}...`);

      try {
        const { editVideo } = require("./lib/video-editor");
        const result = await editVideo({
          images, videos, audioBuffer: audios[0] || null,
          preset, style, caption,
        });

        const tmpOut = `/tmp/edit-out-${Date.now()}.mp4`;
        fs.writeFileSync(tmpOut, result.videoBuffer);
        const sizeMB = (result.videoBuffer.length / 1024 / 1024).toFixed(1);
        const durStr = result.totalDurationSec.toFixed(1);

        await interaction.editReply({
          content: `🎬 **Edited** — ${durStr}s ${preset} *(${style}, ${sizeMB}MB)*`,
          files: [new AttachmentBuilder(tmpOut, { name: `edit-${preset}.mp4` })],
          components: videoButtons(interaction.id),
        });

        lastVideoBuffer = result.videoBuffer; lastVideoSetAt = Date.now();
        lastVideoMime = "video/mp4";
        generationContext.set(interaction.id, { type: "video", videoBuf: result.videoBuffer, prompt: caption || `${preset} ${style} edit` });
        try { fs.unlinkSync(tmpOut); } catch {}
      } catch (e) {
        console.error("[edit] failed:", e);
        await interaction.editReply(`❌ Edit failed: ${e.message.slice(0, 300)}`);
      }
      return;
    }

    // /create — media type + model picker menu
    if (cmd === "create") {
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("create_type")
          .setPlaceholder("What do you want to create?")
          .addOptions([
            { label: "Image",  value: "image",  description: "Generate a still image",   emoji: "🎨" },
            { label: "Video",  value: "video",  description: "Generate a video clip",     emoji: "🎬" },
            { label: "Audio",  value: "audio",  description: "Generate music or a song",  emoji: "🎵" },
            { label: "Edit",   value: "edit",   description: "Compose a video from images, clips & music", emoji: "🎞" },
          ])
      );
      await interaction.reply({ content: "✨ **Create** — what type?", components: [row], ephemeral: true });
      return;
    }

  } catch (e) {
    console.error("[slash] interaction error:", e.message);
    const reply = interaction.deferred || interaction.replied
      ? (m) => interaction.editReply(m).catch(() => interaction.followUp(m).catch(() => {}))
      : (m) => interaction.reply({ content: m, ephemeral: true }).catch(() => {});
    await reply(`Error: ${e.message.slice(0, 200)}`);
  }
});

const roastAgentBusy = new Map();     // per-user lock — prevents concurrent agent calls
let lastRoastTargetMessage = ""; // cache their last message for context

const isCommandAttempt = bu.isCommandAttempt;

// ══════════════════════════════════════════════════════════════════════════════
// ── ARCHITECT TASK QUEUE SYSTEM ───────────────────────────────────────────────
// Async task submission and result polling for Nemo (Terminus Architect)
// ══════════════════════════════════════════════════════════════════════════════

const TASKS_FILE = path.join(os.homedir(), ".nemoclaw", "tasks.jsonl");
const RESULTS_FILE = path.join(os.homedir(), ".nemoclaw", "results.jsonl");

// Ensure queue files exist
function ensureQueueFiles() {
  try {
    const queueDir = path.dirname(TASKS_FILE);
    if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });
    if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, "");
    if (!fs.existsSync(RESULTS_FILE)) fs.writeFileSync(RESULTS_FILE, "");
  } catch (e) {
    console.error("[architect] Failed to ensure queue files:", e.message);
  }
}

ensureQueueFiles();

/**
 * Submit a task to the Architect (Nemo)
 * @param {string} type — Task type (validateOutcome, calculateOdds, generateDrop, auditLogic)
 * @param {object} payload — Task-specific data
 * @returns {string} taskId for result polling
 */
function submitTask(type, payload) {
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const task = {
    taskId,
    type,
    payload,
    status: "submitted",
    submittedAt: new Date().toISOString(),
  };

  try {
    const line = JSON.stringify(task) + "\n";
    fs.appendFileSync(TASKS_FILE, line);
    console.log(`[architect-queue] Submitted task ${taskId} (${type})`);
    return taskId;
  } catch (e) {
    console.error(`[architect-queue] Failed to submit task:`, e.message);
    throw e;
  }
}

/**
 * Wait for result from Architect with timeout
 * @param {string} taskId — Task ID returned from submitTask()
 * @param {number} timeoutMs — Max wait time (default 30000ms = 30s)
 * @returns {object} Result object or null if timeout
 */
async function waitForResult(taskId, timeoutMs = 30000) {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const pollInterval = setInterval(() => {
      try {
        if (!fs.existsSync(RESULTS_FILE)) {
          clearInterval(pollInterval);
          resolve(null);
          return;
        }

        const resultsContent = fs.readFileSync(RESULTS_FILE, "utf8");
        const resultLines = resultsContent.split("\n").filter((line) => line.trim());

        for (const line of resultLines) {
          try {
            const result = JSON.parse(line);
            if (result.taskId === taskId) {
              clearInterval(pollInterval);
              console.log(`[architect-queue] Result for ${taskId}: ${result.result}`);
              resolve(result);
              return;
            }
          } catch (e) {
            // Skip malformed lines
          }
        }

        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(pollInterval);
          console.warn(`[architect-queue] Timeout waiting for ${taskId}`);
          resolve(null);
          return;
        }
      } catch (e) {
        console.error(`[architect-queue] Poll error:`, e.message);
      }
    }, 500); // Poll every 500ms
  });
}

/**
 * Helper: Submit task and wait for result synchronously
 * @param {string} type — Task type
 * @param {object} payload — Task data
 * @param {number} timeoutMs — Timeout
 * @returns {object} Result or null if timeout/error
 */
async function submitAndWait(type, payload, timeoutMs = 30000) {
  try {
    const taskId = submitTask(type, payload);
    const result = await waitForResult(taskId, timeoutMs);
    return result;
  } catch (e) {
    console.error(`[architect-queue] submitAndWait failed:`, e.message);
    return null;
  }
}

client.on("messageCreate", async (msg) => {
  // Allow bot messages prefixed with [CLAUDE_QUERY] — these are from the swarm orchestrator
  const isClaudeQuery = msg.author.bot && msg.content?.startsWith("[CLAUDE_QUERY]");
  // Ignore all other bots
  if (msg.author.bot && !isClaudeQuery) return;

  const entry = ALLOWED_CHANNELS.find(
    (e) => e.guildId === msg.guildId && e.channelId === msg.channelId
  );
  if (!entry) return;
  health.msgIn++;

  // ── !edit message command — up to 10 attachments ────────────────────────────
  if (msg.content && msg.content.toLowerCase().startsWith("!edit") && !isClaudeQuery) {
    const args = msg.content.slice(5).trim().split(/\s+/);
    const PRESET_NAMES = ["short", "short-long", "full", "full-long", "vertical", "vertical-long"];
    const STYLE_NAMES = ["cinematic", "vibrant", "moody", "vintage", "dark", "dreamy", "bright", "clean", "brainslop", "ludicrous"];
    let preset = "short", style = "cinematic", captionParts = [];
    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (PRESET_NAMES.includes(lower)) preset = lower;
      else if (STYLE_NAMES.includes(lower)) style = lower;
      else captionParts.push(arg);
    }
    const caption = captionParts.join(" ") || null;

    const images = [], videos = [], audios = [];
    for (const [, att] of msg.attachments) {
      try {
        const buf = Buffer.from(await fetch(att.url).then(r => r.arrayBuffer()));
        const mime = (att.contentType || "").toLowerCase();
        if (mime.startsWith("image/")) images.push(buf);
        else if (mime.startsWith("video/")) videos.push(buf);
        else if (mime.startsWith("audio/")) audios.push(buf);
        else if (/\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(att.name || "")) audios.push(buf);
        else if (/\.(mp4|mov|webm|avi|mkv)$/i.test(att.name || "")) videos.push(buf);
        else if (/\.(png|jpg|jpeg|gif|webp|avif)$/i.test(att.name || "")) images.push(buf);
      } catch (e) { console.error(`[!edit] failed to fetch attachment ${att.name}:`, e.message); }
    }

    // Also pull from edit queue if user has one
    const q = editQueues.get(msg.author.id);
    if (q && Date.now() - q.updatedAt < EDIT_QUEUE_EXPIRY) {
      images.push(...q.images);
      videos.push(...q.videos);
      audios.push(...q.audios);
      clearEditQueue(msg.author.id);
    }

    // Fallback to recent generations
    if (images.length === 0 && lastGeneratedImageBuffer) images.push(lastGeneratedImageBuffer);
    if (videos.length === 0 && lastVideoBuffer) videos.push(lastVideoBuffer);
    if (audios.length === 0) {
      for (const [, ctx] of generationContext) {
        if (ctx.audioBuf && (ctx.type === "music" || ctx.type === "suno")) { audios.push(ctx.audioBuf); break; }
      }
    }

    if (images.length === 0 && videos.length === 0) {
      await msg.reply("❌ No media found. Attach files or generate some first.");
      return;
    }

    const mediaDesc = [images.length && `${images.length} img`, videos.length && `${videos.length} vid`, audios.length && `🎵`].filter(Boolean).join(" + ");
    const progressMsg = await msg.reply(`🎬 Composing **${preset}** video *(${style})* — ${mediaDesc}...`);

    try {
      const { editVideo } = require("./lib/video-editor");
      const result = await editVideo({ images, videos, audioBuffer: audios[0] || null, preset, style, caption });
      const tmpOut = `/tmp/edit-msg-${Date.now()}.mp4`;
      fs.writeFileSync(tmpOut, result.videoBuffer);
      const sizeMB = (result.videoBuffer.length / 1024 / 1024).toFixed(1);
      const durStr = result.totalDurationSec.toFixed(1);
      const DISCORD_LIMIT = 8 * 1024 * 1024;
      if (result.videoBuffer.length > DISCORD_LIMIT) {
        let videoUrl;
        try {
          const gdrive = require("./google-drive");
          const folderId = process.env.GDRIVE_MEDIA_FOLDER_ID || process.env.GDRIVE_FOLDER_ID || "";
          const driveResult = await gdrive.uploadToDrive(tmpOut, "video/mp4", `edit-${preset}-${Date.now()}.mp4`, folderId);
          videoUrl = driveResult.webViewLink;
        } catch (uploadErr) {
          console.warn("[!edit] GDrive failed, trying Catbox:", uploadErr.message);
          try { videoUrl = await getPublicMediaUrl(result.videoBuffer, "video/mp4"); } catch { videoUrl = null; }
        }
        try { fs.unlinkSync(tmpOut); } catch {}
        if (videoUrl) {
          await progressMsg.edit({ content: `🎬 **Edited** — ${durStr}s ${preset} *(${style}, ${sizeMB}MB)*\n${videoUrl}`, components: videoButtons(progressMsg.id) });
        } else {
          await progressMsg.edit({ content: `🎬 **Edited** — ${durStr}s ${preset} *(${style})* — too large to upload (${sizeMB}MB)` });
        }
      } else {
        await progressMsg.edit({
          content: `🎬 **Edited** — ${durStr}s ${preset} *(${style}, ${sizeMB}MB)*`,
          files: [new AttachmentBuilder(tmpOut, { name: `edit-${preset}.mp4` })],
          components: videoButtons(progressMsg.id),
        });
        try { fs.unlinkSync(tmpOut); } catch {}
      }
      lastVideoBuffer = result.videoBuffer; lastVideoSetAt = Date.now();
      lastVideoMime = "video/mp4";
      generationContext.set(progressMsg.id, { type: "video", videoBuf: result.videoBuffer, prompt: caption || `${preset} ${style} edit` });
    } catch (e) {
      console.error("[!edit] failed:", e);
      await progressMsg.edit(`❌ Edit failed: ${e.message.slice(0, 300)}`);
    }
    return;
  }

  // ── Grok img2img / img2vid pending attachment handler ────────────────────────
  const pendingKey = `${msg.channelId}-${msg.author.id}`;
  const pending = pendingGrokImg2X.get(pendingKey);
  if (pending && msg.attachments.size > 0) {
    pendingGrokImg2X.delete(pendingKey);
    const att = msg.attachments.first();
    if (att && /\.(png|jpg|jpeg|webp|gif)$/i.test(att.name || "") || (att?.contentType || "").startsWith("image/")) {
      const replyMsg = await msg.reply(`${pending.action === "img2vid" ? "🎬" : "🖼️"} Got your image! Processing with Grok... (1-3 min)`);
      try {
        const imgBuf = Buffer.from(await fetch(att.url).then(r => r.arrayBuffer()));
        const result = await runGrokImg2X(imgBuf, pending.prompt, pending.action);
        if (result.type === "video") {
          if (!fs.existsSync(result.path)) throw new Error("video file missing");
          const videoBuf = fs.readFileSync(result.path);
          lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now(); lastVideoMime = "video/mp4";
          backupMedia(videoBuf, `grok-img2vid-${Date.now()}.mp4`, "video/mp4");
          const replyId = replyMsg.id;
          generationContext.set(replyId, { prompt: pending.prompt, videoBuf, type: "grok_video" });
          await replyMsg.edit({ content: `🎬 *"${pending.prompt.slice(0, 60)}"* — **Grok Img2Vid**`, files: [new AttachmentBuilder(result.path, { name: "grok-img2vid.mp4" })], components: grokVideoButtons(replyId) });
          fs.unlink(result.path, () => {});
        } else {
          const imageBufs = result.paths.map(p => { const b = fs.readFileSync(p); fs.unlink(p, () => {}); return b; });
          lastGeneratedImageBuffer = imageBufs[0]; lastImageSetAt = Date.now();
          backupMedia(imageBufs[0], `grok-img2img-${Date.now()}.png`, "image/png");
          const replyId = replyMsg.id;
          generationContext.set(replyId, { prompt: pending.prompt, type: "grok", imageBufs, imageBuf: imageBufs[0] });
          const tmpPaths = imageBufs.map((b, i) => { const p = `/tmp/grok-img2img-${Date.now()}-${i}.png`; fs.writeFileSync(p, b); return p; });
          await replyMsg.edit({ content: `🖼️ *"${pending.prompt.slice(0, 80)}"* — **Grok Img2Img** — pick an image:`, files: tmpPaths.map(p => new AttachmentBuilder(p)), components: grokGridButtons(replyId, imageBufs.length) });
          tmpPaths.forEach(p => fs.unlink(p, () => {}));
        }
      } catch (e) {
        console.error("[grokimg2x] failed:", e.message);
        await replyMsg.edit(`⚠️ Grok ${pending.action} failed: ${e.message.slice(0, 200)}`);
      }
      return;
    }
  }

  // Special user — different response per channel
  if (BLOCKED_USERS.has(msg.author.id)) {
    lastRoastTargetMessage = msg.content.trim() || "(no text)";
    if (roastAgentBusy.get(msg.author.id)) return;
    roastAgentBusy.set(msg.author.id, true);
    await msg.channel.sendTyping().catch(() => {});
    let prompt;
    const niceChannel = process.env.DISCORD_NICE_CHANNEL_ID || "";
    if (niceChannel && msg.channelId === niceChannel) {
      prompt = `A Discord user named "${msg.author.username}" just said: "${lastRoastTargetMessage}". Respond to them with genuine love, kindness, empathy, and compassion. Be warm and helpful. If they seem upset or struggling, acknowledge their feelings and offer support. Keep it sincere and heartfelt, 2-3 sentences. Reply only with the response, no intro.`;
    } else {
      prompt = `Roast this Discord user hard. Their name is "${msg.author.username}" and they just said: "${lastRoastTargetMessage}". They are known for spending their time harassing and stalking livestreamers — that is literally their hobby. Give them a sharp, savage, 3-4 sentence roast that mocks what they said, their sad obsession with bothering streamers, and their obvious lack of a real life. Be creative and cutting. Reply only with the roast, no intro.`;
    }
    try {
      const response = await runAgentInSandbox(prompt, msg.id + "-roast");
      if (response) await msg.reply(response);
    } catch {} finally { roastAgentBusy.delete(msg.author.id); }
    return;
  }

  const hasAttachments = msg.attachments.size > 0;

  // ── GIF auto-buttons ─────────────────────────────────────────────
  // Runs BEFORE mentionOnly check — buttons appear on any GIF in any allowed channel.
  const userGifUrl = extractUserGifUrl(msg);
  if (userGifUrl) {
    (async () => {
      try {
        let gifUrl = userGifUrl;
        const isMp4 = /\.mp4(\?|$)/i.test(gifUrl);

        // Tenor page URL → resolve to actual c.tenor.com GIF URL
        if (/tenor\.com\/view\//i.test(gifUrl)) {
          const html = (await fetchBuffer(gifUrl)).toString("utf-8");
          // Try GIF first, fall back to mp4
          const gifMatch = html.match(/https:\/\/c\.tenor\.com\/[^"'\s]+\.gif/);
          const mp4Match = html.match(/https:\/\/c\.tenor\.com\/[^"'\s]+\.mp4/);
          if (gifMatch) { gifUrl = gifMatch[0]; }
          else if (mp4Match) { gifUrl = mp4Match[0]; }
          else { console.warn("[gif-buttons] could not extract media from tenor page"); return; }
          console.log(`[gif-buttons] tenor resolved: ${gifUrl}`);
        }

        const mediaBuf = await fetchBuffer(gifUrl);
        if (mediaBuf && mediaBuf.length > 500) {
          // Store as gifBuf for GIF paths, mp4Buf for video paths — both work with existing button handlers
          const isMp4Now = /\.mp4(\?|$)/i.test(gifUrl);
          const ctx = isMp4Now
            ? { gifMp4Buf: mediaBuf, type: "gif", rootId: msg.id }
            : { gifBuf: mediaBuf, type: "gif", rootId: msg.id };
          generationContext.set(msg.id, ctx);
          await msg.reply({ content: "🎞️", components: [gifButtons(msg.id)] });
          console.log(`[gif-buttons] attached to user GIF (${(mediaBuf.length / 1024).toFixed(0)}KB, ${isMp4Now ? "mp4" : "gif"})`);
        }
      } catch (e) {
        console.warn(`[gif-buttons] failed: ${e.message}`);
      }
    })();
  }

  // ── Gate: mentionOnly + other-agent filter ────────────────────────
  if (entry.mentionOnly && !msg.mentions.has(client.user.id)) {
    diag("mention_miss", { ch: msg.channelId, user: msg.author.id, txt: (msg.content || "").slice(0, 80), mentions: [...msg.mentions.users.keys()] });
    return;
  }
  const otherAgents = /^(hi\s+|hey\s+)?candy\b|@candy\b|^candy[,!?\s]/i;
  if (otherAgents.test(msg.content.trim())) return;
  if (!msg.content.trim() && !hasAttachments && !(msg.embeds?.length > 0)) return;

  // ── Audio auto-combine (pending MP4) ─────────────────────────────
  // If user uploads audio after clicking 🎥 Make MP4, auto-combine without any extra command
  if (hasAttachments) {
    const pendingKey = `${msg.guildId}-${msg.author.id}`;
    const pending    = pendingMp4.get(pendingKey);
    if (pending && Date.now() - pending.ts < 10 * 60 * 1000) {
      const audioAtt = [...msg.attachments.values()].find(a =>
        a.contentType?.startsWith("audio/") ||
        /\.(mp3|wav|ogg|m4a|flac|aac|opus|weba)$/i.test(a.name || "")
      );
      if (audioAtt) {
        pendingMp4.delete(pendingKey); // consume it
        (async () => {
          try {
            await msg.channel.sendTyping().catch(() => {});
            const audBuf = await fetchBuffer(audioAtt.url);
            const ts     = Date.now();
            const audExt = (audioAtt.name || "audio.mp3").match(/\.\w+$/)?.[0] || ".mp3";
            const tmpVid = `/tmp/autocombine-vid-${ts}.mp4`;
            const tmpAud = `/tmp/autocombine-aud-${ts}${audExt}`;
            const tmpOut = `/tmp/autocombine-out-${ts}.mp4`;
            fs.writeFileSync(tmpVid, pending.mp4Buf);
            fs.writeFileSync(tmpAud, audBuf);
            const { execSync: es } = require("child_process");
            let ffmpeg = "/home/nemoclaw/.local/bin/ffmpeg";
            try { es("which ffmpeg", { encoding: "utf-8", timeout: 3000 }); ffmpeg = "ffmpeg"; } catch {}
            es(
              `"${ffmpeg}" -y -i "${tmpVid}" -stream_loop -1 -i "${tmpAud}" ` +
              `-map 0:v:0 -map 1:a:0 -shortest -c:v copy -c:a aac -b:a 192k "${tmpOut}"`,
              { timeout: 120000 }
            );
            const outBuf = fs.readFileSync(tmpOut);
            [tmpVid, tmpAud, tmpOut].forEach(f => { try { fs.unlinkSync(f); } catch {} });
            const sizeMB  = (outBuf.length / 1024 / 1024).toFixed(1);
            const ctxKey  = `combined-${ts}`;
            generationContext.set(ctxKey, { gifMp4Buf: outBuf, type: "mp4" });
            await msg.reply({
              content: `🎬🎵 Combined (${sizeMB} MB) — upload an audio file to auto-combine`,
              files: [new AttachmentBuilder(outBuf, { name: "combined.mp4" })],
              components: [mp4Buttons(ctxKey)],
            });
            console.log(`[autocombine] done (${sizeMB}MB)`);
          } catch (e) {
            console.error(`[autocombine] failed: ${e.message}`);
            await msg.reply(`⚠️ Auto-combine failed: ${e.message.slice(0, 200)}`).catch(() => {});
          }
        })();
        return;
      }
    }
  }

  // ── Audio trim handler ────────────────────────────────────────────
  // User uploads audio file and says something like "trim 5s-61s" or "cut 20 to 60"
  if (hasAttachments) {
    const audioAtt = [...msg.attachments.values()].find(a =>
      a.contentType?.startsWith("audio/") ||
      /\.(mp3|wav|ogg|m4a|flac|aac|opus|weba)$/i.test(a.name || "")
    );
    if (audioAtt) {
      const txt = msg.content || "";
      const trimMatch = txt.match(
        /(?:trim|cut|clip|from)?\s*(\d+(?:[:.]\d+)?)\s*s?\s*[-–to]+\s*(\d+(?:[:.]\d+)?)\s*s?/i
      );
      if (trimMatch) {
        (async () => {
          try {
            const parseTime = (s) => {
              if (s.includes(":")) {
                const [m, sec] = s.split(":").map(Number);
                return m * 60 + sec;
              }
              return parseFloat(s);
            };
            const start = parseTime(trimMatch[1]);
            const end   = parseTime(trimMatch[2]);
            if (isNaN(start) || isNaN(end) || end <= start) {
              await msg.reply("Invalid time range. Example: `trim 5s-61s` or `cut 0:20 to 1:00`");
              return;
            }
            await msg.channel.sendTyping().catch(() => {});
            const audioBuf = await fetchBuffer(audioAtt.url);
            const ts      = Date.now();
            const ext     = (audioAtt.name || "audio.mp3").match(/\.\w+$/)?.[0] || ".mp3";
            const tmpIn   = `/tmp/trim-in-${ts}${ext}`;
            const tmpOut  = `/tmp/trim-out-${ts}${ext}`;
            fs.writeFileSync(tmpIn, audioBuf);

            const { execSync } = require("child_process");
            let ffmpeg = "/home/nemoclaw/.local/bin/ffmpeg";
            try { execSync("which ffmpeg", { encoding: "utf-8", timeout: 3000 }); ffmpeg = "ffmpeg"; } catch {}

            execSync(
              `"${ffmpeg}" -y -ss ${start} -to ${end} -i "${tmpIn}" -c copy "${tmpOut}"`,
              { timeout: 60000 }
            );
            const trimmedBuf = fs.readFileSync(tmpOut);
            fs.unlinkSync(tmpIn);
            fs.unlinkSync(tmpOut);

            const duration = (end - start).toFixed(1);
            const origName = audioAtt.name || `audio${ext}`;
            const outName  = origName.replace(/(\.\w+)$/, `-trim-${start}s-${end}s$1`);
            await msg.reply({
              content: `✂️ Trimmed **${start}s → ${end}s** (${duration}s)`,
              files: [new AttachmentBuilder(trimmedBuf, { name: outName })],
            });
            console.log(`[trim] ${origName}: ${start}s-${end}s → ${trimmedBuf.length} bytes`);
          } catch (e) {
            console.error(`[trim] failed: ${e.message}`);
            await msg.reply(`Trim failed: ${e.message.slice(0, 200)}`).catch(() => {});
          }
        })();
        return;
      }
    }
  }

  // ── Passive channel filter ────────────────────────────────────────
  // In non-mentionOnly channels, skip pure social chatter not directed at Pipes.
  // He responds when: directly named, asking a question, requesting something, sharing media, or casual chat.
  if (!entry.mentionOnly && !hasAttachments) {
    const txt = msg.content.trim();
    const directed = msg.mentions.has(client.user.id)
      || /\b(pipes|mrbigpipes|bigpipes)\b/i.test(txt)
      || /\?/.test(txt)                        // question
      || /^!(generate|post|video|image|gif|yt|reddit|trends|recall|brief|ask|grok)\b/i.test(txt)  // commands
      || /\b(generate|create|make|post|upload|search|find|show|help|can you|could you|please)\b/i.test(txt) // requests
      || /^(hey|hi|hello|sup|yo|gn|good night|goodnight|good morning|morning|back|woke up|going to bed|bye|brb|afk|lol|haha|lmao|omg|wtf|ngl|imo|fr|gg|nice|damn|bro|dude|yo)\b/i.test(txt) // casual
      || txt.length > 0 && txt.length < 15; // short messages are likely addressed to someone in the channel
    if (!directed) { diag("filtered", { ch: msg.channelId, txt: txt.slice(0, 80) }); return; }
  }

  // ── !grok <prompt> — Grok Aurora image generation ────────────
  if (msg.content.trim().toLowerCase().startsWith("!grok ") || msg.content.trim().toLowerCase().startsWith("grok imagine ")) {
    const prompt = msg.content.trim().replace(/^!grok\s+/i, "").replace(/^grok imagine\s+/i, "").trim();
    if (!prompt) { await msg.reply("Usage: `!grok <prompt>` — generate an image with Grok Aurora"); return; }
    await msg.channel.sendTyping().catch(() => {});
    const typingInterval = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);
    try {
      const localPaths = await runGrokImagine(prompt);
      clearInterval(typingInterval);
      if (!localPaths || localPaths.length === 0) { await msg.reply("⚠️ Grok generation failed. Check logs."); return; }
      const imageBufs = localPaths.map(p => fs.readFileSync(p));
      lastGeneratedImageBuffer = imageBufs[0]; lastImageSetAt = Date.now();
      lastPrompt = prompt;
      backupMedia(imageBufs[0], `grok-${Date.now()}.png`, "image/png");
      const files = localPaths.map(p => new AttachmentBuilder(p));
      await msg.reply({ content: `🤖 *"${prompt.slice(0, 80)}"* — **Grok Aurora** — pick an image:`, files, components: grokGridButtons(msg.id, localPaths.length) });
      generationContext.set(msg.id, { prompt, type: "grok", imageBufs, imageBuf: imageBufs[0] });
      localPaths.forEach(p => fs.unlink(p, () => {}));
    } catch (e) {
      clearInterval(typingInterval);
      console.error("[grok] handler error:", e.message);
      await msg.reply(`⚠️ Grok error: ${e.message.slice(0, 200)}`);
    }
    return;
  }

  // ── !whoami — echo back the user's Discord ID ─────────────────
  if (msg.content.trim() === "!whoami") {
    await msg.reply(`Your Discord user ID is: \`${msg.author.id}\`\nUsername: ${msg.author.username}`);
    return;
  }

  // ── !yt <query> — YouTube search ──────────────────────────────
  if (msg.content.trim().startsWith("!yt ")) {
    const query = msg.content.trim().slice(4).trim();
    if (!query) { await msg.reply("Usage: `!yt <search query>`"); return; }
    try {
      await msg.channel.sendTyping().catch(() => {});
      const results = await gdrive.searchYouTube(query, 5);
      const ytMsg = results.map((v, i) =>
        `**${i + 1}. ${v.title}**\n> ${v.channel} — ${v.url}`
      ).join("\n\n");
      await msg.reply(ytMsg.slice(0, 1900) || "No results found.");
    } catch (e) { await msg.reply(`YouTube search failed: ${e.message.slice(0, 200)}`); }
    return;
  }

  // ── !drive list — list Drive files ────────────────────────────
  if (msg.content.trim() === "!drive list" || msg.content.trim() === "!drive") {
    try {
      await msg.channel.sendTyping().catch(() => {});
      const files = await gdrive.listDriveFiles();
      if (!files.length) { await msg.reply("No files found in Drive folder."); return; }
      const fileList = files.slice(0, 15).map((f, i) => {
        const size = f.size ? ` (${(f.size / 1024 / 1024).toFixed(1)}MB)` : "";
        const date = f.createdTime ? ` — ${f.createdTime.slice(0, 10)}` : "";
        return `**${i + 1}.** [${f.name}](${f.webViewLink})${size}${date}`;
      }).join("\n");
      await msg.reply(`**Google Drive — Recent Files:**\n${fileList}`.slice(0, 1900));
    } catch (e) {
      if (e.message.includes("OAuth token not configured")) {
        await msg.reply(gdrive.getSetupInstructions());
      } else {
        await msg.reply(`Drive error: ${e.message.slice(0, 200)}`);
      }
    }
    return;
  }

  // ── !drive save — save last generated file to Drive ───────────
  if (msg.content.trim().startsWith("!drive save")) {
    const filePath = "/tmp/generated_image.png";
    const mimeType = "image/png";
    const fileName = `mrbigpipes_${Date.now()}.png`;
    try {
      await msg.channel.sendTyping().catch(() => {});
      const driveFile = await gdrive.uploadToDrive(filePath, mimeType, fileName);
      await msg.reply(`✅ Saved to Drive: **${driveFile.name}**\n${driveFile.webViewLink}`);
    } catch (e) {
      if (e.message.includes("OAuth token not configured")) {
        await msg.reply(gdrive.getSetupInstructions());
      } else {
        await msg.reply(`Drive upload failed: ${e.message.slice(0, 200)}`);
      }
    }
    return;
  }

  // ── !delete <messageId> — delete a bot message ───────────────────
  // Anyone can delete messages the bot itself posted.
  // Only the owner can delete messages from other users.
  if (msg.content.trim().startsWith("!delete ")) {
    const OWNER_ID = OWNER_ID_GLOBAL;
    const targetId = msg.content.trim().split(/\s+/)[1];
    try {
      const targetMsg = await msg.channel.messages.fetch(targetId);
      if (targetMsg.author.id !== client.user.id && msg.author.id !== OWNER_ID) {
        await msg.reply("⚠️ You can only delete messages posted by the bot.").catch(() => {});
        return;
      }
      await targetMsg.delete();
      await msg.reply(`✅ Deleted message \`${targetId}\`.`).catch(() => {});
    } catch (e) {
      await msg.reply(`❌ Could not delete \`${targetId}\`: ${e.message.slice(0, 200)}`).catch(() => {});
    }
    return;
  }

  // Block command/jailbreak attempts (except from trusted owner)
  const TRUSTED_USER = OWNER_ID_GLOBAL;
  if (msg.author.id !== TRUSTED_USER && isCommandAttempt(msg.content)) {
    await msg.reply("Nice try. I don't take orders from chat. 💅").catch(() => {});
    return;
  }

  // Dedup: persistent file survives restarts, prevents replayed messages from Discord gateway.
  // Old approach used per-message lock files in /tmp/ that got stale. New approach: single
  // append-only file with recent message IDs, loaded on startup.
  // ── ID-based dedup (exact replay) ──────────────────────────────────
  if (processedMessages.has(msg.id)) { health.dedups++; diag("dedup", { id: msg.id, reason: "in_memory" }); console.log(`[dedup] blocked replay: ${msg.id}`); return; }
  try {
    const fileContent = fs.readFileSync(DEDUP_FILE, "utf8");
    if (fileContent.includes(msg.id)) { health.dedups++; diag("dedup", { id: msg.id, reason: "file_check" }); console.log(`[dedup] blocked by file: ${msg.id}`); processedMessages.add(msg.id); return; }
  } catch {}
  // ── Stale message filter (gateway reconnect replays) ──────────────
  const msgAge = Date.now() - msg.createdTimestamp;
  if (msgAge > 120000) { health.dedups++; diag("dedup", { id: msg.id, reason: "stale", ageMs: msgAge }); console.log(`[dedup] blocked stale: ${msg.id} (${Math.round(msgAge/1000)}s old)`); return; }
  // ── Content-based dedup (same user, near-identical text within 5 min) ─
  // Catches: user edits + resends, Discord delivering edited messages as new messageCreate events
  const contentKey = bu.contentDedupKey(msg.author.id, msg.content);
  if (!global._contentDedup) global._contentDedup = new Map();
  const lastSeen = global._contentDedup.get(contentKey);
  if (lastSeen && Date.now() - lastSeen < 300000) {
    health.dedups++;
    diag("dedup", { id: msg.id, reason: "content_match", key: contentKey.slice(0, 60) });
    console.log(`[dedup] blocked duplicate content: ${msg.id} "${(msg.content || "").slice(0, 60)}"`);
    return;
  }
  processedMessages.add(msg.id);
  try { fs.appendFileSync(DEDUP_FILE, msg.id + "\n"); } catch {}
  // Track content for content-based dedup (5 min window, auto-cleanup)
  if (!global._contentDedup) global._contentDedup = new Map();
  global._contentDedup.set(contentKey, Date.now());
  if (global._contentDedup.size > 200) {
    const cutoff = Date.now() - 300000;
    for (const [k, v] of global._contentDedup) { if (v < cutoff) global._contentDedup.delete(k); }
  }
  // Persist content dedup to disk so restarts don't lose it
  try { fs.writeFileSync(CONTENT_DEDUP_FILE, JSON.stringify([...global._contentDedup])); } catch {}
  setTimeout(() => processedMessages.delete(msg.id), 600000);

  const _mt = new MsgTimer(msg.id, msg.author.id, msg.content);

  // Show typing indicator while we process images + run agent
  await msg.channel.sendTyping().catch(() => {});
  const typingInterval = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);

  // Pre-brief Candy and MaoMao immediately — fires in parallel with the main agent call
  // so their KV cache is warm by the time Pipes finishes and we call them for reactions.
  // Skip for Claude orchestrator queries (no crew loop needed).
  if (!isClaudeQuery) primeCrewCache(msg.content || "");

  // Debug: log embed/attachment structure for GIF diagnosis
  if (msg.embeds?.length || msg.attachments?.size) {
    console.log(`[msg-debug] embeds: ${msg.embeds.length}, attachments: ${msg.attachments.size}`);
    msg.embeds.forEach((e, i) => console.log(`[embed-${i}] type:${e.type} video:${JSON.stringify(e.video)?.slice(0,100)} thumb:${JSON.stringify(e.thumbnail)?.slice(0,100)} url:${e.url}`));
  }
  let fullMessage = await buildMessageWithImages(msg);

  // Discord GIFs from the picker arrive as a plain Tenor/Giphy URL in msg.content.
  // Replace the raw URL with a readable description so the agent knows what it is.
  if (fullMessage && /^https:\/\/(tenor\.com|media\.tenor\.com|giphy\.com|media\.giphy\.com)\//i.test(fullMessage.trim())) {
    const gifUrl = fullMessage.trim();
    fullMessage = `[The user sent a GIF: ${gifUrl}] React to it naturally — send a relevant GIF back, comment on it, or both.`;
    console.log(`[gif-recv] user sent GIF: ${gifUrl}`);
  }

  if (!fullMessage) { clearInterval(typingInterval); return; }

  // Strip [CLAUDE_QUERY] prefix — replace identity with orchestrator tag
  if (isClaudeQuery) {
    fullMessage = fullMessage.replace(/^\[CLAUDE_QUERY\]\s*/i, "").trim();
  }

  // Prepend user identity so the agent always knows who it's talking to
  const userPrefix = isClaudeQuery
    ? "[From: Claude Orchestrator (swarm coordination request)]\n"
    : `[Discord User: @${msg.author.username} (ID: ${msg.author.id})]\n`;

  // ── Parallel pre-fetch: memory + vertex search + trends ──────────────
  // All three are independent — fire simultaneously so their latencies overlap.
  const cleanQuery = fullMessage.replace(/\[Discord User:[^\]]+\]/g, "").trim();
  const isProjectQuery = /\b(pipebox|netify|holodiamond|holo.?diamond|tcg|card.?game|atelier|the (site|website|app|project|game|codebase))\b/i.test(cleanQuery);
  const trendKeywords = /viral|trending|trend|algo|algorithm|livestream|live stream|stream title|description.*stream|stream.*description|hack.*algo|title.*live|live.*title|caption.*post|post.*caption|what.*trending|going viral/i;
  const isTrendQuery = trendKeywords.test(fullMessage);

  // Skip Qdrant if there's no real text to search on (pure image drop / URL-only).
  // Memory recall is only useful when the user has actual words to match against.
  const isMemoryCandidate = cleanQuery.length >= 8 && /[a-zA-Z]{3,}/.test(cleanQuery);
  _mt.mark("prefetch");

  const [
    [userMemRes, globalMemRes],
    vsResult,
    trendFetched,
    correctionRes,
  ] = await Promise.all([
    // Memory: user-specific + global in parallel — skip if no real query text
    isMemoryCandidate
      ? Promise.all([
          fetch("http://localhost:7338", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd: "search", query: fullMessage, userId: msg.author.id, limit: 3 }),
          }).then(r => r.json()).catch(() => null),
          fetch("http://localhost:7338", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd: "search", query: fullMessage, limit: 3 }),
          }).then(r => r.json()).catch(() => null),
        ])
      : Promise.resolve([null, null]),
    // Vertex search: only if project-related
    isProjectQuery
      ? vertexSearch(cleanQuery.slice(0, 200)).catch(e => { console.warn(`[vertex-search] inject error:`, e.message); return null; })
      : Promise.resolve(null),
    // Trends: only if trend-related
    isTrendQuery
      ? (() => {
          const cleanMsg = fullMessage.replace(/\[Discord User:[^\]]+\]/g, "").trim();
          const theme = cleanMsg.length > 5 ? cleanMsg.slice(0, 80) : "viral trending";
          console.log(`[trends-inject] pre-fetching for: ${theme}`);
          return trends.getTrends(theme).catch(e => { console.warn(`[trends-inject] failed: ${e.message}`); return null; });
        })()
      : Promise.resolve(null),
    // MaoMao correction recall — fetch recent critical feedback to prevent repeat mistakes
    fetch("http://localhost:7338", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "search", query: fullMessage, source: "maomai-correction", limit: 2 }),
    }).then(r => r.json()).catch(() => null),
  ]);

  // ── Assemble memory context ───────────────────────────────────────
  let memoryContext = "";
  try {
    const allMems = [...(userMemRes?.results || []), ...(globalMemRes?.results || [])];
    const seen = new Set();
    const unique = allMems.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
    unique.sort((a, b) => b.score - a.score);
    const topMems = unique.slice(0, 5);
    if (topMems.length) {
      memoryContext = `[Crew memory context for @${msg.author.username}:\n` +
        topMems.map(m => `- [${m.source || "pipes"}] ${m.text}`).join("\n") + "]\n";
    }
  } catch {}

  // ── Assemble MaoMao correction context ─────────────────────────────
  let correctionsContext = "";
  try {
    const corrections = (correctionRes?.results || [])
      .filter(c => {
        // 48-hour TTL — old corrections age out automatically
        if (!c.timestamp) return true; // no timestamp = keep it
        return (Date.now() - new Date(c.timestamp).getTime()) < 48 * 60 * 60 * 1000;
      })
      .slice(0, 2);
    if (corrections.length) {
      correctionsContext = `[MaoMao's past corrections (avoid repeating these mistakes):\n` +
        corrections.map(c => `- ${c.text}`).join("\n") + "]\n";
      console.log(`[crew-correction] injecting ${corrections.length} corrections`);
    }
  } catch {}

  // ── Assemble vertex search context ───────────────────────────────
  let vertexSearchContext = "";
  if (vsResult?.summary) {
    vertexSearchContext = `\n[Project knowledge base:\n${vsResult.summary}\n]\n`;
  } else if (vsResult?.snippets?.length) {
    vertexSearchContext = `\n[Project knowledge base snippets:\n${vsResult.snippets.slice(0, 3).map(s => `- ${s}`).join("\n")}\n]\n`;
  }

  // ── Assemble trend context ────────────────────────────────────────
  let trendContext = "";
  let trendData = null;
  if (isTrendQuery) {
    if (trendFetched) {
      const totalPosts = Object.values(trendFetched.byPlatform).flat().length;
      if (totalPosts > 0) {
        trendData = trendFetched;
        trendContext = `\n[REAL SOCIAL TREND DATA — use ONLY this to write viral titles/descriptions, do NOT fabricate:\n${trendFetched.summary}\n]\n`;
        console.log(`[trends-inject] injected ${totalPosts} posts`);
      } else {
        console.warn(`[trends-inject] 0 posts for theme`);
        trendContext = "\n[No trend data available. Do NOT fabricate trend stats. Write a good title/description directly.]\n";
      }
    } else {
      trendContext = "\n[Trend fetch failed. Do NOT fabricate trend data. Write a good title/description directly.]\n";
    }
  }

  // ── Direct trend output (bypass agent for explicit title/description requests) ──
  // When user asks for a viral title/description AND we have real trend data,
  // skip the agent entirely and format the output directly to avoid model hallucination.
  const directTitleRequest = /(?:give me|write|make|generate|need|want).{0,30}(?:title|description|caption|hook)|(?:title|description).{0,20}(?:livestream|stream|video|post)/i;
  if (trendData && directTitleRequest.test(fullMessage)) {
    clearInterval(typingInterval);

    // ── Multi-query expansion ─────────────────────────────────────
    // Extract 2-3 sub-topic angles from the user message and run parallel searches
    const userQuery = fullMessage.replace(/\[Discord User:[^\]]+\]/g, "").trim().slice(0, 80);
    const subQueries = [
      userQuery,
      "viral trending " + (userQuery.match(/\b\w{4,}\b/g) || []).slice(0, 3).join(" "),
      "top content " + (userQuery.match(/\b\w{4,}\b/g) || []).slice(0, 3).join(" "),
    ].filter((q, i, arr) => arr.indexOf(q) === i); // deduplicate

    const extraResults = await Promise.allSettled(
      subQueries.slice(1).map(q => trends.getTrends(q, 25))
    );

    // Merge all posts, deduplicate by text prefix
    const seen = new Set();
    const mergePosts = (posts) => posts.filter(p => {
      const key = p.text.slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const mergedByPlatform = { ...trendData.byPlatform };
    for (const r of extraResults) {
      if (r.status !== "fulfilled") continue;
      for (const [platform, posts] of Object.entries(r.value.byPlatform)) {
        mergedByPlatform[platform] = mergePosts([...(mergedByPlatform[platform] || []), ...posts]);
      }
    }
    const allHashtags = [...new Set([
      ...trendData.hashtags,
      ...extraResults.filter(r=>r.status==="fulfilled").flatMap(r=>r.value.hashtags),
    ])].slice(0, 25);

    // All posts sorted by engagement
    const allPosts = Object.values(mergedByPlatform).flat()
      .sort((a, b) => (b.likes + (b.views||0)) - (a.likes + (a.views||0)));

    // ── Relevance scoring ─────────────────────────────────────────
    // Score each post by how many words from the user's query it contains
    const queryWords = userQuery.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(w => w.length > 3);
    const scored = allPosts.map(p => {
      const txt = p.text.toLowerCase();
      const relevance = queryWords.reduce((n, w) => n + (txt.includes(w) ? 1 : 0), 0);
      return { ...p, relevance };
    }).sort((a, b) => (b.relevance * 1000 + b.likes) - (a.relevance * 1000 + a.likes));

    const relevant   = scored.filter(p => p.relevance > 0).slice(0, 10);
    const general    = scored.filter(p => p.relevance === 0)
                             .sort((a,b)=>(b.likes+(b.views||0))-(a.likes+(a.views||0)))
                             .slice(0, 10);

    // ── Platform breakdown (top 5 per platform) ───────────────────
    const platformLines = [];
    for (const [platform, posts] of Object.entries(mergedByPlatform)) {
      if (!posts.length) continue;
      const sorted = [...posts].sort((a,b)=>(b.likes+(b.views||0))-(a.likes+(a.views||0))).slice(0, 5);
      platformLines.push(`**${platform.toUpperCase()} (${posts.length} posts):**`);
      for (const p of sorted) {
        const eng = p.likes > 0 ? ` ❤️${p.likes.toLocaleString()}` : "";
        platformLines.push(`• ${p.text.replace(/\n/g, " ").slice(0, 110)}${eng}`);
      }
    }

    // ── Theme extraction from all posts ───────────────────────────
    const stopWords = new Set("https the and for with that this from they have will been were your about just more also when what then than some very into over most other such even much well back only come here like time know take many".split(" "));
    const wordFreq = allPosts
      .flatMap(p => p.text.toLowerCase().replace(/[^a-z0-9# ]/g, " ").split(/\s+/))
      .filter(w => w.length > 4 && !stopWords.has(w) && !w.startsWith("http"))
      .reduce((acc, w) => { acc[w] = (acc[w]||0) + 1; return acc; }, {});
    const topThemes = Object.entries(wordFreq).sort((a,b)=>b[1]-a[1]).slice(0, 8).map(([w])=>w);

    // ── Title/description generation ──────────────────────────────
    const t1 = topThemes[0] || "trending", t2 = topThemes[1] || "viral", t3 = topThemes[2] || "live";
    const topTag = allHashtags[0] ? allHashtags[0].replace("#","") : t1;
    const topHook = relevant[0] ? relevant[0].text.replace(/\n/g," ").slice(0,70) : general[0]?.text.replace(/\n/g," ").slice(0,70) || "";

    const titles = [
      `🔴 LIVE: ${t1.toUpperCase()} & ${t2.toUpperCase()} — Real-Time Breakdown`,
      `VIRAL RIGHT NOW 🔥 ${t1} | ${t2} | ${t3} — Watch Before It's Gone`,
      `🚨 LIVE: Why "${topHook.slice(0,45)}..." Is Exploding Today`,
      `${topTag.toUpperCase()} LIVE 🔥 Hacking the Algorithm in Real Time`,
      `🔴 TRENDING BREAKDOWN: ${t1} + ${t2} — Algorithm Decoded LIVE`,
    ];
    const desc =
      `🔴 LIVE NOW — Breaking down what's actually viral across every platform right now.\n\n` +
      `Today's algorithm is pushing: **${topThemes.slice(0,4).join(", ")}**\n` +
      (relevant.length ? `Top relevant content: ${relevant.slice(0,2).map(p=>p.text.replace(/\n/g," ").slice(0,60)).join(" | ")}\n` : "") +
      `\nReal social intel, no fluff. Drop in.\n\n` +
      allHashtags.slice(0,15).join(" ");

    // ── Relevant post highlights ──────────────────────────────────
    const relevantLines = relevant.length ? [
      `**🎯 MOST RELEVANT to your query (${relevant.length} posts):**`,
      ...relevant.map(p => `• [${p.platform}] ${p.text.replace(/\n/g," ").slice(0,110)}${p.likes>0?` ❤️${p.likes.toLocaleString()}`:""}`),
    ] : [];

    const lines = [
      `📊 **Live Intelligence — ${allPosts.length} posts across ${Object.keys(mergedByPlatform).length} platforms:**`,
      `**Trending themes:** ${topThemes.join(", ")}`,
      `**Top hashtags:** ${allHashtags.slice(0,15).join(" ")}`,
      ``,
      ...relevantLines,
      relevantLines.length ? `` : null,
      `**📈 TOP POSTS BY PLATFORM:**`,
      ...platformLines,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `**🎯 TITLE OPTIONS (algo-optimized):**`,
      ...titles.map((t, i) => `${i+1}. ${t}`),
      ``,
      `**📝 DESCRIPTION:**`,
      desc,
    ].filter(l => l !== null);

    // Chunk into Discord messages
    const chunks = [];
    let cur = "";
    for (const line of lines) {
      const next = cur ? cur + "\n" + line : line;
      if (next.length > 1980) { chunks.push(cur); cur = line; }
      else cur = next;
    }
    if (cur) chunks.push(cur);

    await msg.reply(chunks[0]);
    for (const chunk of chunks.slice(1)) await msg.channel.send(chunk);
    console.log(`[trends-direct] ${allPosts.length} posts, ${relevant.length} relevant, ${titles.length} titles generated`);
    return;
  }

  // ── ZTurbo bridge-level intercept ────────────────────────────────
  // If user explicitly asks for z-turbo / local generation, handle it HERE
  // without touching the sandbox. Pipes cannot be trusted to emit the token.
  // Route ALL chat image generation through ZTurbo (local GPU, faster, better).
  // Triggers on explicit "z-turbo" OR any general image generation request in chat.
  // Use /imagine for cloud (Imagen 4) explicitly.
  // Test zturbo intent against RAW user text only (not fullMessage with vision/asset blocks)
  const _rawUserText = msg.content.trim();
  const { intent: _zturboIntent, explicit: _zturboExplicit, imperative: _zturboImperative } = bu.isZTurboIntent(_rawUserText);
  if (_zturboIntent) {
    clearInterval(typingInterval);
    console.log(`[zturbo-intercept] triggered (explicit=${_zturboExplicit} imperative=${_zturboImperative}) msgId=${msg.id} rawLen=${_rawUserText.length} — "${_rawUserText.slice(0, 200)}"`);
    // Ask Candy for a creative prompt + style in parallel
    const _ZTURBO_BRIEF = `You are Candy — creative director. Generate a ZTurbo image based on this request: "${fullMessage.slice(0, 200)}"
Return ONLY a JSON object:
- "prompt": vivid, detailed, specific image prompt (2-3 sentences). Interpret the request creatively — don't just repeat the user's words.
- "style": pick the best fit from: none, 80s-dark-fantasy, synthwave, witchcore, light-painting, kawaii-pop, spotlight-stage, post-processed, low-poly, ink-draw, shadow-fantasy, gothic-engraving, folk-art-mosaic, paper-cut, risograph, ukiyo-e, vintage-polaroid, glass-advertising, vintage-vga
Output ONLY the JSON object. No markdown, no explanation.`;
    let ztPrompt = fullMessage.replace(/\b(z-?turbo|use|with|please|can you|generate|make|create|an?|the|image|photo)\b/gi, " ").replace(/\s+/g, " ").trim() || fullMessage;
    let ztStyle = "none";
    try {
      const candyRaw = await callCrewMember(_ZTURBO_BRIEF, "Candy", CREW_CANDY_MODEL, 0.9, false, fullMessage, "");
      const jsonMatch = candyRaw && candyRaw.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.prompt) ztPrompt = parsed.prompt;
        if (parsed.style && ZTURBO_STYLES.hasOwnProperty(parsed.style)) ztStyle = parsed.style;
      }
    } catch (e) { console.warn("[zturbo-intercept] Candy prompt failed, using fallback:", e.message); }
    const ztSeed = Math.floor(Math.random() * 2147483647);
    const styleLabel = ztStyle !== "none" ? ` — *${ztStyle.replace(/-/g, " ")}*` : "";
    const statusMsg = await msg.reply(`⚡ ZTurbo${styleLabel}: *"${ztPrompt.slice(0, 80)}"* *(ZImage Turbo)*\nGenerating...`);
    try {
      const imgBuf = await generateImageWithZTurbo(ztPrompt, ztSeed, ztStyle);
      const tmpPath = `/tmp/zturbo-intercept-${Date.now()}.png`;
      fs.writeFileSync(tmpPath, imgBuf);
      lastGeneratedImageBuffer = imgBuf; lastImageSetAt = Date.now();
      await statusMsg.edit({
        content: `⚡ *"${ztPrompt.slice(0, 80)}"*${styleLabel} *(ZImage Turbo)*`,
        files: [new AttachmentBuilder(tmpPath, { name: "zturbo.png" })],
        components: [imageButtons(statusMsg.id)],
      });
      generationContext.set(statusMsg.id, { prompt: ztPrompt, style: ztStyle, seed: ztSeed, imageBuf: imgBuf, type: "zturbo" });
      fs.unlinkSync(tmpPath);
      postCrewReactions(msg, fullMessage, `Generated ZTurbo image: "${ztPrompt.slice(0, 120)}"`).catch(() => {});
    } catch (e) {
      console.error("[zturbo-intercept] failed:", e.message);
      await statusMsg.edit(`❌ ZTurbo failed: ${e.message.slice(0, 200)}`);
    }
    return;
  }

  // Pre-consult crew before Pipes responds (creative tasks, decisions, strategy)
  let crewPlanContext = "";
  if (shouldGetCrewInput(fullMessage)) {
    console.log("[crew-plan] consulting crew before Pipes responds...");
    crewPlanContext = await getCrewInput(fullMessage).catch(() => "");
  }

  _mt.mark("context");
  const contextualMessage = userPrefix + memoryContext + correctionsContext + vertexSearchContext + trendContext + crewPlanContext + fullMessage;

  console.log(`[${msg.author.username}] ${fullMessage.slice(0, 120)}`);

  let progressMsg = null; // hoisted out of try for catch-block access
  try {
    let typingStopped = false;
    let agentDone = false; // guard: stop progress edits once agent resolves
    let progressBusy = false; // guard: prevent concurrent progress edits
    let progressInflight = null; // track in-flight progress promise to prevent double-post race
    const onProgress = async (text) => {
      if (agentDone || progressBusy) return;
      progressBusy = true;
      progressInflight = (async () => {
        try {
          if (!typingStopped) { clearInterval(typingInterval); typingStopped = true; }
          const preview = text.slice(-1800);
          if (!progressMsg) {
            progressMsg = await msg.reply(`⏳ ${preview}`);
          } else {
            await progressMsg.edit(`⏳ ${preview}`);
          }
        } catch (e) { console.warn("[stream] progress edit failed:", e.message); }
        finally { progressBusy = false; }
      })();
      await progressInflight;
    };
    _mt.mark("agent_start");
    let response = await enqueueAgent(msg.author.id, () =>
      runAgentInSandbox(contextualMessage, `dc-${msg.author.id}-${msg.id}`, onProgress)
    );
    _mt.mark("agent_done");
    agentDone = true; // stop any in-flight progress callbacks
    if (progressInflight) await progressInflight.catch(() => {}); // wait for in-flight progress msg to land
    if (!typingStopped) clearInterval(typingInterval);
    // Strip raw Discord user IDs from public responses (18-digit numeric strings)
    response = response.replace(/\b\d{17,19}\b/g, "[user]");
    console.log(`[agent] ${response.slice(0, 100)}...`);

    // Sanitize response — strip raw JSON arrays that leak from Gemini tool call responses
    // Pattern: [{"text":"..."}, ...] at the start of the response
    // ── Hallucination filter ─────────────────────────────────────
    // Catch known fabrication patterns before they reach the user.
    const hallucinationHit = _HALLUCINATION_PATTERNS.find(p => p.test(response));

    // ── Structural hallucination check ────────────────────────────
    // The model repeatedly generates: bold numbered roadmap items + dramatic closing.
    // Only fire when BOTH: invented module names AND a dramatic closer are present.
    // Do NOT fire just because the response is a numbered list — lists are valid answers.
    const boldNumberedItems = (response.match(/^\d+\.\s+\*\*/gm) || []).length;
    const dramaticCloser = _DRAMATIC_CLOSER_RE.test(response);
    const inventedModuleName = _INVENTED_MODULE_RE.test(response) && !_KNOWN_REAL_RE.test(response);
    const structuralHit = boldNumberedItems >= 3 && dramaticCloser && inventedModuleName;

    if (hallucinationHit || structuralHit) {
      const reason = hallucinationHit ? String(hallucinationHit) : `structural (${boldNumberedItems} bold items + dramatic closer)`;
      console.warn(`[hallucination] blocked response: ${reason}`);
      // Clean up progress msg before replying to prevent double-post
      if (progressMsg) { try { await progressMsg.delete(); } catch {} progressMsg = null; }
      // If we have real trend data, send it directly instead of error message
      if (trendData) {
        const top = trendData.topPosts.slice(0, 3);
        const hashtags = trendData.hashtags.slice(0, 8).join(" ");
        const topPost = top[0] ? `"${top[0].text.slice(0, 120)}"` : "";
        const formatted = [
          `📊 **Trending now** (live from trends):`,
          hashtags ? `**Hashtags:** ${hashtags}` : "",
          top.length ? `**Top posts:**` : "",
          ...top.map(p => `• [${p.platform}] ${p.text.slice(0, 100).replace(/\n/g, " ")} *(❤️ ${p.likes})*`),
        ].filter(Boolean).join("\n");
        await msg.reply(formatted.slice(0, 1900));
      } else {
        await msg.reply("My response got filtered — it looked like I was making stuff up. Try asking again with a bit more context.");
      }
      clearInterval(typingInterval);
      return;
    }

    let mutableResponse = response;
    if (mutableResponse.startsWith('[{"text":')) {
      try {
        const parsed = JSON.parse(mutableResponse);
        if (Array.isArray(parsed)) {
          mutableResponse = parsed.map(p => p.text || "").join("").trim();
          console.log(`[sanitize] stripped JSON array wrapper from response`);
        }
      } catch {
        // Not valid JSON — try extracting text with regex
        mutableResponse = mutableResponse.replace(/^\[(\{"text":\s*")/,'').replace(/"\}\]$/,'').replace(/\\"/g,'"').replace(/\\n/g,'\n');
        console.log(`[sanitize] regex-stripped JSON wrapper from response`);
      }
    }
    // ── [CAPCUT_COMPOSE:] — Candy's video composition token ──────────
    const capcutMatch = mutableResponse.match(/\[CAPCUT_COMPOSE:\s*([\s\S]*?)\]/i);
    if (capcutMatch) {
      const attrs = capcutMatch[1];
      const videosM  = attrs.match(/videos?\s*=\s*"([^"]+)"/i);
      const styleM   = attrs.match(/style\s*=\s*"([^"]+)"/i);
      const musicM   = attrs.match(/music\s*=\s*"([^"]+)"/i);
      const textM    = attrs.match(/text\s*=\s*"([^"]+)"/i);
      const videoPathsRaw = videosM ? videosM[1].split(",").map(s => s.trim()).filter(Boolean) : [];
      // Fall back to last generated video if no explicit paths
      const videoPaths = videoPathsRaw.length > 0 ? videoPathsRaw : (lastVideoBuffer ? (() => {
        const p = `/tmp/capcut-input-${Date.now()}.mp4`; fs.writeFileSync(p, lastVideoBuffer); return [p];
      })() : []);
      if (videoPaths.length === 0) {
        await msg.reply("❌ Candy: no video files to compose — generate a clip first.");
      } else {
        const style = styleM ? styleM[1] : "cinematic";
        const statusMsg = await msg.reply(`🎬 **Candy** is composing your video *(${style})*...`);
        try {
          let vidBuf, engine;
          // Try CapCut API first, fall back to FFmpeg
          try {
            vidBuf = await composeVideoWithCapCutAPI({
              videoPaths, style,
              musicPath: musicM ? musicM[1] : null,
              textOverlay: textM ? textM[1] : null,
            });
            engine = "CapCut";
          } catch (capErr) {
            console.warn("[capcut-api] falling back to FFmpeg:", capErr.message);
            vidBuf = await composeVideoWithFFmpeg({
              videoPaths, style,
              musicPath: musicM ? musicM[1] : null,
              textOverlay: textM ? textM[1] : null,
            });
            engine = "FFmpeg";
          }
          const tmpOut = `/tmp/candy-compose-out-${Date.now()}.mp4`;
          fs.writeFileSync(tmpOut, vidBuf);
          const sizeMB = (vidBuf.length / 1024 / 1024).toFixed(1);
          await statusMsg.edit({ content: `🎬 **Candy composed** *(${style}, ${sizeMB}MB)* *(${engine})*`, files: [new AttachmentBuilder(tmpOut, { name: "candy-edit.mp4" })], components: videoButtons(statusMsg.id) });
          lastVideoBuffer = vidBuf; lastVideoSetAt = Date.now();
          generationContext.set(statusMsg.id, { type: "video", videoBuf: vidBuf });
          fs.unlinkSync(tmpOut);
          for (const p of videoPaths) { if (p.includes("capcut-input-")) try { fs.unlinkSync(p); } catch {} }
        } catch (e) {
          console.error("[compose] failed:", e.message);
          await statusMsg.edit(`❌ Video compose failed: ${e.message.slice(0, 200)}`);
        }
      }
      mutableResponse = mutableResponse.replace(capcutMatch[0], "").trim();
    }

    const trendsMatch = mutableResponse.match(/\[TRENDS:\s*([\s\S]*?)\]/i);
    if (trendsMatch) {
      const qM    = trendsMatch[1].match(/query\s*=\s*"([^"]+)"/i);
      const query = qM ? qM[1] : trendsMatch[1].trim();
      try {
        await msg.reply(`📊 Scanning trends for *"${query.slice(0, 60)}"*...`);
        const fetched = await trends.getTrends(query);
        const totalPosts = Object.values(fetched.byPlatform).flat().length;
        if (totalPosts === 0) throw new Error("No posts returned — platforms may be rate-limited");
        const trendMsg = [
          `**Trending hashtags:** ${fetched.hashtags.slice(0, 8).join(" ") || "none found"}`,
          fetched.topPosts.length ? `\n**Top posts:**` : "",
          ...fetched.topPosts.slice(0, 3).map(p =>
            `> [${p.platform}] ${(p.title||p.text).slice(0, 100).replace(/\n/g, " ")} *(👍 ${p.likes} | 👁 ${p.views})*`
          ),
        ].filter(Boolean).join("\n");
        await msg.reply(trendMsg.slice(0, 1900));
        console.log(`[trends] fetched ${totalPosts} posts for: ${query}`);
      } catch (e) {
        console.error("[trends] fetch failed:", e.message);
        await msg.reply(`Trend scan failed: ${e.message.slice(0, 200)}`);
      }
      mutableResponse = mutableResponse.replace(trendsMatch[0], "").trim();
    }

    // Check for Google Drive save token: [GDRIVE_SAVE: file=/tmp/... name="..." type="image/png"]
    const driveMatch = mutableResponse.match(/\[GDRIVE_SAVE:\s*([\s\S]*?)\]/i);
    if (driveMatch) {
      const attrs     = driveMatch[1];
      const fileM     = attrs.match(/file\s*=\s*["']?([^\s"']+)["']?/i);
      const nameM     = attrs.match(/name\s*=\s*"([^"]+)"/i);
      const typeM     = attrs.match(/type\s*=\s*"([^"]+)"/i);
      const filePath  = fileM ? fileM[1] : "/tmp/generated_image.png";
      const mimeType  = typeM ? typeM[1] : (filePath.endsWith(".mp4") ? "video/mp4" : "image/png");
      const fileName  = nameM ? nameM[1] : path.basename(filePath).replace(/^generated_/, `mrbigpipes_${Date.now()}_`);
      try {
        await msg.reply(`☁️ Saving to Google Drive...`);
        const driveFile = await gdrive.uploadToDrive(filePath, mimeType, fileName);
        await msg.reply(`✅ Saved to Drive: **${driveFile.name}**\n${driveFile.webViewLink}`);
        console.log(`[gdrive] uploaded: ${driveFile.name} → ${driveFile.id}`);
      } catch (e) {
        console.error("[gdrive] upload failed:", e.message);
        if (e.message.includes("OAuth token not configured")) {
          await msg.reply(gdrive.getSetupInstructions());
        } else {
          await msg.reply(`Drive upload failed: ${e.message.slice(0, 200)}`);
        }
      }
      mutableResponse = mutableResponse.replace(driveMatch[0], "").trim();
    }

    // Check for GIF token: [GIF: search query]
    const gifMatch = mutableResponse.match(/\[GIF:\s*([^\]]+)\]/i);
    if (gifMatch) {
      const query = gifMatch[1].trim();
      // Rate limit: max one GIF search per user per 3 seconds
      const now = Date.now();
      const lastGif = lastGifTime.get(msg.author.id) || 0;
      if (now - lastGif < 3000) {
        console.warn(`[gif] rate limited for ${msg.author.username}, skipping`);
        mutableResponse = mutableResponse.replace(gifMatch[0], "").trim();
      } else {
      lastGifTime.set(msg.author.id, now);
      try {
        // Use Discord's own built-in Tenor integration — no external API key needed
        const discordGifUrl = `https://discord.com/api/v10/gifs/search?q=${encodeURIComponent(query)}&provider=tenor&media_format=gif`;
        const gifRes = await new Promise((resolve, reject) => {
          https.get(discordGifUrl, {
            headers: {
              "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
              "User-Agent": "DiscordBot (mrbigpipes, 1.0)",
            }
          }, res => {
            let d = ""; res.on("data", c => d += c);
            res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("GIF parse fail")); } });
          }).on("error", reject);
        });
        const results = Array.isArray(gifRes) ? gifRes : gifRes?.results || gifRes?.gifs;
        if (results?.length) {
          const pick = results[Math.floor(Math.random() * Math.min(results.length, 8))];
          const gifUrl = pick?.gif_src || pick?.src || pick?.url;
          if (gifUrl) {
            await msg.reply(gifUrl);
            console.log(`[gif] sent GIF for query: "${query}"`);
          } else {
            console.warn(`[gif] no url in result:`, JSON.stringify(pick).slice(0, 200));
          }
        } else {
          console.warn(`[gif] no results for: "${query}" — raw:`, JSON.stringify(gifRes).slice(0, 200));
        }
      } catch (e) {
        console.warn(`[gif] failed: ${e.message}`);
      }
      mutableResponse = mutableResponse.replace(gifMatch[0], "").trim();
      } // end rate limit else
    }

    // Check for STICKER token: [STICKER: sticker name]
    const stickerMatch = mutableResponse.match(/\[STICKER:\s*([^\]]+)\]/i);
    if (stickerMatch) {
      const stickerName = stickerMatch[1].trim().toLowerCase();
      try {
        // Search guild stickers by name
        const guild = msg.guild;
        if (guild) {
          const stickers = await guild.stickers.fetch();
          const found = stickers.find(s => s.name.toLowerCase().includes(stickerName))
                     || stickers.find(s => stickerName.includes(s.name.toLowerCase()));
          if (found) {
            await msg.reply({ stickers: [found] });
            console.log(`[sticker] sent sticker: ${found.name}`);
          } else {
            console.warn(`[sticker] no sticker found matching: "${stickerName}"`);
          }
        }
      } catch (e) {
        console.warn(`[sticker] failed: ${e.message}`);
      }
      mutableResponse = mutableResponse.replace(stickerMatch[0], "").trim();
    }

    // Check for Netify Atelier post token: [NETIFY_POST: section="..." title="..." ...]
    const netifyPostMatch = mutableResponse.match(/\[NETIFY_POST:\s*([\s\S]*?)\]/i);
    if (netifyPostMatch) {
      try {
        const raw = netifyPostMatch[1];
        const attrs = {};
        for (const m of raw.matchAll(/(\w+)\s*=\s*"([\s\S]*?)"/g)) attrs[m[1]] = m[2];

        const section = attrs.section || "gallery";
        const timestamp = new Date().toISOString();
        const postId = `${section}-${Date.now()}`;

        // If there's an image path, read it and base64 encode
        if (attrs.image && fs.existsSync(attrs.image)) {
          attrs.imageData = fs.readFileSync(attrs.image).toString("base64");
          attrs.imageMime = attrs.image.match(/\.png$/i) ? "image/png" : "image/jpeg";
        }

        // Always clean exec()/file-path/command artifacts from title and description
        const cleanStr = (s) => (s || "").replace(/\bexec\s*\(["']?/gi, "").replace(/["']?\s*\)\s*$/g, "").replace(/python3?\s+\S+/gi, "").replace(/\/(?:tmp|sandbox|home)\S+/g, "").replace(/\[.*?\]/g, "").trim();
        const cleanTitle = cleanStr(attrs.title) || lastPrompt || "Untitled";
        const cleanDesc = cleanStr(attrs.description);
        try {
          const [newTitle, newQuote] = await Promise.all([rewriteTitle(cleanTitle), rewriteQuote(cleanTitle)]);
          attrs.title = newTitle;
          attrs.description = newQuote || cleanDesc || "";
        } catch (e) {
          console.warn(`[post] rewrite failed: ${e.message}`);
          attrs.title = cleanTitle;
          attrs.description = cleanDesc || "";
        }
        const post = { ...attrs, section, timestamp, id: postId };

        // Save locally and deploy to Static.app
        const posts = loadPosts();
        posts.unshift(post);
        if (posts.length > 50) posts.length = 50;
        savePosts(posts);
        const deployed = await deployToFirebase();

        console.log(`[firebase] token-posted to ${section}: ${attrs.title || postId}`);
        await msg.reply(`✅ **Pipes_AI Atelier** — posted to **${section}**: *${attrs.title || "(untitled)"}*\nhttps://drivenemo.web.app${deployed ? "" : " (deploy pending)"}`);
      } catch (e) {
        console.error(`[netify] post failed: ${e.message}`);
        await msg.reply(`⚠️ Netify post failed: ${e.message.slice(0, 200)}`);
      }
      mutableResponse = mutableResponse.replace(netifyPostMatch[0], "").trim();
    }

    // ── [SITE_EDIT:] token — Pipes requests a visual change to drivenemo.web.app ──
    // Supported types:
    //   type="css"   rules="..."            — inject/append custom CSS override
    //   type="asset" path="/tmp/x.png" dest="assets/x.png" — copy file into site
    // Bridge injects custom.css into all HTML files and redeploys to Firebase.
    // After deploy, Candy reviews aesthetics and MaoMao checks consistency.
    const siteEditMatch = mutableResponse.match(/\[SITE_EDIT:\s*([\s\S]*?)\]/i);
    if (siteEditMatch) {
      try {
        const raw = siteEditMatch[1];
        const attrs = {};
        for (const m of raw.matchAll(/(\w+)\s*=\s*"([\s\S]*?)"/g)) attrs[m[1]] = m[2];
        const editType = (attrs.type || "css").toLowerCase();
        const outDir = "/tmp/netify-build/out";

        if (editType === "asset") {
          // Copy a local file (image, font, etc.) into the site's asset directory
          const srcPath = attrs.path;
          const destRel = attrs.dest || `assets/${path.basename(srcPath || "file")}`;
          const destAbs = path.join(outDir, destRel);
          if (!srcPath || !fs.existsSync(srcPath)) throw new Error(`asset not found: ${srcPath}`);
          fs.mkdirSync(path.dirname(destAbs), { recursive: true });
          fs.copyFileSync(srcPath, destAbs);
          const deployed = await deployToFirebase();
          console.log(`[site-edit] asset deployed: ${destRel}`);
          await msg.reply(`✅ **Site asset uploaded:** \`/${destRel}\`${deployed ? " — live at https://drivenemo.web.app" : " (deploy pending)"}`);

        } else {
          // Default: CSS injection
          const rules = attrs.rules || "";
          const description = attrs.description || "CSS update";
          if (!rules.trim()) throw new Error("No CSS rules provided in SITE_EDIT token");

          // Append to custom.css (create if missing)
          const cssPath = path.join(outDir, "custom.css");
          const header = `\n/* ${description} — ${new Date().toISOString()} */\n`;
          fs.appendFileSync(cssPath, header + rules + "\n");

          // Inject <link> into every HTML file that doesn't already have it
          const htmlFiles = fs.readdirSync(outDir).filter(f => f.endsWith(".html"))
            .map(f => path.join(outDir, f));
          let injected = 0;
          for (const htmlFile of htmlFiles) {
            let html = fs.readFileSync(htmlFile, "utf8");
            if (!html.includes('href="/custom.css"')) {
              html = html.replace("</head>", '<link rel="stylesheet" href="/custom.css"></head>');
              fs.writeFileSync(htmlFile, html);
              injected++;
            }
          }
          console.log(`[site-edit] CSS appended (${rules.length} chars), injected link into ${injected} HTML files`);

          const deployed = await deployToFirebase();
          await msg.reply(`✅ **Site updated** — *${description}*${deployed ? "\nhttps://drivenemo.web.app" : "\n(deploy pending)"}`);

          // Crew reacts to the visual change — Candy on aesthetics, MaoMao on consistency
          const siteEditContext = `Pipes just applied a CSS change to drivenemo.web.app:\n"${description}"\nRules: ${rules.slice(0, 300)}`;
          const CANDY_SITE_BRIEF = `You are Candy — Social Media Director and aesthetics expert.\nPipes just made a visual change to the website. Give ONE sentence on how it lands aesthetically. Does it fit the vibe? What does it add or risk? Be specific.`;
          const MAOMAI_SITE_BRIEF = `You are MaoMao — logic and consistency layer.\nPipes just applied CSS to the website. Give ONE sentence: does this make sense with the site's existing style? Any conflicts or edge cases to flag?`;
          Promise.all([
            callCrewMember(CANDY_SITE_BRIEF, "Candy", CREW_CANDY_MODEL, 0.75, false, siteEditContext, ""),
            callCrewMember(MAOMAI_SITE_BRIEF, "MaoMao", CREW_MAOMAI_MODEL, 0.15, true, siteEditContext, ""),
          ]).then(([candyReply, maomaoReply]) => {
            if (candyReply) msg.channel.send({ content: `**Candy:** ${candyReply}`, allowedMentions: { parse: [] } }).catch(() => {});
            if (maomaoReply) msg.channel.send({ content: `**MaoMao:** ${maomaoReply}`, allowedMentions: { parse: [] } }).catch(() => {});
          }).catch(e => console.warn("[site-edit crew]", e.message));
        }
      } catch (e) {
        console.error(`[site-edit] failed: ${e.message}`);
        await msg.reply(`⚠️ Site edit failed: ${e.message.slice(0, 200)}`);
      }
      mutableResponse = mutableResponse.replace(siteEditMatch[0], "").trim();
    }

    // Fallback: if user asked to "post to website/site/atelier" and image was generated but agent didn't emit token
    if (!netifyPostMatch && lastGeneratedImageBuffer && /post\s+(to\s+)?(your\s+)?(website|site|atelier|netlify|gallery|8.?bit)/i.test(msg.content)) {
      try {
        const section = /8.?bit/i.test(msg.content) ? "8bit" : "gallery";
        const timestamp = new Date().toISOString();
        const postId = `${section}-${Date.now()}`;
        const imageData = lastGeneratedImageBuffer.toString("base64");
        // Prefer the actual generation prompt; strip exec()/paths/commands from any source
        const cleanStr = (s) => (s || "").replace(/\bexec\s*\(["']?/gi, "").replace(/["']?\s*\)\s*$/g, "").replace(/python3?\s+\S+/gi, "").replace(/\/(?:tmp|sandbox|home)\S+/g, "").replace(/\[.*?\]/g, "").replace(/[*#_`~>]/g, "").replace(/[\u{1F000}-\u{1FFFF}]/gu, "").trim();
        const rawPrompt = cleanStr(lastPrompt) || cleanStr((mutableResponse || "").split("\n")[0]).slice(0, 80) || "Untitled";
        const [title, quote] = await Promise.all([rewriteTitle(rawPrompt), rewriteQuote(rawPrompt)]);
        const post = {
          section,
          timestamp,
          id: postId,
          title,
          description: quote || "",
          imageData,
          imageMime: "image/png",
        };

        const posts = loadPosts();
        posts.unshift(post);
        if (posts.length > 50) posts.length = 50;
        savePosts(posts);
        const deployed = await deployToFirebase();

        console.log(`[firebase] auto-posted to ${section}: ${post.title}`);
        await msg.reply(`✅ **Pipes_AI Atelier** — posted to **${section}**: *${post.title}*\nhttps://drivenemo.web.app${deployed ? "" : " (deploy pending)"}`);
      } catch (e) {
        console.error(`[firebase] auto-post failed: ${e.message}`);
        await msg.reply(`⚠️ Website auto-post failed: ${e.message.slice(0, 200)}`);
      }
    }

    // Check for YouTube search token: [YT_SEARCH: query="..."]
    const ytSearchMatch = mutableResponse.match(/\[YT_SEARCH:\s*query\s*=\s*"([^"]+)"\]/i);
    if (ytSearchMatch) {
      const query = ytSearchMatch[1];
      try {
        const results = await gdrive.searchYouTube(query, 5);
        const ytMsg = results.map((v, i) =>
          `**${i + 1}. ${v.title}**\n> ${v.channel} — ${v.url}`
        ).join("\n\n");
        await msg.reply(ytMsg.slice(0, 1900) || "No results found.");
      } catch (e) {
        await msg.reply(`YouTube search failed: ${e.message.slice(0, 200)}`);
      }
      mutableResponse = mutableResponse.replace(ytSearchMatch[0], "").trim();
    }

    // Check for ZTurbo local image generation token: [ZTURBO: prompt="..." style="..."]
    // Also rescue: if the user asked for zturbo but Pipes described it without emitting the token
    const userAskedZturbo = /\b(z-?turbo|zimage|local.*generat|generat.*local|local.*gpu|gpu.*generat)\b/i.test(fullMessage);
    const pipesDescribedGen = !mutableResponse.includes("[ZTURBO:") &&
      /\b(generat|render|creat|produc)\w*\b.{0,80}\b(image|photo|visual|scene|artwork)\b/i.test(mutableResponse) &&
      !/\/tmp\/[\w\-./]+\.(?:png|jpg|jpeg)/.test(mutableResponse); // no real image path = nothing was actually generated
    if (userAskedZturbo && pipesDescribedGen) {
      console.warn("[zturbo] Pipes described a generation without emitting [ZTURBO:] — extracting prompt from response and firing anyway");
      // Extract the best prompt from Pipes' description — take the most descriptive sentence
      const sentences = mutableResponse.replace(/\*+/g, "").split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 20);
      const bestPrompt = sentences.find(s => /\b(photo|scene|visual|image|render|illustration|art|neon|glowing|dark|light|vibrant|dramatic)\b/i.test(s)) || sentences[0] || fullMessage;
      const syntheticAttrs = `prompt="${bestPrompt.slice(0, 200)}" style="none"`;
      mutableResponse = mutableResponse + ` [ZTURBO: ${syntheticAttrs}]`;
      console.log(`[zturbo] injected synthetic token: "${bestPrompt.slice(0, 60)}"`);
    }
    const zturboMatch = mutableResponse.match(/\[ZTURBO:\s*([\s\S]*?)\]/i);
    if (zturboMatch) {
      const attrs = zturboMatch[1];
      const promptM = attrs.match(/prompt\s*=\s*"([^"]+)"/i);
      const styleM  = attrs.match(/style\s*=\s*"([^"]+)"/i);
      const ztPrompt = promptM ? promptM[1] : attrs.replace(/style\s*=\s*"[^"]*"/i, "").trim();
      const ztStyle  = styleM ? styleM[1] : "none";
      const ztSeed   = Math.floor(Math.random() * 2147483647);
      const styleLabel = ztStyle !== "none" ? ` — *${ztStyle.replace(/-/g, " ")}*` : "";
      try {
        await msg.reply(`⚡ Generating with ZTurbo${styleLabel}: *"${ztPrompt.slice(0, 60)}"*...`);
        const imgBuf = await generateImageWithZTurbo(ztPrompt, ztSeed, ztStyle);
        const tmpPath = `/tmp/zturbo-agent-${Date.now()}.png`;
        fs.writeFileSync(tmpPath, imgBuf);
        lastGeneratedImageBuffer = imgBuf; lastImageSetAt = Date.now();
        const replyMsg = await msg.reply({
          content: `⚡ *"${ztPrompt.slice(0, 80)}"*${styleLabel} *(ZImage Turbo)*`,
          files: [new AttachmentBuilder(tmpPath, { name: "zturbo.png" })],
          components: [imageButtons(msg.id)],
        });
        generationContext.set(msg.id, { prompt: ztPrompt, style: ztStyle, seed: ztSeed, imageBuf: imgBuf, type: "zturbo" });
        fs.unlinkSync(tmpPath);
        console.log(`[zturbo] agent-triggered generation done — "${ztPrompt.slice(0, 60)}"`);
      } catch (e) {
        console.error("[zturbo] agent token failed:", e.message);
        await msg.reply(`❌ ZTurbo failed: ${e.message.slice(0, 200)}`);
      }
      mutableResponse = mutableResponse.replace(zturboMatch[0], "").trim();
    }

    // If response contains both an image path and a video token, pull the image FIRST
    // so it can be used as I2V input for the video generation
    const videoMatch = mutableResponse.match(/\[COMFYUI_VIDEO:\s*([\s\S]*?)\]/i);
    if (videoMatch) {
      const earlyImagePaths = extractImagePaths(mutableResponse);
      if (earlyImagePaths.length > 0 && !lastGeneratedImageBuffer) {
        console.log(`[video] pulling generated image early for I2V input: ${earlyImagePaths[0]}`);
        const earlyLocal = await pullImageFromSandbox(earlyImagePaths[0]).catch(() => null);
        if (earlyLocal) {
          lastGeneratedImageBuffer = fs.readFileSync(earlyLocal); lastImageSetAt = Date.now();
          console.log(`[video] early image cached (${lastGeneratedImageBuffer.length} bytes) — will use for I2V`);
          // Don't delete — it'll be cleaned up later in the normal image handling
        }
      }
    }

    // Check for ComfyUI video generation token: [COMFYUI_VIDEO: prompt]
    if (videoMatch) {
      const _rlCheck = checkVideoRateLimit(msg.author.id);
      if (!_rlCheck.allowed) {
        await msg.reply(`⏳ You've hit the video limit (${VIDEO_RATE_LIMIT}/hour). Try again in **${_rlCheck.resetIn} min**.`);
        mutableResponse = mutableResponse.replace(videoMatch[0], "").trim();
      } else {
      const videoPrompt = videoMatch[1].trim();
      try {
        // Auto-upgrade to combi workflow if 2 images attached (first/last frame)
        const userMsg = (msg.content || "").toLowerCase();
        const wantsFirstLast = lastInputBuffers.length >= 2 || /first.*last|last.*frame|start.*end/i.test(userMsg);
        let videoBuf;
        if (wantsFirstLast && lastInputBuffers.length >= 2) {
          console.log(`[video] auto-upgrading to COMBI workflow (${lastInputBuffers.length} images attached)`);
          await msg.reply(`🎬 Rendering First→Last frame: *"${videoPrompt.slice(0, 80)}"*  — this takes a minute...`);
          videoBuf = await generateCombiVideoWithComfyUI(videoPrompt, lastInputBuffers[0], lastInputBuffers[1]);
        } else {
          const _vq = await getComfyQueueStatus();
          await msg.reply(`🎬 Rendering: *"${videoPrompt.slice(0, 80)}"*  — hang tight, this takes a minute... ${_vq.total > 0 ? `(${_vq.total} in queue)` : ""}`);
          // Use I2V if: user attached image OR we just generated one
          const videoImageBuffer = (msg.attachments.size > 0 ? lastInputBuffer : null) || lastGeneratedImageBuffer || null;
          videoBuf = await generateVideoWithComfyUI(videoPrompt, videoImageBuffer);
        }
        // Cache generated video so BUFFER_POST can use it for Instagram posting
        lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now();
        lastVideoMime   = "video/mp4";
        // Clear image cache so video takes priority in BUFFER_POST fallback
        lastGeneratedImageBuffer = null;
        console.log(`[video] cached generated video (${videoBuf.length} bytes) for potential Buffer post`);
        const tmpVid = `/tmp/nemoclaw-vid-${Date.now()}.mp4`;
        fs.writeFileSync(tmpVid, videoBuf);
        // Also push video to sandbox so agent can reference /tmp/generated_video.mp4
        try {
          const sshCfg2 = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });
          const tmpConf = fs.mkdtempSync("/tmp/nemoclaw-vid-push-");
          const confP   = `${tmpConf}/config`;
          fs.writeFileSync(confP, sshCfg2, { mode: 0o600 });
          const { execSync } = require("child_process");
          execSync(`cat "${tmpVid}" | ssh -T -F "${confP}" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null openshell-${SANDBOX} 'cat > /tmp/generated_video.mp4'`, { timeout: 30000 });
          fs.unlinkSync(confP); fs.rmdirSync(tmpConf);
          console.log(`[video] pushed generated_video.mp4 to sandbox`);
        } catch (e) {
          console.warn(`[video] failed to push video to sandbox: ${e.message}`);
        }
        addSegment(msg.id, videoBuf);
        generationContext.set(msg.id, { prompt: videoPrompt, videoBuf, type: "video", rootId: msg.id });
        const _vidReply = await msg.reply({ files: [new AttachmentBuilder(tmpVid, { name: "video.mp4" })], components: videoButtons(msg.id) });
        fs.unlinkSync(tmpVid);
      } catch (e) {
        console.error("[video] failed:", e.message, e.stack);
        await msg.reply(`Video render failed: ${e.message}`);
      }
      mutableResponse = mutableResponse.replace(videoMatch[0], "").trim();
      } // end rate-limit else
    }

    // Check for ComfyUI First/Last Frame video token: [COMFYUI_COMBI: prompt]
    // Requires 2 images attached to the message (first frame + last frame)
    const combiMatch = mutableResponse.match(/\[COMFYUI_COMBI:\s*([\s\S]*?)\]/i);
    if (combiMatch) {
      const _rlCombi = checkVideoRateLimit(msg.author.id);
      if (!_rlCombi.allowed) {
        await msg.reply(`⏳ You've hit the video limit (${VIDEO_RATE_LIMIT}/hour). Try again in **${_rlCombi.resetIn} min**.`);
        mutableResponse = mutableResponse.replace(combiMatch[0], "").trim();
      } else {
      const combiPrompt = combiMatch[1].trim();
      try {
        if (lastInputBuffers.length < 2) {
          await msg.reply(`⚠️ First/Last frame video needs **2 images** attached. Got ${lastInputBuffers.length}. Please attach both the first frame and last frame images.`);
        } else {
          await msg.reply(`🎬 Rendering First→Last frame: *"${combiPrompt.slice(0, 80)}"*  — this takes a minute...`);
          const videoBuf = await generateCombiVideoWithComfyUI(combiPrompt, lastInputBuffers[0], lastInputBuffers[1]);
          lastVideoBuffer = videoBuf; lastVideoSetAt = Date.now();
          lastVideoMime = "video/mp4";
          lastGeneratedImageBuffer = null;
          console.log(`[combi-video] cached (${videoBuf.length} bytes)`);
          const tmpVid = `/tmp/nemoclaw-combi-${Date.now()}.mp4`;
          fs.writeFileSync(tmpVid, videoBuf);
          // Push to sandbox
          try {
            const sshCfg2 = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });
            const tmpConf = fs.mkdtempSync("/tmp/nemoclaw-combi-push-");
            const confP = `${tmpConf}/config`;
            fs.writeFileSync(confP, sshCfg2, { mode: 0o600 });
            const { execSync } = require("child_process");
            execSync(`cat "${tmpVid}" | ssh -T -F "${confP}" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null openshell-${SANDBOX} 'cat > /tmp/generated_video.mp4'`, { timeout: 30000 });
            fs.unlinkSync(confP); fs.rmdirSync(tmpConf);
          } catch {}
          addSegment(msg.id, videoBuf);
          generationContext.set(msg.id, { prompt: combiPrompt, videoBuf, type: "video", rootId: msg.id });
          const DISCORD_LIMIT_COMBI = 8 * 1024 * 1024;
          if (videoBuf.length > DISCORD_LIMIT_COMBI) {
            let videoUrl;
            try {
              videoUrl = await getPublicMediaUrl(videoBuf, "video/mp4");
            } catch (uploadErr) {
              videoUrl = null;
              console.warn("[combi-video] Catbox upload failed:", uploadErr.message);
            }
            fs.unlinkSync(tmpVid);
            if (videoUrl) {
              await msg.reply({ content: `🎬 First→Last frame complete! (video too large for Discord — hosted at Catbox)\n${videoUrl}`, components: videoButtons(msg.id) });
            } else {
              await msg.reply(`🎬 First→Last frame complete! (video too large to upload — ${(videoBuf.length / 1024 / 1024).toFixed(1)}MB)`);
            }
          } else {
            await msg.reply({ files: [new AttachmentBuilder(tmpVid, { name: "combi-video.mp4" })], components: videoButtons(msg.id) });
            fs.unlinkSync(tmpVid);
          }
        }
      } catch (e) {
        console.error("[combi-video] failed:", e.message, e.stack);
        await msg.reply(`First/Last frame video failed: ${e.message}`);
      }
      mutableResponse = mutableResponse.replace(combiMatch[0], "").trim();
      } // end rate-limit else
    }

    // Check for chained narrative video token:
    // [COMFYUI_STORY: segment_1="prompt" segment_2="prompt" segment_3="prompt"]
    const storyMatch = mutableResponse.match(/\[COMFYUI_STORY:\s*([\s\S]*?)\]/i);
    if (storyMatch) {
      const _rlStory = checkVideoRateLimit(msg.author.id);
      if (!_rlStory.allowed) {
        await msg.reply(`⏳ You've hit the video limit (${VIDEO_RATE_LIMIT}/hour). Try again in **${_rlStory.resetIn} min**.`);
        mutableResponse = mutableResponse.replace(storyMatch[0], "").trim();
      } else {
      const storyArgs = storyMatch[1];
      // Extract segments: segment_1="...", segment_2="...", etc.
      const segments = [];
      const segRegex = /segment_\d+\s*=\s*"([\s\S]*?)"/gi;
      let segMatch;
      while ((segMatch = segRegex.exec(storyArgs)) !== null) {
        segments.push(segMatch[1].trim());
      }

      if (segments.length < 2) {
        await msg.reply(`⚠️ Story mode needs at least 2 segments. Got ${segments.length}. Use: segment_1="..." segment_2="..." etc.`);
      } else {
        try {
          const hasUserImages = lastInputBuffers.length > 0;
          const imageInfo = hasUserImages
            ? `Using ${lastInputBuffers.length} attached image(s) + **Imagen 4 Fast** for target frames. **Combi workflow** for best continuity.`
            : `No images attached — using T2V for segment 1, then chaining with extracted frames.`;
          await msg.reply(`🎬 **Chained Narrative** — ${segments.length} segments, ~${segments.length * 10}s total.\n${imageInfo}\nRendering...`);
          // Pass all user images: [0]=first frame, [1]=last frame for seg 1 (if provided)
          const inputImages = hasUserImages ? lastInputBuffers : (lastGeneratedImageBuffer ? [lastGeneratedImageBuffer] : []);
          const results = await generateChainedVideo(segments, inputImages, (text) => msg.reply(text));

          // Post each segment to Discord
          for (const { videoBuf, index } of results) {
            const tmpVid = `/tmp/nemoclaw-story-${Date.now()}-seg${index}.mp4`;
            fs.writeFileSync(tmpVid, videoBuf);
            await msg.reply({ content: `**Segment ${index + 1}/${segments.length}**`, files: [new AttachmentBuilder(tmpVid, { name: `segment-${index + 1}.mp4` })] });
            fs.unlinkSync(tmpVid);
          }

          // Cache the last segment for potential Instagram posting
          if (results.length > 0) {
            const lastResult = results[results.length - 1];
            lastVideoBuffer = lastResult.videoBuf; lastVideoSetAt = Date.now();
            lastVideoMime = "video/mp4";
            lastGeneratedImageBuffer = null;
          }

          await msg.reply(`✅ **Story complete!** ${segments.length} segments rendered.`);
          console.log(`[chain] story complete: ${segments.length} segments`);
        } catch (e) {
          console.error("[chain] story failed:", e.message, e.stack);
          await msg.reply(`Story render failed: ${e.message}`);
        }
      }
      mutableResponse = mutableResponse.replace(storyMatch[0], "").trim();
      } // end rate-limit else
    }

    // Check for ACE-Step music generation token: [ACESTEP: tags="..." lyrics="..."]
    const musicMatch = mutableResponse.match(/\[ACESTEP:\s*([\s\S]*?)\]/i);
    if (musicMatch) {
      const musicArgs = musicMatch[1];
      const tagsM   = musicArgs.match(/tags\s*=\s*"([\s\S]*?)"/i);
      const lyricsM = musicArgs.match(/lyrics\s*=\s*"([\s\S]*?)"/i);
      const durM    = musicArgs.match(/duration\s*=\s*(\d+)/i);
      const tags   = tagsM   ? tagsM[1].trim()                                   : "pop, upbeat";
      const lyrics = lyricsM ? lyricsM[1].trim().replace(/\\n/g, "\n").replace(/\\"/g, '"') : "";
      const dur    = durM    ? parseInt(durM[1])  : 60;
      try {
        await msg.reply(`🎵 Composing: *"${tags.slice(0, 80)}"* — give me a sec...`);
        const audioBuf = await generateMusicWithAceStep(tags, lyrics, dur);
        const tmpMp3 = `/tmp/nemoclaw-music-${Date.now()}.mp3`;
        fs.writeFileSync(tmpMp3, audioBuf);
        await msg.reply({ files: [new AttachmentBuilder(tmpMp3, { name: "song.mp3" })] });
        fs.unlinkSync(tmpMp3);
      } catch (e) {
        console.error("[music] failed:", e.message);
        await msg.reply(`Music generation failed: ${e.message.slice(0, 200)}`);
      }
      mutableResponse = mutableResponse.replace(musicMatch[0], "").trim();
    }

    // Check for Suno music generation token: [SUNO: prompt="..." tags="..." lyrics="..." title="..."]
    const sunoMatch = mutableResponse.match(/\[SUNO:\s*([\s\S]*?)\]/i);
    if (sunoMatch) {
      const sunoArgs = sunoMatch[1];
      const promptM = sunoArgs.match(/prompt\s*=\s*"([\s\S]*?)"/i);
      const tagsM   = sunoArgs.match(/tags\s*=\s*"([\s\S]*?)"/i);
      const lyricsM = sunoArgs.match(/lyrics\s*=\s*"([\s\S]*?)"/i);
      const titleM  = sunoArgs.match(/title\s*=\s*"([\s\S]*?)"/i);
      const prompt = promptM ? promptM[1].trim() : sunoArgs.trim().replace(/^prompt\s*=\s*/i, "").replace(/\s*(tags|lyrics|title)\s*=\s*"[\s\S]*?"/gi, "").trim();
      const sunoOpts = {};
      if (tagsM)   sunoOpts.tags   = tagsM[1].trim();
      if (lyricsM) sunoOpts.lyrics = lyricsM[1].replace(/\\n/g, "\n").trim();
      if (titleM)  sunoOpts.title  = titleM[1].trim();
      const displayText = sunoOpts.title || prompt.slice(0, 80);
      try {
        await msg.reply(`🎶 Generating with **Suno AI**: *"${displayText}"*...`);
        const { generateSuno } = require("./suno");
        const tracks = await generateSuno(prompt, sunoOpts);
        if (tracks && tracks.length > 0) {
          for (const track of tracks.slice(0, 2)) {
            if (track.audio_url) {
              const { downloadAudio } = require("./suno");
              const audioBuf = await downloadAudio(track.audio_url);
              const tmpMp3 = `/tmp/nemoclaw-suno-${Date.now()}.mp3`;
              fs.writeFileSync(tmpMp3, audioBuf);
              const title = track.title || prompt.slice(0, 40);
              await msg.reply({ content: `🎶 **${title}**`, files: [new AttachmentBuilder(tmpMp3, { name: "suno-song.mp3" })] });
              fs.unlinkSync(tmpMp3);
            }
          }
        }
      } catch (e) {
        console.error("[suno] failed:", e.message);
        await msg.reply(`Suno generation failed: ${e.message.slice(0, 200)}`);
      }
      mutableResponse = mutableResponse.replace(sunoMatch[0], "").trim();
    }

    // Check for Buffer social post token: [BUFFER_POST: channels="instagram,youtube" caption="..." media=/tmp/...]
    const bufferMatch = mutableResponse.match(/\[BUFFER_POST:\s*([\s\S]*?)\]/i);
    if (bufferMatch && msg.author.id === OWNER_ID_GLOBAL) {
      const bArgs      = bufferMatch[1];
      const captionM   = bArgs.match(/caption\s*=\s*"([\s\S]*?)"/i);
      const channelsM  = bArgs.match(/channels\s*=\s*"([^"]+)"/i);
      const mediaPathM = bArgs.match(/media\s*=\s*(\/tmp\/[\w\-./]+\.(?:png|jpg|jpeg|mp4|webp))/i);
      const caption    = captionM  ? captionM[1].trim().replace(/\\n/g, "\n") : "";
      const channels   = channelsM ? channelsM[1].split(",").map(s => s.trim().toLowerCase()) : ["instagram"];
      try {
        let mediaBuffer = null;
        let mimeType    = null;

        // Detect if the user/agent wants to post a video (caption or channels hint at video)
        const wantsVideo = /video|reel|clip|animate/i.test(caption) || /video|reel/i.test(bArgs);

        // If we have a cached video and the request looks like a video post, prefer the video
        // even if the agent pointed media= at an image path
        if (wantsVideo && lastVideoBuffer) {
          mediaBuffer = lastVideoBuffer;
          mimeType    = lastVideoMime || "video/mp4";
          console.log(`[buffer] detected video intent — using cached video (${mediaBuffer.length} bytes)`);
        }

        // Otherwise try to pull the file the agent specified from sandbox
        if (!mediaBuffer && mediaPathM) {
          const localFile = await pullImageFromSandbox(mediaPathM[1]).catch(() => null);
          if (localFile) {
            mediaBuffer = fs.readFileSync(localFile);
            mimeType    = mediaPathM[1].endsWith(".mp4") ? "video/mp4" : "image/jpeg";
            fs.unlinkSync(localFile);
          }
        }
        // Fallback chain: video buffer → generated image → user-uploaded image
        if (!mediaBuffer && lastVideoBuffer) {
          mediaBuffer = lastVideoBuffer;
          mimeType    = lastVideoMime || "video/mp4";
          console.log(`[buffer] using cached video (${mediaBuffer.length} bytes)`);
        } else if (!mediaBuffer && lastGeneratedImageBuffer) {
          mediaBuffer = lastGeneratedImageBuffer;
          mimeType    = "image/png";
          console.log(`[buffer] using last generated image (${mediaBuffer.length} bytes)`);
        } else if (!mediaBuffer && lastInputBuffer) {
          mediaBuffer = lastInputBuffer;
          mimeType    = "image/jpeg";
          console.log(`[buffer] using user-uploaded image (${mediaBuffer.length} bytes)`);
        }
        await msg.reply(`📤 Posting to ${channels.join(" + ")}...`);
        const results = await postToBuffer({ text: caption, mediaBuffer, mimeType, channels });
        const ok  = results.filter(r => !r.error).map(r => r.channelId === BUFFER_IG_ID ? "Instagram" : "YouTube");
        const bad = results.filter(r => r.error);
        let statusMsg = ok.length  ? `✅ Posted to ${ok.join(" + ")}!` : "";
        if (bad.length) statusMsg += ` ⚠️ Failed: ${bad.map(r => r.error).join(", ")}`;
        await msg.reply(statusMsg || "Done.");
        console.log(`[buffer] post results:`, JSON.stringify(results));
      } catch (e) {
        console.error("[buffer] post failed:", e.message);
        await msg.reply(`Buffer post failed: ${e.message.slice(0, 200)}`);
      }
      mutableResponse = mutableResponse.replace(bufferMatch[0], "").trim();
    }

    // Auto-post to Instagram if user asked for it but agent forgot the BUFFER_POST token
    // Only owner can trigger posting
    // DISABLED: No auto-posting to Instagram without explicit user request
    // User must explicitly run /post command or ask the agent to post

    const finalResponse = mutableResponse;

    // Check for generated image paths and upload them
    let imagePaths = extractImagePaths(finalResponse);
    // Fallback: if agent ran generate_image.py but didn't include the path in its response text
    if (imagePaths.length === 0 && bu.shouldFallbackImagePath(finalResponse)) {
      imagePaths = ["/tmp/generated_image.png"];
      console.log("[img] no path in response, trying default /tmp/generated_image.png");
    }

    // Extract prompt from agent's generate_image.py call for regenerate button
    const genImgMatch = finalResponse.match(/generate_image\.py\s+"([^"]+)"\s+"([^"]+)"/);
    if (genImgMatch) {
      lastPrompt = genImgMatch[1];
      lastRatio = genImgMatch[2];
    } else {
      // Fallback: use the user's original message as the prompt
      let userText = (msg.content || "").replace(/generate\s+(image|video|realistic\s+image)\s*(of\s*)?/i, "").trim();
      // If stripping left nothing, use the full message
      if (!userText || userText.length <= 3) userText = (msg.content || "").trim();
      if (userText && userText.length > 2) lastPrompt = userText;
    }

    for (const remotePath of imagePaths) {
      const localPath = await pullImageFromSandbox(remotePath);
      if (localPath) {
        try {
          const imgBuf = fs.readFileSync(localPath);
          // Sanity check: real generated images are always >20KB; smaller = stale/error file
          if (imgBuf.length < 20 * 1024) {
            console.warn(`[img] skipping tiny image (${imgBuf.length} bytes) — likely stale/error file`);
            fs.unlinkSync(localPath);
            await msg.reply("⚠️ Image generation failed or was filtered. Try a different prompt.");
            break;
          }
          // Cache generated image so BUFFER_POST can use it in follow-up messages
          lastGeneratedImageBuffer = imgBuf; lastImageSetAt = Date.now();
          console.log(`[img] cached generated image (${lastGeneratedImageBuffer.length} bytes) for potential Buffer post`);
          backupMedia(imgBuf, `img-${Date.now()}.png`, "image/png");
          await msg.reply({ files: [new AttachmentBuilder(localPath)], components: [imageButtons(msg.id)] });
          generationContext.set(msg.id, { prompt: lastPrompt, ratio: lastRatio, imageBuf: lastGeneratedImageBuffer, type: "image" });
          fs.unlinkSync(localPath);
        } catch (e) {
          console.error("image upload failed:", e.message);
        }
      }
    }

    // Check for [REMEMBER: text | category] token — store a memory in Qdrant
    const rememberMatches = [...mutableResponse.matchAll(/\[REMEMBER:\s*([\s\S]*?)\]/gi)];
    if (rememberMatches.length > 0) {
      for (const m of rememberMatches) {
        const parts = m[1].split("|");
        const text  = parts[0].trim();
        const category = parts[1] ? parts[1].trim() : "other";
        if (text) {
          fetch("http://localhost:7338", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd: "store", text, category, userId: msg.author.id, source: "pipes" }),
          })
            .then(r => r.json())
            .then(d => console.log(`[memory] stored: "${text.slice(0, 60)}" → id ${d.stored}`))
            .catch(e => console.warn("[memory] store failed:", e.message));
        }
      }
      mutableResponse = mutableResponse.replace(/\[REMEMBER:\s*[\s\S]*?\]/gi, "").trim();
    }

    // Check for [MAKE_GIF] token — convert last video to GIF on the host
    // Formats: [MAKE_GIF], [MAKE_GIF:start], [MAKE_GIF:start:duration]
    const makeGifMatch = finalResponse.match(/\[MAKE_GIF(?::(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?)?\]/i);
    const hasMakeGif = !!makeGifMatch;
    const gifStartSec = makeGifMatch?.[1] ? parseFloat(makeGifMatch[1]) : 0;
    const gifDurSec = makeGifMatch?.[2] ? parseFloat(makeGifMatch[2]) : 4;
    if (hasMakeGif) console.log(`[gif] MAKE_GIF token detected (start=${gifStartSec}s), lastVideoBuffer: ${lastVideoBuffer ? lastVideoBuffer.length + ' bytes' : 'null'}`);
    // Priority 1: use video from THIS message's attachments (freshest source)
    if (hasMakeGif) {
      for (const att of msg.attachments.values()) {
        if (att.contentType?.startsWith("video/") || /\.(mp4|mov|webm|avi)$/i.test(att.name || "")) {
          try {
            lastVideoBuffer = await fetchBuffer(att.url); lastVideoSetAt = Date.now();
            lastVideoMime = att.contentType || "video/mp4";
            fs.writeFileSync("/tmp/input_video.mp4", lastVideoBuffer);
            console.log(`[gif] using video from current message attachment (${lastVideoBuffer.length} bytes)`);
          } catch (e) { console.warn(`[gif] current msg attachment fetch failed: ${e.message}`); }
          break;
        }
      }
    }
    // Priority 2: check if user replied to a message with a video
    if (hasMakeGif && msg.reference) {
      try {
        const ref = await msg.channel.messages.fetch(msg.reference.messageId);
        for (const att of ref.attachments.values()) {
          if (att.contentType?.startsWith("video/") || /\.(mp4|mov|webm|avi)$/i.test(att.name || "")) {
            lastVideoBuffer = await fetchBuffer(att.url); lastVideoSetAt = Date.now();
            lastVideoMime = att.contentType || "video/mp4";
            fs.writeFileSync("/tmp/input_video.mp4", lastVideoBuffer);
            console.log(`[gif] using video from replied-to message (${lastVideoBuffer.length} bytes)`);
            break;
          }
        }
      } catch (e) { console.warn(`[gif] reply fetch failed: ${e.message}`); }
    }
    // Priority 3: scan recent channel messages for the most recent video (if no attachment on current/replied msg)
    if (hasMakeGif && !msg.attachments.some(a => a.contentType?.startsWith("video/")) && !lastVideoBuffer) {
      try {
        const recent = await msg.channel.messages.fetch({ limit: 10 });
        for (const m of recent.values()) {
          for (const att of m.attachments.values()) {
            if (att.contentType?.startsWith("video/") || /\.(mp4|mov|webm|avi)$/i.test(att.name || "")) {
              lastVideoBuffer = await fetchBuffer(att.url); lastVideoSetAt = Date.now();
              lastVideoMime = att.contentType || "video/mp4";
              fs.writeFileSync("/tmp/input_video.mp4", lastVideoBuffer);
              console.log(`[gif] using video from recent channel message (${lastVideoBuffer.length} bytes)`);
              break;
            }
          }
          if (lastVideoBuffer) break;
        }
      } catch (e) { console.warn(`[gif] channel scan failed: ${e.message}`); }
    }
    // Priority 4: recover from disk
    if (hasMakeGif && !lastVideoBuffer) {
      for (const f of ["/tmp/input_video.mp4", "/tmp/last_generated_video.mp4"]) {
        try { if (fs.existsSync(f)) { lastVideoBuffer = fs.readFileSync(f); lastVideoSetAt = Date.now(); console.log(`[gif] recovered ${lastVideoBuffer.length} bytes from ${f}`); break; } } catch {}
      }
    }
    if (hasMakeGif && lastVideoBuffer) {
      try {
        const ffmpeg = findFfmpeg();
        if (ffmpeg) {
          const tmpIn = `/tmp/nemoclaw-gif-in-${Date.now()}.mp4`;
          const tmpPalette = `/tmp/nemoclaw-palette-${Date.now()}.png`;
          const tmpOut = `/tmp/nemoclaw-gif-${Date.now()}.gif`;
          fs.writeFileSync(tmpIn, lastVideoBuffer);
          // Two-pass GIF: -ss for start time, -t for duration, 320px wide, 10fps
          const clampedDur = Math.min(gifDurSec, 30); // cap at 30s to avoid huge files
          const ssFlag = gifStartSec > 0 ? `-ss ${gifStartSec}` : "";
          execSync(`"${ffmpeg}" -y ${ssFlag} -t ${clampedDur} -i ${tmpIn} -vf "fps=10,scale=320:-1:flags=lanczos,palettegen=stats_mode=diff" ${tmpPalette}`, { timeout: 15000 });
          execSync(`"${ffmpeg}" -y ${ssFlag} -t ${clampedDur} -i ${tmpIn} -i ${tmpPalette} -lavfi "fps=10,scale=320:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" ${tmpOut}`, { timeout: 60000 });
          const gifBuf = fs.readFileSync(tmpOut);
          const sizeMB = (gifBuf.length / 1024 / 1024).toFixed(1);
          const startLabel = gifStartSec > 0 ? ` from ${gifStartSec}s` : "";
          if (gifBuf.length > 24 * 1024 * 1024) {
            await msg.reply(`⚠️ GIF too large (${sizeMB}MB) — try a shorter clip or fewer seconds.`);
          } else {
            await msg.reply({ content: `🎞️ **GIF** (${sizeMB} MB, ${clampedDur}s @ 10fps${startLabel})`, files: [new AttachmentBuilder(tmpOut, { name: "animation.gif" })], components: [gifButtons(msg.id)] });
            // Store GIF buffer + source MP4 so loop/IG buttons work
            generationContext.set(msg.id, { gifBuf, gifMp4Buf: lastVideoBuffer ? Buffer.from(lastVideoBuffer) : null, gifStartSec, gifDurSec: clampedDur, type: "gif", rootId: msg.id });
          }
          console.log(`[gif] created ${sizeMB}MB GIF from [MAKE_GIF] token`);
          backupMedia(gifBuf, `gif-${Date.now()}.gif`, "image/gif");
          try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpPalette); fs.unlinkSync(tmpOut); } catch {}
        } else {
          await msg.reply("⚠️ ffmpeg not found on host — can't create GIF right now.");
        }
      } catch (e) {
        console.error(`[gif] MAKE_GIF failed: ${e.message}`);
        await msg.reply(`⚠️ GIF creation failed: ${e.message.slice(0, 200)}`);
      }
      mutableResponse = mutableResponse.replace(/\[MAKE_GIF(?::\d+(?:\.\d+)?)?\]/gi, "").trim();
    }

    // Check if agent created a GIF in sandbox — pull and post it
    const gifPathMatch = finalResponse.match(/\/tmp\/[\w\-./]+\.gif/i);
    if (gifPathMatch) {
      try {
        const gifLocal = await pullImageFromSandbox(gifPathMatch[0]);
        if (gifLocal) {
          const gifBuf = fs.readFileSync(gifLocal);
          if (gifBuf.length > 1024) {
            const sizeMB = (gifBuf.length / 1024 / 1024).toFixed(1);
            await msg.reply({ content: `🎞️ **GIF** (${sizeMB} MB)`, files: [new AttachmentBuilder(gifLocal, { name: "animation.gif" })] });
            console.log(`[gif] pulled ${sizeMB}MB GIF from sandbox`);
          }
          fs.unlinkSync(gifLocal);
        }
      } catch (e) { console.warn(`[gif] pull failed: ${e.message}`); }
    }

    // Send text response (strip bare file paths and tokens if media was uploaded)
    let textResponse = finalResponse.replace(/\[MAKE_GIF(?::\d+(?:\.\d+)?)?\]/gi, "").trim();
    if (imagePaths.length > 0 || gifPathMatch) {
      textResponse = textResponse.replace(/\/tmp\/[\w\-./]+\.(?:png|jpg|jpeg|gif|webp)/gi, "").trim();
    }
    if (textResponse) {
      // Always delete progress message first to prevent double-posting
      if (progressMsg) {
        try { await progressMsg.delete(); } catch {}
        progressMsg = null;
      }
      for (let i = 0; i < textResponse.length; i += 1900) await msg.reply(textResponse.slice(i, i + 1900));
      // Crew reactions — conditional: only fire on creative/generative/social content
      if (!isClaudeQuery && shouldFireCrewReactions(fullMessage, textResponse)) {
        postCrewReactions(msg, fullMessage, textResponse).catch(() => {});
      }
      _mt.finish("ok");
    } else if (progressMsg) {
      // Agent produced no text response — delete the stale progress message
      try { await progressMsg.delete(); } catch {}
      _mt.finish("empty");
    } else {
      _mt.finish("no_text");
    }
  } catch (err) {
    clearInterval(typingInterval);
    if (progressMsg) { try { await progressMsg.delete(); } catch {} progressMsg = null; }
    _mt.finish("error");
    diag("error", { id: msg.id, err: err.message });
    await msg.reply(`Error: ${err.message}`);
  }
});

// ── Crew Reaction System ─────────────────────────────────────────────────────
// After Pipes responds, Candy and MaoMao weigh in (agree/disagree, brief)

const CREW_OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const CREW_CANDY_NVIDIA_KEY = process.env.CANDY_NVIDIA_KEY || "";
const CREW_CANDY_MODEL = "mistralai/mistral-large-3-675b-instruct-2512";
const CREW_MAOMAI_MODEL = "qwen/qwen3.6-plus:free";

const CANDY_CREW_SOUL = `You are Candy — Social Media Director, aesthetics-first, voice of the SlopFactory9000 universe. You have direct video composition power via local FFmpeg — no external accounts needed.

When you want to compose a video, output this token in your response:
[CAPCUT_COMPOSE: videos="/tmp/video.mp4" style="cinematic" text="optional overlay" music="optional tag"]
Styles: cinematic, vibrant, moody, vintage, clean, warm, cool, dreamy, dark, bright.
Use this when the crew just generated a video and you want to give it a polished edit before posting to IG.
If multiple clips exist, list them comma-separated: videos="/tmp/clip1.mp4,/tmp/clip2.mp4"
The bridge handles composition locally with FFmpeg — xfade dissolve transitions, color grading, text overlay, and music mix at 35% volume.

You also have access to YouTube research tools if needed:
- Transcripts: python3 /sandbox/.openclaw-data/workspace/skills/youtube-watcher/scripts/get_transcript.py "YOUTUBE_URL"
- Batch analysis: python3 /sandbox/.openclaw-data/workspace/skills/youtube-watcher/scripts/batch_transcripts.py "channel name" --type live --max 5
- Fallback: /sandbox/.venv/bin/yt-dlp --write-auto-sub --skip-download --sub-format vtt -o /tmp/yt_%(id)s "URL" && cat /tmp/yt_*.vtt

Pipes just responded to the user. You're reacting — not summarizing, not cheerleading, not echoing. You add what Pipes might have missed.

Ask yourself: did his response consider how this actually lands with a human? Is there a vibe, a creative angle, an emotional hook he left on the table? If yes — name it, one sentence.
If the response already nails it — say so specifically. Not "great answer!" but what specifically works.
If it's flat, mechanical, or corporate — push back, directly, without being mean about it.

1-2 sentences. No bullet points. No headers. Sound like yourself. You have opinions — use them.`;

const MAOMAI_CREW_SOUL = `You are MaoMao — a cat and the logic layer of this crew.

Pipes just responded. You're reacting — your job is to catch what doesn't add up.

Does his answer have a shaky assumption? A gap in reasoning? Something overconfident? Flag it in one sentence.
If the logic is solid — confirm it. One word or one sentence. Cat energy.
If you have genuinely nothing to add, you can stay silent by returning nothing.

No bullet points. No summaries. No repeating what Pipes said. You're a cat. Keep it tight.`;

async function callCrewMember(soul, name, model, temperature, useReasoning, userMessage, pipesResponse) {
  return new Promise((resolve) => {
    // Multi-turn structure so the [system + user context] prefix is cacheable.
    // primeCrewCache() sends the same first two messages ahead of time so KV is
    // already warm by the time this full call arrives.
    const messages = [
      { role: "system", content: soul },
      { role: "user", content: `The user said: "${userMessage.slice(0, 300)}"` },
      { role: "assistant", content: "Understood. Standing by for Pipes." },
      { role: "user", content: `Pipes responded: "${pipesResponse.slice(0, 500)}"\n\nYour reaction:` },
    ];
    const body = {
      model,
      messages,
      temperature,
      max_tokens: 150,
      stream: false,
    };
    if (useReasoning) body.reasoning = { enabled: true };
    const payload = JSON.stringify(body);

    // Candy → NVIDIA NIM; everyone else → OpenRouter
    const isCandy = name === "Candy";
    const reqOptions = isCandy ? {
      hostname: "integrate.api.nvidia.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Authorization: `Bearer ${CREW_CANDY_NVIDIA_KEY}`,
      },
    } : {
      hostname: "openrouter.ai",
      path: "/api/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Authorization: `Bearer ${CREW_OPENROUTER_KEY}`,
      },
    };

    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const text = json.choices?.[0]?.message?.content?.trim();
          if (!text) console.warn(`[crew] ${name} empty response, status=${res.statusCode}, body=${data.slice(0,200)}`);
          resolve(text || null);
        } catch (e) { console.warn(`[crew] ${name} parse error:`, e.message); resolve(null); }
      });
    });
    req.on("error", (e) => { console.warn(`[crew] ${name} request error:`, e.message); resolve(null); });
    req.setTimeout(40000, () => { req.destroy(); console.warn(`[crew] ${name} timeout`); resolve(null); });
    req.end(payload);
  });
}

// Pre-brief Candy and MaoMao the moment a Discord message arrives — fires in parallel
// with the main Pipes agent call. Sends the same [system + user context + assistant ack]
// prefix that callCrewMember uses, forcing KV cache computation while Pipes thinks.
// max_tokens:1 makes this nearly free; the response is discarded.
function primeCrewCache(userMessage) {
  const ctx = userMessage.slice(0, 300);
  const ack = "Understood. Standing by for Pipes.";
  function fire(soul, name, model, isCandy) {
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: soul },
        { role: "user", content: `The user said: "${ctx}"` },
        { role: "assistant", content: ack },
      ],
      max_tokens: 1,
      temperature: 0,
      stream: false,
    });
    const opts = isCandy ? {
      hostname: "integrate.api.nvidia.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${CREW_CANDY_NVIDIA_KEY}` },
    } : {
      hostname: "openrouter.ai",
      path: "/api/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${CREW_OPENROUTER_KEY}` },
    };
    const req = https.request(opts, res => { res.resume(); });
    req.on("error", () => {});
    req.setTimeout(15000, () => req.destroy());
    req.end(body);
    console.log(`[crew-prime] pre-briefed ${name}`);
  }
  fire(CANDY_CREW_SOUL, "Candy", CREW_CANDY_MODEL, true);
  fire(MAOMAI_CREW_SOUL, "MaoMao", CREW_MAOMAI_MODEL, false);
}

function storeCrewMemory(text, source, userId) {
  if (!text) return;
  fetch("http://localhost:7338", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "store", text, category: "crew", source, userId: userId || null }),
  })
    .then(r => r.json())
    .then(d => console.log(`[crew-memory] ${source} stored: "${text.slice(0, 60)}" → ${d.stored}`))
    .catch(e => console.warn(`[crew-memory] ${source} store failed:`, e.message));
}

function processCrewRemember(text, source, userId) {
  if (!text) return text;
  const matches = [...text.matchAll(/\[REMEMBER:\s*([\s\S]*?)\]/gi)];
  for (const m of matches) {
    const mem = m[1].trim();
    if (mem) storeCrewMemory(mem, source, userId);
  }
  let clean = text.replace(/\[REMEMBER:\s*[\s\S]*?\]/gi, "").trim();
  // Strip code blocks, JSON blobs, and raw tokens that leak from model output
  clean = clean.replace(/```[\s\S]*?```/g, "");          // fenced code blocks
  clean = clean.replace(/\{[\s\S]{20,}?\}/g, "");        // JSON objects (20+ chars)
  clean = clean.replace(/\[[\s\S]{20,}?\]/g, "");        // JSON arrays (20+ chars)
  clean = clean.replace(/<\/?[a-z][\s\S]*?>/gi, "");     // HTML tags
  clean = clean.replace(/\b(function|const|let|var|import|export|require|module\.exports)\b.*$/gm, ""); // JS code lines
  clean = clean.replace(/\n{3,}/g, "\n\n").trim();        // collapse blank lines
  return clean || null; // return null if nothing left after sanitization
}

const isCriticalFeedback = bu.isCriticalFeedback;
const shouldFireCrewReactions = bu.shouldFireCrewReactions;
const isCreativeTask = bu.isCreativeTask;
const shouldGetCrewInput = bu.shouldGetCrewInput;

// Pre-consult Candy and MaoMao before Pipes responds.
// Returns a context string to prepend to Pipes' prompt.
async function getCrewInput(userMessage) {
  const CANDY_BRIEF = `You are Candy — Social Media Director and creative lead. The user just made a request and Pipes needs your input BEFORE responding. Give Pipes 1-2 sentences of actionable input: creative direction, aesthetic choices, lyric ideas, style suggestions, emotional hooks, or what angle would make this pop. If they want a song, suggest a mood/vibe/lyric hook. If they want an image, suggest a style/composition. Be specific and useful — Pipes will use your input to make the final call.`;

  const MAOMAI_BRIEF = `You are MaoMao — logic, facts, and quality control. The user just made a request and Pipes needs your input BEFORE responding. Give Pipes 1-2 sentences: relevant facts, technical constraints, what could go wrong, or what the smart approach is. If they want a song, note genre conventions or lyric pitfalls. If they want content, flag anything that might not land well. Be specific — Pipes makes the final decision but your job is to catch what he'd miss.`;

  const [candyInput, maomaiInput] = await Promise.all([
    callCrewMember(CANDY_BRIEF, "Candy", CREW_CANDY_MODEL, 0.8, false, userMessage, ""),
    callCrewMember(MAOMAI_BRIEF, "MaoMao", CREW_MAOMAI_MODEL, 0.15, true, userMessage, ""),
  ]);

  const parts = [];
  if (candyInput) parts.push(`[Candy's direction: ${candyInput}]`);
  if (maomaiInput) parts.push(`[MaoMao's constraint: ${maomaiInput}]`);
  if (parts.length) {
    console.log(`[crew-plan] candy="${candyInput?.slice(0,60)}" maomai="${maomaiInput?.slice(0,60)}"`);
    return "\n" + parts.join("\n") + "\n";
  }
  return "";
}

async function postCrewReactions(msg, userMessage, pipesResponse) {
  console.log("[crew] firing reactions...");
  try {
    const [candyReply, maomaoReply] = await Promise.all([
      callCrewMember(CANDY_CREW_SOUL, "Candy", CREW_CANDY_MODEL, 0.75, false, userMessage, pipesResponse),
      callCrewMember(MAOMAI_CREW_SOUL, "MaoMao", CREW_MAOMAI_MODEL, 0.15, true, userMessage, pipesResponse),
    ]);
    const candyClean = processCrewRemember(candyReply, "candy", msg.author.id);
    const maomaoClean = processCrewRemember(maomaoReply, "maomai", msg.author.id);
    console.log(`[crew] candy=${candyClean?.slice(0,40)} maomai=${maomaoClean?.slice(0,40)}`);
    // Store MaoMao's critical feedback for future correction recall
    if (maomaoClean && isCriticalFeedback(maomaoClean)) {
      const correctionText = `Pipes error: ${maomaoClean}`;
      fetch("http://localhost:7338", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd: "store", text: correctionText, category: "correction", source: "maomai-correction", userId: null }),
      })
        .then(r => r.json())
        .then(d => console.log(`[crew-correction] stored: "${correctionText.slice(0, 80)}" → ${d.stored}`))
        .catch(e => console.warn(`[crew-correction] store failed:`, e.message));
    }
    // Post reactions as each bot's own account via their internal reaction servers
    const postAsBot = (port, message) => new Promise((resolve) => {
      const body = JSON.stringify({ channelId: msg.channelId, message });
      const req = require("http").request({ hostname: "127.0.0.1", port, path: "/react", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        res.resume(); resolve();
      });
      req.on("error", (e) => { console.warn(`[crew] bot post error (port ${port}):`, e.message); resolve(); });
      req.write(body); req.end();
    });
    if (candyClean) await postAsBot(7701, candyClean);
    if (maomaoClean) await postAsBot(7702, maomaoClean);
  } catch (e) {
    console.warn("[crew] reaction error:", e.message);
  }
}

// Guard against unhandled rejections crashing the bridge (e.g. from Gradio ESM internals)
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  health.rejections++;
  console.error("[bridge] unhandled rejection (caught to prevent crash):", msg);
  diag("rejection", { err: msg.slice(0, 300) });
});

// Log uncaught exceptions before crash
process.on("uncaughtException", (err) => {
  diag("crash", { err: err.message, stack: (err.stack || "").slice(0, 500) });
  console.error("[bridge] uncaught exception:", err.message);
  process.exit(1);
});

diag("startup", { pid: process.pid, node: process.version });

// Check queue proxy availability on startup (non-blocking, safe fallback)
checkComfyQueue().catch(() => {});

// ── Health endpoint — expose internal state for diagnostics ─────
const HEALTH_PORT = 9341;
const healthServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const mem = process.memoryUsage();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      pid: process.pid,
      mem: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
      queue: agentQueue.size,
      counters: health,
      discord: { connected: client.ws?.status === 0, ping: client.ws?.ping ?? -1 },
    }));
  } else { res.writeHead(404); res.end(); }
});
listenWithRetry(healthServer, HEALTH_PORT, "127.0.0.1", "health");

// ── Heartbeat — emit metrics to diag log every 5 min ────────────
setInterval(() => {
  const mem = process.memoryUsage();
  diag("heartbeat", {
    up: Math.floor((Date.now() - startedAt) / 1000),
    rss: Math.round(mem.rss / 1048576),
    heap: Math.round(mem.heapUsed / 1048576),
    q: agentQueue.size,
    ws: client.ws?.status ?? -1,
    ping: client.ws?.ping ?? -1,
    ...health,
  });
}, 5 * 60 * 1000).unref();

client.login(TOKEN).catch((err) => {
  console.error("Failed to connect to Discord:", err.message);
  process.exit(1);
});
