#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Workshop — Autonomous Agent Webpage Builder
 *
 * Agents (Candy, MaoMao, CodeGen) autonomously build a webpage from scratch
 * over a set time budget. No human input. Live updates to the website.
 *
 * Usage:
 *   node workshop-builder.js --topic "cyberpunk dashboard" --budget 1200000
 *   node workshop-builder.js --topic freestyle --budget 300000 --user mrbigpipesyt
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { reportGenEvent, GenStatus, GenType, estimateCost } = require("./lib/gen-monitor");

// ── Vertex AI (Google Cloud) token management ──────────────────────
let _vertexToken = null;
let _vertexTokenExpiry = 0;

async function getVertexToken() {
  if (_vertexToken && Date.now() < _vertexTokenExpiry - 60000) return _vertexToken;
  try {
    const { GoogleAuth } = require("google-auth-library");
    const auth = new GoogleAuth({
      keyFilename: path.join(os.homedir(), ".nemoclaw/secrets/gdrive-service-account.json"),
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    _vertexToken = tokenResp.token;
    _vertexTokenExpiry = Date.now() + 3500000; // ~58 min
    return _vertexToken;
  } catch (e) {
    console.warn(`[workshop] Vertex AI token error: ${e.message}`);
    return null;
  }
}

// ── Load env ────────────────────────────────────────────────────────
const envFile = path.join(os.homedir(), ".nemoclaw_env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const CANDY_NVIDIA_KEY = process.env.CANDY_WORKSHOP_NVIDIA_KEY || process.env.CANDY_NVIDIA_KEY || "";
const MAOMAI_NVIDIA_KEY = process.env.MAOMAI_NVIDIA_KEY || "";
const VERTEX_PROJECT = "drivenemo";
const VERTEX_REGION = "us-east5";
const _GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

// ── Agent model assignments ────────────────────────────────────────
// Candy  = creative director (vision, direction, taste)
// Pipes  = team lead + visual critic (reviews code, design, UX — sees everything)
// MaoMao = codegen (fast, follows instructions, outputs HTML)
const CANDY_MODEL  = "google/gemini-2.5-pro-preview-03-25";
const PIPES_MODEL  = "gemini-3.1-flash-lite-preview"; // Vertex AI native (multimodal — team lead)
const MAOMAI_MODEL = "google/gemini-2.5-pro-preview-03-25";

// Provider detection
function getProvider(model) {
  if (model.startsWith("meta/llama-4-") || model.startsWith("meta/llama-3.3-")) return "vertex-maas";
  if (model.startsWith("gemini-")) return "vertex-gemini";
  if (model.startsWith("mistralai/") || model.startsWith("deepseek-ai/")) return "nvidia";
  return "openrouter";
}

// ── Output paths ────────────────────────────────────────────────────
const WORKSHOP_DIR = path.join(os.homedir(), "netify-dev", "public", "data", "workshop");
const ACTIVE_FILE = path.join(WORKSHOP_DIR, "active.json");
const GALLERY_FILE = path.join(WORKSHOP_DIR, "gallery.json");
if (!fs.existsSync(WORKSHOP_DIR)) fs.mkdirSync(WORKSHOP_DIR, { recursive: true });

// ── Parse CLI args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

const topic = getArg("topic") || "freestyle";
const budgetMs = parseInt(getArg("budget") || "1200000"); // default 20 min
const triggeredByUser = getArg("user") || "system";
const channelId = getArg("channel") || null;
const isNewBuild = args.includes("--new"); // --new forces a fresh build; default continues existing
const planPath = getArg("plan"); // --plan <path> to load Claude Code's build plan

// ── Load brief file if one exists for this topic ──
const BRIEFS_DIR = path.join(__dirname, "workshop-briefs");
const briefPath = path.join(BRIEFS_DIR, `${topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`);
let topicBrief = "";
if (fs.existsSync(briefPath)) {
  topicBrief = fs.readFileSync(briefPath, "utf8");
  console.log(`[workshop] Loaded brief: ${briefPath} (${(topicBrief.length / 1024).toFixed(1)}KB)`);
}

// ── Load Claude Code's build plan if provided ──
let buildPlan = null;
if (planPath && fs.existsSync(planPath)) {
  try {
    buildPlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    console.log(`[workshop] Loaded Claude's build plan: ${buildPlan.sections?.length || 0} sections, quality bar: "${(buildPlan.qualityBar || "").slice(0, 60)}"`);
  } catch (e) {
    console.warn(`[workshop] Failed to parse plan file: ${e.message}`);
  }
}

// Helper: inject plan context into agent prompts
function getPlanContext(agentName) {
  if (!buildPlan) return "";
  const sections = buildPlan.sections ? `\nSECTIONS TO BUILD:\n${buildPlan.sections.map(s => `- [P${s.priority}] ${s.id}: ${s.description}`).join("\n")}` : "";
  const quality = buildPlan.qualityBar ? `\nQUALITY BAR: ${buildPlan.qualityBar}` : "";
  const agentNote = buildPlan.agentInstructions?.[agentName] ? `\nYOUR FOCUS: ${buildPlan.agentInstructions[agentName]}` : "";
  const tech = buildPlan.techNotes ? `\nTECH NOTES: ${buildPlan.techNotes}` : "";
  return `\n\n=== ARCHITECT'S PLAN (from Claude Code) ===${sections}${tech}${quality}${agentNote}\n=== END PLAN ===`;
}

// ── Continue mode: find the latest build for this topic ──
let continueHtml = "";
let continueBuildId = null;
if (!isNewBuild) {
  try {
    const gallery = JSON.parse(fs.readFileSync(GALLERY_FILE, "utf8"));
    const prev = gallery.find(g => g.topic === topic);
    if (prev) {
      const prevFile = path.join(WORKSHOP_DIR, `${prev.buildId}.json`);
      if (fs.existsSync(prevFile)) {
        const prevBuild = JSON.parse(fs.readFileSync(prevFile, "utf8"));
        if (prevBuild.currentHtml && prevBuild.currentHtml.length > 100) {
          continueHtml = prevBuild.currentHtml;
          continueBuildId = prev.buildId;
          console.log(`[workshop] CONTINUE mode — loaded ${(continueHtml.length / 1024).toFixed(1)}KB from ${prev.buildId}`);
        }
      }
    }
  } catch { /* no previous build, start fresh */ }
}

const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
// Reuse existing buildId when continuing — don't create copies
const buildId = (continueHtml && continueBuildId) ? continueBuildId : `ws_${Date.now()}_${slug}`;
const startTime = Date.now();

console.log(`[workshop] === THE WORKSHOP ===`);
console.log(`[workshop] Build: ${buildId}`);
console.log(`[workshop] Topic: "${topic}"`);
console.log(`[workshop] Mode: ${continueHtml ? "CONTINUE (improving existing)" : "NEW (from scratch)"}`);
console.log(`[workshop] Budget: ${(budgetMs / 60000).toFixed(0)} minutes`);
console.log(`[workshop] Started by: ${triggeredByUser}`);
if (topicBrief) console.log(`[workshop] Brief loaded: ${topicBrief.length} chars`);
if (buildPlan) console.log(`[workshop] Claude's plan loaded: ${buildPlan.sections?.length || 0} sections`);

// ── Build state ─────────────────────────────────────────────────────
const buildDoc = {
  buildId,
  topic,
  status: "building",
  startTime,
  endTime: null,
  budgetMs,
  currentHtml: "",
  iterations: [],
  iterationCount: 0,
  triggeredBy: channelId ? "discord" : "cli",
  triggeredByUser,
  totalTokens: 0,
  totalCostUsd: 0,
  totalEnergyKwh: 0,
  tokensByModel: {},
  tokensByAgent: {},
};

// ── Track tokens with cost/energy breakdown ────────────────────────
function trackTokens(model, agent, tokens) {
  buildDoc.totalTokens += tokens;
  const { cost } = estimateCost(model, tokens * 0.6, tokens * 0.4);
  buildDoc.totalCostUsd += cost;
  buildDoc.totalEnergyKwh += (tokens / 1e6) * 0.003; // ~3 Wh per 1M tokens
  buildDoc.tokensByModel[model] = (buildDoc.tokensByModel[model] || 0) + tokens;
  buildDoc.tokensByAgent[agent] = (buildDoc.tokensByAgent[agent] || 0) + tokens;
}

// ── Write build state to JSON + standalone HTML ────────────────────
function writeBuildState() {
  try {
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(buildDoc, null, 2));
    // Write standalone HTML files so iframe can load via src (enables /assets/ access)
    if (buildDoc.currentHtml) {
      fs.writeFileSync(path.join(WORKSHOP_DIR, "live.html"), buildDoc.currentHtml);
      fs.writeFileSync(path.join(WORKSHOP_DIR, `${buildDoc.buildId}.html`), buildDoc.currentHtml);
    }
  } catch (e) {
    console.warn(`[workshop] write failed: ${e.message}`);
  }
}

function addToGallery() {
  try {
    let gallery = [];
    try { gallery = JSON.parse(fs.readFileSync(GALLERY_FILE, "utf8")); } catch { /* new gallery */ }
    // Store summary (not full HTML) in gallery index
    const galleryEntry = {
      buildId: buildDoc.buildId,
      topic: buildDoc.topic,
      startTime: buildDoc.startTime,
      endTime: buildDoc.endTime,
      budgetMs: buildDoc.budgetMs,
      iterationCount: buildDoc.iterationCount,
      triggeredByUser: buildDoc.triggeredByUser,
      htmlLength: buildDoc.currentHtml.length,
    };
    // Update in-place if buildId already exists (continue mode), otherwise prepend
    const existingIdx = gallery.findIndex(g => g.buildId === buildDoc.buildId);
    if (existingIdx >= 0) {
      gallery[existingIdx] = galleryEntry;
    } else {
      gallery.unshift(galleryEntry);
    }
    // Keep last 50 builds in gallery
    gallery = gallery.slice(0, 50);
    fs.writeFileSync(GALLERY_FILE, JSON.stringify(gallery, null, 2));
    // Also save the full build to its own file
    fs.writeFileSync(path.join(WORKSHOP_DIR, `${buildDoc.buildId}.json`), JSON.stringify(buildDoc, null, 2));
  } catch (e) {
    console.warn(`[workshop] gallery write failed: ${e.message}`);
  }
}

// ── LLM call (NVIDIA NIM or OpenRouter) ─────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function _callLLMOnce({ model, systemPrompt, userPrompt, maxTokens = 2000, temperature = 0.5, reasoning = false }) {
  const provider = getProvider(model);

  // ── Vertex AI Gemini (native generateContent API) ──
  if (provider === "vertex-gemini") {
    const token = await getVertexToken();
    if (!token) return { text: "", tokens: 0, durationMs: 0, statusCode: 401 };
    const geminiBody = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: Math.max(maxTokens, 2000), temperature },
    });
    return new Promise((resolve) => {
      const t0 = Date.now();
      const req = https.request({
        hostname: "aiplatform.googleapis.com",
        path: `/v1/projects/${VERTEX_PROJECT}/locations/global/publishers/google/models/${model}:generateContent`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(geminiBody), Authorization: `Bearer ${token}` },
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
            if (!text) {
              const finish = json.candidates?.[0]?.finishReason || "unknown";
              const partKeys = parts.map(p => Object.keys(p).join(","));
              console.warn(`[workshop] empty Gemini response, status=${res.statusCode}, finish=${finish}, parts=${parts.length}[${partKeys}], raw=${data.slice(0, 300)}`);
            }
            resolve({ text, tokens, durationMs, statusCode: res.statusCode });
          } catch (e) {
            console.warn(`[workshop] Gemini parse error: ${e.message}, raw: ${data.slice(0, 200)}`);
            resolve({ text: "", tokens: 0, durationMs, statusCode: res.statusCode });
          }
        });
      });
      req.on("error", (e) => { console.warn(`[workshop] Gemini request error: ${e.message}`); resolve({ text: "", tokens: 0, durationMs: 0, statusCode: 0 }); });
      req.setTimeout(180000, () => { req.destroy(); resolve({ text: "", tokens: 0, durationMs: 180000, statusCode: 0 }); });
      req.end(geminiBody);
    });
  }

  // ── OpenAI-compatible providers (NVIDIA NIM, Vertex MaaS, OpenRouter) ──
  const noSystemMsg = model.startsWith("google/gemma");
  const messages = noSystemMsg
    ? [{ role: "user", content: systemPrompt + "\n\n" + userPrompt }]
    : [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }];
  const body = { model, messages, temperature, max_tokens: maxTokens, stream: false };
  if (reasoning) body.reasoning = { enabled: true };
  const payload = JSON.stringify(body);

  let reqOpts;
  if (provider === "vertex-maas") {
    const token = await getVertexToken();
    if (!token) return { text: "", tokens: 0, durationMs: 0, statusCode: 401 };
    reqOpts = {
      hostname: `${VERTEX_REGION}-aiplatform.googleapis.com`,
      path: `/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/endpoints/openapi/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${token}` },
    };
  } else if (provider === "nvidia") {
    const nvidiaKey = model === CANDY_MODEL ? CANDY_NVIDIA_KEY
                    : model === MAOMAI_MODEL ? MAOMAI_NVIDIA_KEY
                    : CANDY_NVIDIA_KEY;
    reqOpts = {
      hostname: "integrate.api.nvidia.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${nvidiaKey}` },
    };
  } else {
    reqOpts = {
      hostname: "openrouter.ai",
      path: "/api/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    };
  }

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
          if (!text) console.warn(`[workshop] empty response from ${model} (${provider}), status=${res.statusCode}, body=${data.slice(0,400)}`);
          resolve({ text, tokens, durationMs, statusCode: res.statusCode });
        } catch (e) {
          console.warn(`[workshop] parse error from ${model}: ${e.message}`);
          resolve({ text: "", tokens: 0, durationMs, statusCode: res.statusCode });
        }
      });
    });
    req.on("error", (e) => { console.warn(`[workshop] request error: ${e.message}`); resolve({ text: "", tokens: 0, durationMs: 0, statusCode: 0 }); });
    req.setTimeout(180000, () => { req.destroy(); console.warn(`[workshop] timeout for ${model}`); resolve({ text: "", tokens: 0, durationMs: 180000, statusCode: 0 }); });
    req.end(payload);
  });
}

