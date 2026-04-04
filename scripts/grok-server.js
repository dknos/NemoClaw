#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * grok-server.js — Persistent Playwright browser server for Grok Aurora image generation
 *
 * Keeps a headless Chromium session open and logged in to grok.com/imagine.
 * Accepts HTTP POST /generate { prompt } → { paths: [...] }
 * Restarts browser session if it crashes. Idles for up to IDLE_TIMEOUT_MS.
 *
 * Run via pm2: pm2 start grok-server.js --name grok-server
 */

"use strict";

const { chromium } = require("/home/nemoclaw/.nemoclaw/source/node_modules/playwright-core");
const http = require("http");
const fs   = require("fs");
const path = require("path");
const https = require("https");

const PORT            = 3091;
const CHROMIUM_PATH   = "/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
const COOKIE_FILE     = process.env.GROK_COOKIE_FILE
  || path.join(process.env.HOME, ".nemoclaw", "grok-cookies.json");
const X_USER          = process.env.X_USERNAME || "";
const X_PASS          = process.env.X_PASSWORD || "";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min — restart browser if idle this long

// ── state ─────────────────────────────────────────────────────────────────────
let browser  = null;
let context  = null;
let page     = null;
let busy     = false;
let idleTimer = null;
let sessionReady = false;
let lastVideoPageUrl = null;  // URL after video generation (for extend/upscale)
let lastImagePageUrl = null;  // URL after image generation (so Make Video reuses the right images)

// ── helpers ───────────────────────────────────────────────────────────────────
function saveCookies(cookies) {
  try { fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true }); fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2)); } catch {}
}
function loadCookies() {
  try { return JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8")); } catch { return null; }
}
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith("https") ? https : require("http");
    get.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) { file.close(); return downloadFile(res.headers.location, dest).then(resolve).catch(reject); }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", e => { fs.unlink(dest, () => {}); reject(e); });
  });
}
async function clickByText(pg, texts) {
  const btns = await pg.$$("button, a, div[role='button'], span[role='button']");
  for (const btn of btns) {
    const txt = (await btn.innerText().catch(() => "")).trim().toLowerCase().replace(/\s+/g, " ");
    for (const t of texts) { if (txt === t || txt.includes(t)) { await btn.click(); return true; } }
  }
  return false;
}
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    console.log("[grok-server] idle timeout — closing browser to free memory");
    await closeBrowser();
    sessionReady = false;
  }, IDLE_TIMEOUT_MS);
}

// ── browser lifecycle ─────────────────────────────────────────────────────────
async function closeBrowser() {
  try { if (browser) await browser.close(); } catch {}
  browser = null; context = null; page = null; sessionReady = false;
}

async function launchBrowser() {
  console.log("[grok-server] launching browser...");
  browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--no-zygote", "--disable-blink-features=AutomationControlled",
    ],
  });
  context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 1000 },
    acceptDownloads: true,
  });
  const saved = loadCookies();
  if (saved) { await context.addCookies(saved); console.log("[grok-server] loaded saved cookies"); }
  page = await context.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
  browser.on("disconnected", () => {
    console.log("[grok-server] browser disconnected — will re-launch on next request");
    browser = null; context = null; page = null; sessionReady = false;
  });
}

async function ensureSession() {
  if (!browser || !page) await launchBrowser();

  console.log("[grok-server] navigating to grok.com/imagine...");
  await page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  const needsLogin = await page.evaluate(() => {
    const body = document.body.innerText || "";
    return body.includes("Sign in") || body.includes("Sign up");
  });

  if (needsLogin) {
    console.log("[grok-server] not logged in — logging in via accounts.x.ai");
    await loginViaXAI();
    saveCookies(await context.cookies());
    console.log("[grok-server] cookies saved");
    await page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
  } else {
    console.log("[grok-server] already logged in");
  }

  sessionReady = true;
  console.log("[grok-server] session ready");
}

// ── generate images ───────────────────────────────────────────────────────────
async function generate(prompt) {
  if (!sessionReady) await ensureSession();

  // Navigate to fresh /imagine page for clean state
  console.log(`[grok-server] generating: "${prompt.slice(0, 60)}"`);
  await page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Check session still valid
  const stillLoggedIn = await page.evaluate(() => !document.body.innerText.includes("Sign in"));
  if (!stillLoggedIn) {
    console.log("[grok-server] session expired — re-logging in");
    sessionReady = false;
    await ensureSession();
    await page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  // Find prompt input
  const inputSelectors = [
    '[placeholder="Type to imagine"]', '[placeholder*="imagine"]', '[placeholder*="Imagine"]',
    'textarea', '[role="textbox"]', '[contenteditable="true"]',
  ];
  let inputEl = null;
  for (const sel of inputSelectors) {
    try { inputEl = await page.waitForSelector(sel, { timeout: 4000, state: "visible" }); if (inputEl) break; }
    catch { inputEl = null; }
  }
  if (!inputEl) throw new Error("prompt input not found on grok.com/imagine");

  await inputEl.click();
  const isContentEditable = await inputEl.evaluate(el => el.isContentEditable);
  const tag = await inputEl.evaluate(el => el.tagName.toLowerCase());
  if (isContentEditable && tag !== "textarea" && tag !== "input") {
    await page.keyboard.type(prompt, { delay: 15 });
  } else {
    await inputEl.fill(prompt);
  }
  await page.waitForTimeout(400);
  // Submit: disable ProseMirror overlay, trusted mouse click on ↑ send button
  const sendPos = await page.evaluate(() => {
    const allBtns = [...document.querySelectorAll("button, [role='button']")];
    for (const b of allBtns) {
      const label = (b.getAttribute("aria-label") || "").toLowerCase();
      const r = b.getBoundingClientRect();
      if ((label.includes("submit") || label.includes("send")) && r.width > 0 && r.right > window.innerWidth - 250) {
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), how: label };
      }
    }
    const bottom = allBtns.filter(b => { const r = b.getBoundingClientRect(); return r.top > window.innerHeight - 150 && r.width > 0; })
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    if (bottom.length) { const r = bottom[0].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), how: "rightmost" }; }
    return null;
  });
  if (sendPos) {
    await page.evaluate(() => {
      document.querySelectorAll('.ProseMirror, .tiptap, [contenteditable="true"]').forEach(el => { el.dataset.peSaved = el.style.pointerEvents; el.style.pointerEvents = "none"; });
    });
    await page.mouse.click(sendPos.x, sendPos.y);
    await page.evaluate(() => {
      document.querySelectorAll("[data-pe-saved]").forEach(el => { el.style.pointerEvents = el.dataset.peSaved || ""; delete el.dataset.peSaved; });
    });
    console.log(`[grok-server] submitted via mouse click at (${sendPos.x},${sendPos.y}) [${sendPos.how}]`);
  } else {
    await inputEl.press("Enter");
    console.log("[grok-server] submitted via Enter (fallback)");
  }
  console.log("[grok-server] waiting 30s for generation...");

  // Wait 30s for grok to start generating
  await page.waitForTimeout(30000);

  // Poll for real images (up to 120s more)
  const imgSrcs = await waitForImages(120000, 4);
  if (!imgSrcs || imgSrcs.length === 0) {
    const dbg = `/tmp/grok-server-fail-${Date.now()}.png`;
    await page.screenshot({ path: dbg }).catch(() => {});
    throw new Error(`no images generated (screenshot: ${dbg})`);
  }

  console.log(`[grok-server] got ${imgSrcs.length} image(s)`);

  // Download
  const ts = Date.now();
  const outPaths = [];
  for (let i = 0; i < imgSrcs.length; i++) {
    const src = imgSrcs[i];
    const out = `/tmp/grok-${ts}-${i}.png`;
    if (src.startsWith("data:")) {
      fs.writeFileSync(out, Buffer.from(src.replace(/^data:image\/\w+;base64,/, ""), "base64"));
    } else {
      await downloadFile(src, out);
    }
    outPaths.push(out);
  }
  saveCookies(await context.cookies());
  return outPaths;
}

