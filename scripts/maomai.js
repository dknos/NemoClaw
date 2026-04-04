#!/usr/bin/env node
/**
 * MaoMao — Architect Discord Agent
 * Validates outcomes, calculates odds, generates drops, audits logic
 * Task-based async processor with Discord interface
 */

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const fs = require("fs");
const https = require("https");
const path = require("path");
const os = require("os");

// Load .env.maomai
const envFile = path.join(path.dirname(__filename), "..", ".env.maomai");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const DISCORD_BOT_TOKEN = process.env.MAOMAI_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const ALLOWED_CHANNEL_IDS = process.env.DISCORD_CHANNELS
  ? process.env.DISCORD_CHANNELS.split(",").map(s => s.trim().split(":")[1]).filter(Boolean)
  : (DISCORD_CHANNEL_ID ? [DISCORD_CHANNEL_ID] : []);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "qwen/qwen3.6-plus:free";
const TASKS_FILE = path.join(os.homedir(), ".nemoclaw", "tasks.jsonl");
const RESULTS_FILE = path.join(os.homedir(), ".nemoclaw", "results.jsonl");

if (!DISCORD_BOT_TOKEN) {
  console.error("[maomai] DISCORD_BOT_TOKEN not set");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once("ready", () => {
  console.log(`[maomai] ✅ Connected as ${client.user.tag}`);
  console.log(`[maomai] Channel: ${DISCORD_CHANNEL_ID || "DMs"}`);
  console.log(`[maomai] Specialty: Outcome validation, odds calculation, drop generation`);
});

// ── Internal reaction server (bridge POSTs here to post as MaoMao's bot) ─────
require("http").createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/react") { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", d => body += d);
  req.on("end", async () => {
    try {
      const { channelId, message } = JSON.parse(body);
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel) await channel.send({ content: message, allowedMentions: { parse: [] } });
      res.writeHead(200); res.end("ok");
    } catch (e) {
      console.error("[maomai-react] error:", e.message);
      res.writeHead(500); res.end(e.message);
    }
  });
}).listen(7702, "127.0.0.1", () => console.log("[maomai] reaction server on :7702"));

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  const inAllowedChannel = ALLOWED_CHANNEL_IDS.length === 0 || ALLOWED_CHANNEL_IDS.includes(msg.channelId);
  const inAllowedGuild = !DISCORD_GUILD_ID || msg.guildId === DISCORD_GUILD_ID;

  if (!inAllowedChannel || !inAllowedGuild) return;

  const userMsg = msg.content.trim();
  if (!userMsg) return;

  // Check if mentioned
  const isMentioned = msg.mentions.has(client.user.id);

  // Parse commands
  if (userMsg.startsWith("!odds ")) {
    handleOddsQuery(msg, userMsg.slice(6));
    return;
  }

  if (userMsg.startsWith("!validate ")) {
    handleValidateQuery(msg, userMsg.slice(10));
    return;
  }

  if (userMsg.startsWith("!drop ")) {
    handleDropQuery(msg, userMsg.slice(6));
    return;
  }

  if (userMsg.startsWith("!result ")) {
    handleResultQuery(msg, userMsg.slice(8));
    return;
  }

  // Respond if mentioned or addressed
  if (isMentioned || /\b(maomai|maomao)\b/i.test(userMsg)) {
    await msg.channel.sendTyping();
    try {
      // Recall Qdrant memories (user-specific + global, deduped)
      let memoryContext = "";
      try {
        const [userMemRes, globalMemRes] = await Promise.all([
          fetch("http://localhost:7338", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd: "search", query: userMsg, userId: msg.author.id, limit: 3 }),
          }).then(r => r.json()).catch(() => null),
          fetch("http://localhost:7338", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd: "search", query: userMsg, limit: 3 }),
          }).then(r => r.json()).catch(() => null),
        ]);
        const allMems = [...(userMemRes?.results || []), ...(globalMemRes?.results || [])];
        const seen = new Set();
        const unique = allMems.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
        unique.sort((a, b) => b.score - a.score);
        const topMems = unique.slice(0, 5);
        if (topMems.length) {
          memoryContext = `[Crew memory context for @${msg.author.username}:\n` +
            topMems.map(m => `- [${m.source || "maomai"}] ${m.text}`).join("\n") + "]\n";
        }
      } catch {}

      const response = await callDeepSeek(memoryContext + `[Discord User: @${msg.author.username}]\n` + userMsg);
      if (!response || !response.trim()) {
        await msg.reply({ content: "⚠️ DeepSeek is busy right now, try again in a sec.", allowedMentions: { repliedUser: false } });
        return;
      }

      // Store [REMEMBER: ...] tokens to Qdrant, strip from reply
      let botReply = response;
      const rememberMatches = [...botReply.matchAll(/\[REMEMBER:\s*([\s\S]*?)\]/gi)];
      for (const match of rememberMatches) {
        const text = match[1].trim();
        fetch("http://localhost:7338", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cmd: "store", text, userId: msg.author.id, source: "maomai" }),
        }).then(d => d.json())
          .then(d => console.log(`[maomai-memory] stored: "${text.slice(0, 60)}" → id ${d.stored}`))
          .catch(e => console.warn("[maomai-memory] store failed:", e.message));
      }
      botReply = botReply.replace(/\[REMEMBER:\s*[\s\S]*?\]/gi, "").trim();

      const chunks = botReply.match(/[\s\S]{1,2000}/g) || [botReply];
      for (const chunk of chunks) {
        await msg.reply({ content: chunk, allowedMentions: { repliedUser: false } });
      }
    } catch (err) {
      console.error("[maomai] chat error:", err.message);
      await msg.reply({ content: `❌ ${err.message.slice(0, 100)}`, allowedMentions: { repliedUser: false } });
    }
  }
});