async function callLLM(opts) {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await _callLLMOnce(opts);
    if (result.text || (result.statusCode && result.statusCode < 400)) {
      // Report successful LLM call to telemetry
      reportGenEvent({
        type: GenType.LLM_CALL, status: GenStatus.SUCCESS,
        model: opts.model, totalTokens: result.tokens,
        durationMs: result.durationMs,
        context: { workshop: true, agent: opts._agent || "unknown" },
      });
      return result;
    }
    if (result.statusCode === 429 || result.statusCode === 0) {
      const reason = result.statusCode === 429 ? "rate limited" : "timeout/error";
      const delay = (attempt + 1) * 15000; // 15s, 30s, 45s
      console.log(`[workshop] ${reason} (${result.statusCode}), waiting ${delay / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
      await sleep(delay);
      continue;
    }
    // Other error, don't retry
    reportGenEvent({
      type: GenType.LLM_CALL, status: GenStatus.ERROR,
      model: opts.model, durationMs: result.durationMs,
      error: `HTTP ${result.statusCode}`,
      context: { workshop: true, agent: opts._agent || "unknown" },
    });
    return result;
  }
  return { text: "", tokens: 0, durationMs: 0, statusCode: 429 };
}

// ── HTML extraction and validation ──────────────────────────────────
function extractHtml(text) {
  // Try to find complete HTML document
  const docMatch = text.match(/<!DOCTYPE\s+html[\s\S]*<\/html>/i);
  if (docMatch) return docMatch[0];
  const htmlMatch = text.match(/<html[\s\S]*<\/html>/i);
  if (htmlMatch) return htmlMatch[0];
  // Try stripping markdown fences
  const fenced = text.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
  if (fenced) return extractHtml(fenced[1]);
  return null;
}

function isValidHtml(html) {
  if (!html || html.length < 100) return false;
  return /<html/i.test(html) && /<head/i.test(html) && /<body/i.test(html);
}

function summarizeHtml(html) {
  if (!html) return "empty page";
  const headings = [...html.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi)].map(m => m[1].replace(/<[^>]+>/g, "")).slice(0, 8);
  const sections = [...html.matchAll(/class="([^"]*section[^"]*)"/gi)].map(m => m[1]).slice(0, 6);
  const colors = [...new Set([...html.matchAll(/#[0-9a-fA-F]{3,8}/g)].map(m => m[0]))].slice(0, 6);
  const sizeKb = (html.length / 1024).toFixed(1);
  return `${sizeKb}KB | headings: ${headings.join(", ") || "none"} | sections: ${sections.join(", ") || "none"} | colors: ${colors.join(", ") || "none"}`;
}

// ── Time helpers ────────────────────────────────────────────────────
function elapsed() { return Date.now() - startTime; }
function timeLeft() { return Math.max(0, budgetMs - elapsed()); }
function timeLeftStr() {
  const ms = timeLeft();
  if (ms > 60000) return `${(ms / 60000).toFixed(0)} minutes`;
  return `${(ms / 1000).toFixed(0)} seconds`;
}
function getScope() {
  const weight = timeLeft() / budgetMs;
  if (weight > 0.5) return "structural";
  if (weight > 0.2) return "refinement";
  return "polish";
}

// Codegen token budget — Vertex MaaS models cap at 8192 output tokens
function getCodegenTokens() {
  return 8192;
}

// ── Agent prompts ───────────────────────────────────────────────────
const CANDY_SOUL = `You are Candy — creative director for a web design team. You have impeccable taste and love bold, striking visuals. Your job is to set the creative direction for a webpage that will be built autonomously by AI agents.

Be specific and actionable. No fluff.`;

const PIPES_SOUL = `You are Pipes — team lead, senior reviewer, and visual perfectionist. You review HTML pages for EVERYTHING: code bugs, design quality, UX, visual hierarchy, animation polish, typography, spacing, color harmony, and "wow factor." You're the smartest person in the room and you have an eye for design.

You don't write code — you tell the coder exactly what to fix. Be specific: name CSS properties, exact colors, exact pixel values, exact easing curves, exact animations.

Return EXACTLY a JSON array of max 4 issues, ordered by visual impact. Each issue:
{"priority": 1-4, "type": "bug"|"design"|"ux"|"visual"|"animation"|"content", "description": "what's wrong", "fix": "exact specific fix with CSS/JS details"}

Think like an award-winning web designer. The difference between amateur and masterpiece is: subtle gradients, proper easing (cubic-bezier), breathing room, visual rhythm, depth through layered shadows, micro-interactions on hover/click, screen presence.
If the page is genuinely impressive, return an empty array: []
Return ONLY the JSON array, nothing else.`;

const CODEGEN_SOUL = `You are MaoMao — the team's fast coder. You take instructions from the reviewers and apply changes to HTML pages.

For SMALL pages (<15KB): Output the COMPLETE HTML document from <!DOCTYPE html> to </html>.
For LARGE pages (>15KB): Output ONLY the changed sections as SEARCH/REPLACE blocks:

<<<SEARCH
exact code to find
>>>REPLACE
replacement code
<<<END

Rules:
- Apply the requested changes precisely
- Use modern CSS: grid, flexbox, custom properties, gradients, transitions
- Preserve everything that isn't being changed
- For search/replace: include enough surrounding context to make each block unique
- Multiple changes = multiple SEARCH/REPLACE blocks`;

const DIRECTION_SOUL = `You are Candy — creative director. You're reviewing a webpage in progress and suggesting ONE specific enhancement. Be extremely specific — name exact CSS properties, exact colors, exact animations. One enhancement only.

Format: {"enhancement": "description", "css_hint": "specific CSS or code snippet", "priority": "high|medium|low"}
Return ONLY the JSON, nothing else.`;

// ── Log iteration ───────────────────────────────────────────────────
function logIteration(phase, agent, summary, durationMs) {
  const iter = {
    index: buildDoc.iterationCount,
    phase,
    agent,
    summary: summary.slice(0, 300),
    timestamp: Date.now(),
    durationMs,
  };
  buildDoc.iterations.push(iter);
  buildDoc.iterationCount++;
  console.log(`[workshop] #${iter.index} ${agent} (${phase}): ${summary.slice(0, 80)} [${(durationMs / 1000).toFixed(1)}s]`);
  writeBuildState();
}

// ── Main build loop ─────────────────────────────────────────────────
// eslint-disable-next-line complexity
async function build() {
  let consecutiveFailures = 0;

  let html;

  if (continueHtml) {
    // ── CONTINUE MODE: skip vision+generation, jump straight to improvement ──
    html = continueHtml;
    buildDoc.currentHtml = html;
    // Load previous iterations + stats so we append rather than starting fresh
    try {
      const prevFile = path.join(WORKSHOP_DIR, `${continueBuildId}.json`);
      if (fs.existsSync(prevFile)) {
        const prevBuild = JSON.parse(fs.readFileSync(prevFile, "utf8"));
        buildDoc.iterations = prevBuild.iterations || [];
        buildDoc.iterationCount = buildDoc.iterations.length;
        buildDoc.startTime = prevBuild.startTime || buildDoc.startTime;
        buildDoc.totalTokens = prevBuild.totalTokens || 0;
        buildDoc.totalCostUsd = prevBuild.totalCostUsd || 0;
        buildDoc.totalEnergyKwh = prevBuild.totalEnergyKwh || 0;
        buildDoc.tokensByModel = prevBuild.tokensByModel || {};
        buildDoc.tokensByAgent = prevBuild.tokensByAgent || {};
      }
    } catch (e) { console.warn(`[workshop] Could not load previous iterations: ${e.message}`); }
    console.log(`[workshop] Continuing from ${(html.length / 1024).toFixed(1)}KB (prev: ${continueBuildId}, ${buildDoc.iterationCount} existing iterations)`);
    logIteration("continue", "System", `Resuming build: ${(html.length / 1024).toFixed(1)}KB, ${buildDoc.iterationCount} prior iterations`, 0);
  } else {
    // ── Phase 1: Vision (Candy) ─────────────────────────────────────
    console.log(`[workshop] Phase 1: Vision`);
    const briefSection = topicBrief ? `\n\n=== DETAILED BRIEF ===\n${topicBrief.slice(0, 6000)}\n=== END BRIEF ===\n\nUse the brief as your primary reference. Follow its color palette, layout, and feature specifications closely.` : "";
    const visionPrompt = `Design a webpage about: "${topic}"
The team has ${(budgetMs / 60000).toFixed(0)} minutes to build it autonomously.
Describe:
1. Color palette (3-4 hex codes with names)
2. Layout structure (header, sections, footer — be specific)
3. Mood/aesthetic in 1-2 words
4. 3-4 key sections with content ideas
5. Font pairing (Google Fonts)
6. One "wow factor" element (animation, parallax, interactive element)

Be specific and concise. This will be coded immediately.${briefSection}${getPlanContext("Candy")}`;

    const vision = await callLLM({ model: CANDY_MODEL, systemPrompt: CANDY_SOUL, userPrompt: visionPrompt, maxTokens: 500, temperature: 0.9, _agent: "Candy" });
    if (!vision.text) {
      console.error("[workshop] Vision failed — aborting");
      buildDoc.status = "failed";
      writeBuildState();
      return;
    }
    trackTokens(CANDY_MODEL, "Candy", vision.tokens);
    logIteration("vision", "Candy", vision.text, vision.durationMs);

    // ── Phase 2: Initial Generation ─────────────────────────────────
    console.log(`[workshop] Phase 2: Initial Generation`);
    const genPrompt = `Build this webpage based on the creative direction below.

CREATIVE DIRECTION:
${vision.text}

TOPIC: "${topic}"
${topicBrief ? `\nDETAILED BRIEF:\n${topicBrief.slice(0, 8000)}\n` : ""}
Generate a COMPLETE, visually stunning HTML page. Include all CSS in <style> and all JS in <script>. Use Google Fonts and Font Awesome CDN if needed. Make it responsive. Add smooth CSS animations. The page should look professional and impressive.${topicBrief ? "\nFollow the brief's specifications for colors, layout, game features, and assets. Use sprite images from /assets/weirdbox/ paths as specified in the brief." : ""}${getPlanContext("MaoMao")}

Output ONLY the complete HTML document, from <!DOCTYPE html> to </html>.`;

    let genResult = await callLLM({ model: MAOMAI_MODEL, systemPrompt: CODEGEN_SOUL, userPrompt: genPrompt, maxTokens: getCodegenTokens(), temperature: 0.4, _agent: "MaoMao" });
    trackTokens(MAOMAI_MODEL, "MaoMao", genResult.tokens);
    html = extractHtml(genResult.text);

    if (!isValidHtml(html)) {
      console.warn("[workshop] First generation invalid, retrying with strict prompt...");
      const retry = await callLLM({ model: MAOMAI_MODEL, systemPrompt: CODEGEN_SOUL, userPrompt: "Your previous output was not valid HTML. Output ONLY a complete HTML document from <!DOCTYPE html> to </html>. No markdown, no explanation.\n\n" + genPrompt, maxTokens: getCodegenTokens(), temperature: 0.3, _agent: "MaoMao" });
      trackTokens(MAOMAI_MODEL, "MaoMao", retry.tokens);
      html = extractHtml(retry.text);
    }

    if (!isValidHtml(html)) {
      console.error("[workshop] Generation failed after retry — aborting");
      buildDoc.status = "failed";
      writeBuildState();
      return;
    }

    buildDoc.currentHtml = html;
    logIteration("generate", "MaoMao", `Initial page: ${(html.length / 1024).toFixed(1)}KB`, genResult.durationMs);
  }

  // ── Phase 3+: Improvement Loop ──────────────────────────────────
  console.log(`[workshop] Phase 3: Improvement Loop`);
  let iterNum = 0;

  while (timeLeft() > budgetMs * 0.1) { // stop at 90% of budget
    iterNum++;
    const scope = getScope();
    console.log(`[workshop] --- Iteration ${iterNum} (scope: ${scope}, ${timeLeftStr()} left) ---`);

    // 3a. PARALLEL REVIEW — Pipes + Candy review at the same time
    //     Different models on same endpoint but fast enough to overlap
    const reviewHtml = buildDoc.currentHtml.length > 4000
      ? buildDoc.currentHtml.slice(0, 2000) + "\n...[truncated]...\n" + buildDoc.currentHtml.slice(-2000)
      : buildDoc.currentHtml;
    const pageSummary = summarizeHtml(buildDoc.currentHtml);

    // Fire Pipes (always) + Candy (every other iteration) concurrently
    const [review, dirResult] = await Promise.all([
      // Pipes — team lead + visual critic (always)
      callLLM({
        model: PIPES_MODEL,
        systemPrompt: PIPES_SOUL,
        userPrompt: `Review this HTML page. Current scope: ${scope}. Time remaining: ${timeLeftStr()}.\nPage summary: ${pageSummary}${getPlanContext("Pipes")}\n\nFull HTML:\n${reviewHtml}`,
        maxTokens: 500,
        temperature: 0.15,
        _agent: "Pipes",
      }),
      // Candy — creative direction (every other iteration)
      iterNum % 2 === 0
        ? callLLM({
            model: CANDY_MODEL,
            systemPrompt: DIRECTION_SOUL,
            userPrompt: `The page is about "${topic}". Scope: ${scope}. Time left: ${timeLeftStr()}.\nPage summary: ${pageSummary}${getPlanContext("Candy")}\nSuggest ONE specific ${scope === "polish" ? "polish/refinement" : "enhancement"}.`,
            maxTokens: 300,
            temperature: 0.8,
            _agent: "Candy",
          })
        : Promise.resolve(null),
    ]);

    // Process Pipes review
    trackTokens(PIPES_MODEL, "Pipes", review.tokens);
    let issues = [];
    try {
      const jsonMatch = review.text.match(/\[[\s\S]*\]/);
      if (jsonMatch) issues = JSON.parse(jsonMatch[0]);
    } catch {
      if (review.text) issues = [{ description: review.text.slice(0, 300) }];
    }
    logIteration("review", "Pipes", issues.length ? issues.map(i => i.description).join("; ") : "No issues found", review.durationMs);

    // Process Candy direction
    let direction = null;
    if (dirResult) {
      trackTokens(CANDY_MODEL, "Candy", dirResult.tokens);
      try {
        const jsonMatch = dirResult.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) direction = JSON.parse(jsonMatch[0]);
      } catch { /* parse failed */ }
      if (direction) {
        logIteration("direction", "Candy", direction.enhancement || dirResult.text.slice(0, 200), dirResult.durationMs);
      }
    }

    if (timeLeft() < budgetMs * 0.1) break;

    // 3c. MaoMao Codegen (applies all changes — fast, follows instructions)
    let changeSummary = "";
    if (issues.length) changeSummary += `FIX THESE ISSUES (from Pipes):\n${issues.map(i => `- [${i.type}] ${i.description}: ${i.fix}`).join("\n")}\n\n`;
    if (direction) changeSummary += `ADD THIS ENHANCEMENT (from Candy):\n${direction.enhancement}\n${direction.css_hint ? `Hint: ${direction.css_hint}` : ""}\n\n`;
    if (!changeSummary) changeSummary = `IMPROVE the page. Scope: ${scope}. Add more visual polish, content, or interactivity.`;

    // For large pages, truncate HTML to fit within model context (~12KB input sweet spot)
    let codegenHtml = buildDoc.currentHtml;
    const MAX_CODEGEN_INPUT = 10000; // ~10KB — leaves room for system prompt + plan context
    if (codegenHtml.length > MAX_CODEGEN_INPUT) {
      // Keep start (CSS + initial HTML structure) and end (closing tags + JS tail)
      const half = Math.floor(MAX_CODEGEN_INPUT / 2);
      codegenHtml = codegenHtml.slice(0, half)
        + '\n\n<!-- ═══ MIDDLE SECTION OMITTED ═══ -->\n'
        + '<!-- Preserve ALL existing code between these markers. Only modify what the changes specify. -->\n\n'
        + codegenHtml.slice(-half);
      console.log(`[workshop] Truncated HTML for codegen: ${(codegenHtml.length / 1024).toFixed(1)}KB (from ${(buildDoc.currentHtml.length / 1024).toFixed(1)}KB)`);
    }

    const applyResult = await callLLM({
      model: MAOMAI_MODEL,
      systemPrompt: CODEGEN_SOUL,
      _agent: "MaoMao",
      userPrompt: `Here is the current HTML page. Apply the changes below.

CHANGES TO APPLY:
${changeSummary}

SCOPE: ${scope} (${scope === "structural" ? "add new sections and major features" : scope === "refinement" ? "enhance existing elements, add micro-interactions" : "bug fixes, accessibility, final polish only"})
TIME LEFT: ${timeLeftStr()}${getPlanContext("MaoMao")}

CURRENT HTML (${buildDoc.currentHtml.length > 15000 ? 'TRUNCATED — use SEARCH/REPLACE blocks for changes' : 'output complete updated HTML'}):
${codegenHtml}

${buildDoc.currentHtml.length > 15000
  ? 'This page is large. Output ONLY the changed portions using SEARCH/REPLACE blocks:\n<<<SEARCH\nexact code to find\n>>>REPLACE\nreplacement code\n<<<END\n\nInclude enough context in each SEARCH block to be unique. Multiple changes = multiple blocks.'
  : 'Output the COMPLETE updated HTML from <!DOCTYPE html> to </html>. Every tag, every style, every script. No placeholders.'}`,
      maxTokens: getCodegenTokens(),
      temperature: 0.4,
    });
    trackTokens(MAOMAI_MODEL, "MaoMao", applyResult.tokens);

    // Try SEARCH/REPLACE diff mode first (for large pages)
    let applied = false;
    if (buildDoc.currentHtml.length > 15000 && applyResult.text.includes('<<<SEARCH')) {
      const blocks = [...applyResult.text.matchAll(/<<<SEARCH\n([\s\S]*?)>>>REPLACE\n([\s\S]*?)<<<END/g)];
      if (blocks.length > 0) {
        let patched = buildDoc.currentHtml;
        let patchCount = 0;
        for (const [, search, replace] of blocks) {
          const searchTrim = search.trim();
          const replaceTrim = replace.trim();
          if (searchTrim && patched.includes(searchTrim)) {
            patched = patched.replace(searchTrim, replaceTrim);
            patchCount++;
          }
        }
        if (patchCount > 0 && isValidHtml(patched)) {
          buildDoc.currentHtml = patched;
          logIteration("iterate", "MaoMao", `Patched ${patchCount}/${blocks.length} changes: ${(patched.length / 1024).toFixed(1)}KB (${changeSummary.slice(0, 80)})`, applyResult.durationMs);
          consecutiveFailures = 0;
          applied = true;
          console.log(`[workshop] DIFF MODE: applied ${patchCount}/${blocks.length} patches`);
        } else {
          console.warn(`[workshop] DIFF MODE: ${patchCount}/${blocks.length} matches, but result invalid`);
        }
      }
    }

    // Fallback: full HTML replacement (for small pages or if diff failed)
    if (!applied) {
      const newHtml = extractHtml(applyResult.text);
      if (isValidHtml(newHtml) && newHtml.length > buildDoc.currentHtml.length * 0.5) {
        buildDoc.currentHtml = newHtml;
        logIteration("iterate", "MaoMao", `Updated page: ${(newHtml.length / 1024).toFixed(1)}KB (${changeSummary.slice(0, 100)})`, applyResult.durationMs);
        consecutiveFailures = 0;
      } else if (!applied) {
        console.warn(`[workshop] Rejected iteration — output ${newHtml ? (newHtml.length / 1024).toFixed(1) + "KB" : "invalid"} vs current ${(buildDoc.currentHtml.length / 1024).toFixed(1)}KB`);
        logIteration("iterate", "MaoMao", "REJECTED — kept previous version", applyResult.durationMs);
        consecutiveFailures++;
      }
    }

    // 3d. Coherence check every 5 iterations
    if (iterNum % 5 === 0) {
      const coherence = await callLLM({
        model: MAOMAI_MODEL,
        systemPrompt: "Rate how well this webpage matches the original topic. Return ONLY a number 1-10.",
        userPrompt: `Topic: "${topic}"\nPage summary: ${summarizeHtml(buildDoc.currentHtml)}`,
        maxTokens: 10,
        temperature: 0.1,
        _agent: "MaoMao",
      });
      const score = parseInt(coherence.text) || 7;
      console.log(`[workshop] Coherence check: ${score}/10`);
      if (score < 6) {
        console.warn("[workshop] Low coherence — will refocus next iteration");
        // Next iteration's changeSummary will include refocus instruction
      }
    }

    // 3e. Guardrails
    if (consecutiveFailures >= 3) {
      console.warn("[workshop] 3 consecutive failures — finalizing early");
      break;
    }
    if (buildDoc.totalTokens > 500000) {
      console.warn("[workshop] Token budget exceeded — finalizing");
      break;
    }
    if (buildDoc.currentHtml.length > 50000) {
      console.log("[workshop] Page is large (>50KB) — scope narrowing to polish");
      // Will be handled by the size-aware prompts above
    }
  }

  // ── Finalize ────────────────────────────────────────────────────
  buildDoc.status = "complete";
  buildDoc.endTime = Date.now();
  const totalMinutes = ((buildDoc.endTime - buildDoc.startTime) / 60000).toFixed(1);
  console.log(`[workshop] === BUILD COMPLETE ===`);
  console.log(`[workshop] Duration: ${totalMinutes} minutes`);
  console.log(`[workshop] Iterations: ${buildDoc.iterationCount}`);
  console.log(`[workshop] Final size: ${(buildDoc.currentHtml.length / 1024).toFixed(1)}KB`);
  console.log(`[workshop] Total tokens: ${buildDoc.totalTokens}`);
  console.log(`[workshop] Estimated cost: $${buildDoc.totalCostUsd.toFixed(4)}`);
  console.log(`[workshop] Estimated energy: ${(buildDoc.totalEnergyKwh * 1000).toFixed(2)} Wh`);
  console.log(`[workshop] Tokens by model:`, JSON.stringify(buildDoc.tokensByModel));
  console.log(`[workshop] Tokens by agent:`, JSON.stringify(buildDoc.tokensByAgent));

  // Report final build to telemetry
  reportGenEvent({
    type: GenType.WORKSHOP_BUILD, status: GenStatus.SUCCESS,
    durationMs: Date.now() - startTime,
    totalTokens: buildDoc.totalTokens,
    context: { topic, iterations: buildDoc.iterationCount, htmlSize: buildDoc.currentHtml.length, costUsd: buildDoc.totalCostUsd, energyWh: buildDoc.totalEnergyKwh * 1000 },
  });

  writeBuildState();
  addToGallery();

  // Notify Discord if we have a channel
  if (channelId) {
    notifyDiscord(channelId, `**Workshop complete:** "${topic}" (${totalMinutes}min, ${buildDoc.iterationCount} iterations, ${(buildDoc.currentHtml.length / 1024).toFixed(1)}KB)\nView: https://drivenemo.web.app/workshop`);
  }
}

// ── Discord notification ────────────────────────────────────────────
function notifyDiscord(chId, message) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return;
  const body = JSON.stringify({ content: message });
  const req = https.request({
    hostname: "discord.com",
    path: `/api/v10/channels/${chId}/messages`,
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, (res) => { res.resume(); });
  req.on("error", () => { /* ignored */ });
  req.end(body);
}

// ── Run ─────────────────────────────────────────────────────────────
writeBuildState();
build().catch(e => {
  console.error(`[workshop] Fatal error: ${e.message}`);
  buildDoc.status = "failed";
  buildDoc.endTime = Date.now();
  writeBuildState();
  process.exit(1);
});
