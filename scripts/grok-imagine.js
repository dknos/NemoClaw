#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * grok-imagine.js — Headless Playwright script for Grok Aurora image generation
 *
 * Usage: node grok-imagine.js "<prompt>"
 *
 * Outputs 1-4 file paths to stdout (one per line) — each a downloaded image
 * Exits 0 on success, 1 on failure (error written to stderr)
 *
 * Env:
 *   X_USERNAME        — X/Twitter email
 *   X_PASSWORD        — X/Twitter password
 *   GROK_COOKIE_FILE  — path to persist cookies (default: ~/.nemoclaw/grok-cookies.json)
 */

"use strict";

const { chromium } = require("/home/nemoclaw/.nemoclaw/source/node_modules/playwright-core");
const fs   = require("fs");
const path = require("path");
const https = require("https");

const CHROMIUM_PATH = "/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
const COOKIE_FILE   = process.env.GROK_COOKIE_FILE
  || path.join(process.env.HOME, ".nemoclaw", "grok-cookies.json");
const X_USER = process.env.X_USERNAME || "";
const X_PASS = process.env.X_PASSWORD || "";

const prompt = process.argv[2] || "";
if (!prompt) { console.error("Usage: grok-imagine.js \"<prompt>\""); process.exit(1); }

// ── helpers ───────────────────────────────────────────────────────────────────

function saveCookies(cookies) {
  try {
    fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  } catch {}
}

function loadCookies() {
  try { return JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8")); } catch { return null; }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get  = url.startsWith("https") ? https : require("http");
    get.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", e => { fs.unlink(dest, () => {}); reject(e); });
  });
}

async function clickByText(page, texts) {
  const btns = await page.$$("button, a, div[role='button'], span[role='button']");
  for (const btn of btns) {
    const txt = (await btn.innerText().catch(() => "")).trim().toLowerCase();
    for (const t of texts) {
      if (txt === t || txt.includes(t)) { await btn.click(); return true; }
    }
  }
  return false;
}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const saved = loadCookies();
  if (saved) {
    await context.addCookies(saved);
    console.error("[grok] loaded saved cookies");
  }

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // ── navigate ──────────────────────────────────────────────────────
  console.error("[grok] navigating to grok.com/imagine");
  await page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // ── check login ───────────────────────────────────────────────────
  const needsLogin = await page.evaluate(() => {
    const body = document.body.innerText || "";
    return body.includes("Sign in") || body.includes("Sign up") ||
      !!document.querySelector('a[href*="login"], a[href*="signin"]');
  });

  if (needsLogin) {
    console.error("[grok] not logged in — starting accounts.x.ai login");
    if (!X_USER || !X_PASS) {
      console.error("[grok] ERROR: X_USERNAME and X_PASSWORD not set");
      await browser.close(); process.exit(1);
    }
    await loginViaXAI(page, context, X_USER, X_PASS);
    // Save cookies right after login
    saveCookies(await context.cookies());
    console.error("[grok] cookies saved");
    // Navigate to /imagine
    await page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  // ── find prompt input ─────────────────────────────────────────────
  console.error("[grok] finding prompt input...");
  const inputSelectors = [
    '[placeholder="Type to imagine"]',
    '[placeholder*="imagine"]',
    '[placeholder*="Imagine"]',
    'textarea[placeholder*="magine"]',
    'textarea',
    '[role="textbox"]',
    '[contenteditable="true"]',
  ];

  let inputEl = null;
  for (const sel of inputSelectors) {
    try {
      inputEl = await page.waitForSelector(sel, { timeout: 5000, state: "visible" });
      if (inputEl) { console.error(`[grok] input found: ${sel}`); break; }
    } catch { inputEl = null; }
  }

  if (!inputEl) {
    const dump = await page.evaluate(() =>
      [...document.querySelectorAll("textarea,input,[contenteditable],[role='textbox']")]
        .map(e => ({ tag: e.tagName, ph: e.placeholder || e.getAttribute("placeholder") || "", ce: e.getAttribute("contenteditable") || "" }))
    );
    console.error("[grok] input candidates:", JSON.stringify(dump));
    const dbg = `/tmp/grok-noinput-${Date.now()}.png`;
    await page.screenshot({ path: dbg });
    console.error(`[grok] ERROR: no input found. Screenshot: ${dbg}`);
    await browser.close(); process.exit(1);
  }

  // ── type prompt ───────────────────────────────────────────────────
  await inputEl.click();
  const isContentEditable = await inputEl.evaluate(el => el.isContentEditable);
  const tag = await inputEl.evaluate(el => el.tagName.toLowerCase());
  if (isContentEditable && tag !== "textarea" && tag !== "input") {
    await page.keyboard.type(prompt, { delay: 20 });
  } else {
    await inputEl.fill(prompt);
  }
  await page.waitForTimeout(500);
  console.error("[grok] prompt entered, submitting...");

  // ── submit via Enter ──────────────────────────────────────────────
  await inputEl.press("Enter");
  console.error("[grok] submitted — waiting for images...");

  // Give grok at least 30s to start generating before we poll for results
  await page.waitForTimeout(30000);

  // ── wait for generated images ─────────────────────────────────────
  const imgSrcs = await waitForGeneratedImages(page, 120000, 4);

  if (!imgSrcs || imgSrcs.length === 0) {
    const dbg = `/tmp/grok-timeout-${Date.now()}.png`;
    await page.screenshot({ path: dbg });
    console.error(`[grok] ERROR: no images found. Screenshot: ${dbg}`);
    await browser.close(); process.exit(1);
  }

  console.error(`[grok] collected ${imgSrcs.length} image(s)`);

  // Save cookies after successful generation
  saveCookies(await context.cookies());
  await browser.close();

  // ── download all images ───────────────────────────────────────────
  const ts = Date.now();
  const outPaths = [];
  for (let i = 0; i < imgSrcs.length; i++) {
    const src = imgSrcs[i];
    const outPath = `/tmp/grok-${ts}-${i}.png`;
    if (src.startsWith("data:")) {
      const b64 = src.replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
    } else {
      await downloadFile(src, outPath);
    }
    console.error(`[grok] saved: ${outPath}`);
    outPaths.push(outPath);
  }

  // Output one path per line to stdout
  outPaths.forEach(p => console.log(p));
  process.exit(0);
})().catch(err => {
  console.error("[grok] FATAL:", err.message);
  process.exit(1);
});

