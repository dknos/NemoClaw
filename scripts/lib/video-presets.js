// Shared video preset definitions — single source of truth for resolution,
// aspect ratio, duration, bitrate across video-editor.js and capcut-compose.js.
// Supports 720p (default) and 1080p tiers, custom aspect ratios, and auto-detection.

// ── Resolution tiers ───────────────────────────────────────────────────────

const RESOLUTIONS = {
  "720p":  720,
  "1080p": 1080,
};

const DEFAULT_RESOLUTION = "720p";

// ── Base presets (aspect + duration + fps, resolution-independent) ──────────

const BASE_PRESETS = {
  short:           { aspect: "9:16", targetSec: 14.7,  fps: 24 },
  "short-long":    { aspect: "9:16", targetSec: 59.7,  fps: 24 },
  full:            { aspect: "16:9", targetSec: 59.7,  fps: 24 },
  "full-long":     { aspect: "16:9", targetSec: 119.7, fps: 24 },
  vertical:        { aspect: "9:16", targetSec: 59.7,  fps: 24 },
  "vertical-long": { aspect: "9:16", targetSec: 119.7, fps: 24 },
};

// Bitrate targets per resolution tier, keyed by targetSec.
// Formula: 22MB * 8000 / duration − 192 (audio), capped for quality.
const BITRATES = {
  "720p":  { 14.7: 5000, 59.7: 1500, 119.7: 800 },
  "1080p": { 14.7: 10000, 59.7: 2700, 119.7: 1300 },
};

// ── Resolve a preset at a given resolution ─────────────────────────────────

/**
 * Resolve a named preset to concrete { w, h, targetSec, fps, videoBitrateK, aspect }.
 *
 * @param {string} name - Preset name (e.g. "short", "full", "vertical-long")
 * @param {string} [resolution] - "720p" or "1080p" (default: DEFAULT_RESOLUTION)
 * @param {string} [customAr] - Custom aspect ratio override, e.g. "4:3", "1:1", "21:9"
 */
function resolvePreset(name, resolution, customAr) {
  const base = BASE_PRESETS[name] || BASE_PRESETS.short;
  const res = RESOLUTIONS[resolution] || RESOLUTIONS[DEFAULT_RESOLUTION];
  const bitrateTable = BITRATES[resolution] || BITRATES[DEFAULT_RESOLUTION];

  // Determine aspect ratio: custom > preset default
  const aspectStr = customAr || base.aspect;
  const [aw, ah] = aspectStr.split(":").map(Number);
  if (!aw || !ah || aw <= 0 || ah <= 0) {
    // Invalid custom AR — fall back to preset default
    return resolvePreset(name, resolution);
  }

  // Compute dimensions: the "short" dimension = res, the "long" dimension scales from it.
  // For vertical (h > w): h is the long side, w = res
  // For landscape (w > h): w is the long side, h = res
  // For square: both = res
  let w, h;
  if (ah > aw) {
    // Vertical: width = res, height = res * ah / aw
    w = res;
    h = Math.round(res * ah / aw);
  } else if (aw > ah) {
    // Landscape: height = res, width = res * aw / ah
    h = res;
    w = Math.round(res * aw / ah);
  } else {
    // Square
    w = res;
    h = res;
  }

  // Ensure even dimensions (FFmpeg requirement)
  w = w % 2 === 0 ? w : w + 1;
  h = h % 2 === 0 ? h : h + 1;

  const videoBitrateK = bitrateTable[base.targetSec] || 1500;

  return { w, h, targetSec: base.targetSec, fps: base.fps, videoBitrateK, aspect: aspectStr };
}

// ── Backward-compatible PRESETS object ─────────────────────────────────────
// Lazily resolved at default resolution so `PRESETS.short.w` still works.

const PRESETS = {};
for (const name of Object.keys(BASE_PRESETS)) {
  PRESETS[name] = resolvePreset(name);
}

// ── Auto aspect ratio detection ────────────────────────────────────────────

/**
 * Detect dominant aspect ratio from source media files.
 * Returns "9:16", "16:9", "1:1", or null if undetermined.
 *
 * @param {string[]} mediaPaths - File paths to probe
 * @param {function} getMediaDimensions - (filePath) => { width, height } | null
 */
function detectAspectRatio(mediaPaths, getMediaDimensions) {
  if (!mediaPaths || mediaPaths.length === 0) return null;

  let verticalCount = 0, landscapeCount = 0, squareCount = 0;
  for (const p of mediaPaths) {
    const dims = getMediaDimensions(p);
    if (!dims) continue;
    const ratio = dims.width / dims.height;
    if (ratio > 1.1) landscapeCount++;
    else if (ratio < 0.9) verticalCount++;
    else squareCount++;
  }

  const total = verticalCount + landscapeCount + squareCount;
  if (total === 0) return null;
  if (verticalCount >= landscapeCount && verticalCount >= squareCount) return "9:16";
  if (landscapeCount >= verticalCount && landscapeCount >= squareCount) return "16:9";
  return "1:1";
}

/**
 * Map a preset name to its orientation counterpart.
 * e.g. if source is landscape but preset is vertical, switch to landscape equivalent.
 */
function adjustPresetForAspect(presetName, detectedAspect) {
  if (!detectedAspect) return presetName;
  const base = BASE_PRESETS[presetName] || BASE_PRESETS.short;

  // Already matches
  const [aw, ah] = base.aspect.split(":").map(Number);
  const isVertical = ah > aw;
  const wantsVertical = detectedAspect === "9:16";
  const wantsLandscape = detectedAspect === "16:9";

  if (isVertical && wantsLandscape) {
    // Switch vertical preset to landscape equivalent
    const map = { short: "short", "short-long": "short-long", vertical: "full", "vertical-long": "full-long" };
    return map[presetName] || "full";
  }
  if (!isVertical && wantsVertical) {
    // Switch landscape preset to vertical equivalent
    const map = { full: "vertical", "full-long": "vertical-long" };
    return map[presetName] || "vertical";
  }
  return presetName;
}

module.exports = {
  resolvePreset, detectAspectRatio, adjustPresetForAspect,
  PRESETS, BASE_PRESETS, RESOLUTIONS, BITRATES, DEFAULT_RESOLUTION,
};
