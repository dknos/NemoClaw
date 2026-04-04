#!/usr/bin/env node
/**
 * Test script for Manager → Architect task queue
 * Submits a sample task and polls for result
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const TASKS_FILE = path.join(os.homedir(), ".nemoclaw", "tasks.jsonl");
const RESULTS_FILE = path.join(os.homedir(), ".nemoclaw", "results.jsonl");

// Ensure queue files exist
function ensureQueueFiles() {
  const queueDir = path.dirname(TASKS_FILE);
  if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });
  if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, "");
  if (!fs.existsSync(RESULTS_FILE)) fs.writeFileSync(RESULTS_FILE, "");
}

function submitTask(type, payload) {
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const task = {
    taskId,
    type,
    payload,
    status: "submitted",
    submittedAt: new Date().toISOString(),
  };
  const line = JSON.stringify(task) + "\n";
  fs.appendFileSync(TASKS_FILE, line);
  console.log(`[test] Submitted task: ${taskId} (${type})`);
  return taskId;
}

async function waitForResult(taskId, timeoutMs = 30000) {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const pollInterval = setInterval(() => {
      try {
        if (!fs.existsSync(RESULTS_FILE)) {
          clearInterval(pollInterval);
          resolve(null);
          return;
        }

        const resultsContent = fs.readFileSync(RESULTS_FILE, "utf8");
        const resultLines = resultsContent.split("\n").filter((line) => line.trim());

        for (const line of resultLines) {
          try {
            const result = JSON.parse(line);
            if (result.taskId === taskId) {
              clearInterval(pollInterval);
              resolve(result);
              return;
            }
          } catch (e) {
            // Skip malformed
          }
        }

        if (Date.now() - startTime > timeoutMs) {
          clearInterval(pollInterval);
          console.warn(`[test] TIMEOUT waiting for ${taskId}`);
          resolve(null);
          return;
        }
      } catch (e) {
        console.error(`[test] Poll error:`, e.message);
      }
    }, 500);
  });
}

async function main() {
  ensureQueueFiles();

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║ Manager → Architect Task Queue Test                          ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  // Test 1: calculateOdds
  console.log("[TEST 1] calculateOdds — Ken Griffey vs Nolan Ryan");
  console.log("─────────────────────────────────────────────────────────────\n");

  const payload1 = {
    batter: {
      cardId: "batter_ken_griffey",
      contact: 95,
      discipline: 88,
      power: 92,
      speed: 92,
      seasonStats: {
        atBats: 120,
        hits: 38,
        homeRuns: 8,
        strikeouts: 24,
      },
    },
    pitcher: {
      cardId: "pitcher_nolan_ryan",
      velocity: 98,
      movement: 88,
      control: 75,
      stamina: 90,
      seasonStats: {
        inningsPitched: 45,
        strikeouts: 98,
        walks: 18,
      },
    },
    matchupHistoryCount: 3,
  };

  const taskId1 = submitTask("calculateOdds", payload1);
  console.log(`[test] Waiting for result... (timeout: 30s)\n`);

  const result1 = await waitForResult(taskId1, 30000);

  if (result1) {
    console.log(`[test] ✅ RESULT RECEIVED\n`);
    console.log(JSON.stringify(result1, null, 2));
    console.log("\n[test] Outcome probabilities:");
    if (result1.details?.probabilities) {
      const probs = result1.details.probabilities;
      console.log(`  Walk:      ${probs.walk}%`);
      console.log(`  Strikeout: ${probs.strikeout}%`);
      console.log(`  Out:       ${probs.out}%`);
      console.log(`  Single:    ${probs.single}%`);
      console.log(`  Double:    ${probs.double}%`);
      console.log(`  Home Run:  ${probs.homeRun}%`);
      console.log(`\n  Matchup:   ${result1.details.matchupTrendline}`);
    }
  } else {
    console.log(`[test] ❌ TIMEOUT or ERROR`);
    process.exit(1);
  }

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("✅ Queue system working!\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] Fatal error:", err.message);
  process.exit(1);
});
