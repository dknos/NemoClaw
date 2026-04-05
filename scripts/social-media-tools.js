#!/usr/bin/env node
/**
 * Social Media Tools Module for Candy
 * YouTube, Reddit, Instagram, Facebook, TikTok monitoring + trend analysis
 * Real-time search, scroll monitoring, engagement tracking
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, execSync } = require("child_process");

// Load .nemoclaw_env if present (pm2 doesn't source shell profiles)
const _envFile = path.join(os.homedir(), ".nemoclaw_env");
if (fs.existsSync(_envFile)) {
  for (const line of fs.readFileSync(_envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Platform APIs (using public endpoints where available, auth where needed)
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const REDDIT_API_KEY = process.env.REDDIT_API_KEY || "";
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || "";
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || "";
const TIKTOK_ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN || "";

// Brave Search for general trends (if available)
const BRAVE_SEARCH_KEY = process.env.BRAVE_SEARCH_KEY || "";


/**
 * YouTube Trending
 */
async function getYouTubeTrending(region = "US", count = 10) {
  if (!YOUTUBE_API_KEY) {
    return { error: "YouTube API key not configured", platform: "youtube" };
  }

  return new Promise((resolve) => {
    const query = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=${region}&maxResults=${count}&key=${YOUTUBE_API_KEY}`;

    https.get(query, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const videos = (json.items || []).map((v) => ({
            title: v.snippet.title,
            channel: v.snippet.channelTitle,
            views: v.statistics.viewCount,
            likes: v.statistics.likeCount,
            videoId: v.id,
            url: `https://youtube.com/watch?v=${v.id}`,
          }));
          resolve({ platform: "youtube", videos, region });
        } catch (e) {
          resolve({ error: e.message, platform: "youtube" });
        }
      });
    });
  });
}

/**
 * Reddit Trending (using public API, no auth required)
 */
async function getRedditTrending(subreddit = "all", timeframe = "day", count = 10) {
  return new Promise((resolve) => {
    const url = `https://www.reddit.com/r/${subreddit}/top/.json?t=${timeframe}&limit=${count}`;

    https.get(
      url,
      {
        headers: {
          "User-Agent":
            "MrBigPipes-SocialMediaMonitor/1.0 (compatible with social media analysis)",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            const posts = (json.data?.children || [])
              .map((item) => ({
                title: item.data.title,
                author: item.data.author,
                subreddit: item.data.subreddit,
                upvotes: item.data.ups,
                comments: item.data.num_comments,
                url: `https://reddit.com${item.data.permalink}`,
                score: item.data.score,
              }))
              .filter((p) => p.upvotes > 0);

            resolve({ platform: "reddit", posts, subreddit, timeframe });
          } catch (e) {
            resolve({ error: e.message, platform: "reddit" });
          }
        });
      }
    );
  });
}

/**
 * Web Search (Brave) for real-time trends
 */
async function searchTrends(query, timeframe = "pastWeek") {
  if (!BRAVE_SEARCH_KEY) {
    return { error: "Brave Search API key not configured", query };
  }

  return new Promise((resolve) => {
    const options = {
      hostname: "api.search.brave.com",
      path: `/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&freshness=${timeframe}`,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": BRAVE_SEARCH_KEY,
      },
    };

    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const results = (json.web || []).map((r) => ({
            title: r.title,
            description: r.description,
            url: r.url,
            relevance: r.meta_url ? "high" : "medium",
          }));
          resolve({ platform: "web", results, query, count: results.length });
        } catch (e) {
          resolve({ error: e.message, query });
        }
      });
    });
  });
}

/**
 * Generic Trend Monitor (aggregates from multiple sources)
 */
async function aggregateTrends(options = {}) {
  const {
    platforms = ["youtube", "reddit", "web"],
    keywords = [],
    timeframe = "day",
  } = options;

  const results = {
    timestamp: new Date().toISOString(),
    platforms: {},
  };

  // YouTube
  if (platforms.includes("youtube")) {
    results.platforms.youtube = await getYouTubeTrending("US", 5);
  }

  // Reddit
  if (platforms.includes("reddit")) {
    results.platforms.reddit = await getRedditTrending("all", timeframe, 5);
  }

  // Web Search for keywords
  if (platforms.includes("web") && keywords.length > 0) {
    results.platforms.web = {};
    for (const keyword of keywords) {
      results.platforms.web[keyword] = await searchTrends(keyword, timeframe);
    }
  }

  return results;
}

