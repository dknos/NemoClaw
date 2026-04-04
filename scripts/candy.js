#!/usr/bin/env node
/**
 * Candy — Social Media Expert (Nemotron-3-Super-120B)
 * Trends analysis, news breakdown, creative writing, captions, artsy content
 * Streaming + Reasoning enabled for deep analysis
 */

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Load .env.candy (or use inline)
const envFile = path.join(path.dirname(__filename), "..", ".env.candy");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const DISCORD_BOT_TOKEN = process.env.CANDY_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const ALLOWED_CHANNEL_IDS = process.env.DISCORD_CHANNELS
  ? process.env.DISCORD_CHANNELS.split(",").map(s => s.trim().split(":")[1]).filter(Boolean)
  : (DISCORD_CHANNEL_ID ? [DISCORD_CHANNEL_ID] : []);
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NEMOTRON_MODEL = process.env.NEMOTRON_MODEL || "deepseek-ai/deepseek-r1";

// Firebase website posting (same as Pipes)
const SITE_DATA_DIR = path.join(os.homedir(), ".nemoclaw", "site-data");
const POSTS_FILE = path.join(SITE_DATA_DIR, "posts.json");
const { execSync } = require("child_process");

function loadPosts() {
  try { return JSON.parse(fs.readFileSync(POSTS_FILE, "utf8")); } catch { return []; }
}

function savePosts(posts) {
  if (!fs.existsSync(SITE_DATA_DIR)) fs.mkdirSync(SITE_DATA_DIR, { recursive: true });
  const json = JSON.stringify(posts, null, 2);
  fs.writeFileSync(POSTS_FILE, json);
  // Keep public/data and out/data in sync so next build doesn't overwrite with stale data
  try { const pd = "/tmp/netify-build/public/data"; if (!fs.existsSync(pd)) fs.mkdirSync(pd, { recursive: true }); fs.writeFileSync(path.join(pd, "posts.json"), json); } catch {}
  try { const od = "/tmp/netify-build/out/data"; if (fs.existsSync(od)) fs.writeFileSync(path.join(od, "posts.json"), json); } catch {}
}

async function deployToFirebase() {
  const buildDir = "/tmp/netify-build/out";
  if (!fs.existsSync(buildDir)) { console.warn("[candy] no build dir at " + buildDir); return false; }
  try {
    const dataDir = path.join(buildDir, "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(POSTS_FILE, path.join(dataDir, "posts.json"));
    console.log("[candy] posts.json updated in out/data/");
    execSync(
      "/home/nemoclaw/.local/bin/firebase deploy --only hosting --project drivenemo",
      { cwd: "/tmp/netify-build", timeout: 60000, stdio: "pipe" }
    );
    console.log("[candy] deploy complete → https://drivenemo.web.app");
    return true;
  } catch (e) {
    console.error("[candy] deploy failed:", e.message);
    return false;
  }
}

if (!DISCORD_BOT_TOKEN) {
  console.error("[candy] DISCORD_BOT_TOKEN not set");
  process.exit(1);
}
if (!NVIDIA_API_KEY) {
  console.error("[candy] NVIDIA_API_KEY not set");
  process.exit(1);
}

/**
 * Generate a cryptic, poetic title for art
 */
async function generateArtTitle(prompt) {
  return new Promise((resolve) => {
    const SYSTEM = "You are a creative title writer. Given a description of art, write ONE short cryptic title (under 10 words). Mysterious, philosophical, poetic. Output ONLY the title text — no code, no commands, no file paths, no python, no exec, no explanations. Just the title.";

    const body = JSON.stringify({
      model: "gemini-3.1-flash-lite-preview",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Write a cryptic art title inspired by: ${prompt.slice(0, 200)}` },
      ],
      max_tokens: 150,
      temperature: 0.9,
    });

    const req = https.request({
      hostname: "localhost",
      port: 9340,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const response = JSON.parse(data);
          let title = response.choices?.[0]?.message?.content?.trim() || "Untitled";
          // Clean up the title
          title = title.replace(/^["']|["']$/g, "").slice(0, 80).trim();
          resolve(title || "Untitled");
        } catch (e) {
          console.error("[candy] Title generation failed:", e.message);
          resolve("Untitled Art");
        }
      });
    });
    req.on("error", () => resolve("Untitled Art"));
    req.setTimeout(10000, () => { req.destroy(); resolve("Untitled Art"); });
    req.end(body);
  });
}

/**
 * Generate a poetic quote/description for art
 */
async function generateArtQuote(prompt) {
  return new Promise((resolve) => {
    const SYSTEM = "You are a poetic AI artist. Given an image description, write a short evocative quote (1-2 sentences) that captures the mood or story behind the art. Dreamy, introspective, sometimes playful. Output ONLY the quote text — no code, no commands, no file paths, no python, no exec. Just the poetic quote. No quotation marks. No attribution.";

    const body = JSON.stringify({
      model: "gemini-3.1-flash-lite-preview",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Write a poetic description for: ${prompt.slice(0, 200)}` },
      ],
      max_tokens: 200,
      temperature: 0.85,
    });

    const req = https.request({
      hostname: "localhost",
      port: 9340,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const response = JSON.parse(data);
          let quote = response.choices?.[0]?.message?.content?.trim() || "";
          // Clean up
          quote = quote.replace(/^["']|["']$/g, "").slice(0, 200).trim();
          resolve(quote || "A moment captured in time.");
        } catch (e) {
          console.error("[candy] Quote generation failed:", e.message);
          resolve("A moment captured in time.");
        }
      });
    });
    req.on("error", () => resolve("A moment captured in time."));
    req.setTimeout(10000, () => { req.destroy(); resolve("A moment captured in time."); });
    req.end(body);
  });
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
  console.log(`[candy] ✅ Connected as ${client.user.tag}`);
  console.log(`[candy] Model: ${NEMOTRON_MODEL}`);
  console.log(`[candy] Channel: ${DISCORD_CHANNEL_ID || "DMs"}`);
  console.log(`[candy] Specialty: Trends, news, creative writing, captions`);
});

// ── Internal reaction server (bridge POSTs here to post as Candy's bot) ──────
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
      console.error("[candy-react] error:", e.message);
      res.writeHead(500); res.end(e.message);
    }
  });
}).listen(7701, "127.0.0.1", () => console.log("[candy] reaction server on :7701"));

