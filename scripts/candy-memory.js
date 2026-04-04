#!/usr/bin/env node
/**
 * Candy's Memory System — Google Drive + Local Cache
 * Stores, searches, and analyzes trends over time for pattern detection
 *
 * Architecture:
 * - Local: ~/.nemoclaw/candy-trends.jsonl (fast searching, searchable by metadata)
 * - GDrive: Backup archive (GDRIVE_CANDY_FOLDER_ID folder)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const gdrive = require("./google-drive");

const GDRIVE_FOLDER_ID = process.env.GDRIVE_CANDY_FOLDER_ID || process.env.GDRIVE_FOLDER_ID || "";
const TRENDS_FILE = path.join(os.homedir(), ".nemoclaw", "candy-trends.jsonl");

let isInitialized = false;

/**
 * Initialize memory system (create directories, verify access)
 */
async function initializeGDrive() {
  if (isInitialized) return;

  try {
    const dir = path.dirname(TRENDS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    console.log(`[candy-memory] Local cache: ${TRENDS_FILE}`);

    if (GDRIVE_FOLDER_ID) {
      console.log(`[candy-memory] GDrive backup: enabled (${GDRIVE_FOLDER_ID})`);
    } else {
      console.log(`[candy-memory] GDrive backup: disabled (set GDRIVE_CANDY_FOLDER_ID or GDRIVE_FOLDER_ID)`);
    }

    isInitialized = true;
  } catch (err) {
    console.error(`[candy-memory] Initialization error:`, err.message);
    throw err;
  }
}

/**
 * Store a trend in local memory and backup to GDrive
 * @param {object} trend - { platform, title, engagement, url, timestamp, ... }
 * @param {string} insight - Analysis/commentary
 */
async function storeTrend(trend, insight = "") {
  try {
    const {
      platform = "unknown",
      title = "",
      engagement = 0,
      views = 0,
      upvotes = 0,
      comments = 0,
      url = "",
      author = "",
      channel = "",
      timestamp = new Date().toISOString(),
    } = trend;

    const trendData = {
      id: Math.floor(Math.random() * 1000000000),
      platform,
      title,
      insight,
      engagement: Math.max(engagement, Math.max(views, upvotes)),
      views,
      upvotes,
      comments,
      url,
      author,
      channel,
      timestamp: new Date(timestamp).getTime(),
      storedAt: new Date().toISOString(),
    };

    // Store locally
    const line = JSON.stringify(trendData) + "\n";
    fs.appendFileSync(TRENDS_FILE, line);
    console.log(`[candy-memory] Stored trend: ${title.slice(0, 50)} (local cache)`);

    // Backup to GDrive (async, non-blocking)
    if (GDRIVE_FOLDER_ID) {
      setImmediate(async () => {
        try {
          const tempPath = `/tmp/candy-trend-${trendData.id}.json`;
          fs.writeFileSync(tempPath, JSON.stringify(trendData, null, 2));
          const filename = `candy-trend-${new Date().toISOString().split("T")[0]}-${trendData.id}.json`;
          await gdrive.uploadToDrive(tempPath, "application/json", filename, GDRIVE_FOLDER_ID);
          fs.unlinkSync(tempPath);
          console.log(`[candy-memory] Backed up to GDrive: ${filename}`);
        } catch (err) {
          console.warn(`[candy-memory] GDrive backup failed (non-blocking):`, err.message);
        }
      });
    }

    return { id: trendData.id, stored: true };
  } catch (err) {
    console.error(`[candy-memory] Error storing trend:`, err.message);
    throw err;
  }
}

/**
 * Search trends by title or platform (local, instant)
 * @param {string} query - Search query
 * @param {number} limit - Number of results
 */
async function searchTrends(query, limit = 5) {
  try {
    const queryLower = query.toLowerCase();
    const trends = loadLocalTrends();

    // Search by title or platform (simple substring match + ranking)
    const scored = trends
      .map((t) => {
        let score = 0;

        // Title match (stronger weight)
        if (t.title.toLowerCase().includes(queryLower)) {
          score += 10;
          if (t.title.toLowerCase().startsWith(queryLower)) score += 5;
        }

        // Insight match
        if (t.insight && t.insight.toLowerCase().includes(queryLower)) {
          score += 3;
        }

        // Platform match
        if (t.platform.toLowerCase().includes(queryLower)) {
          score += 2;
        }

        return { ...t, score };
      })
      .filter((t) => t.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((t) => ({
        title: t.title,
        platform: t.platform,
        engagement: t.engagement,
        url: t.url,
        timestamp: new Date(t.timestamp).toISOString(),
        insight: t.insight,
        relevance: `${t.score}/10`,
      }));

    console.log(`[candy-memory] Found ${scored.length} trends for: "${query}"`);
    return scored;
  } catch (err) {
    console.error(`[candy-memory] Error searching trends:`, err.message);
    return [];
  }
}

/**
 * Get trend history for a topic (last 7 days with pattern detection)
 * @param {string} topic - Topic to track
 * @param {number} days - How many days back
 */
async function getTrendHistory(topic, days = 7) {
  try {
    const cutoffTime = new Date();
    cutoffTime.setDate(cutoffTime.getDate() - days);
    const cutoffMs = cutoffTime.getTime();

    const trends = loadLocalTrends();
    const topicLower = topic.toLowerCase();

    // Filter by topic and time range
    const history = trends
      .filter((t) => {
        const matchesTopic =
          t.title.toLowerCase().includes(topicLower) ||
          (t.insight && t.insight.toLowerCase().includes(topicLower));
        const inTimeRange = t.timestamp > cutoffMs;
        return matchesTopic && inTimeRange;
      })
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((t) => ({
        timestamp: new Date(t.timestamp).toISOString(),
        title: t.title,
        platform: t.platform,
        engagement: t.engagement,
        url: t.url,
      }));

    console.log(`[candy-memory] Found ${history.length} trend history entries for: "${topic}"`);
    return history;
  } catch (err) {
    console.error(`[candy-memory] Error getting trend history:`, err.message);
    return [];
  }
}

/**
 * Detect viral patterns (velocity, clustering, timing)
 */
function detectPatterns(trends) {
  if (trends.length === 0) {
    return {
      velocity: "0",
      clusters: [],
      timing: "unknown",
      avgEngagement: "0",
      samples: 0,
    };
  }

  // Extract engagement values from trend history
  const engagements = trends.map((t) => {
    if (typeof t === "object" && t.engagement !== undefined) {
      return t.engagement;
    }
    return 0;
  });

  // Sort by timestamp for velocity calculation
  const sorted = trends
    .map((t, i) => ({ ...t, engagement: engagements[i] }))
    .sort((a, b) => {
      const aTime = typeof a.timestamp === "string" ? new Date(a.timestamp).getTime() : a.timestamp;
      const bTime = typeof b.timestamp === "string" ? new Date(b.timestamp).getTime() : b.timestamp;
      return aTime - bTime;
    });

  // Calculate velocity (engagement change per hour)
  let velocity = 0;
  if (sorted.length >= 2) {
    const first = typeof sorted[0].timestamp === "string" ? new Date(sorted[0].timestamp).getTime() : sorted[0].timestamp;
    const last = typeof sorted[sorted.length - 1].timestamp === "string" ? new Date(sorted[sorted.length - 1].timestamp).getTime() : sorted[sorted.length - 1].timestamp;
    const hoursElapsed = (last - first) / (1000 * 60 * 60);
    if (hoursElapsed > 0) {
      velocity = (sorted[sorted.length - 1].engagement - sorted[0].engagement) / hoursElapsed;
    }
  }

  // Detect engagement clusters (peaks above average)
  const avgEngagement = engagements.reduce((sum, e) => sum + e, 0) / engagements.length;
  const clusters = sorted
    .filter((t) => t.engagement > avgEngagement * 1.5)
    .map((t) => ({
      timestamp: typeof t.timestamp === "string" ? t.timestamp : new Date(t.timestamp).toISOString(),
      engagement: t.engagement,
      multiplier: (t.engagement / avgEngagement).toFixed(2),
    }));

  // Timing pattern (time of day analysis)
  const hours = sorted.map((t) => {
    const time = typeof t.timestamp === "string" ? new Date(t.timestamp) : new Date(t.timestamp);
    return time.getHours();
  });
  const commonHours = {};
  hours.forEach((h) => (commonHours[h] = (commonHours[h] || 0) + 1));
  const peakHour = Object.entries(commonHours).sort((a, b) => b[1] - a[1])[0];
  const timing = peakHour ? `${peakHour[0]}:00 UTC (${peakHour[1]} spikes)` : "distributed";

  return {
    velocity: velocity.toFixed(2),
    avgEngagement: Math.round(avgEngagement).toString(),
    clusters,
    timing,
    samples: sorted.length,
  };
}

/**
 * Compare two trends for similarity and patterns
 */
async function compareTrends(topic1, topic2) {
  try {
    const history1 = await getTrendHistory(topic1, 30);
    const history2 = await getTrendHistory(topic2, 30);

    const patterns1 = detectPatterns(history1);
    const patterns2 = detectPatterns(history2);

    const similarity = calculateSimilarity(patterns1, patterns2);

    return {
      topic1: {
        name: topic1,
        samples: history1.length,
        patterns: patterns1,
      },
      topic2: {
        name: topic2,
        samples: history2.length,
        patterns: patterns2,
      },
      similarity,
    };
  } catch (err) {
    console.error(`[candy-memory] Error comparing trends:`, err.message);
    throw err;
  }
}

/**
 * Calculate similarity between two pattern sets (0-100%)
 */
function calculateSimilarity(p1, p2) {
  let score = 0;

  // Compare velocity direction
  const vel1 = parseFloat(p1.velocity);
  const vel2 = parseFloat(p2.velocity);
  if ((vel1 > 0 && vel2 > 0) || (vel1 < 0 && vel2 < 0)) {
    score += 0.3;
  }

  // Compare cluster counts
  const clusterDiff = Math.abs(p1.clusters.length - p2.clusters.length);
  if (clusterDiff <= 1) score += 0.35;

  // Compare timing
  if (p1.timing === p2.timing) score += 0.35;

  return Math.round(score * 100) + "%";
}

/**
 * Load all trends from local cache (JSONL file)
 */
function loadLocalTrends() {
  try {
    if (!fs.existsSync(TRENDS_FILE)) {
      return [];
    }

    const content = fs.readFileSync(TRENDS_FILE, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());

    return lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        console.warn(`[candy-memory] Skipping malformed trend line:`, e.message);
        return null;
      }
    }).filter(Boolean);
  } catch (err) {
    console.error(`[candy-memory] Error loading local trends:`, err.message);
    return [];
  }
}

module.exports = {
  initializeGDrive,
  storeTrend,
  searchTrends,
  getTrendHistory,
  detectPatterns,
  compareTrends,
};
