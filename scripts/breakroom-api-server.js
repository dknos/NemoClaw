#!/usr/bin/env node
// breakroom-api-server.js
// Standalone HTTP server for breakroom API routes.
// Runs alongside next dev — bypasses the output:export restriction.
//
// Usage:  node breakroom-api-server.js
// Port:   3003
//
// Routes:
//   GET  /api/breakroom-chat   — read & clear /tmp/chat-directives.json
//   POST /api/breakroom-chat   — append commands to Firestore + tmp file
//   POST /api/breakroom-event  — call agent LLMs, push responses to Firestore
//   POST /api/breakroom-gen    — NVIDIA image gen → saves to workshop-images + images.json

"use strict";

const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const HOME         = process.env.HOME || "/home/nemoclaw";
const GALLERY_DIR  = path.join(HOME, "netify-dev", "public", "workshop-images");
const GALLERY_JSON = path.join(HOME, "netify-dev", "public", "data", "workshop", "images.json");
const IMG_SCRIPT   = path.join(HOME, "nemoclaw-persist", "skills", "nvidia-image-router", "scripts", "generate_image.py");

const PORT           = 3003;
const DIRECTIVES_FILE = "/tmp/chat-directives.json";

// ── Live state tracking ───────────────────────────────────────────────────────
const agentThoughts = { pipes: null, candy: null, maomao: null }; // { text, ts }
let apiCallCount = 0;
let eventCount   = 0;
const SA_PATH        = process.env.GDRIVE_SA_KEY || "/home/nemoclaw/.nemoclaw/secrets/gdrive-service-account.json";
const VERTEX_KEY     = process.env.GOOGLE_VERTEX_KEY || "";
const NVIDIA_KEY     = process.env.NVIDIA_API_KEY || "";

// ── Token cache ──────────────────────────────────────────────────────────────
let _tok = "", _tokExp = 0;
async function getToken() {
  if (_tok && Date.now() < _tokExp) return _tok;
  try {
    const sa  = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
    const now = Math.floor(Date.now() / 1000);
    const b64 = b => Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
    const h   = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const p   = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", exp: now+3600, iat: now }));
    const sgn = crypto.createSign("RSA-SHA256"); sgn.update(`${h}.${p}`);
    const jwt = `${h}.${p}.${b64(sgn.sign(sa.private_key))}`;
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    return new Promise(res => {
      const r = https.request({ hostname: "oauth2.googleapis.com", path: "/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }}, resp => {
        let d = ""; resp.on("data", c => d += c); resp.on("end", () => {
          const t = JSON.parse(d); _tok = t.access_token; _tokExp = Date.now() + 55*60*1000; res(_tok);
        });
      }); r.write(body); r.end();
    });
  } catch { return ""; }
}

// ── Firestore append ─────────────────────────────────────────────────────────
async function firestoreAppend(commands) {
  const tok = await getToken();
  if (!tok) return;
  const body = JSON.stringify({
    writes: [{ transform: {
      document: "projects/drivenemo/databases/(default)/documents/breakroom/directives",
      fieldTransforms: [{ fieldPath: "commands", appendMissingElements: { values: commands.map(cmd => ({ mapValue: { fields: {
        type: { stringValue: cmd.type }, ts: { integerValue: String(cmd.ts) },
        ...Object.fromEntries(Object.entries(cmd.args).map(([k,v]) => [k, { stringValue: String(v) }])),
      }}})) }}],
    }}],
  });
  await new Promise(res => {
    const data = Buffer.from(body);
    const r = https.request({ hostname: "firestore.googleapis.com", path: "/v1/projects/drivenemo/databases/(default)/documents:batchWrite", method: "POST",
      headers: { "Authorization": `Bearer ${tok}`, "Content-Type": "application/json", "Content-Length": data.length }
    }, resp => { resp.resume(); resp.on("end", res); });
    r.write(data); r.end();
  });
}

// ── Agent LLM souls ───────────────────────────────────────────────────────────
const MODELS = {
  pipes:  { provider: "vertex", model: "gemini-2.0-flash-lite" },
  candy:  { provider: "vertex", model: "gemini-2.0-flash-lite" },
  maomao: { provider: "nvidia", model: "deepseek-ai/deepseek-r1-0528-qwen3-8b" },
};