async function waitForImages(timeoutMs, maxImages) {
  const start = Date.now();
  let screenshotDone = false;
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(3000);

    if (!screenshotDone && Date.now() - start > 20000) {
      screenshotDone = true;
      const dbg = `/tmp/grok-server-midgen-${Date.now()}.png`;
      await page.screenshot({ path: dbg }).catch(() => {});
      console.log(`[grok-server] mid-gen screenshot: ${dbg}`);
    }

    const srcs = await page.evaluate((max) => {
      const seen = new Set(); const results = [];
      for (const img of document.querySelectorAll("img")) {
        if (results.length >= max) break;
        const src = img.src || img.getAttribute("src") || "";
        if (!src || seen.has(src)) continue;
        const rect = img.getBoundingClientRect();
        if (rect.width < 150 || rect.height < 100) continue;
        if (src.includes("profile_images") || src.includes("avatar") || src.includes("icon") ||
            src.includes("logo") || src.includes("favicon") || src.includes("adsct") ||
            src.includes("analytics.twitter")) continue;
        if (src.startsWith("data:") && src.length < 8000) continue;
        if (src.startsWith("blob:") || src.startsWith("data:") || src.startsWith("https:")) {
          seen.add(src); results.push(src);
        }
      }
      return results;
    }, maxImages).catch(() => []);

    // Resolve blob URLs
    const resolved = [];
    for (const src of srcs) {
      if (src.startsWith("blob:")) {
        const dataUrl = await page.evaluate(async blobUrl => {
          try {
            const res = await fetch(blobUrl); const blob = await res.blob();
            return new Promise(r => { const rd = new FileReader(); rd.onloadend = () => r(rd.result); rd.readAsDataURL(blob); });
          } catch { return null; }
        }, src);
        if (dataUrl) resolved.push(dataUrl);
      } else { resolved.push(src); }
    }

    if (resolved.length > 0) {
      console.log(`[grok-server] found ${resolved.length} image(s) at +${Math.round((Date.now() - start) / 1000)}s`);
      return resolved;
    }

    const hasError = await page.evaluate(() => {
      const t = document.body.innerText || "";
      return t.includes("Something went wrong") || t.includes("rate limit") || t.includes("Unable to generate");
    }).catch(() => false);
    if (hasError) throw new Error("grok.com reported a generation error");

    console.log(`[grok-server] waiting... +${Math.round((Date.now() - start) / 1000)}s`);
  }
  return [];
}

