#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// live-session-scraper.js — quota-free YouTube live chat reader
//
// Why this exists: live-session.js uses the official YouTube Data API which
// has a 10k unit/day cap. List operations cost 5 units each so a long stream
// blows the budget by mid-day. After we burned ours on 2026-04-07 the demo
// stream had no chat reader at all until the midnight Pacific quota reset.
//
// This script does the same thing the YouTube web client does: it scrapes
// the live_chat iframe (https://www.youtube.com/live_chat?v=<id>&is_popout=1)
// to grab the InnerTube API key + an initial continuation token, then polls
// the unofficial /youtubei/v1/live_chat/get_live_chat endpoint with that
// continuation. That endpoint is the same one the live page itself hits and
// it does NOT count against the Data API quota.
//
// Output is identical to what live-session.js writes (live-session.json with
// chatHistory: [{name, text, ts}, ...]) so workshop-builder.js does not care
// where the messages came from.
//
// Usage:
//   node live-session-scraper.js                 # uses YOUTUBE_BROADCAST_ID
//   VIDEO_ID=abc node live-session-scraper.js    # explicit override
//
// Limitations:
//   - Read-only. Posting to chat still requires the official API.
//   - Scrapes a private endpoint, so YouTube can change the shape any time.
//   - No swarm reactions or overlay banners — that lives in live-session.js.
//     This script only feeds chatHistory; the builder consumes it.

"use strict";

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const HOME             = process.env.HOME;
const ENV_FILE         = path.join(HOME, ".nemoclaw_env");
const SESSION_FILE     = path.join(HOME, "netify-dev", "public", "data", "live-session.json");
const CHAT_HISTORY_MAX = 15;
const POLL_FLOOR_MS    = 4000;
const POLL_CEIL_MS     = 15000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function loadEnv() {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// Plain HTTPS GET/POST. We don't use Accept-Encoding so we don't have to
// drag in zlib for gzip — these payloads are small.
function httpsRequest(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const req  = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method,
      headers: {
        "User-Agent":      UA,
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie":          "CONSENT=YES+1; SOCS=CAI",
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      // Follow redirects manually so we control the UA on the second hop.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return httpsRequest(next, method, body, headers).then(resolve, reject);
      }
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Read the live_chat iframe HTML and pull out:
//   - INNERTUBE_API_KEY      (required to call get_live_chat)
//   - client version         (sent in the request body context)
//   - first continuation     (the polling cursor)
async function bootstrap(videoId) {
  const url = `https://www.youtube.com/live_chat?v=${encodeURIComponent(videoId)}&is_popout=1`;
  const { status, body } = await httpsRequest(url, "GET", null, {});
  if (status !== 200) throw new Error(`live_chat HTTP ${status}`);
  if (body.length < 5000 || /Oh no!|video unavailable|isn't available/i.test(body)) {
    throw new Error("live_chat returned an error wall (UA blocked or video offline)");
  }

  const apiKey = body.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const cv     = body.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1];
  const cont   = body.match(/"continuation":"([^"]{20,})"/)?.[1];
  if (!apiKey || !cv || !cont) {
    throw new Error("could not parse INNERTUBE_API_KEY/version/continuation from live_chat HTML");
  }
  return { apiKey, clientVersion: cv, continuation: cont };
}

