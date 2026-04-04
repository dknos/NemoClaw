#!/usr/bin/env node
// trends.js — Expandable social trend intelligence for NemoClaw Discord bot
// Add new platforms via registerPlatform(name, async (query, limit) => [...posts])
// Standard post format: { platform, title, text, likes, views, author, url, date }
//
// Platforms:
//   youtube   — Google YouTube Data API v3  (GOOGLE_API_KEY)
//   reddit    — Reddit public JSON API      (no auth)
//   twitter   — XPOZ SDK                   (XPOZ_API_KEY)
//   instagram — XPOZ SDK                   (XPOZ_API_KEY)
//   tiktok    — XPOZ SDK                   (XPOZ_API_KEY)

"use strict";
const https = require("https");
const http  = require("http");
const { XpozClient } = require("@xpoz/xpoz");

// ── HTTP helper ───────────────────────────────────────────────────

function httpGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   "GET",
      headers:  { "User-Agent": "NemoClaw-TrendBot/1.0", ...headers },
      timeout:  18000,
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`unparseable response from ${url.hostname}: ${raw.slice(0,120)}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`timeout: ${url.hostname}`)); });
    req.end();
  });
}

// ── Platform registry ─────────────────────────────────────────────

const PLATFORMS = {};

function registerPlatform(name, scraper) {
  PLATFORMS[name] = scraper;
}

// ── YouTube ───────────────────────────────────────────────────────

registerPlatform("youtube", async (query, limit = 25) => {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY not set");

  const n = Math.min(limit, 50);
  const searchUrl =
    `https://www.googleapis.com/youtube/v3/search` +
    `?part=snippet&type=video&q=${encodeURIComponent(query)}` +
    `&order=viewCount&maxResults=${n}&key=${encodeURIComponent(key)}`;

  const searchRes = await httpGet(searchUrl);
  if (searchRes.error) throw new Error(`YouTube: ${searchRes.error.message}`);

  const items = searchRes.items || [];
  const ids = items.map(i => i.id?.videoId).filter(Boolean);
  if (!ids.length) return [];

  // Fetch stats in one batch call
  const statsUrl =
    `https://www.googleapis.com/youtube/v3/videos` +
    `?part=statistics&id=${ids.join(",")}&key=${encodeURIComponent(key)}`;
  const statsRes = await httpGet(statsUrl).catch(() => ({ items: [] }));

  const statsMap = {};
  for (const v of (statsRes.items || [])) statsMap[v.id] = v.statistics || {};

  return items.map(item => {
    const vid = item.id?.videoId || "";
    const st  = statsMap[vid] || {};
    const sn  = item.snippet || {};
    return {
      platform: "youtube",
      title:    sn.title || "",
      text:     sn.description ? sn.description.slice(0, 200) : sn.title || "",
      likes:    parseInt(st.likeCount  || "0", 10),
      views:    parseInt(st.viewCount  || "0", 10),
      author:   sn.channelTitle || "",
      url:      `https://youtube.com/watch?v=${vid}`,
      date:     sn.publishedAt || "",
    };
  }).filter(p => p.title);
});

// ── Reddit ────────────────────────────────────────────────────────

registerPlatform("reddit", async (query, limit = 25) => {
  const n = Math.min(limit, 100);
  const url =
    `https://www.reddit.com/search.json` +
    `?q=${encodeURIComponent(query)}&sort=hot&limit=${n}&t=week`;

  const res = await httpGet(url, { Accept: "application/json" });
  if (!res.data?.children) throw new Error("Reddit: unexpected response shape");

  return res.data.children
    .filter(c => c.kind === "t3")
    .map(c => {
      const p = c.data;
      return {
        platform: "reddit",
        title:    p.title || "",
        text:     p.selftext?.trim().slice(0, 200) || p.title || "",
        likes:    p.ups    || 0,
        views:    p.view_count || 0,
        author:   p.author || "",
        url:      `https://reddit.com${p.permalink}`,
        date:     p.created_utc ? new Date(p.created_utc * 1000).toISOString() : "",
      };
    }).filter(p => p.title);
});

// ── XPOZ platforms (Twitter, Instagram, TikTok) ───────────────────

function getXpozClient() {
  const key = process.env.XPOZ_API_KEY;
  if (!key) throw new Error("XPOZ_API_KEY not set");
  return new XpozClient(key);
}

