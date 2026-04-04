#!/usr/bin/env node
// NemoClaw Bridge Monitor — real-time web dashboard
// Usage: node monitor.js [port]   (default port: 7337)

const http   = require("http");
const fs     = require("fs");
const os     = require("os");
const { execFileSync, execSync } = require("child_process");

const PORT = parseInt(process.argv[2] || process.env.MONITOR_PORT || "7337", 10);
const DISCORD_LOG  = "/tmp/discord-bridge.log";
const TELEGRAM_LOG = "/tmp/telegram-bridge.log";

// ── Helpers ─────────────────────────────────────────────────────

function getComfyHost() {
  try {
    const m = fs.readFileSync("/etc/resolv.conf", "utf-8").match(/^nameserver\s+(\S+)/m);
    return m ? m[1] : "172.20.224.1";
  } catch { return "172.20.224.1"; }
}

function httpGet(hostname, port, path, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ hostname, port, path, timeout: timeoutMs }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ ok: true, body: d, status: res.statusCode }));
    });
    req.on("error", () => resolve({ ok: false, body: "" }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, body: "" }); });
  });
}

function checkComfyUI() {
  return httpGet(getComfyHost(), 8188, "/system_stats").then(r => {
    if (!r.ok) return { ok: false };
    try {
      const s = JSON.parse(r.body);
      return {
        ok: true,
        vram_free:  s.system?.vram_free,
        vram_total: s.system?.vram_total,
        ram_free:   s.system?.ram_free,
        ram_total:  s.system?.ram_total,
      };
    } catch { return { ok: true }; }
  });
}

function checkComfyQueue() {
  return httpGet(getComfyHost(), 8188, "/queue").then(r => {
    if (!r.ok) return { running: 0, pending: 0 };
    try {
      const q = JSON.parse(r.body);
      return {
        running: (q.queue_running || []).length,
        pending: (q.queue_pending || []).length,
      };
    } catch { return { running: 0, pending: 0 }; }
  });
}