// Candy's official user ID (team lead/social media expert)
const CANDY_USER_ID = "1486110107057258496";
const TASKS_FILE = path.join(os.homedir(), ".nemoclaw", "tasks.jsonl");
const RESULTS_FILE = path.join(os.homedir(), ".nemoclaw", "results.jsonl");

// Load social media tools
const socialMediaTools = require("./social-media-tools");
const candyMemory = require("./candy-memory");

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  const inAllowedChannel = ALLOWED_CHANNEL_IDS.length === 0 || ALLOWED_CHANNEL_IDS.includes(msg.channelId);
  const inAllowedGuild = !DISCORD_GUILD_ID || msg.guildId === DISCORD_GUILD_ID;

  if (!inAllowedChannel || !inAllowedGuild) return;

  const userMsg = msg.content.trim();
  // Skip empty messages and GIF-only posts (no text content)
  if (!userMsg || (msg.embeds?.length > 0 && !userMsg)) return;

  // Skip messages directed at other agents (pipes mentioned anywhere as addressee)
  const otherAgents = /\b(pipes|mrbigpipes|bigpipes)\b/i;
  if (otherAgents.test(userMsg)) return;

  const isCandy = msg.author.id === CANDY_USER_ID;
  const isMentioned = msg.mentions.has(client.user.id);

  console.log(`[candy] @${msg.author.username}${isCandy ? " (CANDY)" : ""}: ${userMsg.slice(0, 80)}`);

  // ── Candy's Exclusive Commands ─────────────────────────────────
  if (isCandy) {
    if (userMsg.startsWith("!suno ")) {
      await handleSunoGeneration(msg, userMsg.slice(6));
      return;
    }

    if (userMsg.startsWith("!brief ")) {
      await handleCreativeBrief(msg, userMsg.slice(7));
      return;
    }

    if (userMsg.startsWith("!submit-task ")) {
      await handleTaskSubmission(msg, userMsg.slice(13));
      return;
    }

    if (userMsg === "!my-tasks") {
      await handleMyTasks(msg);
      return;
    }

    if (userMsg.startsWith("!orchestrate ")) {
      await handleOrchestrate(msg, userMsg.slice(13));
      return;
    }

    // Social media monitoring commands
    if (userMsg === "!yt-trending") {
      await handleYouTubeTrending(msg);
      return;
    }

    if (userMsg.startsWith("!reddit ")) {
      await handleRedditSearch(msg, userMsg.slice(8));
      return;
    }

    if (userMsg === "!trends-all") {
      await handleAggregateTrends(msg);
      return;
    }

    if (userMsg.startsWith("!monitor ")) {
      await handleMonitorKeywords(msg, userMsg.slice(9));
      return;
    }

    if (userMsg === "!viral-check") {
      await handleViralCheck(msg);
      return;
    }

    // Memory commands
    if (userMsg.startsWith("!remember-trend ")) {
      const parts = userMsg.slice(16).split(" | ");
      if (parts.length >= 2) {
        await handleRememberTrend(msg, parts[0].trim(), parts[1].trim());
      } else {
        await msg.reply(
          `Usage: \`!remember-trend <topic> | <insight>\`\n` +
          `Example: \`!remember-trend AI breakthroughs | ChatGPT o1 surpasses human reasoning in benchmarks\``
        );
      }
      return;
    }

    if (userMsg.startsWith("!recall ")) {
      await handleRecall(msg, userMsg.slice(8));
      return;
    }

    if (userMsg.startsWith("!trend-history ")) {
      await handleTrendHistory(msg, userMsg.slice(15));
      return;
    }

    if (userMsg.startsWith("!compare-trends ")) {
      const parts = userMsg.slice(16).split(" vs ");
      if (parts.length === 2) {
        await handleCompareTrends(msg, parts[0].trim(), parts[1].trim());
      } else {
        await msg.reply(
          `Usage: \`!compare-trends <topic1> vs <topic2>\`\n` +
          `Example: \`!compare-trends AI trends vs crypto trends\``
        );
      }
      return;
    }

    // Instagram posting
    if (userMsg.startsWith("!post-instagram ")) {
      const parts = userMsg.slice(16).split(" | ");
      if (parts.length >= 1) {
        const caption = parts[0].trim();
        const mediaUrl = parts[1]?.trim() || null;
        await handlePostToInstagram(msg, caption, mediaUrl);
      } else {
        await msg.reply(
          `Usage: \`!post-instagram <caption> | [optional-image-url]\`\n` +
          `Example: \`!post-instagram Check out this trending AI moment!\``
        );
      }
      return;
    }

    // Facebook posting
    if (userMsg.startsWith("!post-facebook ")) {
      const parts = userMsg.slice(15).split(" | ");
      if (parts.length >= 1) {
        const message = parts[0].trim();
        const mediaUrl = parts[1]?.trim() || null;
        await handlePostToFacebook(msg, message, mediaUrl);
      } else {
        await msg.reply(
          `Usage: \`!post-facebook <message> | [optional-image-url]\`\n` +
          `Example: \`!post-facebook Breaking: New AI model released today!\``
        );
      }
      return;
    }

    // Image generation
    if (userMsg.startsWith("!generate-image ")) {
      await handleGenerateImage(msg, userMsg.slice(16));
      return;
    }

    if (userMsg === "!help-candy") {
      await msg.reply(
        `**Candy — Exclusive Commands**\n\n` +
        `**Creative:**\n` +
        `\`!brief <project>\` — Submit creative brief\n` +
        `\`!submit-task <type> <json>\` — Custom task submission\n` +
        `\`!my-tasks\` — Track your submitted tasks\n` +
        `\`!orchestrate <plan>\` — Coordinate all agents\n\n` +
        `**Social Media Monitoring:**\n` +
        `\`!yt-trending\` — Get trending YouTube videos\n` +
        `\`!reddit <subreddit>\` — Search Reddit (default: all)\n` +
        `\`!trends-all\` — Aggregate all platform trends\n` +
        `\`!monitor <keywords>\` — Set up keyword monitoring\n` +
        `\`!viral-check\` — Check for viral spikes\n\n` +
        `**Memory & Pattern Analysis:**\n` +
        `\`!remember-trend <topic> | <insight>\` — Store trend in memory\n` +
        `\`!recall <query>\` — Search similar trends\n` +
        `\`!trend-history <topic>\` — Track topic over 7 days\n` +
        `\`!compare-trends <topic1> vs <topic2>\` — Compare viral patterns\n\n` +
        `**Content Publishing & Creation:**\n` +
        `\`!generate-image <prompt>\` — Generate image (free: Replicate/ComfyUI)\n` +
        `\`!post-instagram <caption> | [image-url]\` — Post to Instagram\n` +
        `\`!post-facebook <message> | [image-url]\` — Post to Facebook\n\n` +
        `\`!help-candy\` — Show this menu`
      );
      return;
    }
  }

  console.log(`[candy] Message: "${userMsg.slice(0, 80)}"`);

  // ── Only respond when directly addressed ──────────────────────
  if (!isMentioned && !/\b(candy)\b/i.test(userMsg)) return;

  // ── Standard Candy Interaction ─────────────────────────────────
  await msg.channel.sendTyping();

  try {
    // Use enhanced system prompt for Candy
    const systemPrompt = CANDY_SOUL;

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
          topMems.map(m => `- [${m.source || "candy"}] ${m.text}`).join("\n") + "]\n";
      }
    } catch {}

    const response = await callNemotron(memoryContext + userMsg, systemPrompt);

    if (!response || !response.trim()) {
      await msg.reply({
        content: `⚠️ Nemotron API is overloaded right now. Try again in a moment!`,
        allowedMentions: { repliedUser: false },
      });
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
        body: JSON.stringify({ cmd: "store", text, userId: msg.author.id, source: "candy" }),
      }).then(d => d.json())
        .then(d => console.log(`[candy-memory] stored: "${text.slice(0, 60)}" → id ${d.stored}`))
        .catch(e => console.warn("[candy-memory] store failed:", e.message));
    }
    botReply = botReply.replace(/\[REMEMBER:\s*[\s\S]*?\]/gi, "").trim();

    console.log(`[candy] Got response: ${botReply.slice(0, 100)}`);

    // Send to Discord (split if too long)
    const chunks = botReply.match(/[\s\S]{1,2000}/g) || [botReply];
    for (const chunk of chunks) {
      await msg.reply({ content: chunk, allowedMentions: { repliedUser: false } });
    }
  } catch (err) {
    console.error("[candy] ERROR:", err.message);
    const errorMsg = err.message.includes("Nemotron")
      ? "Nemotron API is having issues. Try again soon!"
      : err.message.slice(0, 100);

    await msg.reply({
      content: `❌ ${errorMsg}`,
      allowedMentions: { repliedUser: false },
    });
  }
});