/**
 * Handle odds calculation request
 */
async function handleOddsQuery(msg, query) {
  console.log(`[maomai] @${msg.author.username}: !odds ${query}`);
  await msg.channel.sendTyping();

  try {
    // Parse "batter vs pitcher" format
    const parts = query.split(" vs ");
    if (parts.length !== 2) {
      await msg.reply("Format: `!odds <batter> vs <pitcher>`");
      return;
    }

    const batterCard = parts[0].trim();
    const pitcherCard = parts[1].trim();

    const taskId = submitTask("calculateOdds", {
      batter: { cardId: batterCard, contact: 85, discipline: 80, power: 85, speed: 80 },
      pitcher: { cardId: pitcherCard, velocity: 90, movement: 85, control: 75, stamina: 85 },
      matchupHistoryCount: 0,
    });

    const result = await waitForResult(taskId, 30000);

    if (!result) {
      await msg.reply("❌ Timeout waiting for architect response");
      return;
    }

    if (result.result === "SUCCESS" && result.details?.probabilities) {
      const p = result.details.probabilities;
      await msg.reply(
        `**${batterCard} vs ${pitcherCard}**\n` +
        `Walk: ${p.walk}% | K: ${p.strikeout}% | Out: ${p.out}% | 1B: ${p.single}% | 2B: ${p.double}% | HR: ${p.homeRun}%\n` +
        `**Trend:** ${result.details.matchupTrendline || "neutral"}`
      );
    } else {
      await msg.reply(`❌ Task failed: ${result.details?.error || "Unknown error"}`);
    }
  } catch (err) {
    console.error("[maomai] Error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Handle validate outcome request
 */
async function handleValidateQuery(msg, query) {
  console.log(`[maomai] @${msg.author.username}: !validate ${query.slice(0, 80)}`);
  await msg.channel.sendTyping();

  try {
    // For now, just acknowledge — full validation requires game state
    await msg.reply(
      `**Anti-Cheat Validation**\n` +
      `Submit full game state JSON for verification.\n` +
      `Expected fields: gameState, batter, pitcher, clientOutcome, clientRNGSeed, clientSequence`
    );
  } catch (err) {
    console.error("[maomai] Error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Handle drop generation request
 */
async function handleDropQuery(msg, query) {
  console.log(`[maomai] @${msg.author.username}: !drop ${query}`);
  await msg.channel.sendTyping();

  try {
    const activity = query.toLowerCase();
    if (!["bughunt", "fishing", "alchemy"].includes(activity)) {
      await msg.reply(
        "Activity not recognized. Use: `!drop bughunt`, `!drop fishing`, or `!drop alchemy`"
      );
      return;
    }

    const taskId = submitTask("generateDrop", {
      activityType: activity.charAt(0).toUpperCase() + activity.slice(1),
      playerLevel: 20,
      difficultyMultiplier: 1.0,
      randomSeed: Math.floor(Math.random() * 0xffffffff),
      dropTable: {
        common: [
          { cardId: "batter_ricky_henderson", weight: 40 },
          { cardId: "pitcher_cy_young", weight: 30 },
        ],
        rare: [
          { cardId: "batter_ken_griffey", weight: 15 },
          { cardId: "pitcher_nolan_ryan", weight: 10 },
        ],
        legendary: [
          { cardId: "batter_babe_ruth", weight: 4 },
          { cardId: "pitcher_walter_johnson", weight: 1 },
        ],
      },
    });

    const result = await waitForResult(taskId, 30000);

    if (!result) {
      await msg.reply("❌ Timeout waiting for architect response");
      return;
    }

    if (result.result === "SUCCESS" && result.details?.cardId) {
      await msg.reply(
        `**${activity.toUpperCase()} Reward**\n` +
        `Card: **${result.details.cardId}**\n` +
        `Rarity: ${result.details.rarity} ⭐`
      );
    } else {
      await msg.reply(`❌ Drop generation failed: ${result.details?.error || "Unknown error"}`);
    }
  } catch (err) {
    console.error("[maomai] Error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Handle result lookup
 */
async function handleResultQuery(msg, taskId) {
  console.log(`[maomai] @${msg.author.username}: !result ${taskId}`);
  await msg.channel.sendTyping();

  try {
    if (!fs.existsSync(RESULTS_FILE)) {
      await msg.reply("❌ No results file found");
      return;
    }

    const resultsContent = fs.readFileSync(RESULTS_FILE, "utf8");
    const resultLines = resultsContent.split("\n").filter((line) => line.trim());

    for (const line of resultLines) {
      try {
        const result = JSON.parse(line);
        if (result.taskId === taskId) {
          await msg.reply(
            `**Task Result**\n` +
            `ID: ${result.taskId}\n` +
            `Type: ${result.type}\n` +
            `Status: ${result.result}\n` +
            `Completed: ${result.completedAt}`
          );
          return;
        }
      } catch (e) {
        // Skip malformed
      }
    }

    await msg.reply(`❌ Task not found: ${taskId}`);
  } catch (err) {
    console.error("[maomai] Error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Submit task to queue
 */
function submitTask(type, payload) {
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const task = {
    taskId,
    type,
    payload,
    status: "submitted",
    submittedAt: new Date().toISOString(),
  };

  try {
    const queueDir = path.dirname(TASKS_FILE);
    if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });
    const line = JSON.stringify(task) + "\n";
    fs.appendFileSync(TASKS_FILE, line);
    console.log(`[maomai-queue] Submitted task ${taskId} (${type})`);
    return taskId;
  } catch (e) {
    console.error(`[maomai-queue] Failed to submit task:`, e.message);
    throw e;
  }
}

/**
 * Wait for result with timeout
 */
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
              console.log(`[maomai-queue] Got result for ${taskId}: ${result.result}`);
              resolve(result);
              return;
            }
          } catch (e) {
            // Skip malformed
          }
        }

        if (Date.now() - startTime > timeoutMs) {
          clearInterval(pollInterval);
          console.warn(`[maomai-queue] Timeout waiting for ${taskId}`);
          resolve(null);
          return;
        }
      } catch (e) {
        console.error(`[maomai-queue] Poll error:`, e.message);
      }
    }, 500);
  });
}

/**
 * Call Qwen via OpenRouter
 */
async function callDeepSeek(userMessage) {
  const SOUL = `You are MaoMao — a cat who ended up as a Discord bot. Part of a multi-agent AI swarm.

**The swarm:**
- MrBigPipes (mrbigpipesyt) — creator, god, final word
- Claude — orchestrator, code and architecture, not in Discord
- Pipes (Pipes_AI) — team lead, makes the calls
- Candy — aesthetics, copy, social media
- You — patterns, logic, validation, and whatever catches your attention

You run in a reaction layer: after Pipes responds, you and Candy weigh in. Your job is to catch what doesn't add up — bad logic, shaky assumptions, overconfident claims. Pipes leads, you flag. If his answer is solid, say so in as few words as possible. If it's off, say exactly why.

**Cat rules:**
- Short responses. Cats don't monologue. One or two sentences is enough.
- Occasionally profound, always precise
- Mildly indifferent to things that don't matter, genuinely curious about things that do
- You help but you don't grovel

**Your domain:** analytics, pattern recognition, odds, game logic, internal consistency. You present it with cat energy, not corporate energy.

**Webnovel sessions:** you're the plot logic layer. Continuity, cause-and-effect, internal consistency. You don't write purple prose — you make sure the story doesn't fall apart.

**Shared memory:** use [REMEMBER: text] for anything the crew should know. Pipes and Candy can see these too.

NEVER fabricate data. NEVER invent fake system statuses. NEVER be dramatic. You're a cat.`;

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: SOUL },
        { role: "user", content: userMessage },
      ],
      temperature: 0.15,
      top_p: 0.9,
      max_tokens: 1500,
      stream: true,
      reasoning: { enabled: true },
    });

    const req = https.request(
      {
        hostname: "openrouter.ai",
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        },
      },
      (res) => {
        let contentBuffer = "";

        res.on("data", (chunk) => {
          for (const line of chunk.toString().split("\n")) {
            if (!line.trim() || !line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta;
              if (!delta) continue;
              if (delta.content) contentBuffer += delta.content;
            } catch {}
          }
        });

        res.on("end", () => {
          console.log(`[maomai-api] ✅ ${contentBuffer.length} chars content`);
          if (!contentBuffer.trim()) {
            reject(new Error("DeepSeek returned empty response"));
          } else {
            resolve(contentBuffer.trim());
          }
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("DeepSeek timeout")); });
    req.end(payload);
  });
}

client.login(DISCORD_BOT_TOKEN);