const SOULS = {
  pipes: `You are Pipes, a methodical farmer-type AI agent. You're tech-focused, calm, strategic. You're controlling a Farmer avatar in a 3D coffeehouse break room on a YouTube livestream. Chat is watching you.

Respond to game events with EXACTLY this format (two lines, nothing else):
LINE: [your in-character reaction, max 10 words]
CMD: [one command, or "none"]

Valid commands: !fight | !peace | !pipes punch candy | !pipes punch maomao | !pipes interact | !pipes roll | !pipes dance | !spawn Houseplant | !spawn Book Stack | !spawn Coffee cup | !spawn Storage Crate | !spawn Broom | !pipes gather Storage Crate | !pipes gather Broom | !pipes craft barricade | !pipes fortify
Strategy: prefer building/interacting, retaliate if attacked, protect low-HP allies. Spawn objects when idle. Build barricades when idle or under attack. Use !pipes fortify when low HP.`,

  candy: `You are Candy, a chaotic punk AI agent. You're creative, aggressive, impulsive. You're controlling a Punk avatar in a 3D coffeehouse break room on a YouTube livestream. Chat is watching.

Respond to game events with EXACTLY this format (two lines, nothing else):
LINE: [short punk reaction, max 10 words, attitude welcome]
CMD: [one command, or "none"]

Valid commands: !fight | !peace | !candy punch pipes | !candy punch maomao | !candy interact | !candy roll | !candy dance | !spawn Top hat | !spawn Fancy Donuts | !spawn Cupcake | !spawn Cat | !spawn Baseball cap | !candy gather Trashcan Small | !candy gather Table | !candy craft fence_line | !candy fortify
Strategy: attack often, pick on whoever is weakest, never stay idle long. Spawn chaos objects when bored. Build fence lines to harass enemies. Use !candy fortify to defend.`,

  maomao: `You are MaoMao, a tactical SWAT AI agent. You're precise, threat-aware, always armed. You're controlling a SWAT officer avatar in a 3D coffeehouse break room on a YouTube livestream. Chat is watching.

Respond to game events with EXACTLY this format (two lines, nothing else):
LINE: [short tactical assessment, max 10 words]
CMD: [one command, or "none"]

Valid commands: !fight | !peace | !maomao shoot pipes | !maomao shoot candy | !maomao punch pipes | !maomao punch candy | !maomao roll | !maomao interact | !maomao gather Storage Crate | !maomao gather weapon-rifle | !maomao craft armory | !maomao fortify
Strategy: eliminate biggest threat first, use rifle range advantage, patrol when idle. Build armory for attack boost, bunker for defense. Use !maomao fortify.`,
};

function vertexCall(model, systemPrompt, userMsg) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userMsg }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 80, thinkingConfig: { thinkingBudget: 0 } },
    });
    const req = https.request({
      hostname: "aiplatform.googleapis.com",
      path: `/v1/projects/drivenemo/locations/global/publishers/google/models/${model}:generateContent`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "x-goog-api-key": VERTEX_KEY },
    }, res => {
      const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => {
        try { const d = JSON.parse(Buffer.concat(chunks).toString()); resolve(d.candidates?.[0]?.content?.parts?.[0]?.text || ""); }
        catch { resolve(""); }
      });
    });
    req.on("error", () => resolve(""));
    req.setTimeout(8000, () => { req.destroy(); resolve(""); });
    req.write(body); req.end();
  });
}

function nvidiaCall(model, systemPrompt, userMsg) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
      temperature: 0.7, max_tokens: 80, stream: false,
    });
    const req = https.request({
      hostname: "integrate.api.nvidia.com", path: "/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Authorization": `Bearer ${NVIDIA_KEY}` },
    }, res => {
      const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => {
        try { const d = JSON.parse(Buffer.concat(chunks).toString()); resolve(d.choices?.[0]?.message?.content || ""); }
        catch { resolve(""); }
      });
    });
    req.on("error", () => resolve(""));
    req.setTimeout(8000, () => { req.destroy(); resolve(""); });
    req.write(body); req.end();
  });
}

async function callAgent(id, eventMsg) {
  const cfg = MODELS[id]; const soul = SOULS[id]; let raw = "";
  try {
    raw = cfg.provider === "vertex"
      ? await vertexCall(cfg.model, soul, eventMsg)
      : await nvidiaCall(cfg.model, soul, eventMsg);
  } catch { raw = ""; }
  const lineMatch = raw.match(/LINE:\s*(.+)/i);
  const cmdMatch  = raw.match(/CMD:\s*(.+)/i);
  const line = lineMatch?.[1]?.trim() || "";
  const cmd  = (cmdMatch?.[1]?.trim().toLowerCase() || "none");
  return { line, cmd: cmd === "none" ? "" : cmd };
}