function getGPUStats() {
  try {
    // Try nvidia-smi via cmd.exe (WSL → Windows GPU)
    const raw = execSync(
      'cmd.exe /c "nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,power.limit --format=csv,noheader,nounits 2>nul"',
      { encoding: "utf-8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (!raw) return null;
    const parts = raw.split(",").map(s => s.trim());
    return {
      name:      parts[0] || "GPU",
      temp:      parseFloat(parts[1]) || 0,
      gpu_util:  parseFloat(parts[2]) || 0,
      mem_util:  parseFloat(parts[3]) || 0,
      mem_used:  parseFloat(parts[4]) || 0,
      mem_total: parseFloat(parts[5]) || 0,
      power:     parseFloat(parts[6]) || 0,
      power_max: parseFloat(parts[7]) || 0,
    };
  } catch {
    return null;
  }
}

function checkProcess(scriptName) {
  try {
    const out = execFileSync("pgrep", ["-fa", scriptName], { encoding: "utf-8" }).trim();
    const lines = out.split("\n").filter(l => l.includes(scriptName) && !l.includes("pgrep"));
    if (!lines.length) return null;
    const pid = parseInt(lines[0].trim().split(/\s+/)[0]);
    return { pid, uptime: null };
  } catch { return null; }
}

function checkSandbox() {
  try {
    const out = execFileSync("nemoclaw", ["status", "--json"], { encoding: "utf-8", timeout: 5000 });
    const d = JSON.parse(out);
    return { ok: d.running === true || d.status === "running" };
  } catch { return { ok: false }; }
}

function tailLog(logPath, lines = 300) {
  try {
    const data = fs.readFileSync(logPath, "utf-8");
    const all = data.split("\n");
    return all.slice(-lines).join("\n");
  } catch { return ""; }
}

// ── API call tracking from log ───────────────────────────────────

const API_PATTERNS = [
  { re: /\[video\] submitted:/,           api: "ComfyUI",    label: "LTX Video submit",   type: "video"  },
  { re: /\[video\] done:/,                api: "ComfyUI",    label: "LTX Video done",      type: "video"  },
  { re: /\[video\] failed:/,              api: "ComfyUI",    label: "LTX Video FAILED",    type: "error"  },
  { re: /\[music\] submitting to ComfyUI/,api: "ComfyUI",    label: "ACE-Step submit",     type: "music"  },
  { re: /\[music\] done:/,               api: "ComfyUI",    label: "ACE-Step done",        type: "music"  },
  { re: /\[music\] failed:/,             api: "ComfyUI",    label: "ACE-Step FAILED",      type: "error"  },
  { re: /\[comfy\] VRAM freed/,          api: "ComfyUI",    label: "VRAM free",            type: "comfy"  },
  { re: /\[img2img\] asset uploaded/,    api: "NVIDIA",     label: "NVIDIA asset upload",  type: "img"    },
  { re: /\[img2img\] pushed input image/,api: "Internal",   label: "Image to sandbox",     type: "img"    },
  { re: /ComfyUI upload failed/,         api: "ComfyUI",    label: "Upload FAILED",        type: "error"  },
  { re: /\[agent\]/,                     api: "OpenClaw",   label: "Agent response",       type: "agent"  },
  { re: /replicate\.com|replicate_api/i, api: "Replicate",  label: "Replicate API call",   type: "img"    },
  { re: /nvidia\.com|nvcf\.nvidia/i,     api: "NVIDIA API", label: "NVIDIA API call",      type: "img"    },
];

const apiCallLog = []; // rolling buffer of recent API events

function parseLogForApiCalls(logText) {
  const lines = logText.split("\n").filter(Boolean);
  const calls = [];
  const counts = { video: 0, music: 0, img: 0, agent: 0, error: 0, comfy: 0 };

  for (const line of lines) {
    for (const p of API_PATTERNS) {
      if (p.re.test(line)) {
        calls.push({ api: p.api, label: p.label, type: p.type, line: line.slice(0, 120) });
        counts[p.type] = (counts[p.type] || 0) + 1;
        break;
      }
    }
  }
  return { calls: calls.slice(-50), counts };
}

function parseJobState(logText) {
  const lines = logText.split("\n").filter(Boolean);
  const recent = [];

  for (const line of lines) {
    if (/^\[(?!agent\]|video\]|music\]|comfy\]|img)/.test(line)) {
      const m = line.match(/^\[(.+?)\] (.+)$/);
      if (m) recent.push({ user: m[1], text: m[2].slice(0, 120) });
    }
  }

  const lastLines = lines.slice(-40).join("\n");
  const activeVideo = lastLines.includes("[video] submitted:") && !lastLines.includes("[video] done:") && !lastLines.includes("[video] failed:");
  const activeMusic = lastLines.includes("[music] submitting") && !lastLines.includes("[music] done:") && !lastLines.includes("[music] failed:");

  return { recent: recent.slice(-12), active: { video: activeVideo, music: activeMusic } };
}

// ── SSE log streaming ────────────────────────────────────────────

const sseClients = new Set();
let logWatcher = null;
let logPos = 0;

function startLogWatch() {
  if (logWatcher) return;
  try { logPos = fs.statSync(DISCORD_LOG).size; } catch { logPos = 0; }

  logWatcher = fs.watch(DISCORD_LOG, { persistent: false }, () => {
    try {
      const stat = fs.statSync(DISCORD_LOG);
      if (stat.size < logPos) logPos = 0;
      if (stat.size <= logPos) return;
      const fd = fs.openSync(DISCORD_LOG, "r");
      const buf = Buffer.alloc(stat.size - logPos);
      fs.readSync(fd, buf, 0, buf.length, logPos);
      fs.closeSync(fd);
      logPos = stat.size;
      const text = buf.toString("utf-8");
      for (const res of sseClients) {
        try {
          text.split("\n").filter(Boolean).forEach(line => {
            res.write(`data: ${JSON.stringify(line)}\n\n`);
          });
        } catch {}
      }
    } catch {}
  });
}

// ── Status API ───────────────────────────────────────────────────

async function getStatus() {
  const [comfy, comfyQ] = await Promise.all([checkComfyUI(), checkComfyQueue()]);
  const sandbox  = checkSandbox();
  const discord  = checkProcess("discord-bridge.js");
  const telegram = checkProcess("telegram-bridge.js");
  const gpu      = getGPUStats();
  const logText  = tailLog(DISCORD_LOG, 400);
  const jobState = parseJobState(logText);
  const apiState = parseLogForApiCalls(logText);
  const gb = n => n ? `${(n / 1024).toFixed(1)} GB` : "?";

  return {
    ts: new Date().toISOString(),
    services: {
      discord:  discord  ? { ok: true, pid: discord.pid   } : { ok: false },
      telegram: telegram ? { ok: true, pid: telegram.pid  } : { ok: false },
      sandbox:  { ok: sandbox.ok },
      comfyui:  comfy.ok
        ? { ok: true, vram: comfy.vram_total ? `${gb(comfy.vram_free)} / ${gb(comfy.vram_total)} free` : "online",
            queue: comfyQ }
        : { ok: false },
    },
    gpu,
    active: jobState.active,
    recent: jobState.recent,
    apiCalls: apiState.calls.slice(-20),
    apiCounts: apiState.counts,
    logTail: logText.split("\n").slice(-100).join("\n"),
  };
}

