"use strict";

// suno.js — Direct Suno API client (no Docker wrapper)
// Auth flow: refresh JWT → Clerk session → short-lived Bearer token → studio-api.prod.suno.com
//
// Configure via env:
//   SUNO_REFRESH_TOKEN=eyJhbGci...   (refresh JWT from browser DevTools)
//   -- or fallback to GoAPI --
//   SUNO_PROVIDER=goapi + SUNO_API_KEY=<goapi key>

const https = require("https");
const http  = require("http");

const PROVIDER       = (process.env.SUNO_PROVIDER || "direct").toLowerCase();
const GOAPI_KEY      = process.env.SUNO_API_KEY     || "";
const REFRESH_TOKEN  = process.env.SUNO_REFRESH_TOKEN || process.env.SUNO_COOKIE || "";

const CLERK_BASE     = "https://auth.suno.com";
const API_BASE       = "https://studio-api.prod.suno.com";
const VIDEO_API_BASE = "https://studio-api-prod.suno.com"; // video endpoint uses different subdomain
const CLERK_API_VER = "2025-11-10";
const CLERK_JS_VER  = "5.117.0";

const POLL_INTERVAL_MS = 5000;
const POLL_MAX         = 36; // 3 min

const path = require("path");
const { execFile } = require("child_process");

function runCaptchaSolver(refreshToken, prompt) {
  return new Promise((resolve, reject) => {
    const solver = path.join(__dirname, "captcha-solver.js");
    execFile("node", [solver, refreshToken, prompt], { timeout: 120000 }, (err, stdout, stderr) => {
      if (stderr) console.log("[suno/captcha]", stderr.trim().slice(-800));
      if (err) return reject(new Error(`Captcha solver failed: ${err.message}`));
      try { resolve(JSON.parse(stdout.trim())); }
      catch { reject(new Error("Captcha solver bad output: " + stdout.slice(0, 100))); }
    });
  });
}

// Token cache
let cachedToken = null;
let cachedSid   = null;
let tokenExpiry = 0;

// ── HTTP helpers ──────────────────────────────────────────────────