// ── waitForGeneratedImages ────────────────────────────────────────────────────
// Waits for up to `maxImages` large generated images to appear, returns array of URLs/data-URLs
async function waitForGeneratedImages(page, timeoutMs, maxImages = 4) {
  const start = Date.now();
  let screenshotTaken = false;

  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(3000);

    // Mid-gen diagnostic at 25s
    if (!screenshotTaken && Date.now() - start > 25000) {
      screenshotTaken = true;
      const dbg = `/tmp/grok-midgen-${Date.now()}.png`;
      await page.screenshot({ path: dbg }).catch(() => {});
      const imgs = await page.evaluate(() =>
        [...document.querySelectorAll("img")].map(i => ({
          src: (i.src || "").slice(0, 100),
          w: Math.round(i.getBoundingClientRect().width),
          h: Math.round(i.getBoundingClientRect().height),
        }))
      ).catch(() => []);
      console.error(`[grok] mid-gen screenshot: ${dbg}`);
      console.error(`[grok] imgs on page: ${JSON.stringify(imgs)}`);
    }

    const srcs = await page.evaluate((max) => {
      const seen = new Set();
      const results = [];

      for (const img of document.querySelectorAll("img")) {
        if (results.length >= max) break;
        const src = img.src || img.getAttribute("src") || "";
        if (!src || seen.has(src)) continue;
        const rect = img.getBoundingClientRect();
        if (rect.width < 150 || rect.height < 100) continue;
        if (src.includes("profile_images") || src.includes("avatar") ||
            src.includes("icon") || src.includes("logo") || src.includes("favicon") ||
            src.includes("adsct") || src.includes("analytics.twitter")) continue;
        // For data URLs: require at least 8000 chars — placeholder/loading images are tiny
        if (src.startsWith("data:") && src.length < 8000) continue;
        if (src.startsWith("blob:") || src.startsWith("data:") || src.startsWith("https:")) {
          seen.add(src);
          results.push(src);
        }
      }
      return results;
    }, maxImages).catch(() => []);

    // Resolve any blob URLs to data URLs
    const resolved = [];
    for (const src of srcs) {
      if (src.startsWith("blob:")) {
        const dataUrl = await page.evaluate(async (blobUrl) => {
          try {
            const res = await fetch(blobUrl);
            const blob = await res.blob();
            return new Promise(resolve => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            });
          } catch { return null; }
        }, src);
        if (dataUrl) resolved.push(dataUrl);
      } else {
        resolved.push(src);
      }
    }

    if (resolved.length > 0) {
      console.error(`[grok] found ${resolved.length} image(s) at ${Math.round((Date.now() - start) / 1000)}s`);
      return resolved;
    }

    const hasError = await page.evaluate(() => {
      const txt = document.body.innerText || "";
      return txt.includes("Something went wrong") || txt.includes("rate limit") ||
             txt.includes("Try again") || txt.includes("Unable to generate");
    }).catch(() => false);
    if (hasError) { console.error("[grok] generation error on page"); return []; }

    console.error(`[grok] waiting... (${Math.round((Date.now() - start) / 1000)}s)`);
  }

  return [];
}

