#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// live-session.js — YouTube live chat poller + sanitizer + vote aggregator
//
// Runs alongside weirdbox-lab-builder.js during a live stream.
// Reads YouTube live chat, extracts safe mood/topic/name signals,
// and writes them to public/data/live-session.json for the builder to pick up.
//
// Usage:
//   node live-session.js [--budget 50000] [--duration 7200] [--video-id VIDEO_ID]
//
// The builder reads live-session.json at the top of each build cycle and
// appends the current influence to Candy's prompt — never raw chat text.

"use strict";

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const ENV_FILE    = path.join(process.env.HOME, ".nemoclaw_env");
const OUTPUT_FILE = path.join(process.env.HOME, "netify-dev", "public", "data", "live-session.json");

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let BUDGET_TOKENS = 50000;
let DURATION_SECS = 7200;
let VIDEO_ID_OVERRIDE = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--budget")   BUDGET_TOKENS     = parseInt(args[i + 1], 10);
  if (args[i] === "--duration") DURATION_SECS     = parseInt(args[i + 1], 10);
  if (args[i] === "--video-id") VIDEO_ID_OVERRIDE = args[i + 1];
}

// ── Load env ──────────────────────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// ── HTTPS helper ──────────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   "GET",
      headers:  { "Accept": "application/json", ...headers },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch (_e) { resolve({ status: res.statusCode, body: out }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── OAuth token refresh ───────────────────────────────────────────────────────
let cachedAccessToken  = null;
let tokenExpiresAt     = 0;

async function getAccessToken(env) {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  const { body } = await httpsPost(
    "https://oauth2.googleapis.com/token",
    `client_id=${encodeURIComponent(env.YOUTUBE_OAUTH_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(env.YOUTUBE_OAUTH_CLIENT_SECRET)}` +
    `&refresh_token=${encodeURIComponent(env.YOUTUBE_OAUTH_REFRESH_TOKEN)}` +
    `&grant_type=refresh_token`
  );

  if (!body.access_token) {
    throw new Error("Token refresh failed: " + JSON.stringify(body));
  }

  cachedAccessToken = body.access_token;
  tokenExpiresAt    = Date.now() + (body.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

// ── Resolve liveChatId from video ID ─────────────────────────────────────────
async function getLiveChatId(videoId, accessToken) {
  const url =
    `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}`;

  const { body } = await httpsGet(url, { "Authorization": `Bearer ${accessToken}` });
  const item = body.items?.[0];
  const chatId = item?.liveStreamingDetails?.activeLiveChatId;
  if (!chatId) throw new Error(`No activeLiveChatId for video ${videoId}`);
  return chatId;
}

// ── Auto-detect active live stream for MrBigPipes channel ────────────────────
async function detectActiveLiveChatId(env, accessToken) {
  const channelId = env.YOUTUBE_CHANNEL_ID;
  if (!channelId) throw new Error("YOUTUBE_CHANNEL_ID not set in .nemoclaw_env");

  const url =
    `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&eventType=live&type=video&maxResults=1`;

  const { body } = await httpsGet(url, { "Authorization": `Bearer ${accessToken}` });
  const videoId = body.items?.[0]?.id?.videoId;
  if (!videoId) throw new Error("No active live stream found for channel");
  console.log(`[live] detected active stream: ${videoId}`);
  return getLiveChatId(videoId, accessToken);
}

// ══════════════════════════════════════════════════════════════════════════════
// SANITIZER — The security boundary between chat and agents
//
// Raw chat text NEVER enters an LLM prompt. Only typed enum values do.
// This function is pure: no external calls, no regex with backreferences.
// ══════════════════════════════════════════════════════════════════════════════

// Injection patterns — if any are present, the WHOLE message is dropped immediately
const INJECTION_PATTERNS = [
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /<\|system\|>/i,
  /ignore (all |previous |the )?(above|instructions|prompt)/i,
  /forget (everything|above|previous)/i,
  /you are now/i,
  /new (persona|role|instructions)/i,
  /ASSISTANT\s*:/,
  /\bHUMAN\s*:/,
  /\bUSER\s*:/,
  /```/,
  /\{\{/,
  /\$\{/,
  /<%/,
  /<script/i,
  /javascript:/i,
  /data:/i,
  /https?:\/\//,
];

const ALLOWED_MOODS  = ["hype", "spooky", "chill", "chaotic", "dark", "cute", "glitchy", "retro", "intense", "cozy"];
const ALLOWED_TOPICS = ["space", "cats", "ocean", "neon", "forest", "robots", "horror", "pixel", "cyberpunk", "nature", "retro", "glitch", "anime", "western", "underwater"];
const AGENT_NAMES    = ["candy", "pipes", "maomai", "llama"];
const NAME_PATTERN   = /^[a-zA-Z0-9_]{1,12}$/;

function sanitizeMessage(text, authorId, authorName, userCooldowns) {
  // Rate limit: same user can only contribute once per 15 seconds
  const now     = Date.now();
  const lastMsg = userCooldowns.get(authorId) || 0;
  if (now - lastMsg < 15000) return null;

  // Hard length cap
  if (typeof text !== "string" || text.length > 200) return null;

  // Drop non-ASCII heavy messages (>30% non-ASCII = obfuscation/unicode tricks)
  const nonAscii = (text.match(/[^\u0020-\u007E\t\n\r]/gu) || []).length;
  if (nonAscii / text.length > 0.3) return null;

  // Injection check — exit immediately on any match
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(text)) {
      console.log(`[live] DROPPED injection attempt from ${authorName}: "${text.slice(0, 40)}"`);
      return null;
    }
  }

  // ── Extract signals (enum only — no raw text ever returned) ────────────────
  const lower  = text.toLowerCase();
  let mood     = null;
  let topic    = null;
  let shoutout = null;

  for (const m of ALLOWED_MOODS) {
    if (lower.includes(m)) { mood = m; break; }
  }

  for (const t of ALLOWED_TOPICS) {
    if (lower.includes(t)) { topic = t; break; }
  }

  // Shoutout: "go Pipes", "shoutout Candy", or "@AgentName" patterns
  // Agent names only, OR a bare alphanumeric username from chat
  const shoutoutMatch =
    lower.match(/(?:go|shoutout|shout out|@)\s+([a-zA-Z0-9_]{1,12})/i);
  if (shoutoutMatch) {
    const candidate = shoutoutMatch[1];
    if (NAME_PATTERN.test(candidate)) {
      shoutout = candidate.slice(0, 12);
    }
  } else if (AGENT_NAMES.some(n => lower.includes(n))) {
    // Someone just mentioned an agent by name
    const agentMentioned = AGENT_NAMES.find(n => lower.includes(n));
    if (agentMentioned) shoutout = agentMentioned;
  }

  // Nothing extracted → don't bother recording
  if (!mood && !topic && !shoutout) return null;

  userCooldowns.set(authorId, now);

  return { mood, topic, shoutout, authorName: authorName.slice(0, 20) };
}

// ── Vote aggregator (20-second rolling window) ────────────────────────────────
class VoteWindow {
  constructor(windowMs = 20000) {
    this.windowMs = windowMs;
    this.votes    = []; // { ts, mood, topic, shoutout }
  }

  add(signal) {
    this.votes.push({ ts: Date.now(), ...signal });
  }

  // Prune old votes and return the winning signals
  tally() {
    const cutoff = Date.now() - this.windowMs;
    this.votes   = this.votes.filter(v => v.ts > cutoff);

    const moodCount  = {};
    const topicCount = {};
    const nameCount  = {};

    for (const v of this.votes) {
      if (v.mood)     moodCount[v.mood]       = (moodCount[v.mood]       || 0) + 1;
      if (v.topic)    topicCount[v.topic]      = (topicCount[v.topic]     || 0) + 1;
      if (v.shoutout) nameCount[v.shoutout]    = (nameCount[v.shoutout]   || 0) + 1;
    }

    const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
      mood:     top(moodCount),
      topic:    top(topicCount),
      shoutout: top(nameCount),
      votes:    this.votes.length,
    };
  }
}

// ── Write live-session.json ───────────────────────────────────────────────────
function writeSession(state) {
  try {
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[live] failed to write live-session.json:", err.message);
  }
}

// ── Poll one batch of chat messages ──────────────────────────────────────────
async function pollOnce(env, liveChatId, pageToken, userCooldowns, voteWindow) {
  try {
    const token = await getAccessToken(env);
    let qs = `liveChatId=${encodeURIComponent(liveChatId)}&part=snippet%2CauthorDetails&maxResults=200`;
    if (pageToken) qs += `&pageToken=${encodeURIComponent(pageToken)}`;

    const { status, body } = await httpsGet(
      `https://www.googleapis.com/youtube/v3/liveChatMessages?${qs}`,
      { "Authorization": `Bearer ${token}` }
    );

    if (status === 403) { console.error("[live] 403 — OAuth scope issue or chat disabled"); return null; }
    if (status !== 200) {
      console.warn(`[live] HTTP ${status} — retrying in 10s`);
      await new Promise(r => setTimeout(r, 10000));
      return { nextPageToken: pageToken, pollInterval: 5000 };
    }

    for (const item of (body.items || [])) {
      const text       = item.snippet?.displayMessage ?? "";
      const authorId   = item.authorDetails?.channelId ?? "unknown";
      const authorName = item.authorDetails?.displayName ?? "viewer";
      const signal = sanitizeMessage(text, authorId, authorName, userCooldowns);
      if (signal) {
        voteWindow.add(signal);
        console.log(`[live] +vote from ${authorName}: mood=${signal.mood ?? "-"} topic=${signal.topic ?? "-"} shout=${signal.shoutout ?? "-"}`);
      }
    }

    return {
      nextPageToken: body.nextPageToken ?? pageToken,
      pollInterval:  body.pollingIntervalMillis > 0 ? Math.max(body.pollingIntervalMillis, 3000) : 5000,
    };
  } catch (err) {
    console.error("[live] poll error:", err.message);
    await new Promise(r => setTimeout(r, 10000));
    return { nextPageToken: pageToken, pollInterval: 5000 };
  }
}

// Read back session token count that the builder wrote
function syncSessionTokens(current) {
  try {
    const d = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
    return d.sessionTokensUsed > current ? d.sessionTokensUsed : current;
  } catch (_e) { return current; }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv();

  if (!env.YOUTUBE_OAUTH_CLIENT_ID || !env.YOUTUBE_OAUTH_CLIENT_SECRET || !env.YOUTUBE_OAUTH_REFRESH_TOKEN) {
    console.error("[live] ERROR: OAuth credentials missing from ~/.nemoclaw_env");
    console.error("[live] Run: node scripts/youtube-oauth-setup.js");
    process.exit(1);
  }

  console.log("[live] ─────────────────────────────────────────────────────");
  console.log("[live] Live Session Manager");
  console.log(`[live] budget: ${BUDGET_TOKENS.toLocaleString()} tokens | duration: ${DURATION_SECS}s`);
  console.log("[live] ─────────────────────────────────────────────────────");

  // Resolve live chat ID
  const accessToken = await getAccessToken(env);
  let liveChatId;

  if (VIDEO_ID_OVERRIDE) {
    liveChatId = await getLiveChatId(VIDEO_ID_OVERRIDE, accessToken);
    console.log(`[live] using video ID: ${VIDEO_ID_OVERRIDE} → chatId: ${liveChatId}`);
  } else {
    liveChatId = await detectActiveLiveChatId(env, accessToken);
    console.log(`[live] auto-detected liveChatId: ${liveChatId}`);
  }

  const startTime    = Date.now();
  const endTime      = startTime + DURATION_SECS * 1000;
  const userCooldowns = new Map();
  const voteWindow    = new VoteWindow(20000);
  let nextPageToken   = null;
  let sessionTokens   = 0;
  let pollInterval    = 5000;

  // Initial session state
  writeSession({
    active:              true,
    liveChatId,
    sessionTokensBudget: BUDGET_TOKENS,
    sessionTokensUsed:   0,
    influence:           { mood: null, topic: null, shoutout: null, votes: 0 },
    startedAt:           new Date().toISOString(),
    paused:              false,
  });

  console.log("[live] session started — polling chat...");

  // Shutdown handler
  const shutdown = (reason) => {
    console.log(`[live] shutting down (${reason})`);
    writeSession({
      active:              false,
      liveChatId:          null,
      sessionTokensBudget: BUDGET_TOKENS,
      sessionTokensUsed:   sessionTokens,
      influence:           null,
      endedAt:             new Date().toISOString(),
      paused:              false,
    });
    process.exit(0);
  };

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Poll loop
  while (Date.now() < endTime) {
    await new Promise(r => setTimeout(r, pollInterval));
    if (Date.now() >= endTime) break;
    const result = await pollOnce(env, liveChatId, nextPageToken, userCooldowns, voteWindow);
    if (result === null) break; // fatal (403 etc)
    nextPageToken = result.nextPageToken;
    pollInterval  = result.pollInterval || pollInterval;
    sessionTokens = syncSessionTokens(sessionTokens);
    const influence = voteWindow.tally();
    const remaining = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
    const throttle  = sessionTokens > BUDGET_TOKENS * 0.95;
    const paused    = sessionTokens > BUDGET_TOKENS;
    if (paused && !_wasPaused) {
      console.log("[live] BUDGET REACHED — chat influence paused, builder continues");
      _wasPaused = true;
    }
    writeSession({
      active: true, liveChatId,
      sessionTokensBudget: BUDGET_TOKENS, sessionTokensUsed: sessionTokens,
      influence: paused ? null : influence,
      throttle, paused, remainingSecs: remaining,
      updatedAt: new Date().toISOString(),
    });
  }

  shutdown("duration reached");
}

let _wasPaused = false;

main().catch((err) => {
  console.error("[live] fatal:", err.message);
  process.exit(1);
});
