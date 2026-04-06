#!/usr/bin/env node
"use strict";

/**
 * system-healthcheck.js — MaoMao's system integrity watchdog
 *
 * Detects stale paths, missing deps, broken env vars, crash-looping processes.
 * Reports issues through MaoMao's Discord reaction server.
 *
 * Run: node scripts/system-healthcheck.js
 * Cron: every 2 hours
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execSync } = require("child_process");

const SCRIPTS_DIR = path.join(__dirname);
const ENV_FILE = path.join(os.homedir(), ".nemoclaw_env");
const MAOMAI_PORT = 7702;
const REPORT_CHANNEL = process.env.DISCORD_CHANNEL_ID || "915789984282325016";

// ── Checks ──────────────────────────────────────────────────────────

const issues = [];

function check(label, fn) {
  try {
    const result = fn();
    if (result) issues.push(`${label}: ${result}`);
  } catch (e) {
    issues.push(`${label}: ${e.message}`);
  }
}

// 1. Chromium binary — find what scripts expect vs what exists
function checkChromiumPaths() {
  const chromiumDirs = [];
  try {
    const entries = fs.readdirSync(path.join(os.homedir(), ".cache", "ms-playwright"));
    for (const e of entries) {
      if (e.startsWith("chromium-")) chromiumDirs.push(e);
    }
  } catch { return "playwright cache directory not found"; }

  if (chromiumDirs.length === 0) return "no chromium installations found";

  const latest = chromiumDirs.sort().pop();
  const latestPath = path.join(os.homedir(), ".cache", "ms-playwright", latest, "chrome-linux64", "chrome");
  if (!fs.existsSync(latestPath)) return `${latest} exists but chrome binary missing`;

  // Check all scripts for stale chromium paths
  const stale = [];
  const scripts = ["grok-server.js", "grok-imagine.js", "grok-login-once.js", "suno-login-once.js", "captcha-solver.js"];
  for (const s of scripts) {
    const fp = path.join(SCRIPTS_DIR, s);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, "utf8");
    const m = content.match(/chromium-(\d+)/);
    if (m && `chromium-${m[1]}` !== latest) {
      stale.push(`${s} → chromium-${m[1]} (should be ${latest})`);
    }
  }
  if (stale.length) return `stale chromium paths:\n${stale.join("\n")}`;
  return null;
}

// 2. playwright-core module path
function checkPlaywrightCore() {
  const scripts = ["captcha-solver.js", "suno-login-once.js"];
  const problems = [];
  for (const s of scripts) {
    const fp = path.join(SCRIPTS_DIR, s);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, "utf8");
    const m = content.match(/require\(["']([^"']*playwright-core[^"']*)["']\)/);
    if (m && m[1] !== "playwright-core") {
      // Hardcoded path — check it exists
      if (!fs.existsSync(m[1])) {
        problems.push(`${s}: playwright-core path doesn't exist: ${m[1]}`);
      }
    }
  }
  return problems.length ? problems.join("\n") : null;
}

// 3. Required env vars
function checkEnvVars() {
  const envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const envMap = {};
  for (const line of envContent.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) envMap[m[1]] = m[2];
  }

  const required = [
    "DISCORD_BOT_TOKEN", "NVIDIA_API_KEY", "BRAVE_API_KEY",
    "OPENROUTER_API_KEY", "GOOGLE_API_KEY", "SUNO_REFRESH_TOKEN",
  ];
  const missing = required.filter(k => !envMap[k] && !process.env[k]);
  if (missing.length) return `missing env vars: ${missing.join(", ")}`;
  return null;
}

// 4. Critical file paths from env
function checkFilePaths() {
  const envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const problems = [];
  const pathVars = ["ZTURBO_WORKFLOW_PATH", "GDRIVE_SA_KEY"];
  for (const v of pathVars) {
    const m = envContent.match(new RegExp(`^${v}=(.+)$`, "m"));
    if (m && m[1] && !fs.existsSync(m[1].trim())) {
      problems.push(`${v}=${m[1].trim()} — file not found`);
    }
  }
  return problems.length ? problems.join("\n") : null;
}

// 5. Syntax check critical scripts
function checkSyntax() {
  const scripts = ["discord-bridge.js", "suno.js", "captcha-solver.js", "maomai.js", "candy.js"];
  const broken = [];
  for (const s of scripts) {
    const fp = path.join(SCRIPTS_DIR, s);
    if (!fs.existsSync(fp)) continue;
    try {
      execSync(`node -c "${fp}" 2>&1`, { timeout: 10000 });
    } catch (e) {
      broken.push(`${s}: syntax error`);
    }
  }
  return broken.length ? broken.join("\n") : null;
}

// 6. PM2 crash-looping processes
function checkPM2() {
  try {
    const list = JSON.parse(execSync("pm2 jlist 2>/dev/null", { timeout: 10000 }).toString());
    const problems = [];
    for (const p of list) {
      if (p.pm2_env?.status === "online" && p.pm2_env?.restart_time > 20) {
        problems.push(`${p.name}: ${p.pm2_env.restart_time} restarts (possible crash loop)`);
      }
      if (p.pm2_env?.status === "errored") {
        problems.push(`${p.name}: status=errored`);
      }
    }
    return problems.length ? problems.join("\n") : null;
  } catch { return null; }
}

// 7. Disk space
function checkDisk() {
  try {
    const out = execSync("df -h / 2>/dev/null | tail -1", { timeout: 5000 }).toString();
    const m = out.match(/(\d+)%/);
    if (m && parseInt(m[1]) > 90) return `disk usage at ${m[1]}%`;
  } catch {}
  return null;
}

// 8. Log-based error detection (buttons, APIs, features)
function checkLogs() {
  const LOG_WINDOW = 5 * 60 * 1000; // look at last 5 minutes of logs
  const problems = [];

  // Read recent PM2 logs
  let errLog = "", outLog = "";
  try { errLog = fs.readFileSync(path.join(os.homedir(), ".pm2/logs/discord-bridge-error.log"), "utf8"); } catch {}
  try { outLog = fs.readFileSync(path.join(os.homedir(), ".pm2/logs/discord-bridge-out.log"), "utf8"); } catch {}
  const logs = errLog + "\n" + outLog;

  // Only look at recent lines (last ~200 lines as proxy for recency)
  const recentLines = logs.split("\n").slice(-200).join("\n");

  // ── Button / interaction failures ──
  const interactionErrors = (recentLines.match(/\[slash\] interaction error: (.+)/g) || []);
  const realErrors = interactionErrors.filter(e =>
    !e.includes("Unknown interaction") // stale buttons from restarts, not real
  );
  if (realErrors.length > 0) {
    const unique = [...new Set(realErrors.map(e => e.replace(/\[slash\] interaction error: /, "")))];
    problems.push(`button/interaction errors: ${unique.join(", ")}`);
  }

  // ── API failures ──
  const apiPatterns = [
    { re: /\[suno\] failed: (.+)/g, name: "Suno" },
    { re: /\[zturbo\] failed: (.+)/g, name: "ZTurbo" },
    { re: /\[grok[^\]]*\] error: (.+)/g, name: "Grok" },
    { re: /\[imagen\].*failed(?! to start): (.+)/g, name: "Imagen" },
    { re: /\[comfyui\].*error: (.+)/gi, name: "ComfyUI" },
    { re: /\[crew\].*timeout/gi, name: "Crew" },
    { re: /\[gdrive\].*error: (.+)/gi, name: "GDrive" },
    { re: /\[buffer\].*error: (.+)/gi, name: "Buffer" },
    { re: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/g, name: "Network" },
  ];
  for (const { re, name } of apiPatterns) {
    const matches = recentLines.match(re) || [];
    if (matches.length >= 2) {
      // 2+ errors of same type = real issue, not a one-off
      problems.push(`${name}: ${matches.length} errors — ${matches[0].slice(0, 120)}`);
    }
  }

  // ── Feature-specific broken patterns ──
  const featurePatterns = [
    { re: /Cannot find module '([^']+)'/g, name: "Missing module" },
    { re: /SUNO_REFRESH_TOKEN not set/g, name: "Suno auth" },
    { re: /No active Suno session/g, name: "Suno session expired" },
    { re: /Clerk client [45]\d{2}/g, name: "Suno/Clerk auth" },
    { re: /chromium.*doesn't exist/g, name: "Chromium path" },
    { re: /ENOENT.*workflow/gi, name: "Workflow file missing" },
  ];
  for (const { re, name } of featurePatterns) {
    const matches = recentLines.match(re) || [];
    if (matches.length > 0) {
      problems.push(`${name}: ${matches[0].slice(0, 100)}`);
    }
  }

  return problems.length ? problems.join("\n") : null;
}

// 9. API endpoint liveness (lightweight, localhost only)
function checkAPIs() {
  const problems = [];
  // Check grok-server (should be on :7700)
  try {
    execSync('curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:7700/health 2>/dev/null', { timeout: 5000 });
  } catch {
    problems.push("grok-server not responding on :7700");
  }
  // Check MaoMao reaction server (should be on :7702)
  try {
    execSync('curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:7702/ 2>/dev/null', { timeout: 4000 });
  } catch {
    // 404 is fine — server is up, just wrong path
  }
  // Check ComfyUI (should be on COMFYUI_HOST:8188)
  const comfyHost = process.env.COMFYUI_HOST || "172.20.224.1";
  try {
    const code = execSync(`curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://${comfyHost}:8188/system_stats 2>/dev/null`, { timeout: 5000 }).toString().trim();
    if (code === "000") problems.push(`ComfyUI not responding on ${comfyHost}:8188`);
  } catch {}
  return problems.length ? problems.join("\n") : null;
}

// ── Run all checks ──────────────────────────────────────────────────

check("🔧 Chromium", checkChromiumPaths);
check("📦 Playwright", checkPlaywrightCore);
check("🔑 Env vars", checkEnvVars);
check("📁 File paths", checkFilePaths);
check("✅ Syntax", checkSyntax);
check("🔄 PM2", checkPM2);
check("💾 Disk", checkDisk);
check("📋 Logs", checkLogs);
check("🌐 APIs", checkAPIs);

// ── Dedup: only report new issues ───────────────────────────────────

const LAST_ISSUES_FILE = path.join(os.homedir(), ".nemoclaw", "healthcheck-last.json");

if (issues.length === 0) {
  // Clear last issues on all-clear
  try { fs.unlinkSync(LAST_ISSUES_FILE); } catch {}
  console.log("[healthcheck] all clear ✅");
  process.exit(0);
}

// Compare to last run — only post if issues changed
const issueKey = issues.sort().join("\n");
let lastKey = "";
try { lastKey = JSON.parse(fs.readFileSync(LAST_ISSUES_FILE, "utf8")).key || ""; } catch {}

if (issueKey === lastKey) {
  console.log(`[healthcheck] ${issues.length} known issue(s), already reported — skipping`);
  process.exit(0);
}

// Save current issues
try { fs.writeFileSync(LAST_ISSUES_FILE, JSON.stringify({ key: issueKey, ts: new Date().toISOString() })); } catch {}

const report = `🐱 **MaoMao System Check** — ${issues.length} issue${issues.length > 1 ? "s" : ""} found:\n\n${issues.map(i => `⚠️ ${i}`).join("\n\n")}`;
console.log(report);

// Post to Discord via MaoMao's reaction server
const payload = JSON.stringify({ channelId: REPORT_CHANNEL, message: report });
const req = http.request({
  hostname: "127.0.0.1",
  port: MAOMAI_PORT,
  path: "/react",
  method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
}, (res) => {
  let b = "";
  res.on("data", d => b += d);
  res.on("end", () => {
    if (res.statusCode === 200) console.log("[healthcheck] reported to Discord via MaoMao");
    else console.warn(`[healthcheck] Discord report failed: ${res.statusCode} ${b}`);
  });
});
req.on("error", (e) => {
  console.warn(`[healthcheck] MaoMao not reachable (${e.message}) — issues logged to console only`);
});
req.write(payload);
req.end();