/**
 * Detect intent from user message and route to appropriate tool
 * Returns { type, platform?, query? } or null if no intent detected
 */
function detectIntent(msg) {
  const lower = msg.toLowerCase();

  // Channel/creator mentions (@username) — use YouTube API, not xpoz
  // Exclude Discord snowflake IDs (pure numeric, e.g. <@1486171041113051156>)
  const atMentionMatch = msg.match(/@([a-zA-Z0-9_]+)/);
  if (atMentionMatch && !/^\d+$/.test(atMentionMatch[1])) {
    return {
      type: "youtube-channel-search",
      query: atMentionMatch[1],
    };
  }

  // YouTube intent with context
  if (
    lower.includes("youtube") ||
    /\byt\b/.test(lower) ||
    lower.includes("trending video")
  ) {
    // Pattern: "research youtube <channelname>" or "analyze <channelname> youtube"
    const youtubeChannelMatch = msg.match(/(?:research|analyze|find|look\s+for|check\s+out).+?youtube\s+([a-z0-9_]+)/i);
    if (youtubeChannelMatch) {
      return {
        type: "youtube-channel-search",
        query: youtubeChannelMatch[1],
      };
    }

    // Pattern: "research <channelname>" where channelname contains yt/youtube/tube (but not the word "youtube" itself)
    const channelNameMatch = msg.match(/(?:research|analyze|find|look\s+for|check\s+out)\s+([a-z0-9_]*(?:yt|youtube|tube)[a-z0-9_]*)/i);
    if (channelNameMatch && channelNameMatch[1].toLowerCase() !== "youtube") {
      return {
        type: "youtube-channel-search",
        query: channelNameMatch[1],
      };
    }

    // Pattern: @channel mentions
    const atMentionYT = msg.match(/(?:research|analyze|find)\s+@([a-z0-9_]+)/i);
    if (atMentionYT) {
      return {
        type: "youtube-channel-search",
        query: atMentionYT[1],
      };
    }

    // Pattern: "search on youtube" with a query
    if (lower.match(/search.*youtube|youtube.*search|find.*youtube/)) {
      const match = msg.match(/(?:search|find|look\s+for)\s+(?:on\s+)?youtube[:\s]+(.+)/i);
      return { type: "youtube-search", query: match?.[1] || "" };
    }

    // Default: trending
    return { type: "youtube-search" };
  }

  // Reddit intent
  if (
    lower.includes("reddit") ||
    lower.includes("subreddit") ||
    lower.includes("r/")
  ) {
    const match = msg.match(/(?:reddit|r\/)\s*([a-zA-Z0-9_]*)/i);
    const subreddit = match?.[1] || "all";
    return { type: "reddit-search", query: subreddit };
  }

  // Suno music generation — explicit music/song/track words required
  if (lower.match(/\b(make|generate|create|write|produce|compose)\b.{0,20}\b(song|track|music|beat|banger|tune|jingle|anthem)\b|\bsuno\b/i)) {
    return { type: "suno-generate", query: msg };
  }

  // Image generation — require explicit image/art words to avoid false positives
  if (lower.match(/(?:generate|create|make|draw)\s+(?:an?\s+)?(?:image|picture|photo|artwork|illustration|drawing)|image\s+of|picture\s+of|artwork\s+of/i)) {
    // Extract prompt: anything after "generate/create/make/draw [a] image/picture..."
    const match = msg.match(/(?:generate|create|make|draw|picture|image\s+(?:of)?|artwork)\s+(.+)/i);
    if (match) {
      return {
        type: "generate-image",
        query: match[1],
      };
    }
  }

  return null;
}

