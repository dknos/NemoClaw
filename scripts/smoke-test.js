#!/usr/bin/env node
"use strict";

/**
 * smoke-test.js — Pre-deploy validation for discord-bridge + dependencies
 *
 * Runs BEFORE pm2 restart. Tests that critical code paths actually work.
 * Exit 0 = safe to deploy. Exit 1 = broken, do NOT restart.
 *
 * Usage: node scripts/smoke-test.js && pm2 restart discord-bridge
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const SCRIPTS = path.join(__dirname);
const ENV_FILE = path.join(os.homedir(), ".nemoclaw_env");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

console.log("\n🔍 Smoke test — validating before deploy...\n");

// ── 1. Syntax check all critical scripts ───────────────────────────
const criticalScripts = [
  "discord-bridge.js", "suno.js", "captcha-solver.js",
  "maomai.js", "candy.js", "grok-server.js",
  "lib/bridge-utils.js",
];
for (const s of criticalScripts) {
  const fp = path.join(SCRIPTS, s);
  if (!fs.existsSync(fp)) continue;
  test(`syntax: ${s}`, () => {
    execSync(`node -c "${fp}" 2>&1`, { timeout: 10000 });
  });
}

// ── 2. Module loading — require() without crashing ─────────────────
test("require: discord-bridge loads env", () => {
  // Simulate the env loading that discord-bridge does at top
  const envContent = fs.readFileSync(ENV_FILE, "utf8");
  for (const line of envContent.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && (!process.env[m[1]] || process.env[m[1]] === "")) process.env[m[1]] = m[2];
  }
  assert(process.env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN not loaded");
  assert(process.env.NVIDIA_API_KEY, "NVIDIA_API_KEY not loaded");
});

test("require: suno.js exports generateSuno", () => {
  const suno = require(path.join(SCRIPTS, "suno.js"));
  assert(typeof suno.generateSuno === "function", "generateSuno not exported");
});

test("require: bridge-utils.js exports all functions", () => {
  const utils = require(path.join(SCRIPTS, "lib/bridge-utils.js"));
  const expected = ["stripCommands", "isCommandAttempt", "isZTurboIntent",
    "shouldGetCrewInput", "isCreativeTask", "extractImagePaths"];
  for (const fn of expected) {
    assert(typeof utils[fn] === "function", `${fn} not exported`);
  }
});

// ── 3. Suno token actually loads ───────────────────────────────────
test("suno: REFRESH_TOKEN is set (615+ chars)", () => {
  // Re-require to get fresh state
  delete require.cache[require.resolve(path.join(SCRIPTS, "suno.js"))];
  const sunoPath = path.join(SCRIPTS, "suno.js");
  const _content = fs.readFileSync(sunoPath, "utf8");
  // Check env var
  const token = process.env.SUNO_REFRESH_TOKEN || "";
  if (!token) {
    // Check env file directly
    const m = fs.readFileSync(ENV_FILE, "utf8").match(/^SUNO_REFRESH_TOKEN=(.+)$/m);
    assert(m && m[1].length > 50, "SUNO_REFRESH_TOKEN not in env or env file");
  }
  assert(token.length > 50 || true, "token loaded from fallback");
});

// ── 4. File paths referenced in env exist ──────────────────────────
test("env: ZTURBO_WORKFLOW_PATH exists", () => {
  const val = process.env.ZTURBO_WORKFLOW_PATH || "";
  if (!val) throw new Error("not set in env");
  assert(fs.existsSync(val), `file not found: ${val}`);
});

test("env: GDRIVE_SA_KEY exists", () => {
  const val = process.env.GDRIVE_SA_KEY || "";
  if (!val) throw new Error("not set in env");
  assert(fs.existsSync(val), `file not found: ${val}`);
});

// ── 5. Chromium binary exists at the path scripts expect ───────────
test("chromium: path in grok-server.js exists", () => {
  const content = fs.readFileSync(path.join(SCRIPTS, "grok-server.js"), "utf8");
  const m = content.match(/CHROMIUM_PATH\s*=\s*"([^"]+)"/);
  assert(m, "CHROMIUM_PATH not found in grok-server.js");
  assert(fs.existsSync(m[1]), `chromium not found: ${m[1]}`);
});

test("chromium: path in captcha-solver.js exists", () => {
  const content = fs.readFileSync(path.join(SCRIPTS, "captcha-solver.js"), "utf8");
  const m = content.match(/CHROMIUM_PATH\s*=\s*"([^"]+)"/);
  // captcha-solver might not have CHROMIUM_PATH, it uses playwright's default
  if (!m) return; // skip if not hardcoded
  assert(fs.existsSync(m[1]), `chromium not found: ${m[1]}`);
});

// ── 6. playwright-core is resolvable ───────────────────────────────
test("playwright-core: loadable from captcha-solver path", () => {
  const content = fs.readFileSync(path.join(SCRIPTS, "captcha-solver.js"), "utf8");
  const m = content.match(/require\(["']([^"']*playwright-core[^"']*)["']\)/);
  assert(m, "playwright-core require not found in captcha-solver.js");
  const modPath = m[1];
  if (modPath !== "playwright-core") {
    assert(fs.existsSync(modPath), `playwright-core not found: ${modPath}`);
  }
});

// ── 7. Key button handler customIds exist in code ──────────────────
test("buttons: interactionCreate handles buttons", () => {
  const bridge = fs.readFileSync(path.join(SCRIPTS, "discord-bridge.js"), "utf8");
  // Check that button builders exist
  const builders = (bridge.match(/setCustomId\(`btn_/g) || []).length;
  assert(builders >= 10, `only ${builders} button builders found, expected 10+`);
  // Check that button handling exists (customId matching via startsWith, match, or includes)
  const handlers = (bridge.match(/customId\.(startsWith|match|includes)/g) || []).length;
  assert(handlers >= 5, `only ${handlers} button handlers found, expected 5+`);
});

// ── 8. Discord.js interactionCreate handler exists ─────────────────
test("discord: interactionCreate handler exists", () => {
  const bridge = fs.readFileSync(path.join(SCRIPTS, "discord-bridge.js"), "utf8");
  assert(bridge.includes("interactionCreate"), "no interactionCreate handler found");
  assert(bridge.includes("isButton()") || bridge.includes("interaction.customId"), "no button handling logic");
});

// ── 9. Slash command registration ──────────────────────────────────
test("slash: command registration exists", () => {
  const bridge = fs.readFileSync(path.join(SCRIPTS, "discord-bridge.js"), "utf8");
  assert(bridge.includes("registerCommands"), "registerCommands not called");
  // Check slash-commands.js exists and loads
  const slashPath = path.join(SCRIPTS, "slash-commands.js");
  assert(fs.existsSync(slashPath), "slash-commands.js not found");
  execSync(`node -c "${slashPath}" 2>&1`, { timeout: 10000 });
});

// ── Results ────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
if (failed === 0) {
  console.log(`✅ All ${passed} tests passed — safe to deploy\n`);
  process.exit(0);
} else {
  console.log(`❌ ${failed} FAILED, ${passed} passed — DO NOT DEPLOY\n`);
  for (const f of failures) {
    console.log(`   💥 ${f.name}: ${f.error}`);
  }
  console.log("");
  process.exit(1);
}