// ── loginWithEmail ────────────────────────────────────────────────────────────
// Flow: grok.com → Sign in → Login with email → enter email → Next → enter password → Log in
async function loginWithEmail(page, username, password) {
  console.error("[grok] login step 1: clicking Sign in");
  await clickByText(page, ["sign in"]);
  await page.waitForTimeout(2000);

  await page.screenshot({ path: `/tmp/grok-login-1-${Date.now()}.png` });
  console.error(`[grok] step1: ${(await page.evaluate(() => document.body.innerText.slice(0, 300)))}`);

  // Click "Login with email" (not X, Google, or Apple)
  console.error("[grok] login step 2: clicking Login with email");
  const btns = await page.$$("button, a, div[role='button'], span[role='button']");
  let clickedEmail = false;
  for (const btn of btns) {
    const txt = (await btn.innerText().catch(() => "")).trim().toLowerCase();
    if (txt.includes("email") && txt.includes("login") || txt === "login with email" || txt === "continue with email" || txt === "sign in with email") {
      console.error(`[grok] clicking: "${txt}"`);
      await btn.click();
      clickedEmail = true;
      break;
    }
  }
  if (!clickedEmail) {
    // looser match — any button mentioning email
    for (const btn of btns) {
      const txt = (await btn.innerText().catch(() => "")).trim().toLowerCase();
      if (txt.includes("email")) {
        console.error(`[grok] loose email match: "${txt}"`);
        await btn.click();
        break;
      }
    }
  }
  await page.waitForTimeout(2000);

  await page.screenshot({ path: `/tmp/grok-login-2-${Date.now()}.png` });
  console.error(`[grok] step2: ${(await page.evaluate(() => document.body.innerText.slice(0, 300)))}`);

  // Enter email
  console.error("[grok] login step 3: entering email");
  const emailInput = await page.waitForSelector(
    'input[type="email"], input[name="email"], input[autocomplete="email"], input[placeholder*="mail"], input[placeholder*="Email"], input[type="text"]',
    { timeout: 10000, state: "visible" }
  ).catch(async () => {
    const inputs = await page.$$("input");
    for (const i of inputs) { if (await i.isVisible().catch(() => false)) return i; }
    return null;
  });

  if (!emailInput) {
    await page.screenshot({ path: `/tmp/grok-login-noemail-${Date.now()}.png` });
    console.error("[grok] ERROR: email input not found");
    return;
  }
  await emailInput.click();
  await emailInput.fill(username);
  await page.waitForTimeout(500);
  console.error("[grok] filled email");

  // Click Next
  const nextBtns = await page.$$("button, div[role='button']");
  let nextClicked = false;
  for (const btn of nextBtns) {
    const txt = (await btn.innerText().catch(() => "")).trim().toLowerCase();
    if (txt === "next" || txt === "continue") { await btn.click(); nextClicked = true; break; }
  }
  if (!nextClicked) { await emailInput.press("Enter"); }
  await page.waitForTimeout(2000);

  await page.screenshot({ path: `/tmp/grok-login-3-${Date.now()}.png` });
  console.error(`[grok] step3: ${(await page.evaluate(() => document.body.innerText.slice(0, 300)))}`);

  // Enter password
  console.error("[grok] login step 4: entering password");
  const passInput = await page.waitForSelector(
    'input[type="password"], input[name="password"]',
    { timeout: 15000, state: "visible" }
  );
  await passInput.click();
  await passInput.fill(password);
  await page.waitForTimeout(500);
  console.error("[grok] filled password");

  // Click Log in / Sign in / Continue
  const loginBtns = await page.$$("button, div[role='button']");
  let loginClicked = false;
  for (const btn of loginBtns) {
    const txt = (await btn.innerText().catch(() => "")).trim().toLowerCase();
    if (txt === "log in" || txt === "login" || txt === "sign in" || txt === "continue" || txt === "submit") {
      await btn.click(); loginClicked = true; break;
    }
  }
  if (!loginClicked) { await passInput.press("Enter"); }
  await page.waitForTimeout(3000);

  await page.screenshot({ path: `/tmp/grok-login-4-${Date.now()}.png` });
  console.error(`[grok] step4 (post-login): ${(await page.evaluate(() => document.body.innerText.slice(0, 300)))}`);

  // Wait for redirect back to grok.com (away from auth/login pages)
  await page.waitForURL(
    url => url.toString().includes("grok.com") && !url.toString().includes("login") && !url.toString().includes("auth"),
    { timeout: 20000 }
  ).catch(() => console.error("[grok] post-login redirect timeout — continuing"));

  console.error("[grok] email login complete");
  await page.waitForTimeout(2000);
}