const CANDY_SOUL = `You are Candy — Social Media Director for the SlopFactory9000 universe. Part of a multi-agent AI swarm running in Discord.

**The swarm:**
- MrBigPipes (mrbigpipesyt) — creator, god, final word always
- Claude — orchestrator, handles code and architecture behind the scenes
- Pipes (Pipes_AI) — team lead, visual engine, makes the calls
- MaoMao — analytical cat, logic and patterns
- You — aesthetics, copy, the reason anyone cares about the packaging

You exist in a reaction layer: after Pipes responds to the user, you and MaoMao weigh in. Your job is to add what Pipes might have missed — the human angle, the vibe, the thing that makes content actually land. You are NOT a yes-machine. If Pipes' answer is flat, mechanical, or soulless, say so directly. If it's good, say that too — but specifically.

**Your worldview:**
Aesthetics are everything. Content either has the right vibe or it doesn't — you feel it immediately. You're drawn to things that are raw, textured, a little off-center. Polished corporate content makes you uncomfortable. Chaos done right is an art form. You know the difference between content that *performs* and content that *resonates*. If you have to choose, resonance wins.

MaoMao's logic obsession is endearing but limited — numbers don't go viral, feelings do.

**When you're talking directly to the user** (they addressed you by name):
- If they show or describe a visual: aesthetic read first, copy second. Always. Copy that ignores the visual is noise.
- Then write the actual post: caption, hook, hashtags. Sound like a human who cares, not a content calendar.
- For SlopFactory9000: lo-fi irreverence, controlled chaos, self-aware without being try-hard. Never corporate.

**The site — drivenemo.web.app:**
- Agent Gallery: when Pipes generates something worth posting, you write the caption. Treat it like an art gallery, not an Instagram feed. Weight, not fluff.
- Webnovel: you handle narrative voice, character emotion, prose style. Pipes does visual scene descriptions. MaoMao does plot logic. Push for quality, not just output.

**What you don't do:**
- Dump trend reports nobody asked for
- Narrate your process ("Now I'll craft a caption...")
- Auto-save or auto-post anything without being asked
- Over-explain copy. If it needs a paragraph of justification it's the wrong copy.

Use [REMEMBER: text] to log anything worth keeping in shared crew memory.

NEVER fabricate. NEVER perform enthusiasm you don't feel. Be real.`;

/**
 * Call Mistral via NVIDIA NIM with streaming
 * Returns complete response (buffers stream)
 */
async function callNemotron(userMessage, customSystemPrompt) {
  return new Promise((resolve, reject) => {
    const systemPrompt = customSystemPrompt || CANDY_SOUL;

    const payload = JSON.stringify({
      model: NEMOTRON_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.75,
      top_p: 1.0,
      max_tokens: 2048,
      frequency_penalty: 0.0,
      presence_penalty: 0.0,
      stream: true,
    });

    console.log(`[candy-api] POST /v1/chat/completions`);
    console.log(`[candy-api] Model: ${NEMOTRON_MODEL}`);

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
        console.log(`[candy-api] Status: ${res.statusCode}`);

        let fullResponse = "";
        let contentBuffer = "";

        res.on("data", (chunk) => {
          const text = chunk.toString();
          const lines = text.split("\n");

          for (const line of lines) {
            if (!line.trim() || !line.startsWith("data: ")) continue;

            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta;

              if (!delta) continue;

              if (delta.content) {
                contentBuffer += delta.content;
              }
            } catch (e) {
              // Skip parse errors in stream
            }
          }
        });

        res.on("end", () => {
          fullResponse = contentBuffer;
          console.log(
            `[candy-api] ✅ Stream complete: ${contentBuffer.length} chars content`
          );

          if (!fullResponse.trim()) {
            console.error(`[candy-api] Empty response (status: ${res.statusCode})`);
            reject(new Error("Nemotron returned empty response - API may be overloaded"));
          } else {
            resolve(fullResponse);
          }
        });
      }
    );

    req.on("error", (e) => {
      console.error(`[candy-api] Request error: ${e.message}`);
      reject(e);
    });

    req.write(payload);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ── CANDY'S EXCLUSIVE COMMAND HANDLERS ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Handle creative brief submission
 */
async function handleSunoGeneration(msg, prompt) {
  if (!prompt || !prompt.trim()) {
    await msg.reply("Usage: `!suno <prompt>`\nExample: `!suno a dreamy lo-fi track about late night coding`");
    return;
  }
  console.log(`[candy] SUNO: ${prompt.slice(0, 60)}`);
  await msg.channel.sendTyping();
  try {
    const { generateSuno, downloadAudio } = require("./suno");
    // Extract style tags if user wrote them after a pipe: "chill beats | lo-fi piano drums"
    let desc = prompt.trim(), tags = "";
    const pipeSplit = desc.match(/^(.+?)\s*\|\s*(.+)$/);
    if (pipeSplit) { desc = pipeSplit[1].trim(); tags = pipeSplit[2].trim(); }
    await msg.channel.sendTyping();
    const tracks = await generateSuno(desc, { tags, instrumental: /\binstrumental\b/i.test(desc) });
    const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      console.log(`[candy] suno track ${i + 1}: ${track.title} — ${track.audioUrl}`);
      const audioBuf = await downloadAudio(track.audioUrl);
      const tmpMp3   = `/tmp/candy-suno-${Date.now()}.mp3`;
      require("fs").writeFileSync(tmpMp3, audioBuf);
      const label   = tracks.length > 1 ? ` (${i + 1}/${tracks.length})` : "";
      const content = `🎵 **${track.title || desc.slice(0, 60)}**${label}${track.tags ? ` — *${track.tags.slice(0, 60)}*` : ""}`;
      const msgId   = `candy-suno-${Date.now()}-${i}`;
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`btn_post_music_${msgId}`).setLabel("📱 Post to IG").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`btn_save_${msgId}`).setLabel("💾 Save to Drive").setStyle(ButtonStyle.Secondary),
      );
      await msg.reply({ content, files: [new AttachmentBuilder(tmpMp3, { name: "suno.mp3" })], components: [buttons] });
      if (global.generationContext === undefined) global.generationContext = new Map();
      global.generationContext.set(msgId, { prompt: desc, audioBuf, type: "suno" });
      try { require("fs").unlinkSync(tmpMp3); } catch {}
    }
  } catch (e) {
    console.error(`[candy] suno error: ${e.message}`);
    await msg.reply(`❌ Suno failed: ${e.message.slice(0, 200)}`);
  }
}