// ── login ─────────────────────────────────────────────────────────────────────
async function loginViaXAI() {
  console.log("[grok-server] navigating to accounts.x.ai/sign-in");
  await page.goto("https://accounts.x.ai/sign-in", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  await page.screenshot({ path: `/tmp/grok-server-login1-${Date.now()}.png` });
  console.log(`[grok-server] xai page: ${(await page.evaluate(() => document.body.innerText.slice(0, 300)))}`);

  // Click Login with X
  const btns = await page.$$("button, a, div[role='button']");
  let clickedX = false;
  for (const btn of btns) {
    const txt = (await btn.innerText().catch(() => "")).trim().toLowerCase().replace(/\s+/g, " ");
    if ((txt.includes("login with") || txt.includes("sign in with") || txt.includes("continue with"))
        && !txt.includes("email") && !txt.includes("google") && !txt.includes("apple")) {
      console.log(`[grok-server] clicking: "${txt}"`);
      await btn.click(); clickedX = true; break;
    }
  }
  if (!clickedX) {
    console.log("[grok-server] X button not found, buttons:", JSON.stringify(
      await page.evaluate(() => [...document.querySelectorAll("button,a")].map(b => b.innerText?.trim()).filter(Boolean))
    ));
  }

  // Wait for X OAuth popup
  let xPage = null;
  try { xPage = await context.waitForEvent("page", { timeout: 10000 }); }
  catch {
    const url = page.url();
    if (url.includes("x.com") || url.includes("twitter.com")) xPage = page;
    else {
      const has = await page.$('input[name="text"], input[autocomplete="username"]');
      if (has) xPage = page;
    }
  }
  if (!xPage) {
    console.log("[grok-server] no popup — falling back to grok email login");
    await loginWithEmailOnGrok();
    return;
  }

  await xPage.waitForLoadState("networkidle").catch(() => xPage.waitForLoadState("domcontentloaded").catch(() => {}));
  await xPage.waitForTimeout(3000);
  await xPage.screenshot({ path: `/tmp/grok-server-xpopup-${Date.now()}.png` });
  console.log(`[grok-server] X popup: ${(await xPage.evaluate(() => document.body.innerText.slice(0, 300)))}`);

  // Fill username — use keyboard.type() since fill() doesn't trigger React events in popups
  const userInput = await xPage.waitForSelector(
    'input[name="text"], input[autocomplete="username"], input[placeholder*="email"], input[placeholder*="username"], input[placeholder*="phone"]',
    { timeout: 15000, state: "visible" }
  );
  await userInput.click({ clickCount: 3 }); // triple-click to select any existing text
  await xPage.waitForTimeout(300);
  await xPage.keyboard.type(X_USER, { delay: 50 });
  await xPage.waitForTimeout(800);

  // Verify it was filled
  const filledVal = await userInput.inputValue().catch(() => "");
  console.log(`[grok-server] username field value: "${filledVal}"`);

  // Click Next — try the dark "Next" button directly
  const nextOk = await xPage.locator('button:has-text("Next")').first().click().then(() => true).catch(() => false);
  if (!nextOk) {
    await xPage.$('[data-testid="LoginForm_Login_Button"]').then(b => b ? b.click() : null).catch(() => null);
  }
  await xPage.waitForTimeout(4000);
  await xPage.screenshot({ path: `/tmp/grok-server-afternext-${Date.now()}.png` });
  console.log(`[grok-server] after next: ${(await xPage.evaluate(() => document.body.innerText.slice(0, 400)))}`);


  // Dismiss passkey/PIN — click "Use password instead"
  const pt = await xPage.evaluate(() => document.body.innerText || "");
  if (pt.includes("passkey") || pt.includes("Passkey") || pt.includes("Use password") || pt.includes("PIN")) {
    console.log("[grok-server] passkey prompt — clicking Use password instead");
    const pb = await xPage.$$("button, a, div[role='button'], span");
    for (const b of pb) {
      const t = (await b.innerText().catch(() => "")).trim().toLowerCase();
      if (t.includes("password") || t.includes("try another") || t.includes("different way")) { await b.click(); break; }
    }
    await xPage.waitForTimeout(2000);
    await xPage.screenshot({ path: `/tmp/grok-server-afterpasskey-${Date.now()}.png` });
    console.log(`[grok-server] after passkey: ${(await xPage.evaluate(() => document.body.innerText.slice(0, 300)))}`);
  }

  // Unusual activity check
  const ua = await xPage.$('input[data-testid="ocfEnterTextTextInput"]').catch(() => null);
  if (ua) {
    console.log("[grok-server] unusual activity check");
    await ua.click(); await ua.fill(X_USER);
    const ub = await xPage.$('[data-testid="ocfEnterTextNextButton"]').catch(() => null);
    if (ub) await ub.click(); else await ua.press("Enter");
    await xPage.waitForTimeout(2000);
  }

  // Fill password
  const passInput = await xPage.waitForSelector('input[name="password"], input[type="password"]', { timeout: 15000, state: "visible" });
  await passInput.click();
  await passInput.fill(X_PASS);
  await xPage.waitForTimeout(500);
  console.log("[grok-server] filled password");

  // Log in
  const loginOk = await xPage.$('[data-testid="LoginForm_Login_Button"]').then(b => b ? b.click().then(() => true) : false).catch(() => false);
  if (!loginOk) {
    const lb = await xPage.$$("button, div[role='button']");
    let found = false;
    for (const b of lb) { const t = (await b.innerText().catch(() => "")).trim().toLowerCase(); if (t === "log in" || t === "login") { await b.click(); found = true; break; } }
    if (!found) await passInput.press("Enter");
  }
  await xPage.waitForTimeout(3000);

  // Authorize app
  const auth = await xPage.$('[data-testid="OAuth_Consent_Button"], input[value="Authorize app"]').catch(() => null);
  if (auth) { console.log("[grok-server] authorizing"); await auth.click(); await xPage.waitForTimeout(3000); }

  if (xPage !== page) {
    await xPage.waitForEvent("close", { timeout: 20000 }).catch(() => console.log("[grok-server] popup close timeout"));
  }
  console.log("[grok-server] X OAuth login complete");
  await page.waitForTimeout(2000);
}

async function loginWithEmailOnGrok() {
  console.log("[grok-server] using grok.com email login");
  await page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);
  await clickByText(page, ["sign in"]);
  await page.waitForTimeout(2000);
  // Click Login with email
  const btns = await page.$$("button, a, div[role='button']");
  for (const btn of btns) {
    const t = (await btn.innerText().catch(() => "")).trim().toLowerCase();
    if (t.includes("email")) { await btn.click(); break; }
  }
  await page.waitForTimeout(2000);
  // Fill email
  const emailInput = await page.waitForSelector('input[type="email"], input[type="text"]', { timeout: 10000, state: "visible" }).catch(() => null);
  if (!emailInput) { console.log("[grok-server] email input not found"); return; }
  await emailInput.click(); await emailInput.fill(X_USER); await page.waitForTimeout(500);
  const nb = await page.$$("button, div[role='button']");
  let nf = false;
  for (const b of nb) { const t = (await b.innerText().catch(() => "")).trim().toLowerCase(); if (t === "next" || t === "continue") { await b.click(); nf = true; break; } }
  if (!nf) await emailInput.press("Enter");
  await page.waitForTimeout(2000);
  // Fill password
  const passInput = await page.waitForSelector('input[type="password"]', { timeout: 15000, state: "visible" }).catch(() => null);
  if (!passInput) { console.log("[grok-server] password input not found"); return; }
  await passInput.click(); await passInput.fill(X_PASS); await page.waitForTimeout(500);
  const lb = await page.$$("button, div[role='button']");
  let lf = false;
  for (const b of lb) { const t = (await b.innerText().catch(() => "")).trim().toLowerCase(); if (t === "log in" || t === "login" || t === "sign in" || t === "continue") { await b.click(); lf = true; break; } }
  if (!lf) await passInput.press("Enter");
  await page.waitForTimeout(3000);
  console.log("[grok-server] email login done");
}

