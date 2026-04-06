// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generation Monitor — structured event reporting for the crew to watch.
 *
 * Posts rich generation events (success + failure) to a Discord channel
 * so MaoMao and the crew can analyze errors firsthand.
 *
 * Usage:
 *   const { reportGenEvent, GenStatus } = require("./lib/gen-monitor");
 *   reportGenEvent({ type: "grok_image", status: "error", error: e, context: { prompt, style } });
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config ──────────────────────────────────────────────────────────
const GEN_LOG = path.join(os.homedir(), ".nemoclaw", "logs", "gen-events.jsonl");
const GEN_LOG_MAX = 10 * 1024 * 1024; // 10MB

// Channel where generation events are posted (set by init())
let _discordClient = null;
let _monitorChannelId = null;
let _enabled = false;

const GenStatus = {
  SUCCESS: "success",
  ERROR: "error",
  TIMEOUT: "timeout",
  FILTERED: "filtered", // content filtered / safety block
};

const GenType = {
  GROK_IMAGE: "grok_image",
  GROK_VIDEO: "grok_video",
  GROK_IMG2IMG: "grok_img2img",
  GROK_IMG2VID: "grok_img2vid",
  ZTURBO: "zturbo",
  COMFY_T2V: "comfy_t2v",
  COMFY_I2V: "comfy_i2v",
  COMFY_COMBI: "comfy_combi",
  COMFY_CHAIN: "comfy_chain",
  SUNO_MUSIC: "suno_music",
  ACESTEP_MUSIC: "acestep_music",
  FFMPEG_EDIT: "ffmpeg_edit",
  CAPCUT_COMPOSE: "capcut_compose",
  IMAGINE: "imagine",
  GIF_CREATE: "gif_create",
  IG_POST: "ig_post",
};

// ── Emoji map for Discord formatting ────────────────────────────────
const STATUS_EMOJI = {
  success: "\u2705",
  error: "\u274c",
  timeout: "\u23f0",
  filtered: "\ud83d\udea7",
};

const TYPE_EMOJI = {
  grok_image: "\ud83e\udde0",
  grok_video: "\ud83c\udfac",
  grok_img2img: "\ud83d\uddbc\ufe0f",
  grok_img2vid: "\ud83c\udfac",
  zturbo: "\u26a1",
  comfy_t2v: "\ud83c\udfac",
  comfy_i2v: "\ud83c\udfac",
  comfy_combi: "\ud83c\udfac",
  comfy_chain: "\u26d3\ufe0f",
  suno_music: "\ud83c\udfb5",
  acestep_music: "\ud83c\udfb6",
  ffmpeg_edit: "\u2702\ufe0f",
  capcut_compose: "\ud83c\udfa8",
  imagine: "\ud83d\uddbc\ufe0f",
  gif_create: "\ud83d\ude4c",
  ig_post: "\ud83d\udcf8",
};

/**
 * Initialize the monitor with Discord client and target channel.
 * Call once at startup.
 */
function initGenMonitor(discordClient, channelId) {
  _discordClient = discordClient;
  _monitorChannelId = channelId;
  _enabled = !!(discordClient && channelId);
  if (_enabled) console.log(`[gen-monitor] active → channel ${channelId}`);
  // Ensure log dir exists
  const d = path.dirname(GEN_LOG);
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch { /* ignored */ }
}

/**
 * Report a generation event.
 *
 * @param {object} evt
 * @param {string} evt.type - GenType value
 * @param {string} evt.status - GenStatus value
 * @param {string} [evt.userId] - Discord user ID
 * @param {string} [evt.userName] - Discord username
 * @param {number} [evt.durationMs] - How long the generation took
 * @param {Error|string} [evt.error] - Error object or message
 * @param {object} [evt.context] - Generation params: { prompt, style, preset, seed, model, ... }
 * @param {number} [evt.outputBytes] - Output file size
 */
function reportGenEvent(evt) {
  const now = new Date();
  const entry = {
    t: now.toISOString(),
    type: evt.type || "unknown",
    status: evt.status || "unknown",
    userId: evt.userId || null,
    userName: evt.userName || null,
    durationMs: evt.durationMs || null,
    error: evt.error instanceof Error ? evt.error.message : (evt.error || null),
    stack: evt.error instanceof Error ? (evt.error.stack || "").split("\n").slice(0, 4).join("\n") : null,
    context: evt.context || {},
    outputBytes: evt.outputBytes || null,
  };

  // 1. Always log to file (cheap, reliable)
  _logToFile(entry);

  // 2. Post to Discord if enabled and it's an error/timeout/filtered
  if (_enabled && evt.status !== GenStatus.SUCCESS) {
    _postToDiscord(entry).catch(e =>
      console.warn(`[gen-monitor] Discord post failed: ${e.message}`)
    );
  }

  // 3. For successes, post a compact summary periodically (batch)
  if (_enabled && evt.status === GenStatus.SUCCESS) {
    _trackSuccess(entry);
  }
}

// ── File logging ────────────────────────────────────────────────────
function _logToFile(entry) {
  try {
    try { if (fs.statSync(GEN_LOG).size > GEN_LOG_MAX) fs.renameSync(GEN_LOG, GEN_LOG + ".prev"); } catch { /* ignored */ }
    fs.appendFileSync(GEN_LOG, JSON.stringify(entry) + "\n");
  } catch { /* ignored */ }
}