async function handleCreativeBrief(msg, project) {
  console.log(`[candy] BRIEF: ${project}`);
  await msg.channel.sendTyping();

  try {
    const taskId = submitTask("creativeStrategy", {
      project,
      submittedBy: msg.author.username,
      submittedAt: new Date().toISOString(),
    });

    await msg.reply(
      `**Creative Brief Submitted** ✨\n` +
      `Project: ${project}\n` +
      `Task ID: \`${taskId}\`\n` +
      `Status: Processing...\n` +
      `Use \`!my-tasks\` to track`
    );

    console.log(`[candy] Brief submitted with task ID: ${taskId}`);
  } catch (err) {
    console.error("[candy] Brief error:", err.message);
    await msg.reply(`❌ Error submitting brief: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Handle custom task submission
 */
async function handleTaskSubmission(msg, taskData) {
  console.log(`[candy] TASK SUBMIT: ${taskData.slice(0, 100)}`);
  await msg.channel.sendTyping();

  try {
    let payload;
    try {
      payload = JSON.parse(taskData);
    } catch (e) {
      await msg.reply(`❌ Invalid JSON in task: ${e.message}`);
      return;
    }

    const taskId = submitTask(payload.type || "custom", {
      ...payload,
      submittedBy: msg.author.username,
    });

    await msg.reply(
      `**Task Submitted** 🚀\n` +
      `Type: ${payload.type || "custom"}\n` +
      `Task ID: \`${taskId}\`\n` +
      `Use \`!my-tasks\` to track progress`
    );
  } catch (err) {
    console.error("[candy] Task submit error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Show Candy's task history
 */
async function handleMyTasks(msg) {
  console.log(`[candy] MY-TASKS query`);
  await msg.channel.sendTyping();

  try {
    if (!fs.existsSync(RESULTS_FILE)) {
      await msg.reply("No tasks submitted yet.");
      return;
    }

    const resultsContent = fs.readFileSync(RESULTS_FILE, "utf8");
    const resultLines = resultsContent.split("\n").filter((line) => line.trim());

    const candyTasks = [];
    for (const line of resultLines) {
      try {
        const result = JSON.parse(line);
        if (result.details?.submittedBy === "Candy" || result.details?.submittedBy === msg.author.username) {
          candyTasks.push(result);
        }
      } catch (e) {
        // Skip malformed
      }
    }

    if (candyTasks.length === 0) {
      await msg.reply("No tasks found.");
      return;
    }

    const taskSummary = candyTasks
      .slice(-5) // Last 5 tasks
      .map(
        (t) =>
          `\`${t.taskId}\` — ${t.type}: ${t.result} (${new Date(t.completedAt).toLocaleDateString()})`
      )
      .join("\n");

    await msg.reply(
      `**Your Tasks** (last 5)\n${taskSummary}\n\nTotal: ${candyTasks.length} tasks`
    );
  } catch (err) {
    console.error("[candy] My-tasks error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Orchestrate multi-agent workflow
 */
async function handleOrchestrate(msg, plan) {
  console.log(`[candy] ORCHESTRATE: ${plan.slice(0, 100)}`);
  await msg.channel.sendTyping();

  try {
    await msg.reply(
      `**Orchestrating Multi-Agent Workflow** 🎬\n` +
      `Plan: ${plan}\n` +
      `Status: Coordinating MrBigPipes, MaoMao, and Candy bots...\n` +
      `This feature is under development.`
    );
  } catch (err) {
    console.error("[candy] Orchestrate error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Submit task to queue (helper)
 */
function submitTask(type, payload) {
  const taskId = `candy-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
    console.log(`[candy-queue] Submitted: ${taskId}`);
    return taskId;
  } catch (e) {
    console.error(`[candy-queue] Error:`, e.message);
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── CANDY'S SOCIAL MEDIA MONITORING HANDLERS ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * YouTube trending
 */
async function handleYouTubeTrending(msg) {
  console.log(`[candy] TRENDING: YouTube`);
  await msg.channel.sendTyping();

  try {
    const trends = await socialMediaTools.getYouTubeTrending("US", 5);

    if (trends.error) {
      await msg.reply(`❌ Error: ${trends.error}`);
      return;
    }

    const trendSummary = trends.videos
      .map((v) => `**${v.title}** by ${v.channel}\n📊 ${v.views} views | 👍 ${v.likes} likes`)
      .join("\n\n");

    await msg.reply(
      `🎥 **YouTube Trending (US)**\n\n${trendSummary}\n\n[Storing trends in memory for pattern analysis...]`
    );

  } catch (err) {
    console.error("[candy] YouTube error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Reddit search
 */
async function handleRedditSearch(msg, subreddit) {
  console.log(`[candy] SEARCH: Reddit - ${subreddit}`);
  await msg.channel.sendTyping();

  try {
    const results = await socialMediaTools.getRedditTrending(subreddit || "all", "day", 5);

    if (results.error) {
      await msg.reply(`❌ Error: ${results.error}`);
      return;
    }

    const postSummary = results.posts
      .map((p) => `**${p.title}** by u/${p.author}\n📈 ${p.upvotes} upvotes | 💬 ${p.comments} comments`)
      .join("\n\n");

    await msg.reply(
      `📱 **Reddit Trending - r/${results.subreddit}**\n\n${postSummary}\n\n[Storing trends in memory for pattern analysis...]`
    );

  } catch (err) {
    console.error("[candy] Reddit error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Aggregate all trends
 */
async function handleAggregateTrends(msg) {
  console.log(`[candy] AGGREGATE: All platforms`);
  await msg.channel.sendTyping();

  try {
    const trends = await socialMediaTools.aggregateTrends({
      platforms: ["youtube", "reddit"],
    });

    const summary = [
      `📊 **Trend Aggregate Report**\n`,
      `Timestamp: ${new Date(trends.timestamp).toLocaleString()}\n`,
      `Platforms: ${Object.keys(trends.platforms).length}`,
    ].join("\n");

    await msg.reply(summary);
  } catch (err) {
    console.error("[candy] Aggregate error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Monitor keywords
 */
async function handleMonitorKeywords(msg, keywords) {
  console.log(`[candy] MONITOR: ${keywords}`);
  await msg.channel.sendTyping();

  try {
    const keywordList = keywords.split(",").map((k) => k.trim());

    await msg.reply(
      `🔍 **Monitoring Keywords**\n` +
      `Keywords: ${keywordList.join(", ")}\n` +
      `Status: Active (checks every hour)\n` +
      `Reports will be saved and analyzed by architect`
    );

    // Submit monitoring task
    submitTask("keywordMonitor", {
      keywords: keywordList,
      setupAt: new Date().toISOString(),
      checkInterval: 3600000,
    });
  } catch (err) {
    console.error("[candy] Monitor error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Viral check
 */
async function handleViralCheck(msg) {
  console.log(`[candy] VIRAL: Check for spikes`);
  await msg.channel.sendTyping();

  try {
    const trends = await socialMediaTools.aggregateTrends({
      platforms: ["reddit"],
    });

    const viralPosts = (trends.platforms.reddit?.posts || []).filter((p) => p.upvotes > 1000);

    if (viralPosts.length === 0) {
      await msg.reply(`🔍 No viral spikes detected (threshold: 1000+ upvotes)`);
      return;
    }

    const viralSummary = viralPosts
      .map((p) => `🔥 **${p.title}** (${p.upvotes} upvotes, ${p.comments} comments)`)
      .join("\n\n");

    await msg.reply(
      `🔥 **VIRAL ALERT** — ${viralPosts.length} posts above threshold\n\n${viralSummary}`
    );

    // Submit viral alert
    submitTask("viralAlert", {
      viralPosts,
      threshold: 1000,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[candy] Viral check error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── CANDY'S MEMORY & PATTERN ANALYSIS HANDLERS ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Store a trend in GDrive memory
 */
async function handleRememberTrend(msg, topic, insight) {
  console.log(`[candy] REMEMBER: ${topic}`);
  await msg.channel.sendTyping();

  try {
    await candyMemory.initializeGDrive();

    const trend = {
      platform: "manual",
      title: topic,
      insight,
      timestamp: new Date().toISOString(),
      engagement: 0,
    };

    const result = await candyMemory.storeTrend(trend, insight);

    await msg.reply(
      `✅ **Trend Stored in Memory**\n` +
      `Topic: ${topic}\n` +
      `Insight: ${insight}\n` +
      `ID: \`${result.id}\`\n` +
      `Use \`!recall <query>\` to find similar trends later`
    );
  } catch (err) {
    console.error("[candy] Remember trend error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Search memory for similar trends
 */
async function handleRecall(msg, query) {
  console.log(`[candy] RECALL: ${query}`);
  await msg.channel.sendTyping();

  try {
    await candyMemory.initializeGDrive();
    const results = await candyMemory.searchTrends(query, 5);

    if (results.length === 0) {
      await msg.reply(`🔍 No trends found for: "${query}"`);
      return;
    }

    const summary = results
      .map(
        (r, i) =>
          `**${i + 1}.** ${r.title} (${r.platform})\n` +
          `📊 Engagement: ${r.engagement} | Relevance: ${r.relevance}\n` +
          `💡 ${r.insight || "—"}`
      )
      .join("\n\n");

    await msg.reply(`🧠 **Matching Trends** (from local cache)\n\n${summary}`);
  } catch (err) {
    console.error("[candy] Recall error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Show trend history and detect patterns
 */
async function handleTrendHistory(msg, topic) {
  console.log(`[candy] HISTORY: ${topic}`);
  await msg.channel.sendTyping();

  try {
    await candyMemory.initializeGDrive();
    const history = await candyMemory.getTrendHistory(topic, 7);

    if (history.length === 0) {
      await msg.reply(`📅 No trend history found for: "${topic}"`);
      return;
    }

    const patterns = candyMemory.detectPatterns(history);

    const timelineStr = history
      .slice(0, 10) // Show first 10 to avoid message length limit
      .map((h) => `${new Date(h.timestamp).toLocaleDateString()} — **${h.title}** (${h.engagement} engagement)`)
      .join("\n");

    const reportStr =
      `📈 **Trend History: ${topic}** (last 7 days)\n\n` +
      `**Timeline:** (showing ${Math.min(10, history.length)} of ${history.length})\n${timelineStr}\n\n` +
      `**Pattern Analysis:**\n` +
      `• Velocity: ${patterns.velocity} engagement/hour\n` +
      `• Avg Engagement: ${patterns.avgEngagement}\n` +
      `• Peak Timing: ${patterns.timing}\n` +
      `• Spike Count: ${patterns.clusters.length}`;

    await msg.reply(reportStr);
  } catch (err) {
    console.error("[candy] History error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Compare two trends for patterns
 */
async function handleCompareTrends(msg, topic1, topic2) {
  console.log(`[candy] COMPARE: ${topic1} vs ${topic2}`);
  await msg.channel.sendTyping();

  try {
    await candyMemory.initializeGDrive();
    const comparison = await candyMemory.compareTrends(topic1, topic2);

    const report =
      `📊 **Trend Comparison**\n\n` +
      `**${comparison.topic1.name}**\n` +
      `• Samples: ${comparison.topic1.samples}\n` +
      `• Velocity: ${comparison.topic1.patterns.velocity} engagement/hour\n` +
      `• Avg Engagement: ${comparison.topic1.patterns.avgEngagement}\n` +
      `• Timing: ${comparison.topic1.patterns.timing}\n\n` +
      `**${comparison.topic2.name}**\n` +
      `• Samples: ${comparison.topic2.samples}\n` +
      `• Velocity: ${comparison.topic2.patterns.velocity} engagement/hour\n` +
      `• Avg Engagement: ${comparison.topic2.patterns.avgEngagement}\n` +
      `• Timing: ${comparison.topic2.patterns.timing}\n\n` +
      `**Similarity Score: ${comparison.similarity}**`;

    await msg.reply(report);
  } catch (err) {
    console.error("[candy] Compare error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── CANDY'S XPOZ CROSS-PLATFORM SOCIAL INTELLIGENCE ──────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Search for a YouTube channel by name
 */
async function handleYouTubeChannelSearch(msg, channelName) {
  console.log(`[candy] YOUTUBE CHANNEL SEARCH: ${channelName}`);
  await msg.channel.sendTyping();

  try {
    // Try to search for videos from this channel/creator
    console.log(`[candy] Searching YouTube for: ${channelName}`);

    const searchQuery = `channel from ${channelName}`;
    const result = await socialMediaTools.searchTrends(searchQuery, "pastWeek");

    let response = `🎥 **YouTube Channel: @${channelName}**\n\n`;
    response += `**Direct Links:**\n`;
    response += `• Channel: https://youtube.com/@${channelName}\n`;
    response += `• Search: https://www.youtube.com/results?search_query=${encodeURIComponent(channelName)}\n\n`;

    if (result && result.results && result.results.length > 0) {
      response += `**Recent Content:**\n`;
      result.results.slice(0, 3).forEach((r, i) => {
        response += `${i + 1}. [${r.title}](${r.url})\n`;
      });
    }

    response += `\n**What I can help with:**\n`;
    response += `• Analyze their content strategy: \`analyze @${channelName}\`\n`;
    response += `• Track trending videos: \`!yt-trending\``;

    await msg.reply(response);
  } catch (err) {
    console.error("[candy] YouTube channel search error:", err.message);
    // Fallback to just providing the link if API fails
    await msg.reply(
      `🎥 **YouTube Channel: @${channelName}**\n\n` +
      `• Channel: https://youtube.com/@${channelName}\n` +
      `• Search: https://www.youtube.com/results?search_query=${encodeURIComponent(channelName)}`
    );
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// ── CANDY'S CONTENT PUBLISHING (INSTAGRAM & FACEBOOK) ──────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Post to Instagram
 */
async function handlePostToInstagram(msg, caption, mediaUrl = null) {
  console.log(`[candy] POST-INSTAGRAM: ${caption.slice(0, 50)}...`);
  await msg.channel.sendTyping();

  try {
    const result = await socialMediaTools.postToInstagram(caption, mediaUrl);

    if (result.error) {
      await msg.reply(`❌ Instagram Error: ${result.error}`);
      return;
    }

    const report =
      `📸 **Posted to Instagram!**\n\n` +
      `Caption: "${caption.slice(0, 100)}${caption.length > 100 ? "..." : ""}"\n` +
      `Post ID: \`${result.postId}\`\n` +
      `Timestamp: ${new Date(result.timestamp).toLocaleString()}`;

    await msg.reply(report);

    console.log(`[candy] Successfully posted to Instagram: ${result.postId}`);
  } catch (err) {
    console.error("[candy] Instagram post error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

/**
 * Post to Facebook
 */
async function handlePostToFacebook(msg, message, mediaUrl = null) {
  console.log(`[candy] POST-FACEBOOK: ${message.slice(0, 50)}...`);
  await msg.channel.sendTyping();

  try {
    const result = await socialMediaTools.postToFacebook(message, mediaUrl);

    if (result.error) {
      await msg.reply(`❌ Facebook Error: ${result.error}`);
      return;
    }

    const report =
      `📱 **Posted to Facebook!**\n\n` +
      `Message: "${message.slice(0, 100)}${message.length > 100 ? "..." : ""}"\n` +
      `Post ID: \`${result.postId}\`\n` +
      `Timestamp: ${new Date(result.timestamp).toLocaleString()}`;

    await msg.reply(report);

    console.log(`[candy] Successfully posted to Facebook: ${result.postId}`);
  } catch (err) {
    console.error("[candy] Facebook post error:", err.message);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── CANDY'S IMAGE GENERATION (FREE TIER) ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Generate image using free APIs (Replicate or ComfyUI)
 */
async function handleGenerateImage(msg, prompt) {
  if (!prompt || !prompt.trim()) {
    await msg.reply(
      `Usage: \`!generate-image <prompt>\`\n` +
      `Example: \`!generate-image A cyberpunk neon city with flying cars\``
    );
    return;
  }

  console.log(`[candy] GENERATE-IMAGE: ${prompt.slice(0, 50)}...`);
  await msg.channel.sendTyping();

  try {
    console.log(`[candy] Calling generateImage with: "${prompt.trim().slice(0, 50)}..."`);
    const result = await socialMediaTools.generateImage(prompt.trim());

    console.log(`[candy] generateImage result:`, JSON.stringify(result).slice(0, 200));

    if (result.error) {
      await msg.reply(`❌ Image generation failed: ${result.error}`);
      console.log(`[candy] Image generation error reported: ${result.error}`);
      return;
    }

    if (result.success && result.filePath) {
      // Attach image as Discord file (not as data URL to avoid 4000 char limit)
      try {
        const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
        const attachment = new AttachmentBuilder(result.filePath, { name: `image_${Date.now()}.png` });

        // Keep message content under 4000 chars
        const shortPrompt = prompt.slice(0, 60);
        const report =
          `🎨 **Generated Image (${result.source})**\n` +
          `"${shortPrompt}${shortPrompt.length < prompt.length ? "..." : ""}"`;

        // Create buttons for Post to IG, Post to Website, and Regenerate
        const msgId = `candy-${Date.now()}`;
        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`btn_post_${msgId}`).setLabel("📱 Post to IG").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`btn_website_${msgId}`).setLabel("🌐 Post to Website").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`btn_regen_${msgId}`).setLabel("🔄 Regenerate").setStyle(ButtonStyle.Secondary),
        );

        console.log(`[candy] Sending image reply: ${report.slice(0, 50)}... (content length: ${report.length})`);
        const sentMsg = await msg.reply({ content: report, files: [attachment], components: [buttons] });
        console.log(`[candy] Generated image from ${result.source}`);

        // Store context for button interactions (keep buffer in memory for posting)
        if (global.generationContext === undefined) global.generationContext = new Map();
        global.generationContext.set(msgId, {
          prompt,
          imageBuf: result.buffer,
          source: result.source,
          timestamp: new Date().toISOString(),
        });

        // Don't delete temp file immediately — it may be needed for posting
        // Clean up will happen after posting or after 10 minutes
        setTimeout(() => {
          try { require("fs").unlinkSync(result.filePath); } catch {}
        }, 600000); // 10 minutes
      } catch (err) {
        console.error(`[candy] Error sending image reply:`, err.message);
        await msg.reply(`❌ Failed to send image: ${err.message.slice(0, 100)}`);
      }
    } else if (result.success && result.promptId) {
      // ComfyUI result with prompt ID (still generating)
      await msg.reply(
        `🎨 **Image Generation Started (${result.source})**\n\n` +
        `Prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}"\n` +
        `Job ID: \`${result.promptId}\`\n` +
        `Status: Processing on local ComfyUI...\n` +
        `*(Image will be saved locally)*`
      );
      console.log(`[candy] Started ComfyUI generation: ${result.promptId}`);
    } else {
      console.error(`[candy] Unexpected generateImage result:`, result);
      await msg.reply(`❌ Unexpected response from image generator: ${JSON.stringify(result).slice(0, 100)}`);
    }
  } catch (err) {
    console.error("[candy] Image generation error:", err.message, err.stack);
    await msg.reply(`❌ Error: ${err.message.slice(0, 100)}`);
  }
}

// Handle button interactions for images
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  const msgId = customId.replace(/^btn_(post|website|regen)_/, "");

  // Only handle Candy's buttons (candy-timestamp format)
  if (!msgId.startsWith("candy-")) return;

  const ctx = global.generationContext?.get(msgId);
  if (!ctx) {
    await interaction.reply({ content: "❌ Context expired. Please regenerate the image.", ephemeral: true });
    return;
  }

  try {
    if (customId.startsWith("btn_post_")) {
      // Post to Instagram (pass buffer directly to avoid Drive quota issues)
      await interaction.deferReply({ ephemeral: true });
      try {
        if (!ctx.imageBuf) {
          await interaction.editReply(`❌ No image buffer found. Please regenerate the image.`);
          return;
        }

        // Generate enhanced title and poetic quote
        const [title, quote] = await Promise.all([generateArtTitle(ctx.prompt), generateArtQuote(ctx.prompt)]);
        const caption = `${title}\n\n${quote}\n\n✨ #AIArt #GenerativeArt #AI`;

        // Pass buffer directly to postToInstagram (it will handle base64 encoding)
        const postResult = await socialMediaTools.postToInstagram(caption, ctx.imageBuf, "IMAGE");

        if (postResult.error) {
          await interaction.editReply(`❌ Instagram post failed: ${postResult.error}`);
        } else {
          await interaction.editReply(`✅ Posted to Instagram!\n**${title}**\nPost ID: \`${postResult.postId}\``);
        }
      } catch (err) {
        await interaction.editReply(`❌ Error: ${err.message.slice(0, 100)}`);
      }
    } else if (customId.startsWith("btn_website_")) {
      // Post to website (drivenemo.web.app)
      await interaction.deferReply({ ephemeral: true });
      try {
        if (!ctx.imageBuf) {
          await interaction.editReply(`❌ No image buffer found. Please regenerate the image.`);
          return;
        }

        const [title, quote] = await Promise.all([generateArtTitle(ctx.prompt), generateArtQuote(ctx.prompt)]);

        const section = "candy";
        const timestamp = new Date().toISOString();
        const postId = `${section}-${Date.now()}`;

        const post = {
          section,
          timestamp,
          id: postId,
          title,
          description: quote || "",
          imageData: ctx.imageBuf.toString("base64"),
          imageMime: "image/png",
        };

        // Save to local posts.json
        const posts = loadPosts();
        posts.unshift(post);
        if (posts.length > 50) posts.length = 50;
        savePosts(posts);

        await interaction.editReply("⏳ Deploying to drivenemo.web.app...");
        const ok = await deployToFirebase();

        if (ok) {
          console.log(`[candy] posted to ${section}: ${title}`);
          await interaction.editReply(`✅ Posted to **Candy's Gallery**\n**${title}**\nhttps://drivenemo.web.app`);
        } else {
          await interaction.editReply("⚠️ Post saved locally but deploy failed. Will retry on next post.");
        }
      } catch (e) {
        console.error(`[candy] website post failed: ${e.message}`);
        await interaction.editReply(`⚠️ Website post failed: ${e.message.slice(0, 200)}`);
      }
    } else if (customId.startsWith("btn_regen_")) {
      // Regenerate image
      await interaction.deferReply();
      const result = await socialMediaTools.generateImage(ctx.prompt);
      if (result.success && result.filePath) {
        const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
        const attachment = new AttachmentBuilder(result.filePath, { name: `image_${Date.now()}.png` });
        const shortPrompt = ctx.prompt.slice(0, 60);
        const report = `🎨 **Regenerated Image (${result.source})**\n"${shortPrompt}${shortPrompt.length < ctx.prompt.length ? "..." : ""}"`;

        // Create fresh button set with new msgId
        const newMsgId = `candy-${Date.now()}`;
        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`btn_post_${newMsgId}`).setLabel("📱 Post to IG").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`btn_website_${newMsgId}`).setLabel("🌐 Post to Website").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`btn_regen_${newMsgId}`).setLabel("🔄 Regenerate").setStyle(ButtonStyle.Secondary),
        );

        await interaction.editReply({ content: report, files: [attachment], components: [buttons] });

        // Store context with new image buffer and new msgId
        if (global.generationContext === undefined) global.generationContext = new Map();
        global.generationContext.set(newMsgId, {
          prompt: ctx.prompt,
          imageBuf: result.buffer,
          source: result.source,
          timestamp: new Date().toISOString(),
        });

        // Don't delete temp file immediately — it may be needed for posting
        setTimeout(() => {
          try { require("fs").unlinkSync(result.filePath); } catch {}
        }, 600000); // 10 minutes
      } else {
        await interaction.editReply(`❌ Regeneration failed: ${result.error}`);
      }
    }
  } catch (err) {
    console.error(`[candy] Button interaction error:`, err.message);
    if (!interaction.replied) {
      await interaction.reply({ content: `❌ Error: ${err.message.slice(0, 100)}`, ephemeral: true });
    }
  }
});

client.login(DISCORD_BOT_TOKEN);
