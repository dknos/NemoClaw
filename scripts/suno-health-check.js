#!/usr/bin/env node
"use strict";

/**
 * suno-health-check.js — Pings Suno auth to keep session alive.
 *
 * Calls the Clerk /v1/client endpoint with saved cookies.
 * If the response includes a refreshed __client cookie, saves it.
 * If the session is dead, logs a warning (user needs to run suno-login-once.js).
 *
 * Designed to run daily via cron. Zero overhead — single HTTPS request.
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");
const os    = require("os");

const COOKIE_FILE = path.join(os.homedir(), ".nemoclaw", "suno-cookies.json");
const ENV_FILE    = path.join(os.homedir(), ".nemoclaw_env");

function getToken() {
  // Try env first
  if (fs.existsSync(ENV_FILE)) {
    const content = fs.readFileSync(ENV_FILE, "utf8");
    const m = content.match(/^SUNO_REFRESH_TOKEN=(.+)$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  // Try cookie file
  if (fs.existsSync(COOKIE_FILE)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
    const c = cookies.find(c => c.name === "__client");
    if (c) return c.value;
  }
  return "";
}

function saveToken(newToken) {
  // Update cookie file
  if (fs.existsSync(COOKIE_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
      const idx = cookies.findIndex(c => c.name === "__client");
      if (idx >= 0) cookies[idx].value = newToken;
      else cookies.push({ name: "__client", value: newToken, domain: ".suno.com", path: "/" });
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    } catch { /* ignore */ }
  }
  // Update env file
  if (fs.existsSync(ENV_FILE)) {
    try {
      let content = fs.readFileSync(ENV_FILE, "utf8");
      if (content.includes("SUNO_REFRESH_TOKEN=")) {
        content = content.replace(/^SUNO_REFRESH_TOKEN=.+$/m, `SUNO_REFRESH_TOKEN=${newToken}`);
        fs.writeFileSync(ENV_FILE, content);
      }
    } catch { /* ignore */ }
  }
}

function request(url, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        "Cookie": `__client=${cookie}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function main() {
  const token = getToken();
  if (!token) {
    console.error("[suno-health] No token found. Run: node scripts/suno-login-once.js");
    process.exit(1);
  }

  console.log(`[suno-health] Checking session (token: ${token.length} chars)...`);

  try {
    const res = await request(
      "https://auth.suno.com/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0",
      token
    );

    // Check for refreshed cookie
    const setCookies = res.headers["set-cookie"];
    if (setCookies) {
      const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
      for (const sc of arr) {
        const m = sc.match(/__client=([^;]+)/);
        if (m && m[1] !== token) {
          console.log("[suno-health] Cookie refreshed — saving new token");
          saveToken(m[1]);
        }
      }
    }

    if (res.status !== 200) {
      console.error(`[suno-health] Clerk returned ${res.status} — session may be expired`);
      console.error("[suno-health] Run: node scripts/suno-login-once.js");
      process.exit(1);
    }

    const data = JSON.parse(res.body);
    const sid = data.response?.last_active_session_id;
    if (sid) {
      console.log(`[suno-health] Session alive: ${sid}`);
    } else {
      console.error("[suno-health] No active session — token expired");
      console.error("[suno-health] Run: node scripts/suno-login-once.js");
      process.exit(1);
    }
  } catch (err) {
    console.error(`[suno-health] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