// One round of /youtubei/v1/live_chat/get_live_chat. Returns:
//   { messages: [{name,text,ts}], nextContinuation, timeoutMs }
async function fetchChat(apiKey, clientVersion, continuation) {
  const reqBody = {
    context: {
      client: {
        clientName:    "WEB",
        clientVersion: clientVersion,
        hl:            "en",
        gl:            "US",
      },
    },
    continuation,
  };
  const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${apiKey}&prettyPrint=false`;
  const { status, body } = await httpsRequest(url, "POST", reqBody, {});
  if (status !== 200) throw new Error(`get_live_chat HTTP ${status}: ${body.slice(0, 200)}`);

  let resp;
  try { resp = JSON.parse(body); }
  catch (_e) { throw new Error(`get_live_chat non-JSON body: ${body.slice(0, 200)}`); }

  const lcc = resp?.continuationContents?.liveChatContinuation;
  if (!lcc) throw new Error("response missing liveChatContinuation (chat ended?)");

  const actions = lcc.actions || [];
  const messages = [];
  for (const a of actions) {
    // Two action shapes: top-level and replayChatItemAction.actions[]
    const inner = a?.addChatItemAction
      ? [a.addChatItemAction.item]
      : (a?.replayChatItemAction?.actions || []).map(x => x?.addChatItemAction?.item).filter(Boolean);
    for (const item of inner) {
      const m = item?.liveChatTextMessageRenderer
             || item?.liveChatPaidMessageRenderer
             || item?.liveChatPaidStickerRenderer;
      if (!m) continue;
      const name = m.authorName?.simpleText || "anon";
      const runs = m.message?.runs || [];
      const text = runs.map(r => r.text || r.emoji?.shortcuts?.[0] || "").join("").trim();
      const id   = m.id;
      const tsUs = Number(m.timestampUsec || 0);
      const ts   = tsUs ? Math.floor(tsUs / 1000) : Date.now();
      if (!text || !id) continue;
      messages.push({ name, text, ts, id });
    }
  }

  // Pick the next continuation: invalidationContinuationData has timeoutMs.
  const next = lcc.continuations?.[0] || {};
  const wrap = next.invalidationContinuationData
            || next.timedContinuationData
            || next.reloadContinuationData
            || next.liveChatReplayContinuationData;
  const nextContinuation = wrap?.continuation;
  const timeoutMs        = Number(wrap?.timeoutMs || 5000);
  return { messages, nextContinuation, timeoutMs };
}

function readSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); }
  catch (_e) { return {}; }
}

function writeSession(state) {
  // Read-modify-write so we don't clobber fields the builder writes back.
  const cur = readSession();
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...cur, ...state }, null, 2));
}

async function main() {
  const env     = loadEnv();
  const videoId = process.env.VIDEO_ID || env.YOUTUBE_BROADCAST_ID;
  if (!videoId) {
    console.error("[scraper] no VIDEO_ID and no YOUTUBE_BROADCAST_ID in env");
    process.exit(1);
  }
  console.log(`[scraper] starting for videoId=${videoId}`);

  let { apiKey, clientVersion, continuation } = await bootstrap(videoId);
  console.log(`[scraper] bootstrapped: clientVersion=${clientVersion} continuationLen=${continuation.length}`);

  // Mark the session live so the build cycle stops bailing out
  writeSession({
    active:      true,
    liveChatId:  `scraper:${videoId}`,
    videoId,
    chatHistory: [],
    source:      "scraper",
    startedAt:   new Date().toISOString(),
    paused:      false,
  });

  const chatHistory = [];
  const seenIds     = new Set();
  let consecutiveErrors = 0;

  // Graceful exit so the session doesn't show as live forever after a kill
  const shutdown = (reason) => {
    console.log(`[scraper] shutting down (${reason})`);
    writeSession({ active: false, source: "scraper", stoppedAt: new Date().toISOString() });
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  for (;;) {
    let result;
    try {
      result = await fetchChat(apiKey, clientVersion, continuation);
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      console.error(`[scraper] poll error (${consecutiveErrors}): ${e.message}`);
      // Re-bootstrap on persistent errors — chat may have rolled to a new
      // continuation series after a YouTube-side reset.
      if (consecutiveErrors >= 3) {
        try {
          ({ apiKey, clientVersion, continuation } = await bootstrap(videoId));
          console.log("[scraper] re-bootstrapped after errors");
          consecutiveErrors = 0;
        } catch (e2) {
          console.error(`[scraper] re-bootstrap failed: ${e2.message}`);
          await new Promise(r => setTimeout(r, 30000));
        }
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
      continue;
    }

    if (result.nextContinuation) continuation = result.nextContinuation;

    let added = 0;
    for (const m of result.messages) {
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
      chatHistory.push({ name: m.name, text: m.text, ts: m.ts });
      while (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
      added++;
      console.log(`[scraper] +msg ${m.name}: ${m.text.slice(0, 80)}`);
    }
    // Bound the dedupe set so it doesn't grow forever on long streams
    if (seenIds.size > 5000) {
      const arr = Array.from(seenIds);
      seenIds.clear();
      arr.slice(-2500).forEach(id => seenIds.add(id));
    }

    if (added > 0) {
      writeSession({
        active:      true,
        liveChatId:  `scraper:${videoId}`,
        videoId,
        chatHistory: chatHistory.slice(),
        source:      "scraper",
        lastMessageAt: new Date().toISOString(),
      });
    } else {
      // Heartbeat so the build cycle keeps seeing active:true
      writeSession({ active: true, liveChatId: `scraper:${videoId}`, videoId, source: "scraper" });
    }

    const sleepMs = Math.max(POLL_FLOOR_MS, Math.min(POLL_CEIL_MS, result.timeoutMs));
    await new Promise(r => setTimeout(r, sleepMs));
  }
}

main().catch((e) => {
  console.error("[scraper] fatal:", e.message);
  process.exit(1);
});
