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
  LTX_T2V: "ltx_t2v",
  LTX_I2V: "ltx_i2v",
  LTX_COMBI: "ltx_combi",
  LTX_CHAIN: "ltx_chain",
  COMFY_T2V: "comfy_t2v",       // legacy alias
  COMFY_I2V: "comfy_i2v",       // legacy alias
  COMFY_COMBI: "comfy_combi",   // legacy alias
  COMFY_CHAIN: "comfy_chain",   // legacy alias
  SUNO_MUSIC: "suno_music",
  ACESTEP_MUSIC: "acestep_music",
  FFMPEG_EDIT: "ffmpeg_edit",
  CAPCUT_COMPOSE: "capcut_compose",
  IMAGINE: "imagine",
  GIF_CREATE: "gif_create",
  IG_POST: "ig_post",
  // LLM calls (crew, workshop, agents)
  LLM_CALL: "llm_call",
  WORKSHOP_BUILD: "workshop_build",
};

// ── Model pricing (per 1M tokens) ────────────────────────────────────
// Updated 2026-04-06. Add new models as they're used.
const MODEL_PRICING = {
  // NVIDIA NIM
  "mistralai/mistral-large-3-675b-instruct-2512": { input: 0, output: 0, provider: "nvidia-nim" }, // free with API key
  // NVIDIA NIM (free)
  "deepseek-ai/deepseek-v3.2": { input: 0, output: 0, provider: "nvidia-nim" },
  "deepseek-ai/deepseek-v3.1-terminus": { input: 0, output: 0, provider: "nvidia-nim" },
  // Vertex AI (Google Cloud MaaS — free serverless)
  "meta/llama-4-maverick-17b-128e-instruct-maas": { input: 0, output: 0, provider: "vertex-ai" },
  "meta/llama-4-scout-17b-16e-instruct-maas": { input: 0, output: 0, provider: "vertex-ai" },
  "gemini-3.1-flash-lite-preview": { input: 0, output: 0, provider: "vertex-ai" },
  // OpenRouter paid
  "deepseek/deepseek-v3.1-terminus": { input: 0.21, output: 0.79, provider: "openrouter" },
  "google/gemini-3.1-flash-lite-preview": { input: 0.25, output: 1.50, provider: "openrouter" },
  "qwen/qwen3-coder-plus": { input: 0.50, output: 2.00, provider: "openrouter" },
  // OpenRouter free
  "qwen/qwen3.6-plus:free": { input: 0, output: 0, provider: "openrouter-free" },
  "qwen/qwen3-coder:free": { input: 0, output: 0, provider: "openrouter-free" },
  "google/gemma-3-27b-it:free": { input: 0, output: 0, provider: "openrouter-free" },
  // Gemini (via proxy)
  "gemini-2.5-flash": { input: 0.15, output: 0.60, provider: "google" },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.30, provider: "google" },
  // Grok
  "grok-aurora": { input: 0, output: 0, provider: "xai" }, // image gen, flat pricing per image
};

// ── Energy estimates (kWh per 1M tokens, rough) ──────────────────────
// Based on published GPU power draw and throughput benchmarks.
// Image/video: kWh per generation (H100 @ 700W baseline).
const ENERGY_ESTIMATES = {
  "llm_per_mtok": 0.003,       // ~3 Wh per 1M tokens (optimistic, batched)
  "llm_reasoning_per_mtok": 0.008,  // reasoning models use more compute
  "image_gen": 0.002,          // ~2 Wh per image (diffusion ~3-5s on H100)
  "video_gen_per_sec": 0.005,  // ~5 Wh per second of video generated
  "music_gen_per_sec": 0.001,  // ~1 Wh per second of audio
  "ffmpeg_edit": 0.0005,       // ~0.5 Wh per edit (CPU-bound)
};

// ── Cost calculator ────────────────────────��─────────────────────────
function estimateCost(model, inputTokens, outputTokens) {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return { cost: 0, provider: "unknown" };
  const cost = (inputTokens / 1e6) * pricing.input + (outputTokens / 1e6) * pricing.output;
  return { cost, provider: pricing.provider };
}

