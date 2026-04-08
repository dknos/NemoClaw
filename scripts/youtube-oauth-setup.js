#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// youtube-oauth-setup.js — One-time OAuth2 token setup for YouTube live chat
//
// Run this once to get a refresh_token for reading unlisted stream chat.
// The refresh_token is saved to ~/.nemoclaw_env and reused forever.
//
// Usage:
//   node youtube-oauth-setup.js
//
// Prerequisites:
//   1. Go to console.cloud.google.com → APIs & Services → Credentials
//   2. Create an OAuth 2.0 Client ID (type: Desktop App)
//   3. Download the JSON — copy client_id and client_secret
//   4. Add to ~/.nemoclaw_env:
//        YOUTUBE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com
//        YOUTUBE_OAUTH_CLIENT_SECRET=xxx
//   5. Run this script — it opens a browser for you to approve access
//   6. Refresh token is written back to ~/.nemoclaw_env automatically

"use strict";

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const ENV_FILE    = path.join(process.env.HOME, ".nemoclaw_env");
const REDIRECT_PORT = 4521;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/oauth/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
].join(" ");

// ── Load env ─────────────────────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// ── Write a key=value to the env file (appends or updates) ──────────────────
function upsertEnv(key, value) {
  const content = fs.readFileSync(ENV_FILE, "utf8");
  const lines   = content.split("\n");
  const idx     = lines.findIndex(l => l.startsWith(`${key}=`));
  if (idx >= 0) {
    lines[idx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(ENV_FILE, lines.join("\n"));
  console.log(`[oauth] saved ${key} to ${ENV_FILE}`);
}

// ── Exchange auth code for tokens ────────────────────────────────────────────
function exchangeCode(code, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body =
      `code=${encodeURIComponent(code)}` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&client_secret=${encodeURIComponent(clientSecret)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&grant_type=authorization_code`;

    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path:     "/token",
      method:   "POST",
      headers:  {
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (_e) { reject(new Error(`Bad response: ${data}`)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv();

  const clientId     = env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = env.YOUTUBE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("[oauth] ERROR: Missing credentials in ~/.nemoclaw_env");
    console.error("");
    console.error("  Add these two lines:");
    console.error("    YOUTUBE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com");
    console.error("    YOUTUBE_OAUTH_CLIENT_SECRET=xxx");
    console.error("");
    console.error("  Get them from: console.cloud.google.com → APIs & Services → Credentials");
    console.error("  Create an OAuth 2.0 Client ID (type: Desktop App)");
    process.exit(1);
  }

  // Build authorization URL
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&access_type=offline` +
    `&prompt=consent`;

  console.log("[oauth] ─────────────────────────────────────────────────────");
  console.log("[oauth] YouTube OAuth2 Setup — one-time flow");
  console.log("[oauth] ─────────────────────────────────────────────────────");
  console.log("");
  console.log("[oauth] Open this URL in your browser and approve access:");
  console.log("");
  console.log(authUrl);
  console.log("");
  console.log("[oauth] Waiting for redirect on localhost:" + REDIRECT_PORT + "...");
  console.log("[oauth] (this server is local-only, not accessible from outside)");
  console.log("");

  // Start local redirect catcher
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url   = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code  = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h2>Access denied or error: " + error + "</h2><p>Check the terminal.</p>");
        server.close();
        reject(new Error("OAuth denied: " + error));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h2>No code received.</h2>");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end([
        "<html><body style='font-family:monospace;background:#0d0d1a;color:#f0e8d0;padding:40px'>",
        "<h2 style='color:#00ff88'>✅ Authorization successful!</h2>",
        "<p>You can close this tab. Return to the terminal.</p>",
        "</body></html>",
      ].join(""));

      server.close();
      resolve(code);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[oauth] ERROR: Port ${REDIRECT_PORT} is in use. Kill the process using it and retry.`);
      }
      reject(err);
    });

    server.listen(REDIRECT_PORT, "127.0.0.1");
  });

  console.log("[oauth] code received — exchanging for tokens...");

  const tokens = await exchangeCode(code, clientId, clientSecret);

  if (tokens.error) {
    console.error("[oauth] ERROR from Google:", tokens.error, tokens.error_description);
    process.exit(1);
  }

  if (!tokens.refresh_token) {
    console.error("[oauth] ERROR: No refresh_token in response.");
    console.error("[oauth] Try revoking access at accounts.google.com/permissions and re-running.");
    process.exit(1);
  }

  // Save to env file
  upsertEnv("YOUTUBE_OAUTH_REFRESH_TOKEN", tokens.refresh_token);
  if (tokens.access_token) {
    upsertEnv("YOUTUBE_OAUTH_ACCESS_TOKEN", tokens.access_token);
  }

  console.log("");
  console.log("[oauth] ─────────────────────────────────────────────────────");
  console.log("[oauth] Done! Refresh token saved to ~/.nemoclaw_env");
  console.log("[oauth] live-session.js will use it automatically.");
  console.log("[oauth] ─────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("[oauth] fatal:", err.message);
  process.exit(1);
});
