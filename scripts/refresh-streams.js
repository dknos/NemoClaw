#!/usr/bin/env node
"use strict";

/**
 * refresh-streams.js — Fetches latest YouTube videos for the PIPEBOX site
 * Updates /tmp/netify-build/public/data/streams.json
 * Cron: every 6 hours
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Load env
const envFile = path.join(os.homedir(), ".nemoclaw_env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const API_KEY = process.env.YOUTUBE_API_KEY;
const STREAMS_FILE = "/tmp/netify-build/public/data/streams.json";

// Channel IDs to monitor (add more as needed)
const CHANNELS = [
  { id: "UC7jdSqmBUs0ZJhP-A15jq3w", name: "MrBigPipes" },
  { id: "UC_x5XG1OV2P6uZZ5FSM9Ttw", name: "Google for Developers" },
];

// Search queries to find interesting live/recent streams
const SEARCH_QUERIES = [
  "live stream music",
  "live coding stream",
  "live art creation",
  "live cooking stream",
];

function ytGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `https://www.googleapis.com/youtube/v3/${endpoint}&key=${API_KEY}`;
    https.get(url, (res) => {
      let b = "";
      res.on("data", d => b += d);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`YouTube API ${res.statusCode}: ${b.slice(0, 200)}`));
        resolve(JSON.parse(b));
      });
    }).on("error", reject);
  });
}

async function getChannelUploads(channelId, channelName, maxResults = 3) {
  try {
    // Get uploads playlist
    const ch = await ytGet(`channels?part=contentDetails&id=${channelId}`);
    const uploadsId = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) return [];

    const pl = await ytGet(`playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=${maxResults}`);
    return (pl.items || []).map(item => ({
      videoId: item.snippet.resourceId.videoId,
      title: item.snippet.title,
      channel: channelName || item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || "",
      isLive: false,
      publishedAt: item.snippet.publishedAt,
    }));
  } catch (e) {
    console.warn(`[streams] channel ${channelName} failed: ${e.message}`);
    return [];
  }
}

async function searchRecent(query, maxResults = 3) {
  try {
    const data = await ytGet(`search?part=snippet&q=${encodeURIComponent(query)}&type=video&eventType=completed&order=date&maxResults=${maxResults}`);
    return (data.items || []).map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || "",
      isLive: false,
      publishedAt: item.snippet.publishedAt,
    }));
  } catch (e) {
    console.warn(`[streams] search "${query}" failed: ${e.message}`);
    return [];
  }
}

async function searchLive(maxResults = 3) {
  try {
    const data = await ytGet(`search?part=snippet&q=live+stream&type=video&eventType=live&order=viewCount&maxResults=${maxResults}`);
    return (data.items || []).map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || "",
      isLive: true,
      publishedAt: item.snippet.publishedAt,
    }));
  } catch (e) {
    console.warn(`[streams] live search failed: ${e.message}`);
    return [];
  }
}

(async () => {
  if (!API_KEY) { console.error("[streams] YOUTUBE_API_KEY not set"); process.exit(1); }

  console.log("[streams] refreshing...");
  const all = [];

  // 1. Get uploads from tracked channels
  for (const ch of CHANNELS) {
    const vids = await getChannelUploads(ch.id, ch.name, 2);
    all.push(...vids);
    console.log(`[streams] ${ch.name}: ${vids.length} videos`);
  }

  // 2. Find currently live streams
  const live = await searchLive(3);
  all.push(...live);
  console.log(`[streams] live: ${live.length}`);

  // 3. Search for recent interesting streams (pick one random query)
  const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
  const recent = await searchRecent(query, 3);
  all.push(...recent);
  console.log(`[streams] search "${query}": ${recent.length}`);

  // Deduplicate by videoId
  const seen = new Set();
  const unique = all.filter(v => {
    if (seen.has(v.videoId)) return false;
    seen.add(v.videoId);
    return true;
  });

  // Sort: live first, then by date
  unique.sort((a, b) => {
    if (a.isLive && !b.isLive) return -1;
    if (!a.isLive && b.isLive) return 1;
    return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
  });

  // Keep top 9
  const final = unique.slice(0, 9);

  // Write
  const output = { broadcasts: final, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(STREAMS_FILE), { recursive: true });
  fs.writeFileSync(STREAMS_FILE, JSON.stringify(output, null, 2));
  console.log(`[streams] wrote ${final.length} broadcasts to ${STREAMS_FILE}`);

  // Deploy if firebase CLI available
  try {
    const { execSync } = require("child_process");
    execSync("cd /tmp/netify-build && npx firebase deploy --only hosting 2>&1", { timeout: 60000 });
    console.log("[streams] deployed to Firebase");
  } catch (e) {
    console.warn("[streams] deploy skipped:", e.message?.slice(0, 100));
  }
})().catch(e => { console.error("[streams] fatal:", e.message); process.exit(1); });