// ── generateVideo ─────────────────────────────────────────────────────────────
// Upload-based flow: click "+", upload image, select Image or Video tab, enter prompt, submit
// imageBuffer: Buffer containing the PNG/JPEG image
// prompt: text description
// mode: "video" (default) | "image"
async function generateFromImage(imageBuffer, prompt, mode = "video") {
  if (!sessionReady) await ensureSession();

  console.log(`[grok-server] generateFromImage mode=${mode}: "${prompt.slice(0, 60)}"`);

  // Save image to temp file for upload, converting AVIF → PNG if needed
  const tmpImgRaw = `/tmp/grok-upload-raw-${Date.now()}`;
  const tmpImg    = `/tmp/grok-upload-${Date.now()}.png`;
  fs.writeFileSync(tmpImgRaw, imageBuffer);
  // AVIF magic: ftyp box at offset 4 contains "avif" or "avis"
  const isAvif = imageBuffer.length > 12 &&
    (imageBuffer.slice(4, 8).toString("ascii") === "ftyp") &&
    /^avi[fs]/i.test(imageBuffer.slice(8, 12).toString("ascii"));
  if (isAvif) {
    console.log("[grok-server] AVIF detected — converting to PNG via ffmpeg");
    await new Promise((res, rej) => {
      require("child_process").execFile(
        "ffmpeg", ["-y", "-i", tmpImgRaw, tmpImg],
        { timeout: 15000 },
        (err) => { fs.unlink(tmpImgRaw, () => {}); err ? rej(err) : res(); }
      );
    });
  } else {
    fs.renameSync(tmpImgRaw, tmpImg);
  }

  try {
    // Navigate to fresh imagine page
    await page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const loggedIn = await page.evaluate(() => !document.body.innerText.includes("Sign in"));
    if (!loggedIn) { sessionReady = false; await ensureSession(); await page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000); }

    // Step 1: click the "+" attachment button that is next to the prompt input.
    // IMPORTANT: do NOT click page-level "+" buttons (template cards etc.) — only the
    // button that is physically adjacent to / inside the prompt input container.
    const plusClicked = await page.evaluate(() => {
      const input = document.querySelector('[placeholder*="imagine" i]');
      if (!input) return "no-input-found";

      const inputRect = input.getBoundingClientRect();

      // A) Check the immediate container of the input for attachment-related buttons
      let container = input.parentElement;
      for (let i = 0; i < 5 && container; i++, container = container.parentElement) {
        const btns = [...container.querySelectorAll("button")];
        // Only consider buttons within the same horizontal band as the input (±40px)
        const nearby = btns.filter(b => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && Math.abs((r.top + r.height / 2) - (inputRect.top + inputRect.height / 2)) < 40;
        });
        for (const b of nearby) {
          const txt  = (b.innerText || "").trim();
          const lbl  = (b.getAttribute("aria-label") || "").toLowerCase();
          const tid  = (b.getAttribute("data-testid") || "").toLowerCase();
          if (txt === "+" || lbl.includes("attach") || lbl.includes("add image") || lbl.includes("upload") ||
              tid.includes("attach") || tid.includes("upload")) {
            b.click(); return `container-btn:${txt || lbl}`;
          }
        }
        // If the container itself has exactly the right size buttons (icon buttons to the left)
        if (nearby.length > 0 && i <= 2) {
          // The leftmost button in the row is likely the "+" attachment button
          const sorted = nearby.slice().sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          const leftmost = sorted[0];
          if (leftmost.getBoundingClientRect().left < inputRect.left) {
            leftmost.click(); return `leftmost-btn`;
          }
        }
      }

      // B) Positional: probe points to the LEFT of the input (the "+" sits there)
      for (const xOff of [20, 30, 40, 50, 60, 80]) {
        const el = document.elementFromPoint(inputRect.left - xOff, inputRect.top + inputRect.height / 2);
        if (el && el !== input && el !== document.body) {
          const btn = el.closest("button") || (el.tagName === "BUTTON" ? el : null);
          if (btn) { btn.click(); return `positional-${xOff}`; }
        }
      }

      return "not-found";
    });
    console.log(`[grok-server] plus button: ${plusClicked}`);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `/tmp/grok-vidupload-plus-${Date.now()}.png` }).catch(() => {});

    // Step 2: click "Upload File" / "Upload or drop images" to open the OS file chooser.
    // The panel that opens after "+" may say "Drop your media here" + "Upload File" button.
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 8000 }),
      page.evaluate(() => {
        // Priority: button/link whose text matches upload-related phrases
        const uploadTexts = ["upload file", "upload or drop", "choose file", "browse", "select file"];
        for (const el of document.querySelectorAll("button, a, label, span, div")) {
          const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
          for (const t of uploadTexts) {
            if (txt === t || txt.startsWith(t)) { el.click(); return `by-text:${txt}`; }
          }
        }
        // Fallback: direct file input
        const fi = document.querySelector('input[type="file"]');
        if (fi) { fi.click(); return "direct-input"; }
        return null;
      }),
    ]).catch(async () => {
      const fi = await page.$('input[type="file"]');
      if (fi) return [{ setFiles: () => {} }]; // placeholder — not usable this way
      return [null];
    });

    if (!fileChooser) {
      const dbg = `/tmp/grok-vidupload-nochooser-${Date.now()}.png`;
      await page.screenshot({ path: dbg }).catch(() => {});
      throw new Error(`file chooser did not open (screenshot: ${dbg})`);
    }

    await fileChooser.setFiles(tmpImg);
    console.log("[grok-server] image uploaded via file chooser");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `/tmp/grok-vidupload-uploaded-${Date.now()}.png` }).catch(() => {});

    // After setFiles() the image attaches to the prompt automatically — no panel to close,
    // no thumbnail to click. The placeholder changes to "@ to reference images".
    // The ONLY thing that can go wrong: clicking the thumbnail in the prompt area opens a
    // preview lightbox. Close it with Escape if present.
    const lightboxOpen = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="presentation"]')];
      for (const d of dialogs) {
        const rect = d.getBoundingClientRect();
        if (rect.width > 400 && rect.height > 400) return true;
      }
      // Also check for a large centered image overlay (lightbox without role)
      const imgs = [...document.querySelectorAll("img")];
      for (const img of imgs) {
        const rect = img.getBoundingClientRect();
        if (rect.width > 400 && rect.height > 400 && rect.top < 200) return true;
      }
      return false;
    }).catch(() => false);

    if (lightboxOpen) {
      console.log("[grok-server] lightbox detected — pressing Escape to close");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(800);
    }

    await page.screenshot({ path: `/tmp/grok-vidupload-afterclose-${Date.now()}.png` }).catch(() => {});

    // Step 3: click Video or Image tab
    const tabTarget = mode === "video" ? "video" : "image";
    const tabClicked = await page.evaluate((target) => {
      const btns = [...document.querySelectorAll("button, [role='tab']")];
      for (const b of btns) {
        const txt = (b.innerText || "").trim().toLowerCase();
        const label = (b.getAttribute("aria-label") || "").toLowerCase();
        if (txt === target || label === target) { b.click(); return true; }
      }
      return false;
    }, tabTarget);
    console.log(`[grok-server] ${tabTarget} tab clicked: ${tabClicked}`);
    await page.waitForTimeout(1000);

    // Step 4: fill prompt and submit
    // After image attach, placeholder becomes "Type to imagine, @ to reference images".
    // Use the same multi-selector fallback chain as generate() — the element type may
    // be a contenteditable div or textarea, not a plain input with placeholder attribute.
    const inputSelectors = [
      '[placeholder*="reference" i]',
      '[placeholder*="imagine" i]',
      'textarea',
      '[role="textbox"]',
      '[contenteditable="true"]',
    ];
    let inputEl = null;
    for (const sel of inputSelectors) {
      try { inputEl = await page.waitForSelector(sel, { timeout: 4000, state: "visible" }); if (inputEl) break; }
      catch { inputEl = null; }
    }
    if (!inputEl) {
      const dbg = `/tmp/grok-vidupload-noinput-${Date.now()}.png`;
      await page.screenshot({ path: dbg }).catch(() => {});
      throw new Error(`prompt input not found after upload (screenshot: ${dbg})`);
    }

    await inputEl.click();
    const isCE = await inputEl.evaluate(el => el.isContentEditable);
    const tag  = await inputEl.evaluate(el => el.tagName.toLowerCase());
    if (isCE && tag !== "textarea" && tag !== "input") await page.keyboard.type(prompt, { delay: 15 });
    else await inputEl.fill(prompt);
    await page.waitForTimeout(300);

    // Submit: find the ↑ arrow send button position, disable ProseMirror overlay, trusted mouse click.
    // Same technique that fixed the "..." extend button — ProseMirror overlay intercepts pointer events.
    const sendPos = await page.evaluate(() => {
      // Log all bottom-right buttons for diagnostics
      const allBtns = [...document.querySelectorAll("button, [role='button']")];
      const bottomRight = allBtns.filter(b => {
        const r = b.getBoundingClientRect();
        return r.right > window.innerWidth - 250 && r.top > window.innerHeight - 200 && r.width > 0;
      }).map(b => {
        const r = b.getBoundingClientRect();
        return { label: b.getAttribute("aria-label") || "", text: (b.innerText || "").trim().slice(0, 20),
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
      });
      console.log("[grok-diag] bottom-right buttons:", JSON.stringify(bottomRight));
      // Find send/submit button
      for (const b of allBtns) {
        const label = (b.getAttribute("aria-label") || "").toLowerCase();
        const r = b.getBoundingClientRect();
        if ((label.includes("submit") || label.includes("send")) && r.width > 0 && r.right > window.innerWidth - 250) {
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), how: `label:${label}` };
        }
      }
      // Fallback: rightmost button in bottom 150px
      const bottom = allBtns.filter(b => {
        const r = b.getBoundingClientRect();
        return r.top > window.innerHeight - 150 && r.width > 0 && r.height > 0;
      }).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
      if (bottom.length) {
        const r = bottom[0].getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), how: `rightmost:${bottom[0].getAttribute("aria-label") || "?"}` };
      }
      return null;
    });

    // Snapshot existing user-generated video srcs before submit to avoid false positives
    const existingVideoSrcs = await page.evaluate(() =>
      [...document.querySelectorAll("video[src]")]
        .map(v => v.src)
        .filter(s => s && s.includes("assets.grok.com/users/"))
    ).catch(() => []);
    console.log(`[grok-server] existing video srcs: ${existingVideoSrcs.length}`);

    if (sendPos) {
      // Disable ProseMirror overlay pointer events (same fix as extend "..." button)
      await page.evaluate(() => {
        document.querySelectorAll('.ProseMirror, .tiptap, [contenteditable="true"]').forEach(el => {
          el.dataset.peSaved = el.style.pointerEvents;
          el.style.pointerEvents = "none";
        });
      });
      await page.mouse.click(sendPos.x, sendPos.y);
      await page.evaluate(() => {
        document.querySelectorAll("[data-pe-saved]").forEach(el => {
          el.style.pointerEvents = el.dataset.peSaved || "";
          delete el.dataset.peSaved;
        });
      });
      console.log(`[grok-server] ${mode} submitted via mouse click at (${sendPos.x},${sendPos.y}) [${sendPos.how}]`);
    } else {
      await inputEl.press("Enter");
      console.log(`[grok-server] ${mode} submitted via Enter (no send button found)`);
    }

    if (mode === "video") {
      // Check if generation actually started within 5s; if not, retry with keyboard Enter
      await page.waitForTimeout(5000);
      const genStarted = await page.evaluate(() => {
        const t = document.body.innerText || "";
        return t.includes("Generating") || t.includes("Cancel Video");
      }).catch(() => false);

      if (!genStarted) {
        console.log("[grok-server] generation did not start after submit — retrying via keyboard Enter");
        // Re-focus the input and press Enter
        for (const sel of ['[placeholder*="reference" i]', '[placeholder*="imagine" i]', '[role="textbox"]', '[contenteditable="true"]']) {
          try {
            const el = await page.$(sel);
            if (el) { await el.click({ force: true }).catch(() => {}); break; }
          } catch {}
        }
        await page.keyboard.press("Enter");
        await page.waitForTimeout(3000);
        const genStarted2 = await page.evaluate(() => {
          const t = document.body.innerText || "";
          return t.includes("Generating") || t.includes("Cancel Video");
        }).catch(() => false);
        console.log(`[grok-server] generation started after retry: ${genStarted2}`);
      }

      await page.waitForTimeout(10000);
      const videoPath = await waitForVideo(180000, existingVideoSrcs);
      if (!videoPath) {
        const dbg = `/tmp/grok-vidupload-fail-${Date.now()}.png`;
        await page.screenshot({ path: dbg }).catch(() => {});
        throw new Error(`video not generated (screenshot: ${dbg})`);
      }
      saveCookies(await context.cookies());
      // Click the video to open its detail page — needed so Extend/Upscale can navigate back
      try {
        const vidEl = await page.$("video");
        if (vidEl) { await vidEl.click({ force: true }); await page.waitForTimeout(2000); }
        lastVideoPageUrl = page.url();
        console.log(`[grok-server] video detail URL saved: ${lastVideoPageUrl}`);
      } catch {}
      return { type: "video", path: videoPath };
    } else {
      // image mode — wait for generated images
      await page.waitForTimeout(30000);
      const imgSrcs = await waitForImages(120000, 4);
      if (!imgSrcs?.length) {
        const dbg = `/tmp/grok-img2img-fail-${Date.now()}.png`;
        await page.screenshot({ path: dbg }).catch(() => {});
        throw new Error(`no images generated (screenshot: ${dbg})`);
      }
      const ts = Date.now();
      const paths = [];
      for (let i = 0; i < imgSrcs.length; i++) {
        const src = imgSrcs[i];
        const out = `/tmp/grok-img2img-${ts}-${i}.png`;
        if (src.startsWith("data:")) {
          fs.writeFileSync(out, Buffer.from(src.replace(/^data:image\/\w+;base64,/, ""), "base64"));
        } else {
          await downloadFile(src, out);
        }
        paths.push(out);
      }
      saveCookies(await context.cookies());
      return { type: "images", paths };
    }
  } finally {
    fs.unlink(tmpImg, () => {});
  }
}

