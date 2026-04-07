#!/usr/bin/env node
// breakroom-chat-bridge.js
// Watches live-session.json (written by live-session-scraper.js) and
// forwards new chat messages to /api/breakroom-chat so the 3D break room
// reacts to YouTube chat in real time.
//
// Usage:
//   node breakroom-chat-bridge.js
//
// Runs alongside:
//   - next dev -p 3001  (the Next.js app)
//   - live-session-scraper.js  (YouTube chat reader)
//   - stream-headless.sh --url http://localhost:3001/breakroom

"use strict";

const fs   = require("fs");
const http = require("http");
const path = require("path");

const SESSION_FILE  = path.join(process.env.HOME, "netify-dev", "public", "data", "live-session.json");
const BREAKROOM_API = "http://localhost:3001/api/breakroom-chat";
const POLL_MS       = 1500;  // how often we check for new messages

let lastSeenTs = Date.now(); // skip everything before startup

function readSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

function postCommands(commands) {
  const body = JSON.stringify({ commands });
  return new Promise((res) => {
    const req = http.request({
      hostname: "localhost",
      port: 3001,
      path: "/api/breakroom-chat",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (resp) => {
      resp.resume();
      resp.on("end", res);
    });
    req.on("error", () => res());
    req.write(body);
    req.end();
  });
}

async function poll() {
  const data = readSession();
  if (!data) return;

  const history = data.chatHistory || [];
  const fresh = history.filter(m => (m.ts || 0) > lastSeenTs);
  if (!fresh.length) return;

  lastSeenTs = Math.max(...fresh.map(m => m.ts || 0));

  // Convert to breakroom raw_chat commands
  const commands = fresh.map(m => ({
    type: "raw_chat",
    args: {
      text: String(m.text || "").trim(),
      user: String(m.name || "viewer").replace(/^@/, ""),
    },
  })).filter(c => c.args.text.length > 0);

  if (!commands.length) return;

  // Log what we're forwarding
  for (const c of commands) {
    console.log(`[bridge] ${c.args.user}: ${c.args.text}`);
  }

  try {
    await postCommands(commands);
  } catch (e) {
    console.error("[bridge] POST failed:", e.message);
  }
}

console.log(`[bridge] watching ${SESSION_FILE}`);
console.log(`[bridge] forwarding to ${BREAKROOM_API}`);
console.log(`[bridge] started at ts=${lastSeenTs} (skipping old messages)`);

// Poll every 1.5s
setInterval(poll, POLL_MS);

// Also watch file for changes (faster response)
let debounce = null;
fs.watch(SESSION_FILE, () => {
  clearTimeout(debounce);
  debounce = setTimeout(poll, 200);
});