function normalizeXpozPost(p, platform) {
  const likesRaw = p.likesCount ?? p.impressionCount ?? p.score ?? p.upvoteCount ?? 0;
  const likes = typeof likesRaw === "number" ? likesRaw : parseInt(String(likesRaw).replace(/\D/g, ""), 10) || 0;
  const safeL  = likes > 500_000_000 ? 0 : likes; // cap date-misparsed values
  return {
    platform,
    title:  "",
    text:   (p.text || p.caption || p.title || p.body || "").slice(0, 300),
    likes:  safeL,
    views:  p.viewsCount ?? p.views ?? 0,
    author: (p.authorUsername || p.username || p.author || "").replace(/^@/, ""),
    url:    p.url || p.postUrl || "",
    date:   p.date || p.createdAt || "",
  };
}

registerPlatform("twitter", async (query, limit = 25) => {
  const client = getXpozClient();
  const result = await client.twitter.searchPosts(query, { limit, responseType: "fast" });
  const items  = Array.isArray(result) ? result
    : Array.isArray(result?.data) ? result.data
    : Array.isArray(result?.posts) ? result.posts
    : [];
  return items.map(p => normalizeXpozPost(p, "twitter")).filter(p => p.text);
});

registerPlatform("instagram", async (query, limit = 25) => {
  const client = getXpozClient();
  const result = await client.instagram.searchPosts(query, { limit, responseType: "fast" });
  const items  = Array.isArray(result) ? result
    : Array.isArray(result?.data) ? result.data
    : Array.isArray(result?.posts) ? result.posts
    : [];
  return items.map(p => normalizeXpozPost(p, "instagram")).filter(p => p.text);
});

registerPlatform("tiktok", async (query, limit = 25) => {
  const client = getXpozClient();
  const result = await client.tiktok.searchPosts(query, { limit, responseType: "fast" });
  const items  = Array.isArray(result) ? result
    : Array.isArray(result?.data) ? result.data
    : Array.isArray(result?.posts) ? result.posts
    : [];
  return items.map(p => normalizeXpozPost(p, "tiktok")).filter(p => p.text);
});

// ── Core API ──────────────────────────────────────────────────────

async function searchPosts(platform, query, limit = 25) {
  const scraper = PLATFORMS[platform];
  if (!scraper) throw new Error(
    `Unknown platform: ${platform}. Available: ${Object.keys(PLATFORMS).join(", ")}`
  );
  return scraper(query, limit);
}

async function getTrends(theme = "trending viral", limit = 25) {
  const names   = Object.keys(PLATFORMS);
  const results = await Promise.allSettled(names.map(p => searchPosts(p, theme, limit)));

  const byPlatform = {};
  for (let i = 0; i < names.length; i++) {
    const r = results[i];
    byPlatform[names[i]] = r.status === "fulfilled" ? r.value : [];
    if (r.status === "rejected") console.warn(`[trends] ${names[i]} failed: ${r.reason.message}`);
  }

  const allText = Object.values(byPlatform).flat()
    .map(p => (p.title ? p.title + " " : "") + p.text)
    .join(" ");
  const hashtags = [...new Set(allText.match(/#[\w]+/g) || [])].slice(0, 25);

  const topPosts = Object.values(byPlatform).flat()
    .sort((a, b) => (b.likes + b.views) - (a.likes + a.views))
    .slice(0, 10);

  return { theme, hashtags, topPosts, byPlatform, summary: buildSummary(byPlatform, hashtags, topPosts) };
}

function buildSummary(byPlatform, hashtags, topPosts) {
  const lines = ["=== SOCIAL TRENDS ==="];

  if (hashtags.length) lines.push(`Trending hashtags: ${hashtags.slice(0, 10).join(" ")}`);

  if (topPosts.length) {
    lines.push("\nTop posts:");
    for (const p of topPosts.slice(0, 5)) {
      const label = (p.title || p.text).slice(0, 120).replace(/\n/g, " ");
      lines.push(`  [${p.platform}] ${label} (👍 ${p.likes} | 👁 ${p.views})`);
    }
  }

  for (const [platform, posts] of Object.entries(byPlatform)) {
    if (!posts.length) continue;
    const top = [...posts].sort((a, b) => (b.likes + b.views) - (a.likes + a.views))[0];
    if (top) lines.push(
      `\n${platform.toUpperCase()} top: "${(top.title || top.text).slice(0, 100)}" — 👍${top.likes} 👁${top.views}`
    );
  }

  lines.push("=== END TRENDS ===");
  return lines.join("\n");
}

async function getTrendContext(theme) {
  try {
    const trends = await getTrends(theme);
    return trends.summary;
  } catch (e) {
    console.warn("[trends] fetch failed:", e.message);
    return "";
  }
}

module.exports = { getTrends, getTrendContext, searchPosts, registerPlatform, PLATFORMS };
