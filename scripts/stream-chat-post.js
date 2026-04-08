#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// stream-chat-post.js — Post a single message to the active YouTube live chat.
//
// Usage:
//   node stream-chat-post.js "message body"
//
// Reads ~/.nemoclaw_env for OAuth creds and ~/netify-dev/public/data/live-session.json
// for the active liveChatId (populated by live-session.js). Messages over 200 chars
// are truncated — YouTube's live chat limit.

"use strict";

const https = require("https");
const fs    = require("fs");
const path  = require("path");
const quota = require("./lib/youtube-quota");

const ENV_FILE         = path.join(process.env.HOME, ".nemoclaw_env");
const LIVE_SESSION_FILE = path.join(process.env.HOME, "netify-dev", "public", "data", "live-session.json");
const MAX_CHARS        = 200;

function loadEnv() {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function httpsRequest(url, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method,
      headers: {
        "Accept": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
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
    if (data) req.write(data);
    req.end();
  });
}

async function getAccessToken(env) {
  const body =
    `client_id=${encodeURIComponent(env.YOUTUBE_OAUTH_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(env.YOUTUBE_OAUTH_CLIENT_SECRET)}` +
    `&refresh_token=${encodeURIComponent(env.YOUTUBE_OAUTH_REFRESH_TOKEN)}` +
    `&grant_type=refresh_token`;
  const { body: resp } = await httpsRequest(
    "https://oauth2.googleapis.com/token",
    "POST",
    body,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  if (!resp.access_token) throw new Error("Token refresh failed: " + JSON.stringify(resp));
  return resp.access_token;
}

async function main() {
  const message = (process.argv[2] || "").slice(0, MAX_CHARS);
  if (!message) {
    console.error("usage: stream-chat-post.js <message>");
    process.exit(1);
  }

  const env = loadEnv();
  if (!env.YOUTUBE_OAUTH_CLIENT_ID || !env.YOUTUBE_OAUTH_CLIENT_SECRET || !env.YOUTUBE_OAUTH_REFRESH_TOKEN) {
    console.error("[chat-post] missing YOUTUBE_OAUTH_* in ~/.nemoclaw_env");
    process.exit(1);
  }

  if (!fs.existsSync(LIVE_SESSION_FILE)) {
    console.error(`[chat-post] ${LIVE_SESSION_FILE} not found — is live-session.js running?`);
    process.exit(1);
  }
  const session = JSON.parse(fs.readFileSync(LIVE_SESSION_FILE, "utf8"));
  if (!session.active || !session.liveChatId) {
    console.error("[chat-post] no active liveChatId in live-session.json");
    process.exit(1);
  }

  // Hard budget gate — never post if the daily quota can't afford it
  if (!quota.canSpend(quota.COST_INSERT_LIVECHAT)) {
    const s = quota.status();
    console.warn(`[chat-post] BUDGET STOP: used ${s.used}/${s.hardStop} — skipping`);
    process.exit(0);
  }

  const token = await getAccessToken(env);
  const { status, body } = await httpsRequest(
    "https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet",
    "POST",
    {
      snippet: {
        liveChatId: session.liveChatId,
        type: "textMessageEvent",
        textMessageDetails: { messageText: message },
      },
    },
    {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
    }
  );

  quota.record(quota.COST_INSERT_LIVECHAT);
  if (status >= 200 && status < 300) {
    console.log(`[chat-post] ok: ${message}`);
  } else {
    console.error(`[chat-post] HTTP ${status}:`, body);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[chat-post] fatal:", e.message);
  process.exit(1);
});