// ── HTML Dashboard ───────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MrBigPipes AI — Monitor</title>
<style>
  :root {
    --bg: #0a0a0a; --bg2: #111; --bg3: #1a1a1a; --bg4: #222;
    --border: #252525; --text: #ccc; --muted: #555;
    --green: #3ddc84; --red: #e05252; --yellow: #e0b84e;
    --blue: #4a9eff; --purple: #a78bfa; --cyan: #22d3ee;
    --orange: #fb923c; --pink: #f472b6;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Cascadia Code','Fira Code','Consolas',monospace; font-size: 12px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

  header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 8px 14px; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  header h1 { font-size: 13px; font-weight: 700; color: #fff; letter-spacing: .5px; }
  .conn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1}50%{opacity:.3} }
  .ts { margin-left: auto; color: var(--muted); font-size: 11px; }

  .main { display: grid; grid-template-columns: 220px 1fr 280px; flex: 1; overflow: hidden; gap: 0; }

  /* Left column */
  .left { display: flex; flex-direction: column; border-right: 1px solid var(--border); overflow: hidden; }

  /* Center column */
  .center { display: flex; flex-direction: column; overflow: hidden; }

  /* Right column */
  .right { display: flex; flex-direction: column; border-left: 1px solid var(--border); overflow: hidden; }

  .panel { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .panel:last-child { border-bottom: none; }
  .panel-fill { flex: 1; overflow: hidden; display: flex; flex-direction: column; padding: 10px 12px; }
  .ptitle { font-size: 9px; font-weight: 700; letter-spacing: 1.8px; color: var(--muted); text-transform: uppercase; margin-bottom: 8px; flex-shrink: 0; }

  /* Service dots */
  .svc { display: flex; align-items: center; gap: 7px; padding: 5px 7px; border-radius: 5px; background: var(--bg2); margin-bottom: 3px; }
  .sdot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .ok   { background: var(--green); box-shadow: 0 0 4px var(--green); }
  .fail { background: var(--red);   box-shadow: 0 0 4px var(--red); }
  .svc-name { flex: 1; color: #ddd; font-size: 11px; }
  .svc-meta { color: var(--muted); font-size: 10px; text-align: right; }

  /* GPU panel */
  .gpu-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
  .gpu-stat { background: var(--bg2); border-radius: 5px; padding: 6px 8px; }
  .gpu-val { font-size: 17px; font-weight: 700; color: #fff; line-height: 1; }
  .gpu-label { font-size: 9px; color: var(--muted); margin-top: 2px; text-transform: uppercase; letter-spacing: .8px; }
  .bar-wrap { background: var(--bg3); border-radius: 3px; height: 4px; margin-top: 5px; overflow: hidden; }
  .bar { height: 100%; border-radius: 3px; transition: width .5s; }
  .bar-green  { background: var(--green); }
  .bar-orange { background: var(--orange); }
  .bar-red    { background: var(--red); }
  .bar-blue   { background: var(--blue); }
  .gpu-name { font-size: 10px; color: var(--cyan); margin-bottom: 7px; font-weight: 600; }
  .gpu-offline { color: var(--muted); font-style: italic; font-size: 11px; }

  /* Jobs */
  .job { display: flex; align-items: center; gap: 7px; padding: 5px 7px; border-radius: 5px; background: var(--bg2); margin-bottom: 3px; }
  .job-name { flex: 1; color: #ccc; font-size: 11px; }
  .badge-run { background: rgba(61,220,132,.12); border: 1px solid rgba(61,220,132,.3); color: var(--green); padding: 1px 7px; border-radius: 3px; font-size: 10px; display:flex;align-items:center;gap:4px; }
  .badge-run::before { content:''; display:inline-block; width:5px; height:5px; border-radius:50%; background:var(--green); animation:pulse 1s infinite; }
  .badge-idle { color: var(--muted); font-size: 10px; }

  /* Counters */
  .counters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
  .counter { background: var(--bg2); border-radius: 5px; padding: 5px 7px; text-align: center; }
  .counter-val { font-size: 18px; font-weight: 700; color: #fff; line-height: 1; }
  .counter-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: .8px; margin-top: 1px; }

  /* Recent msgs */
  .msg { padding: 5px 0; border-bottom: 1px solid var(--border); }
  .msg:last-child { border-bottom: none; }
  .msg-user { color: var(--purple); font-weight: 700; font-size: 11px; }
  .msg-text { color: var(--text); margin-top: 1px; word-break: break-word; white-space: pre-wrap; font-size: 11px; }

  /* Log */
  #log-output { flex: 1; overflow-y: auto; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
  #log-output::-webkit-scrollbar { width: 3px; }
  #log-output::-webkit-scrollbar-thumb { background: var(--border); }
  .ll { padding: 0 3px; }
  .ll:hover { background: var(--bg3); }
  .ll-user  { color: var(--purple); }
  .ll-agent { color: var(--cyan); }
  .ll-video { color: var(--orange); }
  .ll-music { color: var(--pink); }
  .ll-img   { color: var(--blue); }
  .ll-error { color: var(--red); background: rgba(224,82,82,.05); }
  .ll-warn  { color: var(--yellow); }
  .ll-ok    { color: var(--green); }
  .ll-comfy { color: #6ee7b7; }
  .ll-muted { color: var(--muted); }
  .ll-def   { color: var(--text); }

  /* API activity */
  .api-feed { flex: 1; overflow-y: auto; }
  .api-feed::-webkit-scrollbar { width: 3px; }
  .api-feed::-webkit-scrollbar-thumb { background: var(--border); }
  .api-item { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid #1a1a1a; font-size: 10px; }
  .api-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
  .api-name { color: var(--cyan); font-weight: 600; min-width: 65px; }
  .api-label { color: var(--text); flex: 1; }
  .api-video { background: var(--orange); }
  .api-music { background: var(--pink); }
  .api-img   { background: var(--blue); }
  .api-agent { background: var(--cyan); }
  .api-error { background: var(--red); }
  .api-comfy { background: #6ee7b7; }

  .log-header { display: flex; align-items: center; }
  .autoscroll { margin-left: auto; font-size: 10px; color: var(--muted); cursor: pointer; user-select: none; padding: 2px 6px; border-radius: 3px; background: var(--bg2); }
  .autoscroll.on { color: var(--green); }

  .no-data { color: var(--muted); font-style: italic; font-size: 11px; }

  .comfy-queue { font-size: 10px; color: var(--yellow); }
</style>
</head>
<body>
<header>
  <div class="conn-dot" id="conn-dot"></div>
  <h1>MrBigPipes AI — Monitor</h1>
  <span class="ts" id="ts">—</span>
</header>

<div class="main">

  <!-- LEFT: Services + GPU + Jobs -->
  <div class="left">

    <div class="panel">
      <div class="ptitle">Services</div>
      <div id="services"><div class="no-data">Loading...</div></div>
    </div>

    <div class="panel">
      <div class="ptitle">GPU</div>
      <div id="gpu"><div class="no-data">Querying nvidia-smi...</div></div>
    </div>

    <div class="panel">
      <div class="ptitle">Active Jobs</div>
      <div id="jobs"></div>
    </div>

    <div class="panel">
      <div class="ptitle">Session Totals</div>
      <div id="counters" class="counters"></div>
    </div>

  </div>

  <!-- CENTER: Live log -->
  <div class="center">
    <div class="panel-fill">
      <div class="ptitle log-header">
        Live Log
        <span class="autoscroll on" id="as-toggle" onclick="toggleAS()">⬇ Auto</span>
      </div>
      <div id="log-output"></div>
    </div>
  </div>

  <!-- RIGHT: Recent messages + API activity -->
  <div class="right">

    <div class="panel" style="max-height:220px;overflow-y:auto">
      <div class="ptitle">Recent Messages</div>
      <div id="msgs"><div class="no-data">No messages yet</div></div>
    </div>

    <div class="panel-fill">
      <div class="ptitle">API Activity</div>
      <div id="api-feed" class="api-feed"><div class="no-data">No calls yet</div></div>
    </div>

  </div>

</div>

<script>
let autoscroll = true;
const logOut = document.getElementById('log-output');

function toggleAS() {
  autoscroll = !autoscroll;
  const el = document.getElementById('as-toggle');
  el.textContent = autoscroll ? '⬇ Auto' : '— Paused';
  el.className = 'autoscroll ' + (autoscroll ? 'on' : '');
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function classLine(line) {
  if (line.startsWith('[agent]'))  return 'll-agent';
  if (line.startsWith('[video]'))  return 'll-video';
  if (line.startsWith('[music]'))  return 'll-music';
  if (line.startsWith('[img'))     return 'll-img';
  if (line.startsWith('[comfy]'))  return 'll-comfy';
  if (/error|failed|exception/i.test(line)) return 'll-error';
  if (/warn|deprecated/i.test(line)) return 'll-warn';
  if (/ready|running|started|connected|restored|done:/i.test(line)) return 'll-ok';
  if (/^\\s*[│┌└├]/.test(line)) return 'll-muted';
  if (/^\\[/.test(line)) return 'll-user';
  return 'll-def';
}

function appendLine(line) {
  if (!line.trim()) return;
  const div = document.createElement('div');
  div.className = 'll ' + classLine(line);
  div.textContent = line;
  logOut.appendChild(div);
  while (logOut.children.length > 600) logOut.removeChild(logOut.firstChild);
  if (autoscroll) logOut.scrollTop = logOut.scrollHeight;
}

// Initial log load
fetch('/log').then(r => r.text()).then(text => {
  logOut.innerHTML = '';
  text.split('\\n').forEach(appendLine);
  if (autoscroll) logOut.scrollTop = logOut.scrollHeight;
});

// SSE live stream
const sse = new EventSource('/stream');
sse.onmessage = e => { try { appendLine(JSON.parse(e.data)); } catch {} };
sse.onopen  = () => { document.getElementById('conn-dot').style.background = 'var(--green)'; document.getElementById('conn-dot').style.boxShadow = '0 0 6px var(--green)'; };
sse.onerror = () => { document.getElementById('conn-dot').style.background = 'var(--red)'; document.getElementById('conn-dot').style.boxShadow = '0 0 6px var(--red)'; };

// ── Render functions ────────────────────────────────────────────

function renderServices(s) {
  const names = { discord: 'Discord Bridge', telegram: 'Telegram Bridge', sandbox: 'Sandbox', comfyui: 'ComfyUI' };
  return Object.entries(s).map(([k, v]) => {
    let meta = '';
    if (v.pid)  meta = \`<span class="svc-meta" style="color:var(--cyan)">pid \${v.pid}</span>\`;
    if (v.vram) meta = \`<span class="svc-meta">\${v.vram}</span>\`;
    if (v.queue && (v.queue.running || v.queue.pending))
      meta += \`<span class="comfy-queue"> [\${v.queue.running}R \${v.queue.pending}P]</span>\`;
    return \`<div class="svc">
      <div class="sdot \${v.ok ? 'ok' : 'fail'}"></div>
      <span class="svc-name">\${names[k]||k}</span>
      \${meta}
    </div>\`;
  }).join('');
}

function barColor(pct) {
  if (pct > 90) return 'bar-red';
  if (pct > 70) return 'bar-orange';
  return 'bar-green';
}

function renderGPU(gpu) {
  if (!gpu) return '<div class="gpu-offline">nvidia-smi unavailable</div>';
  const memPct = gpu.mem_total ? Math.round(gpu.mem_used / gpu.mem_total * 100) : 0;
  const pwrPct = gpu.power_max ? Math.round(gpu.power / gpu.power_max * 100) : 0;
  return \`
    <div class="gpu-name">\${gpu.name}</div>
    <div class="gpu-grid">
      <div class="gpu-stat">
        <div class="gpu-val" style="color:\${gpu.gpu_util>80?'var(--orange)':'#fff'}">\${gpu.gpu_util}%</div>
        <div class="gpu-label">GPU Util</div>
        <div class="bar-wrap"><div class="bar \${barColor(gpu.gpu_util)}" style="width:\${gpu.gpu_util}%"></div></div>
      </div>
      <div class="gpu-stat">
        <div class="gpu-val" style="color:\${gpu.temp>80?'var(--red)':gpu.temp>70?'var(--orange)':'#fff'}">\${gpu.temp}°C</div>
        <div class="gpu-label">Temp</div>
        <div class="bar-wrap"><div class="bar \${gpu.temp>80?'bar-red':gpu.temp>70?'bar-orange':'bar-blue'}" style="width:\${Math.min(gpu.temp/100*100,100)}%"></div></div>
      </div>
      <div class="gpu-stat">
        <div class="gpu-val" style="color:\${memPct>90?'var(--red)':memPct>75?'var(--orange)':'#fff'">\${gpu.mem_used.toFixed(0)}M</div>
        <div class="gpu-label">VRAM \${memPct}%</div>
        <div class="bar-wrap"><div class="bar \${barColor(memPct)}" style="width:\${memPct}%"></div></div>
      </div>
      <div class="gpu-stat">
        <div class="gpu-val">\${gpu.power.toFixed(0)}W</div>
        <div class="gpu-label">Power \${pwrPct}%</div>
        <div class="bar-wrap"><div class="bar bar-blue" style="width:\${pwrPct}%"></div></div>
      </div>
    </div>
  \`;
}

function renderJobs(active) {
  const badge = on => on
    ? '<span class="badge-run">running</span>'
    : '<span class="badge-idle">idle</span>';
  return \`
    <div class="job"><span class="job-name">🎬 LTX 2.3 Video</span>\${badge(active.video)}</div>
    <div class="job"><span class="job-name">🎵 ACE-Step Music</span>\${badge(active.music)}</div>
  \`;
}

function renderCounters(c) {
  const items = [
    { val: c.video||0,  label: 'Videos',  color: 'var(--orange)' },
    { val: c.music||0,  label: 'Songs',   color: 'var(--pink)'   },
    { val: c.img||0,    label: 'Images',  color: 'var(--blue)'   },
    { val: c.agent||0,  label: 'Replies', color: 'var(--cyan)'   },
    { val: c.error||0,  label: 'Errors',  color: 'var(--red)'    },
    { val: c.comfy||0,  label: 'VRAM ops',color: '#6ee7b7'       },
  ];
  return items.map(i => \`
    <div class="counter">
      <div class="counter-val" style="color:\${i.color}">\${i.val}</div>
      <div class="counter-label">\${i.label}</div>
    </div>
  \`).join('');
}

function renderMsgs(recent) {
  if (!recent.length) return '<div class="no-data">No messages yet</div>';
  return [...recent].reverse().slice(0, 8).map(m => \`
    <div class="msg">
      <div class="msg-user">@\${esc(m.user)}</div>
      <div class="msg-text">\${esc(m.text)}</div>
    </div>
  \`).join('');
}

const API_COLORS = { video:'api-video', music:'api-music', img:'api-img', agent:'api-agent', error:'api-error', comfy:'api-comfy' };

function renderAPI(calls) {
  if (!calls.length) return '<div class="no-data">No API calls yet</div>';
  return [...calls].reverse().map(c => \`
    <div class="api-item">
      <div class="api-dot \${API_COLORS[c.type]||''}"></div>
      <span class="api-name">\${esc(c.api)}</span>
      <span class="api-label">\${esc(c.label)}</span>
    </div>
  \`).join('');
}

// ── Poll status ─────────────────────────────────────────────────

async function loadStatus() {
  try {
    const d = await fetch('/status').then(r => r.json());
    document.getElementById('ts').textContent = new Date(d.ts).toLocaleTimeString();
    document.getElementById('services').innerHTML = renderServices(d.services);
    document.getElementById('gpu').innerHTML = renderGPU(d.gpu);
    document.getElementById('jobs').innerHTML = renderJobs(d.active);
    document.getElementById('counters').innerHTML = renderCounters(d.apiCounts);
    document.getElementById('msgs').innerHTML = renderMsgs(d.recent);
    document.getElementById('api-feed').innerHTML = renderAPI(d.apiCalls);
  } catch(e) {
    document.getElementById('ts').textContent = 'fetch error';
  }
}

loadStatus();
setInterval(loadStatus, 3000); // refresh every 3s for live GPU
</script>
</body>
</html>`;

// ── HTTP Server ──────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }

  if (url === "/status") {
    try {
      const status = await getStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url === "/log") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(tailLog(DISCORD_LOG, 300));
    return;
  }

  if (url === "/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    startLogWatch();
    req.on("close", () => sseClients.delete(res));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  ┌──────────────────────────────────────────────┐`);
  console.log(`  │  MrBigPipes AI — Monitor                     │`);
  console.log(`  │                                              │`);
  console.log(`  │  http://localhost:${PORT}                    │`);
  console.log(`  └──────────────────────────────────────────────┘\n`);
});
