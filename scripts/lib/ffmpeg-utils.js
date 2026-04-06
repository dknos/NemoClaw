// Shared ffmpeg/ffprobe discovery and media probing utilities.
// Used by discord-bridge.js, beat-detect.js, capcut-compose.js, etc.
// Works in both WSL host and Docker container contexts.

const fs = require("fs");
const { execSync } = require("child_process");

// ── Binary discovery (cached) ───────────────────────────────────────────────

let _ffmpegCache = undefined;
let _ffprobeCache = undefined;

/**
 * Find the ffmpeg binary. Checks PATH first (catches conda, nix, linuxbrew,
 * Docker /app/bin, etc.), then known system locations, then WSL Windows fallbacks.
 * Returns absolute path or "ffmpeg" (PATH) or null if not found.
 */
function findFfmpeg() {
  if (_ffmpegCache !== undefined) return _ffmpegCache;
  // PATH first — works in Docker, conda, nix, and any properly configured env
  try { execSync("which ffmpeg", { encoding: "utf-8", timeout: 3000 }); _ffmpegCache = "ffmpeg"; return _ffmpegCache; } catch { /* not found, try next */ }
  // Known Linux locations
  const linuxPaths = [
    "/home/nemoclaw/.local/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
    "/snap/bin/ffmpeg",
    "/app/bin/ffmpeg", // Docker containers
  ];
  for (const p of linuxPaths) { try { if (fs.existsSync(p)) { _ffmpegCache = p; return _ffmpegCache; } } catch { /* not found, try next */ } }
  // WSL Windows fallbacks
  const winPaths = [
    "/mnt/c/Program Files/Shotcut/ffmpeg.exe",
    "/mnt/c/Program Files/SVP 4/utils/ffmpeg.exe",
    "/mnt/c/Program Files/Krita (x64)/bin/ffmpeg.exe",
  ];
  for (const p of winPaths) { try { execSync(`"${p}" -version`, { encoding: "utf-8", timeout: 5000 }); _ffmpegCache = p; return _ffmpegCache; } catch { /* not found, try next */ } }
  _ffmpegCache = null;
  return null;
}

/**
 * Find the ffprobe binary. Derives path from ffmpeg location,
 * verifies it exists. Returns path or null.
 */
function findFfprobe() {
  if (_ffprobeCache !== undefined) return _ffprobeCache;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) { _ffprobeCache = null; return null; }
  const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
  if (probe === ffmpeg) { _ffprobeCache = null; return null; }
  // If ffmpeg was found via PATH ("ffmpeg"), check if ffprobe is also in PATH
  if (probe === "ffprobe") {
    try { execSync("which ffprobe", { encoding: "utf-8", timeout: 3000 }); _ffprobeCache = "ffprobe"; return _ffprobeCache; } catch { _ffprobeCache = null; return null; }
  }
  // Otherwise check the derived absolute path
  try { if (fs.existsSync(probe)) { _ffprobeCache = probe; return _ffprobeCache; } } catch { /* not found, try next */ }
  _ffprobeCache = null;
  return null;
}

/**
 * Get media duration in seconds. Prefers ffprobe (faster, more reliable),
 * falls back to parsing Duration: from ffmpeg -i stderr.
 * Returns null on failure — callers must handle this.
 */
function getMediaDuration(filePath) {
  // Try ffprobe first
  const ffprobe = findFfprobe();
  if (ffprobe) {
    try {
      const out = execSync(
        `"${ffprobe}" -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
        { encoding: "utf-8", timeout: 15000 }
      );
      const dur = parseFloat(out.trim());
      if (!isNaN(dur) && dur > 0) return dur;
    } catch (e) { console.warn(`[ffmpeg-utils] ffprobe failed, falling back to ffmpeg -i: ${e.message}`); }
  }
  // Fallback: parse Duration from ffmpeg -i stderr
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) { console.warn("[ffmpeg-utils] neither ffprobe nor ffmpeg found — cannot detect duration"); return null; }
  try {
    const out = execSync(`"${ffmpeg}" -i "${filePath}" 2>&1 || true`, { encoding: "utf-8", timeout: 15000 });
    const match = out.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (match) return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 100;
  } catch (e) { console.warn(`[ffmpeg-utils] ffmpeg -i fallback failed: ${e.message}`); }
  console.warn(`[ffmpeg-utils] could not detect duration for ${filePath}`);
  return null;
}

/**
 * Get media dimensions (width x height) via ffprobe.
 * Returns { width, height } or null on failure.
 */
function getMediaDimensions(filePath) {
  const ffprobe = findFfprobe();
  if (!ffprobe) return null;
  try {
    const out = execSync(
      `"${ffprobe}" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`,
      { encoding: "utf-8", timeout: 15000 }
    );
    const [w, h] = out.trim().split(",").map(Number);
    if (w > 0 && h > 0) return { width: w, height: h };
  } catch (e) { console.warn(`[ffmpeg-utils] getMediaDimensions failed for ${filePath}: ${e.message}`); }
  return null;
}

module.exports = { findFfmpeg, findFfprobe, getMediaDuration, getMediaDimensions };