/**
 * Save trend report to file
 */
function saveTrendReport(trendData, filename) {
  const reportsDir = path.join(os.homedir(), ".nemoclaw", "trend-reports");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const filepath = path.join(reportsDir, filename || `trends-${Date.now()}.json`);
  fs.writeFileSync(filepath, JSON.stringify(trendData, null, 2));
  return filepath;
}

/**
 * Candy's direct access to task queue
 */
function submitCandyTask(taskType, payload) {
  const TASKS_FILE = path.join(os.homedir(), ".nemoclaw", "tasks.jsonl");
  const queueDir = path.dirname(TASKS_FILE);
  if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });

  const taskId = `candy-trends-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const task = {
    taskId,
    type: taskType,
    payload: {
      ...payload,
      submittedBy: "Candy",
      source: "social-media-tools",
    },
    status: "submitted",
    submittedAt: new Date().toISOString(),
  };

  const line = JSON.stringify(task) + "\n";
  fs.appendFileSync(TASKS_FILE, line);
  return taskId;
}

/**
 * Monitoring setup - watch for keywords
 */
async function setupKeywordMonitor(keywords, checkIntervalMs = 3600000) {
  console.log(`[social-media-tools] Starting keyword monitor for:`, keywords);

  const monitor = async () => {
    const trendData = await aggregateTrends({
      platforms: ["youtube", "reddit", "web"],
      keywords,
      timeframe: "day",
    });

    // Save report
    const reportPath = saveTrendReport(trendData, `monitor-${Date.now()}.json`);

    // Submit to architect for analysis
    submitCandyTask("trendAnalysis", {
      keywords,
      trendData,
      reportPath,
      checkedAt: new Date().toISOString(),
    });

    console.log(`[social-media-tools] Trend check complete. Report: ${reportPath}`);
  };

  // Run immediately
  await monitor();

  // Schedule recurring
  setInterval(monitor, checkIntervalMs);
}

/**
 * Viral alert - monitor for sudden spikes
 */
async function setupViralAlert(trendThreshold = 1000, checkIntervalMs = 300000) {
  console.log(`[social-media-tools] Starting viral alert monitor (threshold: ${trendThreshold})`);

  const monitor = async () => {
    const trends = await aggregateTrends({
      platforms: ["reddit", "youtube"],
    });

    const viralPosts = [];

    // Check Reddit
    if (trends.platforms.reddit?.posts) {
      viralPosts.push(
        ...trends.platforms.reddit.posts.filter((p) => p.upvotes > trendThreshold)
      );
    }

    if (viralPosts.length > 0) {
      // Alert: submit to Candy
      submitCandyTask("viralAlert", {
        viralPosts,
        timestamp: new Date().toISOString(),
        alertReason: "High engagement detected",
      });

      console.log(
        `[social-media-tools] VIRAL ALERT: ${viralPosts.length} posts above threshold`
      );
    }
  };

  // Check immediately
  await monitor();

  // Schedule recurring
  setInterval(monitor, checkIntervalMs);
}

/**
 * Generate image using NVIDIA API with key rotation
 */
async function generateImageNvidia(prompt, aspectRatio = "1:1") {
  return new Promise((resolve) => {
    const { execSync } = require("child_process");
    const tmpDir = `/tmp/candy-gen-${Date.now()}`;

    try {
      // Create temp directory
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }

      const scriptPath = "/home/nemoclaw/nemoclaw-persist/skills/nvidia-image-router/scripts/generate_image.py";
      const defaultOutputPath = "/tmp/generated_image.png"; // Script always outputs here

      // Clean up any previous output
      try { fs.unlinkSync(defaultOutputPath); } catch {}

      // Check if script exists
      if (!fs.existsSync(scriptPath)) {
        return resolve({ error: `NVIDIA image router script not found at ${scriptPath}`, source: "nvidia" });
      }

      console.log(`[social-media-tools] Calling NVIDIA image router: "${prompt}"`);

      // Build environment with NVIDIA keys
      const env = { ...process.env };
      if (!env.NVIDIA_FLUX_KEY) env.NVIDIA_FLUX_KEY = "";
      if (!env.NVIDIA_SD35_KEY) env.NVIDIA_SD35_KEY = "";
      if (!env.NVIDIA_SD3_KEY) env.NVIDIA_SD3_KEY = "";

      // Execute the image generation script (outputs to /tmp/generated_image.png)
      const cmd = `python3 "${scriptPath}" "${prompt.replace(/"/g, '\\"')}" "${aspectRatio}"`;
      console.log(`[social-media-tools] Executing: ${cmd.slice(0, 100)}...`);

      const runStart = Date.now();
      let stderr = "";
      let stdout = "";
      try {
        const result = execSync(cmd, {
          timeout: 120000,
          env: env,
          cwd: "/tmp",
          stdio: ["pipe", "pipe", "pipe"],
          encoding: "utf8"
        });
        stdout = result || "";
      } catch (e) {
        stderr = e.stderr || e.message || "";
        stdout = e.stdout || "";
        console.error(`[social-media-tools] Script stderr: ${stderr.slice(0, 200)}`);
      }

      // Check if image was generated — must exist AND be freshly written during this run
      if (!fs.existsSync(defaultOutputPath)) {
        return resolve({ error: `Image generation failed: ${stderr.slice(0, 100) || "no output file"}`, source: "nvidia" });
      }
      const mtime = fs.statSync(defaultOutputPath).mtimeMs;
      if (mtime < runStart - 5000) {
        // Stale file from a previous run — script failed without writing a new image
        return resolve({ error: `Image generation failed: ${stderr.slice(0, 200) || "all providers failed"}`, source: "nvidia" });
      }

      // Extract model name from script output: "[ModelName] Image saved to ..."
      let modelName = "NVIDIA";
      const modelMatch = stderr.match(/\[([^\]]+)\] Image saved/) || stdout.match(/\[([^\]]+)\] Image saved/);
      if (modelMatch && modelMatch[1]) {
        modelName = modelMatch[1]; // e.g., "NVIDIA Flux", "NVIDIA SD3.5", etc.
      }

      // Read the image as buffer for Discord
      const imageBuffer = fs.readFileSync(defaultOutputPath);
      console.log(`[social-media-tools] ${modelName} generated successfully (${imageBuffer.length} bytes)`);

      // Save to a temp file with unique name so Discord can attach it
      const tempImagePath = `/tmp/candy-gen-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
      fs.copyFileSync(defaultOutputPath, tempImagePath);

      resolve({
        success: true,
        buffer: imageBuffer,
        filePath: tempImagePath,
        source: modelName,
        prompt,
        timestamp: new Date().toISOString(),
      });

      // Clean up temp directory
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    } catch (err) {
      console.error(`[social-media-tools] NVIDIA script error: ${err.message}`);
      resolve({ error: `NVIDIA image generation failed: ${err.message.slice(0, 100)}`, source: "nvidia" });
    }
  });
}

/**
 * Router: Use NVIDIA image generation via Python script (handles all fallbacks)
 */
async function generateImage(prompt) {
  console.log(`[social-media-tools] generateImage called with: "${prompt.slice(0, 50)}..."`);
  console.log(`[social-media-tools] Calling NVIDIA image router...`);
  const result = await generateImageNvidia(prompt);
  return result;
}

/**
 * Find ffmpeg executable
 */
function findFfmpeg() {
  try { execSync("which ffmpeg", { encoding: "utf-8", timeout: 3000 }); return "ffmpeg"; } catch {}
  // Return UNQUOTED paths — execFileSync handles spaces natively, shell quotes cause ENOENT
  const paths = [
    "/mnt/c/Program Files/Shotcut/ffmpeg.exe",
    "/mnt/c/Program Files/SVP 4/utils/ffmpeg.exe",
    "/mnt/c/Program Files/Krita (x64)/bin/ffmpeg.exe",
  ];
  for (const p of paths) {
    try { execSync(`"${p}" -version`, { encoding: "utf-8", timeout: 5000 }); return p; } catch {}
  }
  return null;
}

/**
 * Normalize image/video for Instagram (resize to 1080x1080 or 1080x1920)
 */
async function normalizeForInstagram(fileBuffer, mimeType) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.warn("[ig-norm] ffmpeg not found, skipping normalization");
    return fileBuffer;
  }
  const isVideo = mimeType?.startsWith("video/");
  const tmpIn   = `/tmp/ig-norm-in-${Date.now()}.${isVideo ? "mp4" : "jpg"}`;
  const tmpOut  = `/tmp/ig-norm-out-${Date.now()}.${isVideo ? "mp4" : "jpg"}`;
  try {
    fs.writeFileSync(tmpIn, fileBuffer);
    if (isVideo) {
      // Pad to 9:16 (1080x1920) with black bars — required for Reels
      execFileSync(ffmpeg, [
        "-y", "-i", tmpIn,
        "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
        "-c:v", "libx264", "-crf", "23", "-preset", "fast",
        "-c:a", "aac", "-b:a", "128k",
        tmpOut
      ], { timeout: 120000 });
    } else {
      // Pad to 1:1 square (1080x1080) with black bars — safe for all IG posts
      execFileSync(ffmpeg, [
        "-y", "-i", tmpIn,
        "-vf", "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black",
        tmpOut
      ], { timeout: 30000 });
    }
    const result = fs.readFileSync(tmpOut);
    console.log(`[ig-norm] normalized ${isVideo ? "video" : "image"}: ${fileBuffer.length} → ${result.length} bytes`);
    return result;
  } catch (e) {
    console.warn(`[ig-norm] normalization failed: ${e.message} — using original`);
    return fileBuffer;
  } finally {
    try { fs.unlinkSync(tmpIn);  } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

/**
 * Upload media to public host and return direct URL
 * Images → Imgur. Videos → Catbox.
 */
async function getPublicMediaUrl(fileBuffer, mimeType) {
  const isVideo = mimeType?.startsWith("video/");

  if (isVideo) {
    // Catbox Litterbox — free anonymous video hosting, 72h TTL
    const boundary = `CatboxBoundary${Date.now()}`;
    const ext      = mimeType === "video/mp4" ? "mp4" : "mp4";
    const head     = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="upload.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const mid      = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n72h\r\n--${boundary}--\r\n`);
    const body     = Buffer.concat([head, fileBuffer, mid]);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "litterbox.catbox.moe", path: "/resources/internals/api.php", method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
      }, res => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => {
          const url = d.trim();
          if (!url.startsWith("https://")) return reject(new Error(`Catbox error: ${url.slice(0, 100)}`));
          console.log(`[ig] video hosted at: ${url}`);
          resolve(url);
        });
      });
      req.on("error", reject); req.write(body); req.end();
    });
  }

  // Images → Imgur anonymous upload
  const base64 = fileBuffer.toString("base64");
  const body   = `image=${encodeURIComponent(base64)}&type=base64`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.imgur.com", path: "/3/image", method: "POST",
      headers: { "Authorization": "Client-ID 546c25a59c58ad7", "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          console.log(`[imgur] response status: ${res.statusCode}, body length: ${d.length}`);
          const j = JSON.parse(d);
          console.log(`[imgur] parsed response: success=${j.success}, data.link=${j.data?.link}`);
          if (!j.success) throw new Error(j.data?.error || "Imgur upload failed");
          if (!j.data?.link) throw new Error(`Imgur returned success but no link: ${JSON.stringify(j.data).slice(0, 100)}`);
          console.log(`[ig] image hosted at: ${j.data.link}`);
          resolve(j.data.link);
        } catch (e) {
          console.error(`[imgur] error: ${e.message}`);
          reject(e);
        }
      });
    });
    req.on("error", (err) => {
      console.error(`[imgur] request error: ${err.message}`);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Instagram posting via Facebook Graph API
 * Buffer input: upload to Google Drive → get direct URL → post via Graph API
 * URL input: post directly via Graph API
 */
async function postToInstagram(caption, mediaUrl = null, mediaType = "IMAGE") {
  const IG_USER_ID = process.env.IG_USER_ID || "";
  const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN || "";

  if (!IG_USER_ID || !FB_PAGE_TOKEN) {
    return { error: "Instagram API not configured (missing IG_USER_ID or FB_PAGE_TOKEN)" };
  }

  if (!mediaUrl) {
    return { error: "Media URL required for Instagram posting" };
  }

  // Handle Buffer input: upload to Google Drive → get public URL
  if (Buffer.isBuffer(mediaUrl)) {
    console.log(`[instagram] received buffer (${mediaUrl.length} bytes), uploading to Google Drive...`);
    try {
      const gdrive = require("./google-drive");
      const fileName = `ig-candy-${Date.now()}.png`;
      const tmpPath = `/tmp/${fileName}`;
      fs.writeFileSync(tmpPath, mediaUrl);

      const folderId = process.env.GDRIVE_MEDIA_FOLDER_ID || process.env.GDRIVE_FOLDER_ID || "";
      const result = await gdrive.uploadToDrive(tmpPath, "image/png", fileName, folderId);
      try { fs.unlinkSync(tmpPath); } catch {}

      const fileId = result.id;
      console.log(`[instagram] uploaded to Drive: ${fileId}`);

      // Make file publicly readable so Instagram can fetch it
      const token = await gdrive._getDriveToken();
      await new Promise((resolve, reject) => {
        const permBody = JSON.stringify({ role: "reader", type: "anyone" });
        const req = https.request({
          hostname: "www.googleapis.com",
          path: `/drive/v3/files/${fileId}/permissions`,
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(permBody) },
        }, res => {
          let d = ""; res.on("data", c => d += c);
          res.on("end", () => resolve(d));
        });
        req.on("error", reject);
        req.write(permBody);
        req.end();
      });

      // Direct image URL from Google Drive
      mediaUrl = `https://lh3.googleusercontent.com/d/${fileId}`;
      console.log(`[instagram] public URL: ${mediaUrl}`);
    } catch (err) {
      console.error(`[instagram] Drive upload failed: ${err.message}`);
      return { error: `Drive upload failed: ${err.message}`, platform: "instagram" };
    }
  }

  // URL-based posting via Graph API
  try {
    const isVideo = (typeof mediaUrl === "string" && mediaUrl.includes(".mp4")) || mediaType === "VIDEO" || mediaType === "REELS";
    const containerParams = {
      caption: caption || "",
      ...(isVideo ? { media_type: "REELS", video_url: mediaUrl, share_to_feed: "true" } : { image_url: mediaUrl }),
      access_token: FB_PAGE_TOKEN,
    };

    // Step 1: Create container
    const qs = new URLSearchParams(containerParams).toString();
    console.log(`[instagram] creating container...`);
    const container = await igGraphRequest(`/v21.0/${IG_USER_ID}/media?${qs}`);
    if (container.error) return { error: container.error.message, platform: "instagram" };
    const creationId = container.id;
    console.log(`[instagram] container: ${creationId}`);

    // Step 2: Poll until ready (Drive URLs need processing time)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, isVideo ? 5000 : 3000));
      const statusQs = new URLSearchParams({ fields: "status_code", access_token: FB_PAGE_TOKEN }).toString();
      const status = await igGraphGet(`/v21.0/${creationId}?${statusQs}`);
      console.log(`[instagram] status: ${status.status_code}`);
      if (status.status_code === "FINISHED") break;
      if (status.status_code === "ERROR") return { error: "Instagram container processing failed", platform: "instagram" };
    }

    // Step 3: Publish
    console.log(`[instagram] publishing...`);
    const pubQs = new URLSearchParams({ creation_id: creationId, access_token: FB_PAGE_TOKEN }).toString();
    const pub = await igGraphRequest(`/v21.0/${IG_USER_ID}/media_publish?${pubQs}`);
    if (pub.error) return { error: pub.error.message, platform: "instagram" };
    console.log(`[instagram] published: ${pub.id}`);
    return { platform: "instagram", success: true, postId: pub.id, caption, timestamp: new Date().toISOString() };
  } catch (e) {
    console.error(`[instagram] error: ${e.message}`);
    return { error: e.message, platform: "instagram" };
  }
}