// Convenience wrappers
async function generateVideo(imageBuffer, videoPrompt) {
  const result = await generateFromImage(imageBuffer, videoPrompt, "video");
  return result.path; // backward compat — callers expect a path string
}

async function extendOrUpscaleVideo(actionType, actionPrompt = "") {
  // actionType: "extend" | "upscale"; actionPrompt: optional description for extend/upscale
  if (!sessionReady) await ensureSession();

  console.log(`[grok-server] ${actionType}: checking if video is on current page...`);

  // Try to navigate back to the video detail page if we saved its URL
  if (lastVideoPageUrl && page.url() !== lastVideoPageUrl) {
    console.log(`[grok-server] navigating back to video page: ${lastVideoPageUrl}`);
    await page.goto(lastVideoPageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  // The video detail page must have the "More options" button (aria-label="More options")
  // in the right panel. Template/browse pages may have <video> elements but not this button.
  const videoOnPage = await page.evaluate(() => {
    // Must have the right-panel "More options" button visible at the far right
    const moreBtn = [...document.querySelectorAll("button")].find(b =>
      (b.getAttribute("aria-label") || "").toLowerCase() === "more options"
    );
    if (!moreBtn) return false;
    const rect = moreBtn.getBoundingClientRect();
    return rect.width > 0 && rect.x > 900; // must be in the right panel area
  }).catch(() => false);
  if (!videoOnPage) {
    throw new Error("Video detail page not loaded — Extend/Upscale must be used immediately after generating the video, before any other Grok requests.");
  }

  await page.screenshot({ path: `/tmp/grok-${actionType}-loaded-${Date.now()}.png` }).catch(() => {});

  // The "..." button is at the BOTTOM of the right action panel — it may be below the
  // visible viewport. Scroll to bottom first, then find it by SVG 3-circles pattern or text.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);

  // Log all buttons for diagnosis
  const allBtnInfo = await page.evaluate(() =>
    [...document.querySelectorAll("button, [role='button']")].map(b => ({
      txt: b.innerText?.trim().slice(0, 20) || "",
      label: b.getAttribute("aria-label") || "",
      svgCircles: b.querySelector("svg") ? b.querySelector("svg").querySelectorAll("circle").length : 0,
      y: Math.round(b.getBoundingClientRect().top),
      x: Math.round(b.getBoundingClientRect().left),
    }))
  ).catch(() => []);
  console.log(`[grok-server] ${actionType}: buttons:`, JSON.stringify(allBtnInfo));

  // Find the "..." button using an ElementHandle so Playwright can auto-scroll it into view.
  // The button uses 3 SVG circles and sits at the BOTTOM of the right action panel —
  // it may be below the visible viewport, so evaluate().click() won't work.
  // Find the "More options" / "..." button coordinates, then use page.mouse.click()
  // which generates a TRUSTED pointer event (isTrusted=true).
  // evaluate().click() dispatches a synthetic event that Grok's React handler ignores.
  const dotsPos = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, [role='button']")];
    // 1. Exact "More options" label (the button's aria-label from the logs)
    for (const b of btns) {
      const label = (b.getAttribute("aria-label") || "").toLowerCase();
      const title = (b.getAttribute("title") || "").toLowerCase();
      const tid   = (b.getAttribute("data-testid") || "").toLowerCase();
      const txt   = (b.innerText || "").trim();
      if (txt === "..." || txt === "•••"
          || label === "more options" || label.includes("more option") || label.includes("more action")
          || title.includes("more option") || title.includes("more action")
          || tid.includes("more") || tid.includes("dots") || tid.includes("ellipsis")) {
        const r = b.getBoundingClientRect();
        if (r.width > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), how: `label:${label || txt}` };
      }
    }
    // 2. SVG 3-circles, bottom-most that is NOT an off-screen "Options" sidebar item
    const circleBtns = btns.filter(b => {
      const label = (b.getAttribute("aria-label") || "").toLowerCase();
      if (label === "options") return false; // sidebar history "..." — skip
      return b.querySelector("svg")?.querySelectorAll("circle").length === 3;
    });
    if (circleBtns.length > 0) {
      circleBtns.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      const btn = circleBtns[0];
      const r = btn.getBoundingClientRect();
      if (r.width > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), how: `svg-3circles y=${Math.round(r.top)}` };
    }
    return null;
  }).catch(() => null);

  if (!dotsPos) {
    const dbg = `/tmp/grok-${actionType}-nodots-${Date.now()}.png`;
    await page.screenshot({ path: dbg }).catch(() => {});
    throw new Error(`"..." button not found (screenshot: ${dbg})`);
  }
  console.log(`[grok-server] dots button at (${dotsPos.x},${dotsPos.y}) via ${dotsPos.how}`);

  // Use ElementHandle.click({ force: true }):
  //   - force:true skips stability check (playing video causes timeout otherwise)
  //   - dispatches trusted events DIRECTLY to the element (bypasses chat bubble overlap)
  const dotsEl = await page.$('button[aria-label="More options"]').catch(() => null)
    || await page.evaluateHandle(() => {
      const btns = [...document.querySelectorAll("button,[role='button']")];
      const cb = btns.filter(b => b.querySelector("svg")?.querySelectorAll("circle").length === 3 && (b.getAttribute("aria-label")||"").toLowerCase() !== "options");
      if (!cb.length) return null;
      cb.sort((a,b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return cb[0];
    }).then(h => h?.asElement()).catch(() => null);

  // The chat input (ProseMirror contenteditable) covers the "More options" button.
  // Temporarily disable its pointer-events so the trusted mouse click reaches the button.
  await page.evaluate(() => {
    document.querySelectorAll('.ProseMirror, .tiptap, [contenteditable="true"]').forEach(el => {
      el.dataset.peSaved = el.style.pointerEvents;
      el.style.pointerEvents = "none";
    });
  });
  await page.mouse.click(dotsPos.x, dotsPos.y);
  await page.evaluate(() => {
    document.querySelectorAll("[data-pe-saved]").forEach(el => {
      el.style.pointerEvents = el.dataset.peSaved || "";
      delete el.dataset.peSaved;
    });
  });
  console.log(`[grok-server] dots button clicked at (${dotsPos.x},${dotsPos.y}) with overlay disabled`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `/tmp/grok-${actionType}-menu-${Date.now()}.png` }).catch(() => {});

  // Dump page text to see what appeared (menu items, etc.)
  const pageTextAfterDots = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => "");
  console.log(`[grok-server] page text after dots click: ${pageTextAfterDots.replace(/\n/g, " | ")}`);

  // Menu has "Extend video" / "Upscale video" — match the full label
  const menuTarget = actionType === "extend" ? "extend video" : "upscale video";
  const menuClicked = await page.evaluate((target) => {
    const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], li, button, a, div')];
    for (const item of items) {
      const txt = (item.innerText?.trim() || "").toLowerCase();
      if (txt === target || txt.startsWith(target)) { item.click(); return txt; }
    }
    // Fallback: partial match
    for (const item of items) {
      const txt = (item.innerText?.trim() || "").toLowerCase();
      if (txt.includes(target.split(" ")[0])) { item.click(); return `partial:${txt}`; }
    }
    return null;
  }, menuTarget);
  console.log(`[grok-server] menu item clicked: ${menuClicked}`);
  if (!menuClicked) {
    const dbg = `/tmp/grok-${actionType}-nomenu-${Date.now()}.png`;
    await page.screenshot({ path: dbg }).catch(() => {});
    throw new Error(`"${menuTarget}" menu item not found (screenshot: ${dbg})`);
  }

  // After clicking Extend/Upscale, the chat input at the bottom shows "× Extend Video | +6s | +10s"
  // DO NOT click +6s / +10s (those change the duration slider).
  // Click the main text input area, type the prompt, then press Enter or click ▲ send button.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `/tmp/grok-${actionType}-aftermenu-${Date.now()}.png` }).catch(() => {});

  // Find the prompt input — it's the main chat bar at the bottom (now in Extend Video mode)
  const promptSelectors = [
    '[placeholder*="imagine" i]', '[placeholder*="extend" i]', '[placeholder*="continue" i]',
    '[placeholder*="describe" i]', '[placeholder*="message" i]', '[placeholder*="ask" i]',
    'textarea', '[role="textbox"]', '[contenteditable="true"]',
  ];
  let promptInput = null;
  for (const sel of promptSelectors) {
    try { promptInput = await page.waitForSelector(sel, { timeout: 3000, state: "visible" }); if (promptInput) break; } catch { promptInput = null; }
  }
  if (promptInput) {
    await promptInput.click();
    const isCE = await promptInput.evaluate(el => el.isContentEditable);
    const tag  = await promptInput.evaluate(el => el.tagName.toLowerCase());
    if (actionPrompt) {
      if (isCE && tag !== "textarea" && tag !== "input") await page.keyboard.type(actionPrompt, { delay: 15 });
      else await promptInput.fill(actionPrompt);
      await page.waitForTimeout(300);
    }
    // Click the ▲ send button if visible, otherwise press Enter
    const sendClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, [role='button']")];
      for (const b of btns) {
        const label = (b.getAttribute("aria-label") || "").toLowerCase();
        const rect  = b.getBoundingClientRect();
        // The send/submit button is at bottom-right, not a duration pill (+6s / +10s)
        const txt = (b.innerText || "").trim();
        if ((label.includes("send") || label.includes("submit") || label.includes("generate"))
            && !txt.includes("s") && rect.right > window.innerWidth - 200) {
          b.click(); return `send-btn`;
        }
      }
      return false;
    });
    if (!sendClicked) {
      await promptInput.press("Enter");
    }
    console.log(`[grok-server] ${actionType} prompt submitted: "${(actionPrompt || "(empty)").slice(0, 40)}"`);
  } else {
    console.log(`[grok-server] no prompt input — pressing Enter`);
    await page.keyboard.press("Enter");
  }

  // Snapshot current video src so waitForVideo can ignore it and wait for the NEW one
  const oldVideoSrc = await page.evaluate(() => {
    const vid = document.querySelector("video[src]");
    return vid ? vid.src : null;
  }).catch(() => null);
  console.log(`[grok-server] old video src before ${actionType}: ${oldVideoSrc}`);

  console.log(`[grok-server] ${actionType} submitted — waiting for result...`);
  await page.waitForTimeout(10000);

  // Wait for the new video (up to 3 minutes), ignoring the original video src
  const outPath = await waitForVideo(180000, oldVideoSrc);
  if (!outPath) throw new Error(`${actionType} video not generated`);
  saveCookies(await context.cookies());
  return outPath;
}