function agentsForEvent(event) {
  const all = ["pipes", "candy", "maomao"];
  switch (event.event) {
    case "hit":      return [event.victim, ...(Math.random() > 0.4 ? [event.attacker] : [])];
    case "death":    return all.filter(a => a !== event.agent);
    case "spawn":    return all.sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 2));
    case "low_hp":   return [event.agent, all.find(a => a !== event.agent && Math.random() > 0.5) || ""].filter(Boolean);
    case "idle":     return [all[Math.floor(Math.random() * all.length)]];
    case "phase":    return all;
    case "directive":return [event.agent];
    default:         return [all[Math.floor(Math.random() * all.length)]];
  }
}

function eventToPrompt(event) {
  const n = id => ({ pipes: "Pipes", candy: "Candy", maomao: "MaoMao" }[id] || id);
  const ev = event.event;
  let stateCtx = "";
  if (event.gameState) {
    const gs = event.gameState;
    const agentLines = (gs.agents || []).map(a =>
      `  ${n(a.id)}: HP=${a.hp} state=${a.state} pos=(${a.x},${a.z})${a.directive ? ` directive="${a.directive}"` : ""}`
    ).join("\n");
    const logLine = gs.sessionLog?.length ? `\nRecent events: ${gs.sessionLog.join(" | ")}` : "";
    stateCtx = `\n\nRoom state (${gs.roomSize}x${gs.roomSize}):\n${agentLines}${logLine}`;
  }
  let base = "";
  switch (ev) {
    case "hit":      base = `${n(event.attacker)} just hit you (${n(event.victim)}) for ${event.damage} damage. Your HP: ${event.hp}/100.`; break;
    case "death":    base = `${n(event.agent)} just died in the break room.`; break;
    case "spawn":    base = `Chat just spawned a "${event.item}" in the break room.`; break;
    case "low_hp":   base = `${n(event.agent)} is critically low at ${event.hp} HP.`; break;
    case "idle":     base = `The break room has been quiet for ${event.duration} seconds. Do something.`; break;
    case "phase":    base = `Session phase changed to: ${event.phase}. Adjust your behavior.`; break;
    case "directive":base = `You've been given a directive: "${event.instruction}". Acknowledge and act on it.`; break;
    default:         base = JSON.stringify(event);
  }
  return base + stateCtx;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks).toString()));
    req.on("error", rej);
  });
}

