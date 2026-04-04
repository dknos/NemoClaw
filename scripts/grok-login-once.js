#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * grok-login-once.js — One-time manual login to save grok.com session cookies
 *
 * Opens a VISIBLE browser window. Log in manually, then press Enter in this terminal.
 * Cookies are saved to ~/.nemoclaw/grok-cookies.json for use by grok-server.
 *
 * Run: node scripts/grok-login-once.js
 */

"use strict";

const { chromium } = require("/home/nemoclaw/.nemoclaw/source/node_modules/playwright-core");
const fs   = require("fs");
const path = require("path");
const readline = require("readline");

const CHROMIUM_PATH = "/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
const COOKIE_FILE   = process.env.GROK_COOKIE_FILE
  || path.join(process.env.HOME, ".nemoclaw", "grok-cookies.json");

(async () => {
  console.log("[grok-login] launching visible browser...");
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  await page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 30000 });

  console.log("");
  console.log("=======================================================");
  console.log("  Browser is open on grok.com/imagine");
  console.log("  Click Sign in → Login with X → use your Windows PIN");
  console.log("  Once you can see the 'Type to imagine' input and");
  console.log("  are fully logged in, press ENTER here to save cookies.");
  console.log("=======================================================");
  console.log("");

  await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Press ENTER when logged in and on grok.com/imagine > ", () => { rl.close(); resolve(); });
  });

  const cookies = await context.cookies();
  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  console.log(`[grok-login] saved ${cookies.length} cookies to ${COOKIE_FILE}`);

  await browser.close();
  console.log("[grok-login] done — you can now start grok-server: pm2 start grok-server");
})().catch(e => { console.error("[grok-login] ERROR:", e.message); process.exit(1); });