async function waitForVideo(timeoutMs, ignoreSrc = null) {
  // Normalize ignoreSrc to a Set for O(1) lookup — accepts string, array, or null
  const ignoreSet = new Set(
    Array.isArray(ignoreSrc) ? ignoreSrc : (ignoreSrc ? [ignoreSrc] : [])
  );
  const start = Date.now();
  let shotTaken = false;
  const outPath = `/tmp/grok-video-${Date.now()}.mp4`;

  console.log(`[grok-server] waiting for video generation to complete... (ignoring ${ignoreSet.size} existing srcs)`);

  // Phase 1: wait for video element to appear (signals generation complete)
  // The page shows "Generating X% | Cancel Video" while generating; when done a <video> element appears
  let videoReady = false;
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(5000);

    if (!shotTaken && Date.now() - start > 30000) {
      shotTaken = true;
      const dbg = `/tmp/grok-vidwait-${Date.now()}.png`;
      await page.screenshot({ path: dbg }).catch(() => {});
      console.log(`[grok-server] mid-video wait screenshot: ${dbg}`);
    }

    const state = await page.evaluate((skipSrcs) => {
      const t = document.body.innerText || "";
      // Check for errors
      if (t.includes("Something went wrong") || t.includes("Unable to generate") || t.includes("generation failed")) return "error";
      // Check if still generating
      if (t.includes("Generating") && t.includes("Cancel Video")) return "generating";
      // Check for user-generated video: assets.grok.com/users/... URLs only.
      // Ignore imagine-public.x.ai (gallery/template videos always on the page).
      const isUserGenerated = src =>
        src && src.includes("assets.grok.com/users/") && !skipSrcs.includes(src);
      const allVids = [...document.querySelectorAll("video[src]")];
      for (const vid of allVids) {
        if (isUserGenerated(vid.src)) return "ready";
      }
      const srcEl = document.querySelector("video source[src]");
      if (isUserGenerated(srcEl && srcEl.src)) return "ready";
      // Check if "Cancel Video" gone — generation may have completed without a video[src] yet
      if (!t.includes("Cancel Video") && !t.includes("Generating")) {
        const btns = [...document.querySelectorAll("button, a")];
        for (const b of btns) {
          const label = (b.getAttribute("aria-label") || "").toLowerCase();
          const title = (b.getAttribute("title") || "").toLowerCase();
          if (label.includes("download") || title.includes("download")) return "ready";
        }
      }
      return "waiting";
    }, [...ignoreSet]).catch(() => "waiting");

    console.log(`[grok-server] video state: ${state} (+${Math.round((Date.now() - start) / 1000)}s)`);

    if (state === "error") throw new Error("grok reported a video generation error");
    if (state === "ready") { videoReady = true; break; }
  }

  if (!videoReady) return null;

  // Phase 2: video is ready — grab the user-generated video src (assets.grok.com/users/)
  await page.waitForTimeout(1000);
  const videoSrc = await page.evaluate(() => {
    const isUserSrc = s => s && s.includes("assets.grok.com/users/");
    const allVids = [...document.querySelectorAll("video[src]")];
    for (const v of allVids) { if (isUserSrc(v.src)) return v.src; }
    const srcEl = document.querySelector("video source[src]");
    if (isUserSrc(srcEl && srcEl.src)) return srcEl.src;
    // Fallback: any http video src
    const first = document.querySelector("video[src]");
    if (first && first.src && first.src.startsWith("http")) return first.src;
    return null;
  }).catch(() => null);

  if (videoSrc) {
    console.log(`[grok-server] video src found: ${videoSrc.slice(0, 80)}... — downloading`);
    // Attempt 1: Node.js direct download (works for cross-origin public URLs like imagine-public.x.ai)
    const directOk = await new Promise(resolve => {
      const get = videoSrc.startsWith("https") ? https : http;
      const cookies = context ? context.cookies().then(cs =>
        cs.filter(c => videoSrc.includes(c.domain.replace(/^\./, ""))).map(c => `${c.name}=${c.value}`).join("; ")
      ).catch(() => "") : Promise.resolve("");
      cookies.then(cookieStr => {
        const req = get.get(videoSrc, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
            ...(cookieStr ? { "Cookie": cookieStr } : {}),
          }
        }, res => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            // follow one redirect
            const redir = res.headers.location;
            if (!redir) return resolve(false);
            const get2 = redir.startsWith("https") ? https : http;
            get2.get(redir, { headers: { "User-Agent": "Mozilla/5.0" } }, res2 => {
              if (res2.statusCode !== 200) { res2.resume(); return resolve(false); }
              const chunks = [];
              res2.on("data", c => chunks.push(c));
              res2.on("end", () => { try { fs.writeFileSync(outPath, Buffer.concat(chunks)); resolve(true); } catch { resolve(false); } });
              res2.on("error", () => resolve(false));
            }).on("error", () => resolve(false));
            return;
          }
          if (res.statusCode !== 200) { res.resume(); return resolve(false); }
          const chunks = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => { try { fs.writeFileSync(outPath, Buffer.concat(chunks)); resolve(true); } catch { resolve(false); } });
          res.on("error", () => resolve(false));
        });
        req.on("error", () => resolve(false));
      });
    });
    if (directOk) {
      const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
      console.log(`[grok-server] video saved (direct): ${outPath} (${size} bytes)`);
      if (size > 10000) return outPath;
    }

    // Attempt 2: in-page fetch (works for assets.grok.com which shares session cookies)
    const videoData = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
      } catch { return null; }
    }, videoSrc).catch(() => null);

    if (videoData) {
      fs.writeFileSync(outPath, Buffer.from(videoData, "base64"));
      const size = fs.statSync(outPath).size;
      console.log(`[grok-server] video saved (in-page fetch): ${outPath} (${size} bytes)`);
      if (size > 10000) return outPath;
    }
  }

  // Phase 3: fallback — intercept download button click
  console.log("[grok-server] no direct src — intercepting download button click");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, a")];
      for (const b of btns) {
        const label = (b.getAttribute("aria-label") || "").toLowerCase();
        const title = (b.getAttribute("title") || "").toLowerCase();
        const txt = b.innerText?.trim().toLowerCase() || "";
        if (label.includes("download") || title.includes("download") || txt === "download") {
          b.click(); return true;
        }
      }
      return false;
    }),
  ]).catch(async (e) => {
    console.log("[grok-server] download event failed:", e.message);
    return [null];
  });

  if (download) {
    await download.saveAs(outPath);
    const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    console.log(`[grok-server] video downloaded via event: ${outPath} (${size} bytes)`);
    if (size > 10000) return outPath;
  }

  const dbg = `/tmp/grok-vidwait-fail-${Date.now()}.png`;
  await page.screenshot({ path: dbg }).catch(() => {});
  console.log(`[grok-server] download failed — screenshot: ${dbg}`);
  return null;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessionReady, busy }));
    return;
  }

  if (req.method === "POST" && req.url === "/generate") {
    if (busy) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "busy — another generation is in progress" }));
      return;
    }

    let body = "";
    req.on("data", d => body += d);
    req.on("end", async () => {
      let prompt;
      try { prompt = JSON.parse(body).prompt; } catch { prompt = null; }
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing prompt" }));
        return;
      }

      busy = true;
      resetIdleTimer();
      try {
        const paths = await generate(prompt);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ paths }));
      } catch (e) {
        console.error("[grok-server] generate error:", e.message);
        // Reset session on error so next request tries fresh
        sessionReady = false;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      } finally {
        busy = false;
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/generate-video") {
    if (busy) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "busy" }));
      return;
    }
    let body = "";
    req.on("data", d => body += d);
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      const { imageBase64, videoPrompt } = parsed;
      if (!imageBase64 || !videoPrompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing imageBase64 or videoPrompt" }));
        return;
      }
      const imageBuffer = Buffer.from(imageBase64, "base64");
      busy = true;
      resetIdleTimer();
      try {
        const videoPath = await generateVideo(imageBuffer, videoPrompt);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ path: videoPath }));
      } catch (e) {
        console.error("[grok-server] video error:", e.message);
        sessionReady = false;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      } finally {
        busy = false;
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/video-action") {
    if (busy) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "busy" }));
      return;
    }
    let body = "";
    req.on("data", d => body += d);
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      const { action, prompt: actionPrompt = "" } = parsed;
      if (action !== "extend" && action !== "upscale") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "action must be extend or upscale" }));
        return;
      }
      busy = true;
      resetIdleTimer();
      try {
        const videoPath = await extendOrUpscaleVideo(action, actionPrompt);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ path: videoPath }));
      } catch (e) {
        console.error(`[grok-server] ${action} error:`, e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      } finally {
        busy = false;
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/generate-img2img") {
    if (busy) { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "busy" })); return; }
    let body = "";
    req.on("data", d => body += d);
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      const { imageBase64, prompt } = parsed;
      if (!imageBase64 || !prompt) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "missing imageBase64 or prompt" })); return; }
      const imageBuffer = Buffer.from(imageBase64, "base64");
      busy = true; resetIdleTimer();
      try {
        const result = await generateFromImage(imageBuffer, prompt, "image");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ paths: result.paths }));
      } catch (e) {
        console.error("[grok-server] img2img error:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      } finally { busy = false; }
    });
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`[grok-server] listening on http://127.0.0.1:${PORT}`);
  // Pre-warm session on startup
  try {
    await ensureSession();
    resetIdleTimer();
  } catch (e) {
    console.error("[grok-server] startup session failed:", e.message, "— will retry on first request");
    sessionReady = false;
  }
});

process.on("SIGTERM", async () => { await closeBrowser(); process.exit(0); });
process.on("SIGINT",  async () => { await closeBrowser(); process.exit(0); });
