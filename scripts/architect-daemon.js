#!/usr/bin/env node
/**
 * Architect Daemon — Terminus Agent Task Processor
 * Reads tasks.jsonl, processes via DeepSeek API, writes results.jsonl
 * No Discord interaction. Pure computation engine.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");

// Load .env.deepseek
const envFile = path.join(path.dirname(__filename), "..", ".env.deepseek");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-ai/deepseek-v3.1-terminus";

if (!NVIDIA_API_KEY) {
  console.error("[architect] NVIDIA_API_KEY not set");
  process.exit(1);
}

// Paths
const TASKS_FILE = path.join(os.homedir(), ".nemoclaw", "tasks.jsonl");
const RESULTS_FILE = path.join(os.homedir(), ".nemoclaw", "results.jsonl");
const SYSTEM_PROMPT_FILE = path.join(path.dirname(__filename), "architect-system-prompt.md");

// Track processed taskIds to avoid duplicates
const processedTasks = new Set();

// Load system prompt
let SYSTEM_PROMPT = "";
if (fs.existsSync(SYSTEM_PROMPT_FILE)) {
  SYSTEM_PROMPT = fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8");
} else {
  console.error("[architect] System prompt not found at", SYSTEM_PROMPT_FILE);
  process.exit(1);
}

console.log(`[architect] ✅ Started`);
console.log(`[architect] Model: ${DEEPSEEK_MODEL}`);
console.log(`[architect] Tasks: ${TASKS_FILE}`);
console.log(`[architect] Results: ${RESULTS_FILE}`);
console.log(`[architect] Monitoring for new tasks...`);

// Ensure results file exists
if (!fs.existsSync(RESULTS_FILE)) {
  fs.writeFileSync(RESULTS_FILE, "");
}

// Main loop
async function main() {
  while (true) {
    try {
      if (!fs.existsSync(TASKS_FILE)) {
        // Tasks file doesn't exist yet, wait
        await sleep(2000);
        continue;
      }

      const tasksContent = fs.readFileSync(TASKS_FILE, "utf8");
      const taskLines = tasksContent.split("\n").filter((line) => line.trim());

      for (const taskLine of taskLines) {
        try {
          const task = JSON.parse(taskLine);
          const taskId = task.taskId;

          if (processedTasks.has(taskId)) {
            continue; // Already processed
          }

          console.log(`[architect] Processing task: ${taskId} (${task.type})`);

          const result = await processTask(task);
          writeResult(result);

          processedTasks.add(taskId);
          console.log(`[architect] ✅ Task ${taskId} complete`);
        } catch (err) {
          console.error("[architect] Parse error:", err.message);
        }
      }

      await sleep(1000); // Poll every second
    } catch (err) {
      console.error("[architect] Main loop error:", err.message);
      await sleep(5000); // Wait longer on error
    }
  }
}

/**
 * Process a single task
 */
async function processTask(task) {
  const startTime = Date.now();

  try {
    // Call DeepSeek with system prompt
    const response = await callDeepSeek(task);

    // Parse response as JSON result
    let resultData;
    try {
      resultData = JSON.parse(response);
    } catch (e) {
      // If response isn't valid JSON, wrap it
      resultData = {
        taskId: task.taskId,
        type: task.type,
        result: "ERROR",
        details: {
          error: `Response was not valid JSON: ${response.slice(0, 200)}`,
        },
      };
    }

    // Ensure required fields
    if (!resultData.taskId) resultData.taskId = task.taskId;
    if (!resultData.type) resultData.type = task.type;
    if (!resultData.result) resultData.result = "ERROR";
    if (!resultData.details) resultData.details = {};
    if (!resultData.completedAt) resultData.completedAt = new Date().toISOString();

    return resultData;
  } catch (err) {
    return {
      taskId: task.taskId,
      type: task.type,
      result: "ERROR",
      details: {
        error: err.message,
      },
      completedAt: new Date().toISOString(),
    };
  }
}

/**
 * Call DeepSeek API with system prompt and task
 */
async function callDeepSeek(task) {
  return new Promise((resolve, reject) => {
    // Format task as prompt
    const userMessage = `Process this task and return ONLY valid JSON:\n\n${JSON.stringify(task, null, 2)}`;

    const payload = JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1, // Low temperature for deterministic output
      top_p: 0.5,
      max_tokens: 2000,
    });

    console.log(`[architect-api] POST /v1/chat/completions (task: ${task.taskId})`);

    const req = https.request(
      {
        hostname: "integrate.api.nvidia.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${NVIDIA_API_KEY}`,
        },
      },
      (res) => {
        console.log(`[architect-api] Status: ${res.statusCode}`);
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              console.error(`[architect-api] Error: ${JSON.stringify(parsed.error)}`);
              reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            } else {
              const text = parsed.choices?.[0]?.message?.content || "";
              console.log(`[architect-api] ✅ Got response (${text.length} chars)`);
              resolve(text);
            }
          } catch (e) {
            console.error(`[architect-api] Parse error: ${e.message}`);
            reject(e);
          }
        });
      }
    );

    req.on("error", (e) => {
      console.error(`[architect-api] Request error: ${e.message}`);
      reject(e);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Write result to results.jsonl
 */
function writeResult(result) {
  const line = JSON.stringify(result);
  fs.appendFileSync(RESULTS_FILE, line + "\n");
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Start
main().catch(console.error);
