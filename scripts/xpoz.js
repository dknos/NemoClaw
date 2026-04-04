#!/usr/bin/env node
// xpoz.js — XPOZ social intelligence wrapper
// Calls the XPOZ MCP API to fetch trending content across Twitter, Instagram, Reddit, TikTok

"use strict";
const https = require("https");

const XPOZ_TOKEN = process.env.XPOZ_API_KEY;
const XPOZ_URL   = "https://mcp.xpoz.ai/mcp";

// ── Core MCP call ────────────────────────────────────────────────

function xpozCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });
    const req = https.request({
      hostname: "mcp.xpoz.ai",
      path: "/mcp",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${XPOZ_TOKEN}`,
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 20000,
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        // Parse SSE: lines starting with "data: "
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) {
            try {
              const d = JSON.parse(line.slice(5).trim());
              if (d.error) return reject(new Error(d.error.message));
              return resolve(d.result);
            } catch {}
          }
        }
        // Fallback: try raw JSON
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error("xpoz: unparseable response")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("xpoz: timeout")); });
    req.end(body);
  });
}

function toolCall(name, args) {
  return xpozCall("tools/call", { name, arguments: args });
}

// ── Extract post data from MCP result ────────────────────────────

function extractPosts(result) {
  if (!result) return [];
  const content = Array.isArray(result.content) ? result.content : [];
  const posts = [];
  for (const c of content) {
    if (c.type !== "text") continue;
    const text = c.text || "";
    // Try JSON first
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.data)) return parsed.data;
      if (Array.isArray(parsed.posts)) return parsed.posts;
      if (Array.isArray(parsed.results)) return parsed.results;
    } catch {}

    // XPOZ table format — header line: results[N]{col1,col2,...}:
    // Data rows: id,field1,field2,... (id may be quoted numeric or bare alphanumeric)
    // Some fields (text/caption) may contain newlines — rejoin continuation lines.
    const headerRe = /results\[\d+\]\{([^}]+)\}:/;
    const headerMatch = text.match(headerRe);
    const cols = headerMatch ? headerMatch[1].split(",").map(c => c.trim()) : [];

    // Row starts: quoted numeric ID ("digits",) or bare alphanumeric ID (word,)
    const rowStartRe = /^("?\w[\w\d]*"?),/;
    const skipPrefixes = ["success:", "data:", "results[", "count:", "query:", "operationId:", "guidance:", "preview:", "suggestions", "tableName:"];

    const lines = text.split("\n");
    let currentRow = null;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const isSkip = skipPrefixes.some(p => line.startsWith(p));
      if (isSkip) continue;

      if (rowStartRe.test(line)) {
        if (currentRow) posts.push(parseXpozRow(currentRow, cols));
        currentRow = line;
      } else if (currentRow) {
        currentRow += " " + line;
      }
    }
    if (currentRow) posts.push(parseXpozRow(currentRow, cols));
  }
  return posts.filter(Boolean);
}

function parseXpozRow(row, cols) {
  try {
    const parts = csvSplit(row).map(p => p.replace(/^"|"$/g, "").trim());
    if (parts.length < 2) return null;
    // Map by column name if we have headers, otherwise use positional fallback
    const get = (names) => {
      for (const name of names) {
        const idx = cols.indexOf(name);
        if (idx >= 0 && parts[idx]) return parts[idx];
      }
      return "";
    };
    const postText  = get(["text", "caption", "title", "body"]) || parts[1] || "";
    const author    = get(["authorUsername", "username", "author"]).replace(/^@/, "") || parts[2] || "";
    const likesRaw  = get(["likesCount", "impressionCount", "score", "upvoteCount"]) || parts[3] || "0";
    const likesNum  = parseInt(likesRaw.replace(/\D/g, ""), 10) || 0;
    // Cap at 500M — anything larger is a misparse (date/timestamp/ID in the likes field)
    const likes     = likesNum > 500_000_000 ? 0 : likesNum;
    if (!postText) return null;
    return { text: postText, likesCount: likes, authorUsername: author };
  } catch {
    return null;
  }
}

function csvSplit(row) {
  // Split CSV row respecting quoted fields
  const parts = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') { inQuote = !inQuote; cur += ch; }
    else if (ch === "," && !inQuote) { parts.push(cur); cur = ""; }
    else { cur += ch; }
  }
  parts.push(cur);
  return parts;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Search trending posts by keyword across one platform.
 * Returns array of { text, likes, platform, author }
 */
async function searchPosts(platform, query, limit = 20) {
  const toolMap = {
    twitter:   "getTwitterPostsByKeywords",
    instagram: "getInstagramPostsByKeywords",
    reddit:    "getRedditPostsByKeywords",
    tiktok:    "getTiktokPostsByKeywords",
  };
  const tool = toolMap[platform];
  if (!tool) throw new Error(`Unknown platform: ${platform}`);

  const result = await toolCall(tool, {
    query,
    responseType: "fast",
    limit,
  });

  return extractPosts(result).slice(0, limit).map(p => ({
    platform,
    text:    p.text || p.caption || p.title || p.body || "",
    likes:   p.likesCount || p.score || 0,
    views:   p.viewsCount || 0,
    author:  p.authorUsername || p.username || "",
    date:    p.date || "",
  }));
}

/**
 * Get trending topics across all platforms for a given theme.
 * Returns a trend summary object ready to inject into AI context.
 */
async function getTrends(theme = "AI art viral trending", limit = 25) {
  const platforms = ["twitter", "instagram", "reddit", "tiktok"];
  const results = await Promise.allSettled(
    platforms.map(p => searchPosts(p, theme, limit))
  );

  const byPlatform = {};
  for (let i = 0; i < platforms.length; i++) {
    const r = results[i];
    byPlatform[platforms[i]] = r.status === "fulfilled" ? r.value : [];
  }

  // Extract top hashtags and keywords from captions/posts
  const allText = Object.values(byPlatform).flat().map(p => p.text).join(" ");
  const hashtags = [...new Set(allText.match(/#[\w]+/g) || [])].slice(0, 20);
  const topPosts = Object.values(byPlatform)
    .flat()
    .sort((a, b) => (b.likes + b.views) - (a.likes + a.views))
    .slice(0, 5);

  return {
    theme,
    hashtags,
    topPosts,
    byPlatform,
    summary: buildTrendSummary(byPlatform, hashtags, topPosts),
  };
}

function buildTrendSummary(byPlatform, hashtags, topPosts) {
  const lines = ["=== SOCIAL TRENDS ==="];

  if (hashtags.length) {
    lines.push(`Trending hashtags: ${hashtags.slice(0, 10).join(" ")}`);
  }

  if (topPosts.length) {
    lines.push("\nTop performing posts:");
    for (const p of topPosts.slice(0, 3)) {
      const snippet = p.text.slice(0, 120).replace(/\n/g, " ");
      lines.push(`  [${p.platform}] ${snippet} (❤️ ${p.likes})`);
    }
  }

  for (const [platform, posts] of Object.entries(byPlatform)) {
    if (!posts.length) continue;
    const top = posts.sort((a, b) => b.likes - a.likes)[0];
    if (top?.text) {
      lines.push(`\n${platform.toUpperCase()} top: "${top.text.slice(0, 100)}" — ❤️${top.likes}`);
    }
  }

  lines.push("=== END TRENDS ===");
  return lines.join("\n");
}

/**
 * Quick trend check — returns a short string for injecting into prompts.
 * Use this before generating images/videos/music.
 */
async function getTrendContext(theme) {
  try {
    const trends = await getTrends(theme);
    return trends.summary;
  } catch (e) {
    console.warn("[xpoz] trend fetch failed:", e.message);
    return "";
  }
}

/**
 * Search a specific user across platforms.
 */
async function searchUser(platform, username) {
  const toolMap = {
    twitter:   "getTwitterUser",
    instagram: "getInstagramUser",
    tiktok:    "getTiktokUser",
  };
  const tool = toolMap[platform];
  if (!tool) throw new Error(`User lookup not supported for: ${platform}`);
  const result = await toolCall(tool, { username, identifierType: "username" });
  const posts = extractPosts(result);
  return posts[0] || result;
}

module.exports = { getTrends, getTrendContext, searchPosts, searchUser, toolCall };