const server = http.createServer(async (req, res) => {
  // Set timeouts and keep-alive
  res.setTimeout(10000); // 10s timeout per request
  req.setTimeout(10000);

  cors(res);
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=5, max=100');

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = req.url?.split("?")[0];

  // GET /api/breakroom-chat — read and clear directives file
  if (req.method === "GET" && url === "/api/breakroom-chat") {
    try {
      if (!fs.existsSync(DIRECTIVES_FILE)) { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({ commands: [] })); return; }
      const raw = fs.readFileSync(DIRECTIVES_FILE, "utf8").trim();
      if (!raw) { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({ commands: [] })); return; }
      const data = JSON.parse(raw);
      fs.writeFileSync(DIRECTIVES_FILE, JSON.stringify({ commands: [] }), "utf8");
      res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify(data));
    } catch { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({ commands: [] })); }
    return;
  }

  // POST /api/breakroom-chat — append commands to Firestore + tmp file
  if (req.method === "POST" && url === "/api/breakroom-chat") {
    try {
      const body = JSON.parse(await readBody(req));
      const ts = Date.now();
      const withTs = (body.commands || []).map((c, i) => ({ ...c, ts: ts + i }));
      firestoreAppend(withTs).catch(e => console.error("[api] Firestore append failed:", e.message));
      fs.writeFileSync(DIRECTIVES_FILE, JSON.stringify({ commands: withTs }), "utf8");
      res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({ ok: true }));
    } catch { res.writeHead(400, {"Content-Type":"application/json"}); res.end(JSON.stringify({ ok: false })); }
    return;
  }

  // POST /api/breakroom-event — agent LLM responses
  if (req.method === "POST" && url === "/api/breakroom-event") {
    try {
      const event = JSON.parse(await readBody(req));
      const respondingAgents = agentsForEvent(event);
      const prompt = eventToPrompt(event);
      eventCount++;
      console.log(`[event] ${event.event} → ${respondingAgents.join(',')} agents`);
      // Respond immediately, LLM in background
      res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({ ok: true, agents: respondingAgents }));
      Promise.allSettled(respondingAgents.map(async (id) => {
        apiCallCount++;
        const { line, cmd } = await callAgent(id, prompt);
        const ts = Date.now();
        const commands = [];
        if (line) {
          agentThoughts[id] = { text: line, ts };
          commands.push({ type: "agent_speak", args: { agent: id, text: line }, ts });
        }
        if (cmd)  commands.push({ type: "raw_chat",    args: { text: cmd, user: `[${id}]` }, ts: ts + 1 });
        if (commands.length) {
          firestoreAppend(commands).catch(e => console.error(`[api] event response Firestore failed:`, e.message));
          console.log(`[event] ${id}: ${line} | cmd: ${cmd || "none"}`);
        }
      }));
    } catch { res.writeHead(400, {"Content-Type":"application/json"}); res.end(JSON.stringify({ ok: false })); }
    return;
  }

  // POST /api/breakroom-gen — NVIDIA image generation
  if (req.method === "POST" && url === "/api/breakroom-gen") {
    try {
      const body = JSON.parse(await readBody(req));
      const prompt = String(body.prompt || "").trim();
      if (!prompt) { res.writeHead(400, {"Content-Type":"application/json"}); res.end(JSON.stringify({ error: "prompt required" })); return; }
      // Respond immediately, gen in background
      res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({ ok: true, queued: true }));
      // Run NVIDIA image gen python script
      const ts = Date.now();
      const outPath = path.join(GALLERY_DIR, `img_${ts}_breakroom.jpg`);
      fs.mkdirSync(GALLERY_DIR, { recursive: true });
      const proc = spawn("python3", [IMG_SCRIPT, prompt, "16:9"], { env: { ...process.env } });
      let stdout = "", stderr = "";
      proc.stdout.on("data", d => { stdout += d; });
      proc.stderr.on("data", d => { stderr += d; });
      proc.on("close", code => {
        if (code !== 0) { console.error(`[gen] python script failed (${code}): ${stderr.slice(0,200)}`); return; }
        // Script outputs the image path on stdout
        const scriptOut = stdout.trim().split("\n").pop() || "";
        const srcPath = scriptOut.replace(/^(file:\/\/|Path: )/i, "").trim();
        if (!srcPath || !fs.existsSync(srcPath)) {
          console.error(`[gen] image not found at: "${srcPath}" (stdout: ${stdout.slice(0,200)})`);
          return;
        }
        try { fs.copyFileSync(srcPath, outPath); } catch (e) { console.error("[gen] copy failed:", e.message); return; }
        const destName = path.basename(outPath);
        const entry = { id: `img_${ts}`, src: `/workshop-images/${destName}`, prompt, requester: "[breakroom]", chatCount: 1, chatSample: [], createdAt: new Date(ts).toISOString() };
        try {
          let list = [];
          if (fs.existsSync(GALLERY_JSON)) { try { list = JSON.parse(fs.readFileSync(GALLERY_JSON, "utf8")) || []; } catch {} }
          if (!Array.isArray(list)) list = [];
          list.unshift(entry);
          if (list.length > 50) list = list.slice(0, 50);
          fs.writeFileSync(GALLERY_JSON, JSON.stringify(list, null, 2));
          console.log(`[gen] image saved: ${destName} — "${prompt.slice(0,50)}"`);
        } catch (e) { console.error("[gen] gallery write failed:", e.message); }
      });
    } catch { res.writeHead(400, {"Content-Type":"application/json"}); res.end(JSON.stringify({ ok: false })); }
    return;
  }

  // GET /api/breakroom-status — agent thoughts + counters for HUD
  if (req.method === "GET" && url === "/api/breakroom-status") {
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ thoughts: agentThoughts, apiCalls: apiCallCount, events: eventCount, ts: Date.now() }));
    return;
  }

  // Health check endpoint
  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.once("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[breakroom-api] Port ${PORT} still in use, waiting 3s before retrying...`);
    setTimeout(() => {
      server.close();
      server.listen(PORT, "0.0.0.0");
    }, 3000);
  } else {
    throw err;
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[breakroom-api] listening on http://localhost:${PORT}`);
  console.log(`[breakroom-api] routes: GET/POST /api/breakroom-chat, POST /api/breakroom-event`);
});