function estimateEnergy(type, durationMs, tokens) {
  let kwh = 0;
  if (type === "llm_call" || type === "workshop_build") {
    kwh = ((tokens || 0) / 1e6) * ENERGY_ESTIMATES.llm_per_mtok;
  } else if (type.includes("image") || type === "zturbo" || type === "imagine") {
    kwh = ENERGY_ESTIMATES.image_gen;
  } else if (type.includes("video") || type.includes("t2v") || type.includes("i2v") || type.includes("combi") || type.includes("chain") || type.includes("ltx")) {
    const secs = (durationMs || 5000) / 1000; // assume output duration ~ gen duration / 10
    kwh = (secs / 10) * ENERGY_ESTIMATES.video_gen_per_sec;
  } else if (type.includes("music")) {
    const secs = (durationMs || 30000) / 1000;
    kwh = secs * ENERGY_ESTIMATES.music_gen_per_sec;
  } else if (type === "ffmpeg_edit" || type === "capcut_compose") {
    kwh = ENERGY_ESTIMATES.ffmpeg_edit;
  }
  return kwh;
}

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
  ltx_t2v: "\ud83c\udfac",
  ltx_i2v: "\ud83c\udfac",
  ltx_combi: "\ud83c\udfac",
  ltx_chain: "\u26d3\ufe0f",
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
  llm_call: "\ud83e\udde0",
  workshop_build: "\ud83d\udd28",
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
 * @param {string} [evt.model] - LLM model used
 * @param {number} [evt.inputTokens] - Input token count
 * @param {number} [evt.outputTokens] - Output token count
 * @param {number} [evt.totalTokens] - Total token count (if input/output not split)
 */
// eslint-disable-next-line complexity
function reportGenEvent(evt) {
  const now = new Date();
  const tokens = evt.totalTokens || (evt.inputTokens || 0) + (evt.outputTokens || 0);
  const costInfo = evt.model ? estimateCost(evt.model, evt.inputTokens || tokens * 0.6, evt.outputTokens || tokens * 0.4) : { cost: 0, provider: "unknown" };
  const energy = estimateEnergy(evt.type || "unknown", evt.durationMs, tokens);

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
    // Token & cost telemetry
    model: evt.model || null,
    inputTokens: evt.inputTokens || null,
    outputTokens: evt.outputTokens || null,
    totalTokens: tokens || null,
    costUsd: costInfo.cost || null,
    provider: costInfo.provider,
    energyKwh: energy || null,
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

/**
 * Full telemetry snapshot for the dashboard.
 * Aggregates all events into a comprehensive summary.
 * @param {number} hours - Lookback window (default: 24)
 */
// eslint-disable-next-line complexity
function getTelemetrySummary(hours = 24) {
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const events = getRecentEvents({ limit: 5000, since });

  const summary = {
    generatedAt: new Date().toISOString(),
    window: { hours, since: since.toISOString(), until: new Date().toISOString() },

    // Totals
    totalEvents: events.length,
    totalTokens: 0,
    totalCostUsd: 0,
    totalEnergyKwh: 0,
    totalImages: 0,
    totalVideos: 0,
    totalMusic: 0,
    totalEdits: 0,
    totalLlmCalls: 0,

    // By status
    byStatus: { success: 0, error: 0, timeout: 0, filtered: 0 },

    // By generation type — { count, ok, fail, tokens, costUsd, energyKwh, avgDurationMs }
    byType: {},

    // By model — { calls, tokens, costUsd, avgDurationMs }
    byModel: {},

    // By provider — { calls, tokens, costUsd }
    byProvider: {},

    // By hour — [{ hour: "2026-04-06T10:00", events, tokens, costUsd }]
    byHour: {},

    // Top users — { userId: { events, tokens, images, videos } }
    byUser: {},

    // Recent errors (last 10)
    recentErrors: [],
  };

  for (const e of events) {
    // Status
    summary.byStatus[e.status] = (summary.byStatus[e.status] || 0) + 1;

    // Tokens & cost
    const tok = e.totalTokens || 0;
    const cost = e.costUsd || 0;
    const energy = e.energyKwh || 0;
    summary.totalTokens += tok;
    summary.totalCostUsd += cost;
    summary.totalEnergyKwh += energy;

    // Count media types
    const t = e.type || "unknown";
    if (t.includes("image") || t === "zturbo" || t === "imagine") summary.totalImages++;
    else if (t.includes("video") || t.includes("t2v") || t.includes("i2v") || t.includes("combi") || t.includes("chain") || t.includes("ltx") || t.includes("gif")) summary.totalVideos++;
    else if (t.includes("music")) summary.totalMusic++;
    else if (t === "ffmpeg_edit" || t === "capcut_compose") summary.totalEdits++;
    else if (t === "llm_call" || t === "workshop_build") summary.totalLlmCalls++;

    // By type
    if (!summary.byType[t]) summary.byType[t] = { count: 0, ok: 0, fail: 0, tokens: 0, costUsd: 0, energyKwh: 0, totalDurationMs: 0 };
    const bt = summary.byType[t];
    bt.count++;
    if (e.status === "success") bt.ok++; else bt.fail++;
    bt.tokens += tok;
    bt.costUsd += cost;
    bt.energyKwh += energy;
    bt.totalDurationMs += e.durationMs || 0;

    // By model
    if (e.model) {
      if (!summary.byModel[e.model]) summary.byModel[e.model] = { calls: 0, tokens: 0, costUsd: 0, totalDurationMs: 0 };
      const bm = summary.byModel[e.model];
      bm.calls++;
      bm.tokens += tok;
      bm.costUsd += cost;
      bm.totalDurationMs += e.durationMs || 0;
    }

    // By provider
    const prov = e.provider || "unknown";
    if (!summary.byProvider[prov]) summary.byProvider[prov] = { calls: 0, tokens: 0, costUsd: 0 };
    summary.byProvider[prov].calls++;
    summary.byProvider[prov].tokens += tok;
    summary.byProvider[prov].costUsd += cost;

    // By hour
    const hourKey = e.t ? e.t.slice(0, 13) + ":00" : "unknown";
    if (!summary.byHour[hourKey]) summary.byHour[hourKey] = { events: 0, tokens: 0, costUsd: 0, images: 0, videos: 0 };
    const bh = summary.byHour[hourKey];
    bh.events++;
    bh.tokens += tok;
    bh.costUsd += cost;
    if (t.includes("image") || t === "zturbo") bh.images++;
    if (t.includes("video") || t.includes("t2v") || t.includes("i2v")) bh.videos++;

    // By user
    const uid = e.userId || e.userName || "system";
    if (!summary.byUser[uid]) summary.byUser[uid] = { name: e.userName || uid, events: 0, tokens: 0, images: 0, videos: 0, music: 0 };
    const bu = summary.byUser[uid];
    bu.events++;
    bu.tokens += tok;
    if (t.includes("image") || t === "zturbo") bu.images++;
    if (t.includes("video") || t.includes("t2v") || t.includes("i2v")) bu.videos++;
    if (t.includes("music")) bu.music++;

    // Recent errors
    if (e.status !== "success" && summary.recentErrors.length < 10) {
      summary.recentErrors.push({ t: e.t, type: t, error: e.error, model: e.model });
    }
  }

  // Compute averages
  for (const bt of Object.values(summary.byType)) {
    bt.avgDurationMs = bt.count ? Math.round(bt.totalDurationMs / bt.count) : 0;
    delete bt.totalDurationMs;
  }
  for (const bm of Object.values(summary.byModel)) {
    bm.avgDurationMs = bm.calls ? Math.round(bm.totalDurationMs / bm.calls) : 0;
    delete bm.totalDurationMs;
  }

  // Sort byHour into array
  summary.byHour = Object.entries(summary.byHour)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, data]) => ({ hour, ...data }));

  // Round costs
  summary.totalCostUsd = Math.round(summary.totalCostUsd * 10000) / 10000;
  summary.totalEnergyKwh = Math.round(summary.totalEnergyKwh * 10000) / 10000;

  return summary;
}

