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
const { OpenRouter } = require("@openrouter/sdk");
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

// ── OpenRouter SDK client (for MaoMao/Qwen streaming) ───────────────
const orClient = new OpenRouter({ apiKey: OPENROUTER_API_KEY });

async function callOpenRouterSDK({ model, systemPrompt, userPrompt, maxTokens = 4000, temperature = 0.4 }) {
  const t0 = Date.now();
  try {
    const stream = await orClient.chat.send({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature,
      stream: true,
    });
    let text = "", reasoningTokens = 0, totalTok = 0;
    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) text += content;
      if (chunk.usage) {
        totalTok = chunk.usage.totalTokens || chunk.usage.total_tokens || 0;
        reasoningTokens = chunk.usage.reasoningTokens || 0;
      }
    }
    if (reasoningTokens > 0) console.log(`[weirdbox-lab] MaoMao reasoning tokens: ${reasoningTokens}`);
    return { text: text.trim(), tokens: totalTok || Math.ceil(text.length / 4), durationMs: Date.now() - t0, statusCode: 200 };
  } catch (e) {
    console.warn(`[weirdbox-lab] OpenRouter SDK error: ${e.message}`);
    return { text: "", tokens: 0, durationMs: Date.now() - t0, statusCode: 0 };
  }
}

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
const CANDY_MODEL  = "gemini-3.1-flash";                              // Vertex Gemini — vision + direction
const PIPES_MODEL  = "gemini-3.1-flash";                              // Vertex Gemini — reviewer + codegen fallback
const MAOMAI_MODEL = "qwen/qwen3-30b-a3b";                            // OpenRouter — architect (async, don't block)
const FLASH_MODEL  = "gemini-2.0-flash";                              // Vertex Gemini — fast codegen (5th agent)
const LLAMA_MODEL  = "meta/llama-4-maverick-17b-128e-instruct-maas"; // Vertex MaaS — polish pass

const MAOMAI_TIMEOUT_MS = 50000; // max wait for Qwen — if it's not done, proceed without it

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
const LIVE_FILE    = path.join(os.homedir(), "netify-dev", "public", "data", "weirdbox-lab-live.json");
fs.mkdirSync(path.dirname(LIVE_FILE), { recursive: true });

// ── Live telemetry state ─────────────────────────────────────────────
const liveState = {
  status: "starting",
  startTime: Date.now(),
  lastUpdate: Date.now(),
  iteration: 0,
  totalTokens: 0,
  totalCost: 0,
  pageSize: 0,
  iterHistory: [], // [{iter, tokens, cost, sizeKb, elapsedMs}] for sparkline/table
  agents: {
    Candy:  { status: "idle", lastMessage: "", tokens: 0 },
    Pipes:  { status: "idle", lastMessage: "", tokens: 0 },
    MaoMao: { status: "idle", lastMessage: "", tokens: 0 },
    Flash:  { status: "idle", lastMessage: "", tokens: 0 },
    Llama:  { status: "idle", lastMessage: "", tokens: 0 },
  },
  logs: [],
};

// writeLiveState is called before totalTokens/currentHtml are declared at module scope,
// so we use typeof guards. They'll be set by the time build() runs.
function writeLiveState() {
  liveState.lastUpdate  = Date.now();

  liveState.totalTokens = typeof totalTokens !== "undefined" ? totalTokens : 0;

  liveState.totalCost   = typeof totalCost   !== "undefined" ? totalCost   : 0;

  liveState.pageSize    = typeof currentHtml !== "undefined" && currentHtml ? currentHtml.length : 0;
  try { fs.writeFileSync(LIVE_FILE, JSON.stringify(liveState, null, 2)); } catch (_e) { /* ignore */ }
}