function request(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const lib  = u.protocol === "https:" ? https : http;
    const headers = { ...(opts.headers || {}) };
    let bodyStr = null;
    if (body !== null) {
      bodyStr = JSON.stringify(body);
      headers["Content-Type"]   = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    const req = lib.request(
      { hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function downloadAudio(url, depth = 0) {
  if (depth > 5) throw new Error("Too many redirects downloading audio");
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    lib.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode))
        return downloadAudio(res.headers.location, depth + 1).then(resolve).catch(reject);
      if (res.statusCode !== 200)
        return reject(new Error(`Audio download HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

// ── Direct auth ───────────────────────────────────────────────────

const CLERK_HEADERS = {
  "Cookie":     `__client=${REFRESH_TOKEN}`,
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
};

async function getSessionId() {
  if (cachedSid) return cachedSid;
  const url = `${CLERK_BASE}/v1/client?__clerk_api_version=${CLERK_API_VER}&_clerk_js_version=${CLERK_JS_VER}`;
  const res  = await request(url, { headers: CLERK_HEADERS });
  if (res.status !== 200)
    throw new Error(`Clerk client ${res.status}: ${res.body.slice(0, 200)}`);
  const data = JSON.parse(res.body);
  cachedSid  = data.response?.last_active_session_id;
  if (!cachedSid)
    throw new Error("No active Suno session — refresh token may be expired");
  console.log(`[suno] session: ${cachedSid}`);
  return cachedSid;
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 5000) return cachedToken;
  const sid = await getSessionId();
  const url = `${CLERK_BASE}/v1/client/sessions/${sid}/tokens?__clerk_api_version=${CLERK_API_VER}&_clerk_js_version=${CLERK_JS_VER}`;
  const res  = await request(url, { method: "POST", headers: { ...CLERK_HEADERS, "Content-Length": "2" } }, {});
  if (res.status !== 200)
    throw new Error(`Token renewal ${res.status}: ${res.body.slice(0, 200)}`);
  const data  = JSON.parse(res.body);
  cachedToken = data.jwt;
  tokenExpiry = now + 55000; // Clerk tokens expire in ~60s
  return cachedToken;
}

async function sunoReq(method, path, body = null) {
  const token = await getAccessToken();
  return request(`${API_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "User-Agent":    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Referer":       "https://suno.com/",
      "Origin":        "https://suno.com",
    },
  }, body);
}

// ── Direct generation ─────────────────────────────────────────────

async function generateDirect(prompt, options) {
  if (!REFRESH_TOKEN)
    throw new Error("SUNO_REFRESH_TOKEN not set");

  // Check captcha requirement
  const checkRes = await sunoReq("POST", "/api/c/check", { ctype: "generation" });
  const check    = JSON.parse(checkRes.body);
  console.log(`[suno/direct] captcha required: ${check.required}`);

  // Solve captcha if required
  let captchaToken = null;
  if (check.required) {
    console.log("[suno/direct] solving captcha via Playwright + vision...");
    const solved = await runCaptchaSolver(REFRESH_TOKEN, prompt);
    // If solver captured full clips, skip API call entirely
    if (solved.clips?.length) {
      console.log("[suno/direct] solver returned clips directly, polling for completion...");
      const ids = solved.clips.map(c => c.id);
      for (let i = 0; i < POLL_MAX; i++) {
        await sleep(POLL_INTERVAL_MS);
        const pollRes  = await sunoReq("GET", `/api/feed/v2?ids=${ids.join(",")}`);
        const pollData = JSON.parse(pollRes.body);
        const tracks   = pollData.clips || [];
        const statuses = tracks.map(t => t.status);
        console.log(`[suno/direct] poll ${i + 1}: ${statuses.join(", ")}`);
        const anyErr = tracks.find(t => t.status === "error");
        if (anyErr) throw new Error(`Suno track error: ${anyErr.metadata?.error_message || "unknown"}`);
        if (tracks.every(t => ["streaming", "complete"].includes(t.status))) {
          return tracks.map(t => ({
            id: t.id, title: t.title || prompt.slice(0, 50),
            audioUrl: t.audio_url, imageUrl: t.image_url,
            duration: t.metadata?.duration, tags: t.metadata?.tags || "",
          }));
        }
      }
      throw new Error("Suno timed out after 3 minutes");
    }
    captchaToken = solved.token || null;
    console.log("[suno/direct] captcha token obtained");
  }

  const isCustom = !!(options.tags || options.lyrics);
  const payload  = isCustom
    ? {
        prompt:             options.lyrics || "",
        tags:               options.tags   || "",
        title:              options.title  || prompt.slice(0, 60),
        mv:                 options.model  || "chirp-fenix",
        make_instrumental:  options.instrumental || false,
        generation_type:    "TEXT",
        token:              captchaToken,
        user_uploaded_images_b64: null,
      }
    : {
        gpt_description_prompt: prompt,
        prompt:                 "",
        mv:                     options.model || "chirp-fenix",
        make_instrumental:      options.instrumental || false,
        generation_type:        "TEXT",
        token:                  captchaToken,
        user_uploaded_images_b64: null,
      };

  console.log(`[suno/direct] generating: "${prompt.slice(0, 60)}"`);
  const genRes  = await sunoReq("POST", "/api/generate/v2-web/", payload);
  if (genRes.status !== 200)
    throw new Error(`Suno generate ${genRes.status}: ${genRes.body.slice(0, 300)}`);

  const genData = JSON.parse(genRes.body);
  const clips   = genData.clips || [];
  if (!clips.length) throw new Error("Suno returned no clips");
  const ids = clips.map(c => c.id);
  console.log(`[suno/direct] clip ids: ${ids.join(", ")}`);

  for (let i = 0; i < POLL_MAX; i++) {
    await sleep(POLL_INTERVAL_MS);
    const pollRes  = await sunoReq("GET", `/api/feed/v2?ids=${ids.join(",")}`);
    const pollData = JSON.parse(pollRes.body);
    const tracks   = pollData.clips || [];
    const statuses = tracks.map(t => t.status);
    console.log(`[suno/direct] poll ${i + 1}: ${statuses.join(", ")}`);

    const anyErr = tracks.find(t => t.status === "error");
    if (anyErr) throw new Error(`Suno track error: ${anyErr.metadata?.error_message || "unknown"}`);
    if (tracks.every(t => ["streaming", "complete"].includes(t.status))) {
      return tracks.map(t => ({
        id:       t.id,
        title:    t.title || prompt.slice(0, 50),
        audioUrl: t.audio_url,
        imageUrl: t.image_url,
        duration: t.metadata?.duration,
        tags:     t.metadata?.tags || options.tags || "",
      }));
    }
  }
  throw new Error("Suno timed out after 3 minutes");
}

// ── GoAPI fallback ────────────────────────────────────────────────

async function generateGoAPI(prompt, options) {
  if (!GOAPI_KEY) throw new Error("SUNO_API_KEY not set for GoAPI provider");
  const body = {
    model:             options.model           || "suno-v4",
    prompt,
    make_instrumental: options.instrumental    || false,
    ...(options.title  && { title:  options.title  }),
    ...(options.tags   && { tags:   options.tags   }),
    ...(options.lyrics && { lyrics: options.lyrics }),
  };
  console.log(`[suno/goapi] generating: "${prompt.slice(0, 60)}"`);
  const res  = await request("https://api.goapi.ai/v1/music/suno/generate",
    { method: "POST", headers: { "X-API-Key": GOAPI_KEY } }, body);
  const data = JSON.parse(res.body);
  if (!data.task_id) throw new Error(`GoAPI submit error: ${res.body.slice(0, 200)}`);

  console.log(`[suno/goapi] task: ${data.task_id}`);
  for (let i = 0; i < POLL_MAX; i++) {
    await sleep(POLL_INTERVAL_MS);
    const poll     = await request(`https://api.goapi.ai/v1/music/suno/feed/${data.task_id}`,
      { headers: { "X-API-Key": GOAPI_KEY } });
    const pollData = JSON.parse(poll.body);
    console.log(`[suno/goapi] status: ${pollData.status}`);
    if (pollData.status === "completed") {
      const tracks = pollData.output || [];
      if (!tracks.length) throw new Error("GoAPI returned no tracks");
      return tracks.map(t => ({
        id: t.id || data.task_id, title: t.title || prompt.slice(0, 50),
        audioUrl: t.audio_url, imageUrl: t.image_url, duration: t.duration,
        tags: t.tags || options.tags || "",
      }));
    }
    if (pollData.status === "failed")
      throw new Error(`GoAPI failed: ${pollData.error || "unknown"}`);
  }
  throw new Error("Suno (GoAPI) timed out after 3 minutes");
}

// ── Video generation ──────────────────────────────────────────────

async function videoReq(method, path, body = null) {
  const token = await getAccessToken();
  return request(`${VIDEO_API_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "User-Agent":    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Referer":       "https://suno.com/",
      "Origin":        "https://suno.com",
    },
  }, body);
}

async function generateVideoForClip(clipId) {
  if (!REFRESH_TOKEN) throw new Error("SUNO_REFRESH_TOKEN not set");
  console.log(`[suno/video] starting video generation for clip ${clipId}`);
  const startRes = await videoReq("POST", `/api/video/generate/${clipId}/`, {});
  if (startRes.status !== 204 && startRes.status !== 200)
    throw new Error(`Video start ${startRes.status}: ${startRes.body.slice(0, 200)}`);

  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const res  = await videoReq("GET", `/api/video/generate/${clipId}/status/`);
    const data = JSON.parse(res.body);
    console.log(`[suno/video] poll ${i + 1}: ${data.status}`);
    if (data.status === "complete") {
      const videoUrl = data.video_url || `https://cdn1.suno.ai/${clipId}.mp4`;
      console.log(`[suno/video] done: ${videoUrl}`);
      return videoUrl;
    }
    if (data.status === "error") throw new Error(`Video failed: ${data.error || "unknown"}`);
  }
  throw new Error("Video generation timed out after 5 minutes");
}

// ── Lyrics generation ─────────────────────────────────────────────

async function generateLyrics(prompt) {
  if (!REFRESH_TOKEN) throw new Error("SUNO_REFRESH_TOKEN not set");
  const res = await sunoReq("POST", "/api/generate/lyrics/", { prompt });
  if (res.status !== 200) throw new Error(`Lyrics ${res.status}: ${res.body.slice(0, 200)}`);
  const lyricId = JSON.parse(res.body).id;
  console.log(`[suno/lyrics] id: ${lyricId}`);

  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const poll = await sunoReq("GET", `/api/generate/lyrics/${lyricId}`);
    const data = JSON.parse(poll.body);
    if (data.text) {
      console.log(`[suno/lyrics] done: ${data.text.slice(0, 60)}...`);
      return { text: data.text, title: data.title || "" };
    }
  }
  throw new Error("Lyrics generation timed out");
}

// ── Public API ────────────────────────────────────────────────────

async function generateSuno(prompt, options = {}) {
  if (PROVIDER === "goapi" && GOAPI_KEY) return generateGoAPI(prompt, options);
  return generateDirect(prompt, options);
}

module.exports = { generateSuno, generateVideoForClip, generateLyrics, downloadAudio };
