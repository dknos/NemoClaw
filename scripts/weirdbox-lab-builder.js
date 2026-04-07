#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Weirdbox Lab Builder — Autonomous agent loop for weirdbox-lab.html
 *
 * Runs on a 20-minute cron. Agents plan + build improvements every cycle:
 *   Candy   (llama-4-maverick, vision) — screenshots the page, sets creative direction
 *   Pipes   (gemini-3.1-flash)         — team lead, reviewer, codegen fallback
 *   MaoMao  (qwen/qwen3-6b)            — primary codegen; falls back to Pipes on timeout
 *   Llama   (llama-4-maverick)         — extra improvement pass when time allows
 *
 * RULES:
 *   - ONLY writes to public/weirdbox-lab.html
 *   - NEVER touches weirdbox-game.html (production)
 *   - Brief loaded from scripts/workshop-briefs/weirdbox.md
 */

const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const { reportGenEvent, GenStatus, GenType, estimateCost } = require("./lib/gen-monitor");

// ── Env ──────────────────────────────────────────────────────────────
const envFile = path.join(os.homedir(), ".nemoclaw_env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN  || "";
const DISCORD_CHANNEL    = process.env.DISCORD_ERRORS_CHANNEL || ""; // set in .nemoclaw_env

// ── Vertex AI token ─────────────────────────────────────────────────
let _vtx = null, _vtxExp = 0;
async function getVertexToken() {
  if (_vtx && Date.now() < _vtxExp - 60000) return _vtx;
  try {
    const { GoogleAuth } = require("google-auth-library");
    const auth = new GoogleAuth({
      keyFilename: path.join(os.homedir(), ".nemoclaw/secrets/gdrive-service-account.json"),
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    const t = await client.getAccessToken();
    _vtx = t.token; _vtxExp = Date.now() + 3500000;
    return _vtx;
  } catch (e) {
    console.warn(`[weirdbox-lab] Vertex token error: ${e.message}`);
    return null;
  }
}

// ── Models ───────────────────────────────────────────────────────────
// Candy  = creative director with screenshot vision
// Pipes  = team lead + visual critic + codegen fallback
// MaoMao = primary codegen (Qwen 3.6 via OpenRouter)
// Llama  = extra improvement pass
const CANDY_MODEL  = "gemini-3.1-flash";                              // Vertex Gemini — fast + vision
const PIPES_MODEL  = "gemini-3.1-flash";                              // Vertex Gemini — full flash
const MAOMAI_MODEL = "qwen/qwen3-6b";                                 // OpenRouter
const LLAMA_MODEL  = "meta/llama-4-maverick-17b-128e-instruct-maas"; // Vertex MaaS — Llama pass

const VERTEX_PROJECT = "drivenemo";
const VERTEX_REGION  = "us-east5";

function getProvider(model) {
  if (model.startsWith("meta/llama-4-") || model.startsWith("meta/llama-3.3-")) return "vertex-maas";
  if (model.startsWith("gemini-")) return "vertex-gemini";
  return "openrouter";
}

// ── Paths ────────────────────────────────────────────────────────────
const TARGET_FILE  = path.join(os.homedir(), "netify-dev", "public", "weirdbox-lab.html");
const BRIEFS_DIR   = path.join(__dirname, "workshop-briefs");
const BRIEF_FILE   = path.join(BRIEFS_DIR, "weirdbox.md");
const STATE_FILE   = path.join(os.homedir(), "netify-dev", "public", "data", "weirdbox-lab-state.json");

// Guard: refuse to touch production file (should never reach here, but just in case)
if (process.argv.includes("weirdbox-game.html") || process.argv.includes("weirdbox.html")) {
  console.error("[weirdbox-lab] REFUSED: weirdbox-game.html is production-frozen. Exiting.");
  process.exit(1);
}

// ── CLI args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(n) { const i = args.indexOf(`--${n}`); return i >= 0 && args[i+1] ? args[i+1] : null; }
const budgetMs      = parseInt(getArg("budget") || "1080000"); // default 18 min (leaves buffer)
const triggeredBy   = getArg("user") || "cron";
const startTime     = Date.now();

// ── Load brief ───────────────────────────────────────────────────────
const brief = fs.existsSync(BRIEF_FILE) ? fs.readFileSync(BRIEF_FILE, "utf8").slice(0, 8000) : "";

// ── Load current page ────────────────────────────────────────────────
let currentHtml = fs.existsSync(TARGET_FILE) ? fs.readFileSync(TARGET_FILE, "utf8") : "";
console.log(`[weirdbox-lab] === START ===`);
console.log(`[weirdbox-lab] Current page: ${(currentHtml.length / 1024).toFixed(1)}KB`);
console.log(`[weirdbox-lab] Budget: ${(budgetMs / 60000).toFixed(0)} min | Triggered by: ${triggeredBy}`);

// ── Telemetry ────────────────────────────────────────────────────────
let totalTokens = 0, totalCost = 0;
function trackTokens(model, agent, tokens) {
  totalTokens += tokens;
  const { cost } = estimateCost(model, tokens * 0.6, tokens * 0.4);
  totalCost += cost;
  console.log(`[weirdbox-lab] ${agent} (${model.split("/").pop()}): ${tokens} tokens`);
}

// ── Time helpers ─────────────────────────────────────────────────────
const elapsed  = () => Date.now() - startTime;
const timeLeft = () => Math.max(0, budgetMs - elapsed());
const timeLeftStr = () => timeLeft() > 60000 ? `${(timeLeft()/60000).toFixed(0)}m` : `${(timeLeft()/1000).toFixed(0)}s`;
const getScope = () => { const w = timeLeft()/budgetMs; return w > 0.5 ? "structural" : w > 0.2 ? "refinement" : "polish"; };
const sleep    = (ms) => new Promise(r => setTimeout(r, ms));

// ── Screenshot via Playwright ─────────────────────────────────────────
async function takeScreenshot() {
  try {
    const { chromium } = require("/home/nemoclaw/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
    const CHROMIUM = "/home/nemoclaw/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome";
    const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const fileUrl = `file://${TARGET_FILE}`;
    await page.goto(fileUrl, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    await sleep(2000); // let animations settle
    const buf = await page.screenshot({ type: "png", fullPage: false });
    await browser.close();
    return buf.toString("base64");
  } catch (e) {
    console.warn(`[weirdbox-lab] Screenshot failed: ${e.message}`);
    return null;
  }
}

// ── LLM call ─────────────────────────────────────────────────────────
async function _callOnce({ model, systemPrompt, userPrompt, maxTokens = 4000, temperature = 0.5, imageBase64 = null }) {
  const provider = getProvider(model);

  // ── Vertex Gemini ──
  if (provider === "vertex-gemini") {
    const token = await getVertexToken();
    if (!token) return { text: "", tokens: 0, durationMs: 0, statusCode: 401 };
    const userParts = [{ text: userPrompt }];
    if (imageBase64) userParts.push({ inlineData: { mimeType: "image/png", data: imageBase64 } });
    const body = JSON.stringify({
      contents: [{ role: "user", parts: userParts }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: Math.max(maxTokens, 4000), temperature },
    });
    return new Promise((resolve) => {
      const t0 = Date.now();
      const req = https.request({
        hostname: "aiplatform.googleapis.com",
        path: `/v1/projects/${VERTEX_PROJECT}/locations/global/publishers/google/models/${model}:generateContent`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${token}` },
      }, (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          const durationMs = Date.now() - t0;
          try {
            const json = JSON.parse(data);
            const parts = json.candidates?.[0]?.content?.parts || [];
            const text = parts.filter(p => p.text).map(p => p.text).join("").trim() || "";
            const usage = json.usageMetadata || {};
            const tokens = (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0);
            if (!text) console.warn(`[weirdbox-lab] Gemini empty, finish=${json.candidates?.[0]?.finishReason}, status=${res.statusCode}`);
            resolve({ text, tokens, durationMs, statusCode: res.statusCode });
          } catch (e) {
            console.warn(`[weirdbox-lab] Gemini parse error: ${e.message}`);
            resolve({ text: "", tokens: 0, durationMs, statusCode: res.statusCode });
          }
        });
      });
      req.on("error", e => { console.warn(`[weirdbox-lab] Gemini error: ${e.message}`); resolve({ text: "", tokens: 0, durationMs: 0, statusCode: 0 }); });
      req.setTimeout(240000, () => { req.destroy(); resolve({ text: "", tokens: 0, durationMs: 240000, statusCode: 0 }); });
      req.end(body);
    });
  }

  // ── Vertex MaaS + OpenRouter (OpenAI-compatible) ──
  const token = provider === "vertex-maas" ? await getVertexToken() : null;
  if (provider === "vertex-maas" && !token) return { text: "", tokens: 0, durationMs: 0, statusCode: 401 };

  // Build user content — supports image for multimodal models
  let userContent;
  if (imageBase64 && (provider === "vertex-maas" || provider === "openrouter")) {
    userContent = [
      { type: "text",      text: userPrompt },
      { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
    ];
  } else {
    userContent = userPrompt;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userContent },
  ];
  const payload = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false });

  const reqOpts = provider === "vertex-maas"
    ? { hostname: `${VERTEX_REGION}-aiplatform.googleapis.com`,
        path: `/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/endpoints/openapi/chat/completions`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${token}` } }
    : { hostname: "openrouter.ai",
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${OPENROUTER_API_KEY}` } };

  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request(reqOpts, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        const durationMs = Date.now() - t0;
        try {
          const json = JSON.parse(data);
          const text = json.choices?.[0]?.message?.content?.trim() || "";
          const tokens = json.usage?.total_tokens || 0;
          if (!text) console.warn(`[weirdbox-lab] empty from ${model} (${provider}), status=${res.statusCode}, body=${data.slice(0,300)}`);
          resolve({ text, tokens, durationMs, statusCode: res.statusCode });
        } catch (e) {
          console.warn(`[weirdbox-lab] parse error from ${model}: ${e.message}`);
          resolve({ text: "", tokens: 0, durationMs, statusCode: res.statusCode });
        }
      });
    });
    req.on("error", e => { console.warn(`[weirdbox-lab] request error: ${e.message}`); resolve({ text: "", tokens: 0, durationMs: 0, statusCode: 0 }); });
    req.setTimeout(240000, () => { req.destroy(); console.warn(`[weirdbox-lab] timeout: ${model}`); resolve({ text: "", tokens: 0, durationMs: 240000, statusCode: 0 }); });
    req.end(payload);
  });
}

async function callLLM(opts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await _callOnce(opts);
    if (result.text) return result;
    if (result.statusCode === 429 || result.statusCode === 0) {
      const delay = (attempt + 1) * 15000;
      console.log(`[weirdbox-lab] retry ${attempt+1}/3 for ${opts.model} after ${delay/1000}s`);
      await sleep(delay);
      continue;
    }
    break;
  }
  return { text: "", tokens: 0, durationMs: 0, statusCode: 0 };
}

// Qwen codegen with Pipes fallback on timeout/failure
async function codegenWithFallback(opts) {
  console.log(`[weirdbox-lab] Codegen: trying Qwen...`);
  const result = await callLLM({ ...opts, model: MAOMAI_MODEL });
  if (result.text) {
    trackTokens(MAOMAI_MODEL, "MaoMao", result.tokens);
    return result;
  }
  console.warn(`[weirdbox-lab] Qwen failed/timed out — falling back to Pipes (Gemini)`);
  const fallback = await callLLM({ ...opts, model: PIPES_MODEL, imageBase64: null }); // no image for codegen
  trackTokens(PIPES_MODEL, "Pipes[codegen]", fallback.tokens);
  return fallback;
}

// ── HTML helpers ─────────────────────────────────────────────────────
function extractHtml(text) {
  const doc = text.match(/<!DOCTYPE\s+html[\s\S]*<\/html>/i);
  if (doc) return doc[0];
  const html = text.match(/<html[\s\S]*<\/html>/i);
  if (html) return html[0];
  const fenced = text.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
  if (fenced) return extractHtml(fenced[1]);
  return null;
}

function isValidHtml(html) {
  return !!(html && html.length > 200 && /<html/i.test(html) && /<body/i.test(html));
}

function summarizeHtml(html) {
  if (!html) return "empty";
  const headings = [...html.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi)].map(m => m[1].replace(/<[^>]+>/g,"")).slice(0,5);
  const colors   = [...new Set([...html.matchAll(/#[0-9a-fA-F]{3,8}/g)].map(m => m[0]))].slice(0,5);
  return `${(html.length/1024).toFixed(1)}KB | ${headings.join(", ")||"no headings"} | colors: ${colors.join(", ")||"none"}`;
}

// Apply SEARCH/REPLACE diff blocks to HTML
function applyDiff(base, diffText) {
  const blocks = [...diffText.matchAll(/<<<SEARCH\n([\s\S]*?)>>>REPLACE\n([\s\S]*?)<<<END/g)];
  if (!blocks.length) return null;
  let patched = base;
  let count = 0;
  for (const [, search, replace] of blocks) {
    const s = search.trim(), r = replace.trim();
    if (s && patched.includes(s)) { patched = patched.replace(s, r); count++; }
  }
  return count > 0 && isValidHtml(patched) ? patched : null;
}

// ── Agent souls ──────────────────────────────────────────────────────
const CANDY_SOUL = `You are Candy — creative director for WEIRDBOX. You look at screenshots and HTML to give sharp, specific visual direction. You have strong taste and see exactly what needs to change. Brief responses. No fluff.`;

const PIPES_SOUL = `You are Pipes — senior engineer and visual perfectionist for WEIRDBOX. You review HTML pages for code bugs, design quality, UX, animation polish, and "wow factor." You're exact: name CSS properties, hex values, easing curves, pixel values.

Return EXACTLY a JSON array (max 5 issues):
[{"priority":1-5,"type":"bug"|"design"|"ux"|"animation","description":"what's wrong","fix":"exact specific fix"}]
Return ONLY the JSON array.`;

const CODEGEN_SOUL = `You are MaoMao — fast coder for WEIRDBOX. You apply exactly the changes you're given.

For pages <20KB: Output the COMPLETE HTML from <!DOCTYPE html> to </html>.
For pages >20KB: Output ONLY changed sections as SEARCH/REPLACE blocks:
<<<SEARCH
exact code to find
>>>REPLACE
replacement code
<<<END

Rules: apply requested changes precisely. Preserve everything else. Use modern CSS (grid, flexbox, custom properties, transitions). Multiple changes = multiple blocks.`;

// ── Write output ─────────────────────────────────────────────────────
function writeLabFile(html) {
  if (!isValidHtml(html)) { console.warn("[weirdbox-lab] Refusing to write invalid HTML"); return false; }
  // Safety check — triple confirm we're not overwriting production
  if (!TARGET_FILE.includes("weirdbox-lab")) {
    console.error("[weirdbox-lab] SAFETY: target path doesn't contain 'weirdbox-lab' — refusing write");
    return false;
  }
  fs.writeFileSync(TARGET_FILE, html, "utf8");
  console.log(`[weirdbox-lab] Wrote ${(html.length/1024).toFixed(1)}KB to weirdbox-lab.html`);
  return true;
}

// ── Discord notify ────────────────────────────────────────────────────
function notifyDiscord(msg) {
  if (!DISCORD_BOT_TOKEN) return;
  const body = JSON.stringify({ content: msg });
  const req = https.request({
    hostname: "discord.com", path: `/api/v10/channels/${DISCORD_CHANNEL}/messages`,
    method: "POST",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, res => res.resume());
  req.on("error", () => { /* ignored */ });
  req.end(body);
}

// ── Main build loop ──────────────────────────────────────────────────
// eslint-disable-next-line complexity
async function build() {
  let consecutiveFailures = 0;
  let iterNum = 0;

  notifyDiscord(`**[weirdbox-lab-builder]** Starting ${(budgetMs/60000).toFixed(0)}-min build cycle (triggered by: ${triggeredBy})`);

  // Phase 1: Candy vision — screenshot + direction
  console.log("[weirdbox-lab] Phase 1: Candy vision (screenshot)");
  const screenshot = await takeScreenshot();
  if (screenshot) {
    console.log(`[weirdbox-lab] Screenshot: ${(screenshot.length/1024).toFixed(0)}KB base64`);
  } else {
    console.warn("[weirdbox-lab] No screenshot — Candy will work from HTML only");
  }

  const candyVisionPrompt = screenshot
    ? `You're looking at the current state of WEIRDBOX Lab. Here's the screenshot of the page.\n\nCurrent HTML size: ${(currentHtml.length/1024).toFixed(1)}KB\nTime budget: ${(budgetMs/60000).toFixed(0)} minutes\n\n${brief ? `BRIEF:\n${brief.slice(0,3000)}\n\n` : ""}What are the top 3 most impactful improvements to make? Be specific — name colors, animations, layout changes. Focus on visual impact.`
    : `Review this WEIRDBOX Lab page and give 3 specific improvement directions.\n\nHTML summary: ${summarizeHtml(currentHtml)}\nBudget: ${(budgetMs/60000).toFixed(0)} min\n\n${brief ? `BRIEF:\n${brief.slice(0,3000)}\n\n` : ""}What needs to change? Name exact CSS properties, animations, colors.`;

  const vision = await callLLM({
    model: CANDY_MODEL, systemPrompt: CANDY_SOUL,
    userPrompt: candyVisionPrompt,
    imageBase64: screenshot,
    maxTokens: 800, temperature: 0.85, _agent: "Candy",
  });
  trackTokens(CANDY_MODEL, "Candy", vision.tokens);
  if (vision.text) {
    console.log(`[weirdbox-lab] Candy direction: ${vision.text.slice(0,120)}...`);
  } else {
    console.warn("[weirdbox-lab] Candy returned nothing — continuing without direction");
  }

  // Phase 2: if no current HTML, generate from scratch
  if (!isValidHtml(currentHtml)) {
    console.log("[weirdbox-lab] No valid current HTML — generating from scratch");
    const genPrompt = `Build a complete WEIRDBOX game page based on the brief and Candy's direction.

CANDY'S DIRECTION:
${vision.text || "Build a visually striking, playful WEIRDBOX game page."}

${brief ? `BRIEF:\n${brief.slice(0,6000)}\n` : ""}

Output a COMPLETE, visually stunning single-file HTML page. All CSS in <style>, all JS in <script>. Use Google Fonts and Font Awesome CDN. Responsive. Smooth CSS animations. Make it impressive.`;

    const genResult = await codegenWithFallback({
      systemPrompt: CODEGEN_SOUL, userPrompt: genPrompt,
      maxTokens: 16384, temperature: 0.4, _agent: "MaoMao",
    });
    const genHtml = extractHtml(genResult.text);
    if (isValidHtml(genHtml)) {
      currentHtml = genHtml;
      writeLabFile(currentHtml);
    } else {
      notifyDiscord("**[weirdbox-lab-builder]** ❌ Initial generation failed. Exiting.");
      return;
    }
  }

  // Phase 3+: Improvement loop
  console.log("[weirdbox-lab] Phase 3: Improvement loop");

  while (timeLeft() > budgetMs * 0.08) {
    iterNum++;
    const scope = getScope();
    console.log(`[weirdbox-lab] --- Iteration ${iterNum} (${scope}, ${timeLeftStr()} left) ---`);

    // 3a. Pipes review
    const reviewHtml = currentHtml.length > 6000
      ? currentHtml.slice(0, 3000) + "\n\n<!-- ...middle truncated... -->\n\n" + currentHtml.slice(-3000)
      : currentHtml;

    const [review, candyDir] = await Promise.all([
      // Pipes always reviews
      callLLM({
        model: PIPES_MODEL, systemPrompt: PIPES_SOUL,
        userPrompt: `Review this WEIRDBOX Lab page. Scope: ${scope}. Time left: ${timeLeftStr()}.\nSummary: ${summarizeHtml(currentHtml)}\n\nHTML:\n${reviewHtml}`,
        maxTokens: 600, temperature: 0.15, _agent: "Pipes",
      }),
      // Candy direction every other iteration (with screenshot if available)
      iterNum % 2 === 0
        ? callLLM({
            model: CANDY_MODEL, systemPrompt: CANDY_SOUL,
            userPrompt: `WEIRDBOX Lab — scope: ${scope}, ${timeLeftStr()} left.\nSummary: ${summarizeHtml(currentHtml)}\n\n${vision.text ? `Original direction: ${vision.text.slice(0,200)}\n\n` : ""}Suggest ONE specific ${scope === "polish" ? "polish" : "enhancement"}.`,
            maxTokens: 300, temperature: 0.8, _agent: "Candy",
          })
        : Promise.resolve(null),
    ]);

    trackTokens(PIPES_MODEL, "Pipes", review.tokens);
    if (candyDir) trackTokens(CANDY_MODEL, "Candy", candyDir.tokens);

    let issues = [];
    try {
      const m = review.text?.match(/\[[\s\S]*\]/);
      if (m) issues = JSON.parse(m[0]);
    } catch { if (review.text) issues = [{ description: review.text.slice(0,300), fix: "See description" }]; }

    if (timeLeft() < budgetMs * 0.08) break;

    // 3b. Build change summary
    let changes = "";
    if (issues.length) changes += `PIPES REVIEW — fix these:\n${issues.map(i => `- [${i.type||"issue"}] ${i.description}: ${i.fix}`).join("\n")}\n\n`;
    if (candyDir?.text) changes += `CANDY DIRECTION:\n${candyDir.text}\n\n`;
    if (!changes) changes = `Improve the page. Scope: ${scope}. Add visual polish, content depth, or interactivity.`;

    // Context window: 32KB input sweet spot for large pages
    const MAX_INPUT = 32000;
    let codegenHtml = currentHtml;
    if (codegenHtml.length > MAX_INPUT) {
      const half = Math.floor(MAX_INPUT / 2);
      codegenHtml = codegenHtml.slice(0, half)
        + "\n\n<!-- ═══ MIDDLE OMITTED — preserve all code between markers ═══ -->\n\n"
        + codegenHtml.slice(-half);
    }

    // 3c. Codegen (Qwen → Pipes fallback)
    const applyResult = await codegenWithFallback({
      systemPrompt: CODEGEN_SOUL,
      userPrompt: `Apply these changes to the WEIRDBOX Lab page.

CHANGES:
${changes}

SCOPE: ${scope} | TIME LEFT: ${timeLeftStr()}

CURRENT HTML (${currentHtml.length > 20000 ? "TRUNCATED — use SEARCH/REPLACE" : "output complete updated HTML"}):
${codegenHtml}

${currentHtml.length > 20000
  ? "Page is large. Use SEARCH/REPLACE blocks:\n<<<SEARCH\nexact code\n>>>REPLACE\nnew code\n<<<END"
  : "Output the COMPLETE updated HTML from <!DOCTYPE html> to </html>."}`,
      maxTokens: 16384, temperature: 0.35,
    });

    // Try diff mode first (large pages)
    let updated = false;
    if (currentHtml.length > 20000 && applyResult.text?.includes("<<<SEARCH")) {
      const patched = applyDiff(currentHtml, applyResult.text);
      if (patched) {
        currentHtml = patched;
        writeLabFile(currentHtml);
        console.log(`[weirdbox-lab] DIFF: patched. Size: ${(currentHtml.length/1024).toFixed(1)}KB`);
        updated = true;
        consecutiveFailures = 0;
      }
    }

    if (!updated) {
      const newHtml = extractHtml(applyResult.text);
      if (isValidHtml(newHtml) && newHtml.length > currentHtml.length * 0.5) {
        currentHtml = newHtml;
        writeLabFile(currentHtml);
        console.log(`[weirdbox-lab] FULL: updated. Size: ${(currentHtml.length/1024).toFixed(1)}KB`);
        consecutiveFailures = 0;
      } else {
        console.warn(`[weirdbox-lab] Rejected — kept current ${(currentHtml.length/1024).toFixed(1)}KB`);
        consecutiveFailures++;
      }
    }

    // 3d. Extra Llama pass when time allows + every 3rd iter
    if (iterNum % 3 === 0 && timeLeft() > budgetMs * 0.3) {
      console.log("[weirdbox-lab] Llama improvement pass");
      const llamaResult = await callLLM({
        model: LLAMA_MODEL, systemPrompt: CODEGEN_SOUL,
        userPrompt: `Polish this WEIRDBOX Lab page. Improve typography, spacing, animations, and micro-interactions. Preserve all functionality. ${currentHtml.length > 20000 ? "Use SEARCH/REPLACE blocks for changes." : "Output the complete updated HTML."}\n\nCurrent HTML:\n${codegenHtml}`,
        maxTokens: 16384, temperature: 0.3, _agent: "Llama",
      });
      trackTokens(LLAMA_MODEL, "Llama", llamaResult.tokens);
      if (currentHtml.length > 20000 && llamaResult.text?.includes("<<<SEARCH")) {
        const patched = applyDiff(currentHtml, llamaResult.text);
        if (patched) { currentHtml = patched; writeLabFile(currentHtml); console.log("[weirdbox-lab] Llama patch applied"); }
      } else {
        const llamaHtml = extractHtml(llamaResult.text);
        if (isValidHtml(llamaHtml) && llamaHtml.length > currentHtml.length * 0.6) {
          currentHtml = llamaHtml;
          writeLabFile(currentHtml);
          console.log("[weirdbox-lab] Llama full update applied");
        }
      }
    }

    // Guardrails
    if (consecutiveFailures >= 3) { console.warn("[weirdbox-lab] 3 failures in a row — stopping early"); break; }
    if (totalTokens > 400000)     { console.warn("[weirdbox-lab] Token budget hit — stopping"); break; }

    // Midpoint Discord update
    if (iterNum === 3) {
      notifyDiscord(`**[weirdbox-lab-builder]** Midpoint — iter ${iterNum}, ${timeLeftStr()} left, ${(currentHtml.length/1024).toFixed(1)}KB, $${totalCost.toFixed(4)} spent`);
    }
  }

  // ── Finalize ─────────────────────────────────────────────────────
  const duration = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`[weirdbox-lab] === DONE === ${duration}min | ${iterNum} iters | ${(currentHtml.length/1024).toFixed(1)}KB | ${totalTokens} tokens | $${totalCost.toFixed(4)}`);

  reportGenEvent({
    type: GenType.WORKSHOP_BUILD, status: GenStatus.SUCCESS,
    durationMs: Date.now() - startTime, totalTokens,
    context: { target: "weirdbox-lab", iterations: iterNum, htmlSize: currentHtml.length, costUsd: totalCost },
  });

  // Save state
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRun: new Date().toISOString(), iterations: iterNum, htmlSize: currentHtml.length, totalTokens, totalCost, duration }, null, 2));
  } catch (e) { console.warn(`[weirdbox-lab] State save failed: ${e.message}`); }

  notifyDiscord(`**[weirdbox-lab-builder]** ✅ Done — ${duration}min, ${iterNum} iterations, ${(currentHtml.length/1024).toFixed(1)}KB, $${totalCost.toFixed(4)}`);
}

build().catch(e => {
  console.error(`[weirdbox-lab] Fatal: ${e.message}`);
  notifyDiscord(`**[weirdbox-lab-builder]** ❌ Fatal error: ${e.message.slice(0,200)}`);
  process.exit(1);
});