// ── Discord posting ─────────────────────────────────────────────────
async function _postToDiscord(entry) {
  if (!_discordClient || !_monitorChannelId) return;
  const channel = await _discordClient.channels.fetch(_monitorChannelId).catch(() => null);
  if (!channel) return;

  const emoji = STATUS_EMOJI[entry.status] || "\u2753";
  const typeEmoji = TYPE_EMOJI[entry.type] || "\ud83d\udd27";
  const user = entry.userName ? `@${entry.userName}` : entry.userId || "unknown";
  const dur = entry.durationMs ? `${(entry.durationMs / 1000).toFixed(1)}s` : "?";

  // Build context summary (prompt, style, model — whatever was passed)
  const ctx = entry.context || {};
  const ctxParts = [];
  if (ctx.prompt) ctxParts.push(`prompt: "${ctx.prompt.slice(0, 100)}"`);
  if (ctx.style) ctxParts.push(`style: ${ctx.style}`);
  if (ctx.preset) ctxParts.push(`preset: ${ctx.preset}`);
  if (ctx.model) ctxParts.push(`model: ${ctx.model}`);
  if (ctx.seed) ctxParts.push(`seed: ${ctx.seed}`);
  if (ctx.beattrack) ctxParts.push("beattrack");
  if (ctx.lyrics) ctxParts.push(`lyrics: ${ctx.lyricsStyle || "on"}`);
  const ctxStr = ctxParts.length ? ctxParts.join(" | ") : "no context";

  let msg = `${emoji} ${typeEmoji} **${entry.type}** ${entry.status.toUpperCase()} (${dur}) — ${user}\n`;
  msg += `> ${ctxStr}\n`;
  if (entry.error) {
    msg += `\`\`\`\n${entry.error.slice(0, 400)}\n\`\`\``;
  }

  await channel.send({ content: msg, allowedMentions: { parse: [] } }).catch(() => { /* ignored */ });
}

// ── Success batching — post a summary every N successes ─────────────
let _successBuffer = [];
let _successTimer = null;
const SUCCESS_BATCH_SIZE = 5;
const SUCCESS_BATCH_INTERVAL = 60000; // 1 minute max hold

function _trackSuccess(entry) {
  _successBuffer.push(entry);
  if (_successBuffer.length >= SUCCESS_BATCH_SIZE) {
    _flushSuccesses();
  } else if (!_successTimer) {
    _successTimer = setTimeout(_flushSuccesses, SUCCESS_BATCH_INTERVAL);
  }
}

async function _flushSuccesses() {
  if (_successTimer) { clearTimeout(_successTimer); _successTimer = null; }
  if (_successBuffer.length === 0) return;
  const batch = _successBuffer.splice(0);

  if (!_discordClient || !_monitorChannelId) return;
  const channel = await _discordClient.channels.fetch(_monitorChannelId).catch(() => null);
  if (!channel) return;

  const lines = batch.map(e => {
    const typeEmoji = TYPE_EMOJI[e.type] || "\ud83d\udd27";
    const dur = e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : "?";
    const bytes = e.outputBytes ? ` ${(e.outputBytes / 1024 / 1024).toFixed(1)}MB` : "";
    const prompt = e.context?.prompt ? ` "${e.context.prompt.slice(0, 50)}"` : "";
    return `${typeEmoji} ${e.type} (${dur}${bytes})${prompt}`;
  });

  const msg = `\u2705 **${batch.length} generations OK**\n${lines.join("\n")}`;
  await channel.send({ content: msg, allowedMentions: { parse: [] } }).catch(() => { /* ignored */ });
}

/**
 * Get recent generation events from the log file.
 * Used by MaoMao and other agents to analyze patterns.
 *
 * @param {object} opts - { limit: 50, status: "error", type: "grok_image", since: Date }
 * @returns {object[]} Parsed events, newest first
 */
function getRecentEvents(opts = {}) {
  const { limit = 50, status, type, since } = opts;
  try {
    if (!fs.existsSync(GEN_LOG)) return [];
    const lines = fs.readFileSync(GEN_LOG, "utf8").split("\n").filter(Boolean);
    let events = [];
    // Read from end (newest first)
    for (let i = lines.length - 1; i >= 0 && events.length < limit * 3; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (status && e.status !== status) continue;
        if (type && e.type !== type) continue;
        if (since && new Date(e.t) < since) continue;
        events.push(e);
        if (events.length >= limit) break;
      } catch { /* skip malformed */ }
    }
    return events;
  } catch { return []; }
}

/**
 * Get error summary stats for the last N hours.
 * @param {number} hours - Lookback window (default: 24)
 */
function getErrorSummary(hours = 24) {
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const events = getRecentEvents({ limit: 1000, since });
  const summary = { total: events.length, errors: 0, timeouts: 0, filtered: 0, successes: 0, byType: {} };
  for (const e of events) {
    if (e.status === "error") summary.errors++;
    else if (e.status === "timeout") summary.timeouts++;
    else if (e.status === "filtered") summary.filtered++;
    else summary.successes++;
    if (!summary.byType[e.type]) summary.byType[e.type] = { ok: 0, fail: 0 };
    if (e.status === "success") summary.byType[e.type].ok++;
    else summary.byType[e.type].fail++;
  }
  return summary;
}

module.exports = {
  initGenMonitor,
  reportGenEvent,
  getRecentEvents,
  getErrorSummary,
  GenStatus,
  GenType,
};
