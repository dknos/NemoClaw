#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * grok-cookie-grab.js — Extract grok.com cookies from your real Chrome browser
 *
 * 1. Run this script (it will tell you what to do)
 * 2. It connects to your Chrome via remote debugging
 * 3. Saves cookies to ~/.nemoclaw/grok-cookies.json
 *
 * Usage: node scripts/grok-cookie-grab.js
 */

"use strict";

const { chromium } = require("/home/nemoclaw/.nemoclaw/source/node_modules/playwright-core");
const fs   = require("fs");
const path = require("path");
const http = require("http");

const COOKIE_FILE = process.env.GROK_COOKIE_FILE
  || path.join(process.env.HOME, ".nemoclaw", "grok-cookies.json");

function checkPort(port) {
  return new Promise(resolve => {
    http.get(`http://localhost:${port}/json/version`, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}

(async () => {
  console.log("");
  console.log("=== grok cookie grabber ===");
  console.log("");
  console.log("Step 1: Open a NEW Chrome window with remote debugging.");
  console.log("        Run this in a Windows terminal (cmd or PowerShell):");
  console.log("");
  console.log('  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --no-first-run');
  console.log("");
  console.log("        Or if Chrome is already open, close it first then run the above.");
  console.log("        (Edge users: replace chrome.exe with msedge.exe)");
  console.log("");
  console.log("Step 2: In that Chrome window, go to grok.com/imagine and make sure");
  console.log("        you are logged in (you should see the 'Type to imagine' input).");
  console.log("");
  console.log("Waiting for Chrome on port 9222...");

  // Poll for Chrome to appear on port 9222
  let info = null;
  for (let i = 0; i < 60; i++) {
    info = await checkPort(9222);
    if (info) break;
    process.stdout.write(".");
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!info) { console.error("\nTimed out waiting for Chrome. Make sure you ran the command above."); process.exit(1); }

  console.log(`\nConnected to: ${info.Browser}`);
  console.log("Connecting via CDP...");

  const browser = await chromium.connectOverCDP("http://10.255.255.254:9222");
  const contexts = browser.contexts();
  if (!contexts.length) { console.error("No browser contexts found."); process.exit(1); }

  // Find the grok.com page or use first context
  let targetContext = contexts[0];
  let targetPage = null;
  for (const ctx of contexts) {
    for (const pg of ctx.pages()) {
      const url = pg.url();
      if (url.includes("grok.com")) { targetContext = ctx; targetPage = pg; break; }
    }
    if (targetPage) break;
  }

  if (!targetPage) {
    // Navigate a page to grok.com to get cookies
    const pages = targetContext.pages();
    targetPage = pages[0] || await targetContext.newPage();
    console.log("Navigating to grok.com/imagine to grab cookies...");
    await targetPage.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
  }

  const cookies = await targetContext.cookies(["https://grok.com", "https://accounts.x.ai", "https://x.com", "https://twitter.com"]);
  console.log(`Grabbed ${cookies.length} cookies`);

  if (cookies.length === 0) {
    console.error("No cookies found — make sure you are logged in to grok.com/imagine in that Chrome window.");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  console.log(`Saved to: ${COOKIE_FILE}`);
  console.log("");
  console.log("Done! Now run:  pm2 start grok-server");

  await browser.disconnect();
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