function logAgent(agent, phase, message) {
  const entry = { t: Date.now(), agent, phase, msg: message.slice(0, 200) };
  liveState.logs.push(entry);
  if (liveState.logs.length > 120) liveState.logs = liveState.logs.slice(-100); // keep last 100
  if (liveState.agents[agent]) liveState.agents[agent] = { status: phase, lastMessage: message.slice(0, 120) };
  console.log(`[weirdbox-lab] [${agent}:${phase}] ${message.slice(0,80)}`);
  writeLiveState();
}

// ── Monitor panel — always injected into weirdbox-lab.html ───────────
// Strip marker so we re-inject fresh on every write
const MONITOR_MARKER_START = "<!-- __WEIRDBOX_MONITOR_START__ -->";
const MONITOR_MARKER_END   = "<!-- __WEIRDBOX_MONITOR_END__ -->";

const MONITOR_PANEL = `${MONITOR_MARKER_START}
<style>
#wbl-m{position:fixed;bottom:16px;right:16px;z-index:99999;font-family:'Courier New',monospace;font-size:11px;color:#00f5d4;background:rgba(0,0,0,.94);border:1px solid #00f5d4;border-radius:8px;width:360px;display:flex;flex-direction:column;box-shadow:0 0 22px rgba(0,245,212,.3);transition:height .2s}
#wbl-m.collapsed #wbl-body{display:none}
#wbl-hdr{display:flex;align-items:center;justify-content:space-between;padding:7px 12px;cursor:pointer;user-select:none;border-bottom:1px solid #00f5d424}
#wbl-hdr-left{display:flex;align-items:center;gap:8px}
#wbl-hdr .title{font-weight:bold;letter-spacing:.5px;font-size:11px}
#wbl-dot{width:7px;height:7px;border-radius:50%;background:#444}
#wbl-dot.live{background:#00f5d4;box-shadow:0 0 6px #00f5d4;animation:wbl-blink 1.2s infinite}
#wbl-dot.done{background:#06d6a0}
@keyframes wbl-blink{0%,100%{opacity:1}50%{opacity:.3}}
#wbl-collapse-btn{background:none;border:none;color:#00f5d4;cursor:pointer;font-size:13px;padding:0;line-height:1}
#wbl-body{display:flex;flex-direction:column}
#wbl-agents-bar{padding:6px 12px;border-bottom:1px solid #00f5d424;display:flex;flex-wrap:wrap;gap:4px}
.wbl-ab{padding:2px 7px;border-radius:3px;font-size:10px;font-weight:bold;border:1px solid transparent;transition:all .2s}
.wbl-ab.idle{color:#ffffff33;border-color:#ffffff11}
.wbl-ab.vision,.wbl-ab.reviewing,.wbl-ab.planning,.wbl-ab.coding,.wbl-ab.thinking,.wbl-ab.polishing,.wbl-ab.starting{color:#000;background:#00f5d4;animation:wbl-blink .9s infinite}
.wbl-ab.done{color:#00f5d4;border-color:#00f5d4}
.wbl-ab.error{color:#ff6b9d;border-color:#ff6b9d}
.wbl-ab.iteration,.wbl-ab.complete{color:#06d6a0;border-color:#06d6a0}
#wbl-tabs{display:flex;border-bottom:1px solid #00f5d424}
.wbl-tab{flex:1;padding:5px 0;text-align:center;cursor:pointer;font-size:10px;color:#ffffff55;letter-spacing:.5px;text-transform:uppercase;transition:color .15s}
.wbl-tab:hover{color:#ffffff99}
.wbl-tab.on{color:#00f5d4;border-bottom:2px solid #00f5d4}
.wbl-tc{display:none;max-height:260px;overflow-y:auto}
.wbl-tc.on{display:block}
/* LOGS */
#wbl-logs{padding:4px 10px}
.wbl-log{padding:2px 0;border-bottom:1px solid #ffffff07;line-height:1.5}
.wbl-log .wbl-t{color:#ffffff33;margin-right:4px;font-size:10px}
.wbl-log .wbl-ag{margin-right:4px;font-weight:bold}
.wbl-ag.Candy{color:#ff6b9d}.wbl-ag.Pipes{color:#00f5d4}.wbl-ag.MaoMao{color:#ffd166}.wbl-ag.Flash{color:#06d6a0}.wbl-ag.Llama{color:#a78bfa}.wbl-ag.System{color:#ffffff55}
/* STATS */
#wbl-stats{padding:8px 12px}
.wbl-sg{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}
.wbl-sitem{display:flex;flex-direction:column}
.wbl-sitem .sl{color:#ffffff44;font-size:9px;text-transform:uppercase;letter-spacing:.5px}
.wbl-sitem .sv{color:#00f5d4;font-weight:bold;font-size:13px}
.wbl-sdivider{border:none;border-top:1px solid #ffffff0f;margin:4px 0}
#wbl-hist{font-size:10px;color:#ffffff55}
.wbl-hr{display:grid;grid-template-columns:2ch 7ch 6ch 6ch 6ch;gap:4px;padding:2px 0;border-bottom:1px solid #ffffff07}
.wbl-hr.hd{color:#ffffff44}
/* AGENTS */
#wbl-agent-cards{padding:6px 10px;display:flex;flex-direction:column;gap:6px}
.wbl-ac{background:#ffffff08;border-radius:4px;padding:6px 8px}
.wbl-ac-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.wbl-ac-name{font-weight:bold;font-size:11px}
.wbl-ac-stat{color:#ffffff55;font-size:10px}
.wbl-ac-msg{color:#ffffff66;font-size:10px;line-height:1.4;word-break:break-word}
#wbl-footer{padding:3px 10px;font-size:10px;color:#ffffff33;border-top:1px solid #00f5d424;text-align:right}
</style>
<div id="wbl-m">
  <div id="wbl-hdr">
    <div id="wbl-hdr-left">
      <div id="wbl-dot"></div>
      <span class="title">⚡ WEIRDBOX LAB MONITOR</span>
    </div>
    <button id="wbl-collapse-btn" onclick="(function(){var m=document.getElementById('wbl-m'),c=m.classList.toggle('collapsed');localStorage.setItem('wbl-c',c?1:0);document.getElementById('wbl-collapse-btn').textContent=c?'▼':'▲'})()">▲</button>
  </div>
  <div id="wbl-body">
    <div id="wbl-agents-bar"></div>
    <div id="wbl-tabs">
      <div class="wbl-tab on" data-tab="logs">Logs</div>
      <div class="wbl-tab" data-tab="stats">Stats</div>
      <div class="wbl-tab" data-tab="agents">Agents</div>
    </div>
    <div id="wbl-tc-logs" class="wbl-tc on"><div id="wbl-logs"></div></div>
    <div id="wbl-tc-stats" class="wbl-tc"><div id="wbl-stats">
      <div class="wbl-sg">
        <div class="wbl-sitem"><span class="sl">Status</span><span class="sv" id="ws-status">—</span></div>
        <div class="wbl-sitem"><span class="sl">Iteration</span><span class="sv" id="ws-iter">—</span></div>
        <div class="wbl-sitem"><span class="sl">Build time</span><span class="sv" id="ws-time">—</span></div>
        <div class="wbl-sitem"><span class="sl">Page size</span><span class="sv" id="ws-size">—</span></div>
        <div class="wbl-sitem"><span class="sl">Total tokens</span><span class="sv" id="ws-tok">—</span></div>
        <div class="wbl-sitem"><span class="sl">Est. cost</span><span class="sv" id="ws-cost">—</span></div>
        <div class="wbl-sitem"><span class="sl">Tok / iter</span><span class="sv" id="ws-tpi">—</span></div>
        <div class="wbl-sitem"><span class="sl">Iter / min</span><span class="sv" id="ws-ipm">—</span></div>
      </div>
      <hr class="wbl-sdivider">
      <div id="wbl-hist">
        <div class="wbl-hr hd"><span>#</span><span>elapsed</span><span>tokens</span><span>cost</span><span>KB</span></div>
        <div id="wbl-hist-rows"></div>
      </div>
    </div></div>
    <div id="wbl-tc-agents" class="wbl-tc"><div id="wbl-agent-cards"></div></div>
    <div id="wbl-footer">polling…</div>
  </div>
</div>
<script>
(function(){
  var AC={Candy:'#ff6b9d',Pipes:'#00f5d4',MaoMao:'#ffd166',Flash:'#06d6a0',Llama:'#a78bfa',System:'#ffffff55'};
  var lastLog=0,curTab='logs';
  if(localStorage.getItem('wbl-c')==='1'){
    document.getElementById('wbl-m').classList.add('collapsed');
    document.getElementById('wbl-collapse-btn').textContent='▼';
  }
  document.querySelectorAll('.wbl-tab').forEach(function(t){
    t.addEventListener('click',function(){
      document.querySelectorAll('.wbl-tab').forEach(function(x){x.classList.remove('on');});
      document.querySelectorAll('.wbl-tc').forEach(function(x){x.classList.remove('on');});
      t.classList.add('on');
      document.getElementById('wbl-tc-'+t.dataset.tab).classList.add('on');
      curTab=t.dataset.tab;
    });
  });
  function fmt(ms){if(!ms)return'—';var s=Math.floor(ms/1000),m=Math.floor(s/60);return m>0?m+'m '+(s%60)+'s':s+'s';}
  function fmtN(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n||0);}
  function esc(s){return String(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function render(d){
    // Dot
    var dot=document.getElementById('wbl-dot');
    dot.className=d.status==='building'?'live':d.status==='complete'?'done':'';
    // Agent badges
    var ag=document.getElementById('wbl-agents-bar');
    ag.innerHTML=Object.entries(d.agents||{}).map(function(e){
      var n=e[0],a=e[1];
      return '<div class="wbl-ab '+a.status+'" style="border-color:'+(AC[n]||'#fff')+'22" title="'+esc(a.lastMessage)+'"><span style="color:'+(AC[n]||'#aaa')+'">'+n+'</span></div>';
    }).join('');
    // Logs tab
    var newLogs=(d.logs||[]).slice(lastLog);
    if(newLogs.length){
      var el=document.getElementById('wbl-logs');
      newLogs.forEach(function(e){
        var div=document.createElement('div');div.className='wbl-log';
        var t=new Date(e.t).toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
        div.innerHTML='<span class="wbl-t">'+t+'</span><span class="wbl-ag '+(e.agent||'System')+'">['+esc(e.agent||'SYS')+']</span>'+esc(e.msg);
        el.appendChild(div);
      });
      if(curTab==='logs')el.scrollTop=el.scrollHeight;
      lastLog=d.logs.length;
    }
    // Stats tab
    var elap=d.startTime?Date.now()-d.startTime:0;
    var ipm=elap>0&&d.iteration?((d.iteration/(elap/60000)).toFixed(1)):0;
    var tpi=d.iteration>0?Math.round((d.totalTokens||0)/d.iteration):0;
    document.getElementById('ws-status').textContent=d.status||'—';
    document.getElementById('ws-iter').textContent=d.iteration||0;
    document.getElementById('ws-time').textContent=fmt(elap);
    document.getElementById('ws-size').textContent=d.pageSize?((d.pageSize/1024).toFixed(1)+'KB'):'—';
    document.getElementById('ws-tok').textContent=fmtN(d.totalTokens);
    document.getElementById('ws-cost').textContent='$'+(d.totalCost||0).toFixed(4);
    document.getElementById('ws-tpi').textContent=fmtN(tpi);
    document.getElementById('ws-ipm').textContent=ipm;
    // History rows
    var hist=d.iterHistory||[];
    document.getElementById('wbl-hist-rows').innerHTML=hist.slice(-8).reverse().map(function(h){
      return '<div class="wbl-hr"><span>'+h.iter+'</span><span>'+fmt(h.elapsedMs)+'</span><span>'+fmtN(h.tokens)+'</span><span>$'+((h.cost||0).toFixed(3))+'</span><span>'+h.sizeKb+'</span></div>';
    }).join('');
    // Agents tab
    document.getElementById('wbl-agent-cards').innerHTML=Object.entries(d.agents||{}).map(function(e){
      var n=e[0],a=e[1],col=AC[n]||'#fff';
      return '<div class="wbl-ac"><div class="wbl-ac-hdr"><span class="wbl-ac-name" style="color:'+col+'">'+n+'</span><span class="wbl-ac-stat">'+fmtN(a.tokens||0)+' tok &nbsp; <span class="wbl-ab '+a.status+'" style="font-size:9px;padding:1px 5px">'+a.status+'</span></span></div>'+(a.lastMessage?'<div class="wbl-ac-msg">'+esc(a.lastMessage)+'</div>':'')+'</div>';
    }).join('');
    document.getElementById('wbl-footer').textContent='updated '+new Date(d.lastUpdate||Date.now()).toLocaleTimeString();
  }
  async function poll(){
    try{
      var r=await fetch('/data/weirdbox-lab-live.json?_='+Date.now());
      if(r.ok)render(await r.json());
    }catch(e){document.getElementById('wbl-footer').textContent='offline';}
  }
  poll();setInterval(poll,3000);
})();
</script>
${MONITOR_MARKER_END}`;

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
  // Track per-agent — normalize "Pipes[codegen]" → "Pipes"
  const agentKey = agent.split("[")[0];
  if (liveState.agents[agentKey]) liveState.agents[agentKey].tokens += tokens;
  console.log(`[weirdbox-lab] ${agent} (${model.split("/").pop()}): ${tokens} tokens`);
}