/** Helper: POST to Graph API */
function igGraphRequest(pathWithQs) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "graph.facebook.com", path: pathWithQs, method: "POST" }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Helper: GET from Graph API */
function igGraphGet(pathWithQs) {
  return new Promise((resolve, reject) => {
    https.get(`https://graph.facebook.com${pathWithQs}`, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

/**
 * Facebook posting via Facebook Graph API
 */
async function postToFacebook(message, mediaUrl = null, mediaType = "IMAGE") {
  const FB_PAGE_ID = process.env.FB_PAGE_ID || "";
  const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN || "";

  if (!FB_PAGE_ID || !FB_PAGE_TOKEN) {
    return { error: "Facebook API not configured (missing FB_PAGE_ID or FB_PAGE_TOKEN)" };
  }

  return new Promise((resolve) => {
    const postData = {
      message,
      ...(mediaUrl && { source: mediaUrl }),
      access_token: FB_PAGE_TOKEN,
    };

    const postBody = Object.entries(postData)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const options = {
      hostname: "graph.facebook.com",
      path: `/v21.0/${FB_PAGE_ID}/feed`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postBody),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            resolve({ error: json.error.message || "Facebook API error", platform: "facebook" });
          } else {
            resolve({
              platform: "facebook",
              success: true,
              postId: json.id,
              message,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (e) {
          resolve({ error: e.message, platform: "facebook" });
        }
      });
    });

    req.on("error", (err) => {
      resolve({ error: err.message, platform: "facebook" });
    });

    req.write(postBody);
    req.end();
  });
}

/**
 * xpoz integration — cross-platform social intelligence
 */
let xpozModule = null;
function getXpozModule() {
  if (!xpozModule) {
    try {
      xpozModule = require("./xpoz");
    } catch (e) {
      console.warn("[social-media-tools] xpoz not available:", e.message);
      return null;
    }
  }
  return xpozModule;
}

/**
 * Search posts across Twitter, Instagram, Reddit, TikTok using xpoz
 */
async function xpozSearchPosts(platform, query, limit = 20) {
  const xpoz = getXpozModule();
  if (!xpoz) {
    return { error: "xpoz API not configured", platform };
  }

  try {
    const results = await xpoz.searchPosts(platform, query, limit);
    console.log(`[xpoz] ${platform}: found ${results.length} posts for "${query}"`);
    return {
      platform,
      query,
      results,
      count: results.length,
    };
  } catch (err) {
    console.error(`[xpoz] Error searching ${platform}:`, err.message);
    return { error: err.message, platform };
  }
}

/**
 * Get trends across all platforms for a theme
 */
async function xpozGetTrends(theme = "trending viral", limit = 25) {
  const xpoz = getXpozModule();
  if (!xpoz) {
    return { error: "xpoz API not configured" };
  }

  try {
    const trends = await xpoz.getTrends(theme, limit);
    console.log(`[xpoz] Trends for "${theme}": ${Object.keys(trends.byPlatform).length} platforms`);
    return trends;
  } catch (err) {
    console.error(`[xpoz] Error fetching trends:`, err.message);
    return { error: err.message };
  }
}

/**
 * Search for a user across platforms
 */
async function xpozSearchUser(platform, username) {
  const xpoz = getXpozModule();
  if (!xpoz) {
    return { error: "xpoz API not configured", platform };
  }

  try {
    const result = await xpoz.searchUser(platform, username);
    console.log(`[xpoz] Found user ${username} on ${platform}`);
    return {
      platform,
      username,
      result,
    };
  } catch (err) {
    console.error(`[xpoz] Error searching user:`, err.message);
    return { error: err.message, platform };
  }
}

// Export for Candy bot integration
module.exports = {
  getYouTubeTrending,
  getRedditTrending,
  searchTrends,
  aggregateTrends,
  saveTrendReport,
  submitCandyTask,
  setupKeywordMonitor,
  setupViralAlert,
  xpozSearchPosts,
  xpozGetTrends,
  xpozSearchUser,
  postToInstagram,
  postToFacebook,
  generateImage,
  generateImageNvidia,
};