// ── loginViaXAI ───────────────────────────────────────────────────────────────
// Flow: accounts.x.ai/sign-in → Login with X → X OAuth popup → Use password instead → email + password → authorize
async function loginViaXAI(page, context, username, password) {
  console.error("[grok] navigating to accounts.x.ai/sign-in");
  await page.goto("https://accounts.x.ai/sign-in", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  await page.screenshot({ path: `/tmp/grok-xai-1-${Date.now()}.png` });
  console.error(`[grok] xai signin: ${(await page.evaluate(() => document.body.innerText.slice(0, 300)))}`);

  // Click "Login with X" / "Sign in with X"
  console.error("[grok] clicking Login with X on accounts.x.ai");
  const btns = await page.$$("button, a, div[role='button']");
  let clickedX = false;
  for (const btn of btns) {
    const txt = (await btn.innerText().catch(() => "")).trim().toLowerCase().replace(/\s+/g, " ");
    if ((txt.includes("login with") || txt.includes("sign in with") || txt.includes("continue with"))
        && !txt.includes("email") && !txt.includes("google") && !txt.includes("apple")) {
      console.error(`[grok] clicking: "${txt}"`);
      await btn.click(); clickedX = true; break;
    }
  }
  if (!clickedX) {
    const allTxt = await page.evaluate(() =>
      [...document.querySelectorAll("button,a,div[role='button']")].map(b => b.innerText?.trim()).filter(Boolean)
    );
    console.error("[grok] buttons on xai page:", JSON.stringify(allTxt));
  }

  // Wait for X OAuth popup
  console.error("[grok] waiting for X OAuth popup...");
  let xPage = null;
  try {
    xPage = await context.waitForEvent("page", { timeout: 10000 });
  } catch {
    // No popup — maybe inline or redirect
    const url = page.url();
    if (url.includes("x.com") || url.includes("twitter.com")) {
      xPage = page;
    } else {
      // Check if inline X form appeared
      const hasInput = await page.$('input[name="text"], input[autocomplete="username"]');
      if (hasInput) xPage = page;
    }
  }

  if (!xPage) {
    await page.screenshot({ path: `/tmp/grok-xai-nopopup-${Date.now()}.png` });
    console.error("[grok] ERROR: X OAuth popup not found — falling back to email login");
    await loginWithEmail(page, username, password);
    return;
  }

  await xPage.waitForLoadState("domcontentloaded").catch(() => {});
  await xPage.waitForTimeout(2000);
  await xPage.screenshot({ path: `/tmp/grok-xai-popup-${Date.now()}.png` });
  console.error(`[grok] X popup text: ${(await xPage.evaluate(() => document.body.innerText.slice(0, 400)))}`);

  // Fill username/email
  const userInput = await xPage.waitForSelector(
    'input[name="text"], input[autocomplete="username"], input[type="email"]',
    { timeout: 15000, state: "visible" }
  );
  await userInput.click();
  await userInput.fill(username);
  await xPage.waitForTimeout(600);
  console.error("[grok] filled X username");

  // Click Next
  const nextClicked = await xPage.$('[data-testid="LoginForm_Login_Button"]')
    .then(b => b ? b.click().then(() => true) : false).catch(() => false);
  if (!nextClicked) {
    const xBtns = await xPage.$$("button, div[role='button']");
    let found = false;
    for (const btn of xBtns) {
      const t = (await btn.innerText().catch(() => "")).trim().toLowerCase();
      if (t === "next") { await btn.click(); found = true; break; }
    }
    if (!found) await userInput.press("Enter");
  }
  await xPage.waitForTimeout(3000);
  await xPage.screenshot({ path: `/tmp/grok-xai-afternext-${Date.now()}.png` });
  console.error(`[grok] after next: ${(await xPage.evaluate(() => document.body.innerText.slice(0, 400)))}`);

  // If passkey/PIN prompt appears, click "Use password instead"
  const pageText = await xPage.evaluate(() => document.body.innerText || "");
  if (pageText.includes("passkey") || pageText.includes("Passkey") || pageText.includes("passkey") || pageText.includes("PIN") || pageText.includes("Use password")) {
    console.error("[grok] passkey prompt detected — clicking Use password instead");
    const xBtns2 = await xPage.$$("button, a, div[role='button'], span");
    for (const btn of xBtns2) {
      const t = (await btn.innerText().catch(() => "")).trim().toLowerCase();
      if (t.includes("password") || t.includes("use password") || t.includes("try another") || t.includes("different")) {
        console.error(`[grok] clicking: "${t}"`);
        await btn.click(); break;
      }
    }
    await xPage.waitForTimeout(2000);
    await xPage.screenshot({ path: `/tmp/grok-xai-afterpasskey-${Date.now()}.png` });
    console.error(`[grok] after passkey dismiss: ${(await xPage.evaluate(() => document.body.innerText.slice(0, 300)))}`);
  }

  // Handle unusual activity check
  const unusualInput = await xPage.$('input[data-testid="ocfEnterTextTextInput"]').catch(() => null);
  if (unusualInput) {
    console.error("[grok] unusual activity check");
    await unusualInput.click();
    await unusualInput.fill(username);
    const ob = await xPage.$('[data-testid="ocfEnterTextNextButton"]').catch(() => null);
    if (ob) await ob.click(); else await unusualInput.press("Enter");
    await xPage.waitForTimeout(2000);
  }

  // Fill password
  const passInput = await xPage.waitForSelector(
    'input[name="password"], input[type="password"]',
    { timeout: 15000, state: "visible" }
  );
  await passInput.click();
  await passInput.fill(password);
  await xPage.waitForTimeout(500);
  console.error("[grok] filled X password");

  // Click Log in
  const loginClicked = await xPage.$('[data-testid="LoginForm_Login_Button"]')
    .then(b => b ? b.click().then(() => true) : false).catch(() => false);
  if (!loginClicked) {
    const lBtns = await xPage.$$("button, div[role='button']");
    let found = false;
    for (const btn of lBtns) {
      const t = (await btn.innerText().catch(() => "")).trim().toLowerCase();
      if (t === "log in" || t === "login") { await btn.click(); found = true; break; }
    }
    if (!found) await passInput.press("Enter");
  }
  await xPage.waitForTimeout(3000);

  // Handle "Authorize app" if shown
  const authBtn = await xPage.$('[data-testid="OAuth_Consent_Button"], input[value="Authorize app"]').catch(() => null);
  if (authBtn) {
    console.error("[grok] authorizing app");
    await authBtn.click();
    await xPage.waitForTimeout(3000);
  }

  // Wait for popup to close (OAuth complete)
  if (xPage !== page) {
    await xPage.waitForEvent("close", { timeout: 20000 })
      .catch(() => console.error("[grok] popup didn't close — continuing"));
  }

  console.error("[grok] X OAuth login complete");
  await page.waitForTimeout(2000);
}