function snapshotIteration() {
  liveState.iterHistory.push({
    iter: liveState.iteration,
    tokens: totalTokens,
    cost: totalCost,
    sizeKb: currentHtml ? parseFloat((currentHtml.length / 1024).toFixed(1)) : 0,
    elapsedMs: Date.now() - startTime,
  });
  if (liveState.iterHistory.length > 50) liveState.iterHistory = liveState.iterHistory.slice(-40);
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

  // MaoMao (Qwen via OpenRouter) uses the official SDK for streaming + reasoning tokens
  if (provider === "openrouter") {
    return callOpenRouterSDK({ model, systemPrompt, userPrompt, maxTokens, temperature });
  }

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

// Flash (Gemini 2.0) codegen with Pipes fallback
async function codegenWithFallback(opts) {
  console.log("[weirdbox-lab] Codegen: Flash (gemini-2.0-flash)...");
  const result = await callLLM({ ...opts, model: FLASH_MODEL });
  if (result.text) {
    trackTokens(FLASH_MODEL, "Flash", result.tokens);
    return result;
  }
  console.warn("[weirdbox-lab] Flash failed — falling back to Pipes");
  const fallback = await callLLM({ ...opts, model: PIPES_MODEL, imageBase64: null });
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

const MAOMAI_SOUL = `You are MaoMao — architect for WEIRDBOX. You analyze the current page and plan specific technical improvements. You don't write code, you write precise implementation specs for the coder.

Return ONLY a JSON object:
{"priority_changes": ["specific change 1", "specific change 2", "specific change 3"], "tech_notes": "CSS/JS implementation hints, exact properties/values"}`;

const CODEGEN_SOUL = `You are Flash — fast coder for WEIRDBOX. You receive a plan and apply it to the HTML page precisely.

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
  if (!TARGET_FILE.includes("weirdbox-lab")) {
    console.error("[weirdbox-lab] SAFETY: target path doesn't contain 'weirdbox-lab' — refusing write");
    return false;
  }
  // Strip any previous monitor panel, then re-inject fresh before </body>
  const stripped = html.replace(new RegExp(MONITOR_MARKER_START + "[\\s\\S]*?" + MONITOR_MARKER_END, "g"), "").trim();
  const injected = stripped.includes("</body>")
    ? stripped.replace("</body>", MONITOR_PANEL + "\n</body>")
    : stripped + "\n" + MONITOR_PANEL;
  fs.writeFileSync(TARGET_FILE, injected, "utf8");
  console.log(`[weirdbox-lab] Wrote ${(injected.length/1024).toFixed(1)}KB to weirdbox-lab.html`);
  writeLiveState();
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

  liveState.status = "starting";
  writeLiveState();
  notifyDiscord(`**[weirdbox-lab]** 🚀 **Starting** — ${(budgetMs/60000).toFixed(0)}-min cycle | page: ${(currentHtml.length/1024).toFixed(1)}KB | triggered by: ${triggeredBy}`);
  logAgent("System", "starting", `Build cycle started. Budget: ${(budgetMs/60000).toFixed(0)}min. Page: ${(currentHtml.length/1024).toFixed(1)}KB`);

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

  liveState.status = "building";
  liveState.agents.Candy.status = "vision";
  writeLiveState();
  logAgent("Candy", "vision", `Reviewing page${screenshot ? " (with screenshot)" : " (HTML only)"}...`);

  const vision = await callLLM({
    model: CANDY_MODEL, systemPrompt: CANDY_SOUL,
    userPrompt: candyVisionPrompt,
    imageBase64: screenshot,
    maxTokens: 800, temperature: 0.85, _agent: "Candy",
  });
  trackTokens(CANDY_MODEL, "Candy", vision.tokens);
  if (vision.text) {
    logAgent("Candy", "done", vision.text.slice(0, 180));
    notifyDiscord(`**[weirdbox-lab]** 🍬 **Candy's plan** (${screenshot ? "saw screenshot" : "HTML only"}):\n> ${vision.text.slice(0,400).replace(/\n/g, "\n> ")}`);
  } else {
    logAgent("Candy", "error", "Returned nothing — proceeding without vision direction");
    notifyDiscord("**[weirdbox-lab]** ⚠️ Candy returned nothing — proceeding without vision");
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
    liveState.iteration = iterNum;
    liveState.status = "building";
    logAgent("System", "iteration", `Iteration ${iterNum} — scope: ${scope}, ${timeLeftStr()} left`);

    // 3a. Fire MaoMao architect ASYNC — don't block, let him think while Pipes reviews
    const summary = summarizeHtml(currentHtml);
    liveState.agents.MaoMao.status = "thinking";
    writeLiveState();
    const maomaiPromise = Promise.race([
      callLLM({
        model: MAOMAI_MODEL, systemPrompt: MAOMAI_SOUL,
        userPrompt: `WEIRDBOX Lab page. Scope: ${scope}. Time left: ${timeLeftStr()}.\nPage summary: ${summary}\n\nPlan the next improvements.`,
        maxTokens: 600, temperature: 0.4, _agent: "MaoMao",
      }),
      sleep(MAOMAI_TIMEOUT_MS).then(() => ({ text: "", tokens: 0, timedOut: true })),
    ]);

    // 3b. Pipes review + Candy direction in parallel (while MaoMao thinks)
    liveState.agents.Pipes.status = "reviewing";
    if (iterNum % 2 === 0) liveState.agents.Candy.status = "planning";
    writeLiveState();
    const reviewHtml = currentHtml.length > 6000
      ? currentHtml.slice(0, 3000) + "\n\n<!-- ...middle truncated... -->\n\n" + currentHtml.slice(-3000)
      : currentHtml;

    const [review, candyDir] = await Promise.all([
      callLLM({
        model: PIPES_MODEL, systemPrompt: PIPES_SOUL,
        userPrompt: `Review this WEIRDBOX Lab page. Scope: ${scope}. Time left: ${timeLeftStr()}.\nSummary: ${summary}\n\nHTML:\n${reviewHtml}`,
        maxTokens: 600, temperature: 0.15, _agent: "Pipes",
      }),
      iterNum % 2 === 0
        ? callLLM({
            model: CANDY_MODEL, systemPrompt: CANDY_SOUL,
            userPrompt: `WEIRDBOX Lab — scope: ${scope}, ${timeLeftStr()} left.\nSummary: ${summary}\n\n${vision.text ? `Original direction: ${vision.text.slice(0,200)}\n\n` : ""}Suggest ONE specific ${scope === "polish" ? "polish" : "enhancement"}.`,
            maxTokens: 300, temperature: 0.8, _agent: "Candy",
          })
        : Promise.resolve(null),
    ]);

    trackTokens(PIPES_MODEL, "Pipes", review.tokens);
    if (candyDir) trackTokens(CANDY_MODEL, "Candy", candyDir.tokens);
    if (candyDir?.text) logAgent("Candy", "done", candyDir.text.slice(0,120));

    // 3c. Catch up with MaoMao — give 5 more seconds after Pipes, then move on
    const maomaiResult = await Promise.race([
      maomaiPromise,
      sleep(5000).then(() => ({ text: "", tokens: 0, timedOut: true })),
    ]);
    if (maomaiResult.tokens) trackTokens(MAOMAI_MODEL, "MaoMao", maomaiResult.tokens);
    if (maomaiResult.timedOut || !maomaiResult.text) {
      logAgent("MaoMao", "idle", "Timed out — proceeding without arch plan");
    } else {
      logAgent("MaoMao", "done", maomaiResult.text.slice(0,150));
      notifyDiscord(`**[weirdbox-lab]** 🐱 **MaoMao plan** (iter ${iterNum}):\n> ${maomaiResult.text.slice(0,300).replace(/\n/g, "\n> ")}`);
    }

    let issues = [];
    try {
      const m = review.text?.match(/\[[\s\S]*\]/);
      if (m) issues = JSON.parse(m[0]);
    } catch (_e) { if (review.text) issues = [{ description: review.text.slice(0,300), fix: "See description" }]; }
    logAgent("Pipes", "done", issues.length ? `Found ${issues.length} issue(s): ${issues.map(i=>i.description).join("; ").slice(0,120)}` : "No critical issues");

    if (timeLeft() < budgetMs * 0.08) break;

    // 3d. Build change summary — Pipes + Candy + MaoMao (if ready)
    let changes = "";
    if (issues.length) changes += `PIPES REVIEW — fix these:\n${issues.map(i => `- [${i.type||"issue"}] ${i.description}: ${i.fix}`).join("\n")}\n\n`;
    if (candyDir?.text) changes += `CANDY DIRECTION:\n${candyDir.text}\n\n`;
    if (maomaiResult.text) {
      let archPlan = null;
      try { archPlan = JSON.parse(maomaiResult.text.match(/\{[\s\S]*\}/)?.[0]); } catch (_e) { /* ignore */ }
      if (archPlan?.priority_changes?.length) {
        changes += `MAOMAI ARCH PLAN:\n${archPlan.priority_changes.map(c => `- ${c}`).join("\n")}`;
        if (archPlan.tech_notes) changes += `\nTech notes: ${archPlan.tech_notes}`;
        changes += "\n\n";
      } else if (maomaiResult.text) {
        changes += `MAOMAI NOTES:\n${maomaiResult.text.slice(0,300)}\n\n`;
      }
    }
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

    // 3e. Flash codegen (Gemini 2.0 → Pipes fallback)
    liveState.agents.Flash.status = "coding";
    writeLiveState();
    logAgent("Flash", "coding", `Applying changes (${scope}) — ${(currentHtml.length/1024).toFixed(1)}KB page`);
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
        logAgent("Flash", "done", `DIFF applied. New size: ${(currentHtml.length/1024).toFixed(1)}KB`);
        updated = true;
        consecutiveFailures = 0;
      }
    }

    if (!updated) {
      const newHtml = extractHtml(applyResult.text);
      if (isValidHtml(newHtml) && newHtml.length > currentHtml.length * 0.5) {
        currentHtml = newHtml;
        writeLabFile(currentHtml);
        logAgent("Flash", "done", `Full rewrite. New size: ${(currentHtml.length/1024).toFixed(1)}KB`);
        consecutiveFailures = 0;
      } else {
        logAgent("Flash", "error", `Output rejected — keeping current ${(currentHtml.length/1024).toFixed(1)}KB`);
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
      liveState.agents.Llama.status = "polishing";
      writeLiveState();
      logAgent("Llama", "polishing", `Polish pass — ${(currentHtml.length/1024).toFixed(1)}KB`);
      if (currentHtml.length > 20000 && llamaResult.text?.includes("<<<SEARCH")) {
        const patched = applyDiff(currentHtml, llamaResult.text);
        if (patched) { currentHtml = patched; writeLabFile(currentHtml); logAgent("Llama", "done", `Patch applied. ${(currentHtml.length/1024).toFixed(1)}KB`); }
        else { logAgent("Llama", "idle", "Patch failed — kept current"); }
      } else {
        const llamaHtml = extractHtml(llamaResult.text);
        if (isValidHtml(llamaHtml) && llamaHtml.length > currentHtml.length * 0.6) {
          currentHtml = llamaHtml;
          writeLabFile(currentHtml);
          logAgent("Llama", "done", `Full polish applied. ${(currentHtml.length/1024).toFixed(1)}KB`);
        } else {
          logAgent("Llama", "idle", "Output rejected — kept current");
        }
      }
    }

    // Guardrails
    if (consecutiveFailures >= 3) {
      console.warn("[weirdbox-lab] 3 failures in a row — stopping early");
      notifyDiscord(`**[weirdbox-lab]** ⚠️ 3 consecutive failures — stopping early at iter ${iterNum}`);
      break;
    }
    if (totalTokens > 400000) {
      console.warn("[weirdbox-lab] Token budget hit — stopping");
      notifyDiscord(`**[weirdbox-lab]** ⚠️ Token budget hit (${totalTokens.toLocaleString()} tokens) — stopping`);
      break;
    }

    snapshotIteration();

    // Per-iteration status every 2 iterations
    if (iterNum % 2 === 0) {
      notifyDiscord(`**[weirdbox-lab]** ⚡ **Iter ${iterNum}** | scope: ${scope} | ${timeLeftStr()} left | ${(currentHtml.length/1024).toFixed(1)}KB | $${totalCost.toFixed(4)}`);
    }
  }

  // ── Finalize ─────────────────────────────────────────────────────
  liveState.status = "complete";
  Object.keys(liveState.agents).forEach(a => { liveState.agents[a].status = "idle"; });
  logAgent("System", "complete", `Build cycle done.`);
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

  notifyDiscord([
    `**[weirdbox-lab]** ✅ **Cycle complete**`,
    `⏱ ${duration} min | 🔁 ${iterNum} iterations | 📄 ${(currentHtml.length/1024).toFixed(1)}KB | 💰 $${totalCost.toFixed(4)} | 🔢 ${totalTokens.toLocaleString()} tokens`,
    `👁 Candy (gemini-3.1-flash) | 🔍 Pipes | 🐱 MaoMao (qwen-30b) | ⚡ Flash (gemini-2.0) | 🦙 Llama`,
  ].join("\n"));
}

build().catch(e => {
  console.error(`[weirdbox-lab] Fatal: ${e.message}`);
  notifyDiscord(`**[weirdbox-lab]** ❌ **Fatal error:** ${e.message.slice(0,200)}`);
  process.exit(1);
});
