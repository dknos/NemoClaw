#!/usr/bin/env node
// google-drive.js — Google Drive & YouTube integration for MrBigPipes AI
// Drive: service account auth (no OAuth flow, no user consent)
// YouTube: public API key (read-only)

"use strict";

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const GOOGLE_API_KEY   = process.env.GOOGLE_API_KEY  || "";
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || "";
const SA_KEY_PATH      = process.env.GDRIVE_SA_KEY
  || path.resolve(__dirname, "../../secrets/gdrive-service-account.json");

// ── Service Account JWT auth ──────────────────────────────────────

let _saKey = null;
function loadSAKey() {
  if (_saKey) return _saKey;
  if (!fs.existsSync(SA_KEY_PATH)) {
    throw new Error(`Service account key not found at: ${SA_KEY_PATH}`);
  }
  _saKey = JSON.parse(fs.readFileSync(SA_KEY_PATH, "utf8"));
  return _saKey;
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getServiceAccountToken(scopes) {
  const key  = loadSAKey();
  const now  = Math.floor(Date.now() / 1000);
  const header  = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  })));

  const crypto = require("crypto");
  const sign   = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = base64url(sign.sign(key.private_key));
  const jwt = `${header}.${payload}.${sig}`;

  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req  = https.request({
      hostname: "oauth2.googleapis.com",
      path:     "/token",
      method:   "POST",
      headers:  { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": body.length },
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        const d = JSON.parse(raw);
        if (!d.access_token) reject(new Error(`Token error: ${raw}`));
        else resolve(d.access_token);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Cache token for up to 55 minutes
let _tokenCache = { token: null, exp: 0 };

async function getOAuthToken() {
  const clientId     = process.env.GDRIVE_CLIENT_ID;
  const clientSecret = process.env.GDRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GDRIVE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type:    "refresh_token",
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path:     "/token",
      method:   "POST",
      headers:  { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": body.length },
    }, res => {
      let raw = ""; res.on("data", c => raw += c);
      res.on("end", () => {
        const d = JSON.parse(raw);
        if (!d.access_token) reject(new Error(`OAuth token refresh failed: ${raw}`));
        else resolve(d.access_token);
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

async function getDriveToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.exp) return _tokenCache.token;
  // Prefer OAuth2 refresh token (personal account) over service account
  const token = await getOAuthToken() || await getServiceAccountToken(["https://www.googleapis.com/auth/drive"]);
  _tokenCache = { token, exp: Date.now() + 55 * 60 * 1000 };
  return token;
}

// ── HTTP helper ───────────────────────────────────────────────────

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Google Drive ──────────────────────────────────────────────────

/**
 * Upload a file to Google Drive using the service account.
 * The target folder must be shared with: nemodisc@drivenemo.iam.gserviceaccount.com
 */
async function uploadToDrive(filePath, mimeType, fileName, folderId) {
  folderId     = folderId || GDRIVE_FOLDER_ID;
  const token  = await getDriveToken();
  const data   = fs.readFileSync(filePath);
  const meta   = JSON.stringify({ name: fileName, parents: folderId ? [folderId] : [] });
  const bound  = "NemoUploadBoundary";

  const body = Buffer.concat([
    Buffer.from(`--${bound}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${bound}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${bound}--`),
  ]);

  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.googleapis.com",
      path:     "/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true",
      method:   "POST",
      headers: {
        "Authorization":  `Bearer ${token}`,
        "Content-Type":   `multipart/related; boundary="${bound}"`,
        "Content-Length": body.length,
      },
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  if (res.status !== 200) throw new Error(`Drive upload failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body; // { id, name, webViewLink }
}

/**
 * List recent files in the configured Drive folder.
 */
async function listDriveFiles(folderId, maxResults = 20) {
  folderId    = folderId || GDRIVE_FOLDER_ID;
  const token = await getDriveToken();
  const q     = folderId
    ? encodeURIComponent(`'${folderId}' in parents and trashed=false`)
    : "trashed=false";
  const fields = encodeURIComponent("files(id,name,mimeType,webViewLink,createdTime,size)");
  const res   = await httpsRequest({
    hostname: "www.googleapis.com",
    path:     `/drive/v3/files?q=${q}&fields=${fields}&pageSize=${maxResults}&orderBy=${encodeURIComponent("createdTime desc")}&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    method:   "GET",
    headers:  { "Authorization": `Bearer ${token}` },
  });
  if (!res.body.files) throw new Error(`Drive list failed: ${JSON.stringify(res.body)}`);
  return res.body.files;
}

// ── YouTube (API key, read-only) ──────────────────────────────────

async function searchYouTube(query, maxResults = 5) {
  if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY not set");
  const q   = encodeURIComponent(query);
  const res = await httpsRequest({
    hostname: "www.googleapis.com",
    path: `/youtube/v3/search?part=snippet&q=${q}&maxResults=${maxResults}&type=video&key=${GOOGLE_API_KEY}`,
    method: "GET",
  });
  if (!res.body.items) throw new Error(res.body.error?.message || "YouTube API error");
  return res.body.items.map(item => ({
    title:   item.snippet.title,
    videoId: item.id.videoId,
    url:     `https://youtube.com/watch?v=${item.id.videoId}`,
    channel: item.snippet.channelTitle,
  }));
}

async function getVideoDetails(videoId) {
  if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY not set");
  const res = await httpsRequest({
    hostname: "www.googleapis.com",
    path: `/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${GOOGLE_API_KEY}`,
    method: "GET",
  });
  const item = res.body.items?.[0];
  if (!item) throw new Error("Video not found");
  return {
    title:    item.snippet.title,
    channel:  item.snippet.channelTitle,
    views:    parseInt(item.statistics?.viewCount || 0).toLocaleString(),
    likes:    parseInt(item.statistics?.likeCount || 0).toLocaleString(),
    duration: item.contentDetails?.duration?.replace("PT","").replace("H","h ").replace("M","m ").replace("S","s"),
    url:      `https://youtube.com/watch?v=${videoId}`,
  };
}

// ── Setup info ────────────────────────────────────────────────────

function getSetupInstructions() {
  return `**Google Drive is almost ready!**

Share your Drive folder with this email so the bot can upload to it:
\`\`\`
nemodisc@drivenemo.iam.gserviceaccount.com
\`\`\`
Then set the folder ID in \`~/.nemoclaw_env\`:
\`\`\`
GDRIVE_FOLDER_ID=your_folder_id_here
\`\`\`
(Folder ID is the last part of the folder's URL in Drive)`;
}

module.exports = { uploadToDrive, listDriveFiles, searchYouTube, getVideoDetails, getSetupInstructions, _getDriveToken: getDriveToken };
