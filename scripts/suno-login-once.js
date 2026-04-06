#!/usr/bin/env node
"use strict";

/**
 * suno-login-once.js — One-time manual login to save suno.com session cookies
 *
 * Opens a VISIBLE browser window. Log in manually, then press Enter in this terminal.
 * Cookies are saved to ~/.nemoclaw/suno-cookies.json for use by suno.js.
 *
 * Run: node scripts/suno-login-once.js
 */

const { chromium } = require("/home/nemoclaw/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const fs       = require("fs");
const path     = require("path");
const readline = require("readline");

const CHROMIUM_PATH = "/home/nemoclaw/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome";
const COOKIE_FILE   = process.env.SUNO_COOKIE_FILE
  || path.join(process.env.HOME, ".nemoclaw", "suno-cookies.json");

(async () => {
  console.log("[suno-login] launching visible browser...");
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  await page.goto("https://suno.com", { waitUntil: "domcontentloaded", timeout: 30000 });

  console.log("");
  console.log("=======================================================");
  console.log("  Browser is open on suno.com");
  console.log("  Click Sign In → Log in with your account");
  console.log("  Once you're fully logged in and can see the");
  console.log("  Suno dashboard, press ENTER here to save cookies.");
  console.log("=======================================================");
  console.log("");

  await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Press ENTER when logged in > ", () => { rl.close(); resolve(); });
  });

  // Navigate to /create to ensure all session cookies are set
  await page.goto("https://suno.com/create", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  const cookies = await context.cookies();
  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  console.log(`[suno-login] saved ${cookies.length} cookies to ${COOKIE_FILE}`);

  // Extract and display the __client token
  const clientCookie = cookies.find(c => c.name === "__client");
  if (clientCookie) {
    console.log(`[suno-login] __client token found (${clientCookie.value.length} chars)`);

    // Write to env file
    const envFile = path.join(process.env.HOME, ".nemoclaw_env");
    if (fs.existsSync(envFile)) {
      let content = fs.readFileSync(envFile, "utf8");
      if (content.includes("SUNO_REFRESH_TOKEN=")) {
        content = content.replace(/^SUNO_REFRESH_TOKEN=.+$/m, `SUNO_REFRESH_TOKEN=${clientCookie.value}`);
      } else {
        content = content.trimEnd() + `\n\n# Suno (auto-refreshed from saved cookies)\nSUNO_REFRESH_TOKEN=${clientCookie.value}\n`;
      }
      fs.writeFileSync(envFile, content);
      console.log("[suno-login] written SUNO_REFRESH_TOKEN to .nemoclaw_env");
    }
  } else {
    console.warn("[suno-login] WARNING: __client cookie not found — login may have failed");
  }

  await browser.close();
  console.log("[suno-login] done — restart discord-bridge to pick up the token: pm2 restart discord-bridge");
})().catch(e => { console.error("[suno-login] ERROR:", e.message); process.exit(1); });