/**
 * Write telemetry summary to a JSON file for the website.
 * Call periodically (e.g., every 5 minutes).
 */
const TELEMETRY_OUT = path.join(os.homedir(), "netify-dev", "public", "data", "telemetry");

function writeTelemetrySummary() {
  try {
    if (!fs.existsSync(TELEMETRY_OUT)) fs.mkdirSync(TELEMETRY_OUT, { recursive: true });
    const summary = getTelemetrySummary(24);
    fs.writeFileSync(path.join(TELEMETRY_OUT, "latest.json"), JSON.stringify(summary, null, 2));
    // Also write a compact 7-day summary
    const weekly = getTelemetrySummary(168);
    fs.writeFileSync(path.join(TELEMETRY_OUT, "weekly.json"), JSON.stringify(weekly, null, 2));
  } catch (e) {
    console.warn(`[gen-monitor] telemetry write failed: ${e.message}`);
  }
}

let _telemetryTimer = null;
function startTelemetryWriter(intervalMs = 300000) { // default 5 min
  writeTelemetrySummary(); // immediate first write
  _telemetryTimer = setInterval(writeTelemetrySummary, intervalMs);
}

function stopTelemetryWriter() {
  if (_telemetryTimer) { clearInterval(_telemetryTimer); _telemetryTimer = null; }
}

module.exports = {
  initGenMonitor,
  reportGenEvent,
  getRecentEvents,
  getErrorSummary,
  getTelemetrySummary,
  writeTelemetrySummary,
  startTelemetryWriter,
  stopTelemetryWriter,
  estimateCost,
  estimateEnergy,
  GenStatus,
  GenType,
  MODEL_PRICING,
};
