// Beat detection via FFmpeg — extracts BPM, beat timestamps, and energy peaks.
// No external deps beyond ffmpeg/ffprobe.
//
// Usage:
//   const { detectBeats } = require("./beat-detect");
//   const beats = await detectBeats("/tmp/audio.mp3");
//   // => { bpm: 128, beatTimestamps: [0.47, 0.94, 1.41, ...], peaks: [...], durationSec: 60.2 }

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const FFMPEG_BIN = (() => {
  const candidates = ["/home/nemoclaw/.local/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return "ffmpeg";
})();
const FFPROBE_BIN = FFMPEG_BIN.replace(/ffmpeg$/, "ffprobe");

/**
 * Get audio duration in seconds.
 */
function getAudioDuration(audioPath) {
  const out = execSync(
    `${FFPROBE_BIN} -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
    { encoding: "utf8", timeout: 30000 }
  ).trim();
  return parseFloat(out) || 0;
}

/**
 * Extract per-frame RMS energy using astats filter.
 * Returns array of { time, rms } sorted by time.
 */
function extractEnergy(audioPath, hopSec = 0.02) {
  // Convert to mono, measure RMS in small windows
  const tmpWav = `/tmp/beat-detect-${Date.now()}.raw`;
  try {
    // Get raw PCM samples at 22050Hz mono
    execSync(
      `${FFMPEG_BIN} -y -i "${audioPath}" -ac 1 -ar 22050 -f f32le -acodec pcm_f32le "${tmpWav}"`,
      { timeout: 60000, stdio: "pipe" }
    );
    const raw = fs.readFileSync(tmpWav);
    const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    const sr = 22050;
    const hopSamples = Math.round(hopSec * sr);
    const frames = [];

    for (let i = 0; i < samples.length - hopSamples; i += hopSamples) {
      let sum = 0;
      for (let j = 0; j < hopSamples; j++) {
        sum += samples[i + j] * samples[i + j];
      }
      const rms = Math.sqrt(sum / hopSamples);
      frames.push({ time: i / sr, rms });
    }
    return frames;
  } finally {
    try { fs.unlinkSync(tmpWav); } catch {}
  }
}

/**
 * Detect onsets (sudden energy increases) from RMS energy curve.
 * Returns timestamps where beats likely occur.
 */
function detectOnsets(energyFrames, sensitivity = 1.5) {
  if (energyFrames.length < 10) return [];

  // Compute spectral flux (energy difference)
  const flux = [];
  for (let i = 1; i < energyFrames.length; i++) {
    const diff = energyFrames[i].rms - energyFrames[i - 1].rms;
    flux.push({ time: energyFrames[i].time, value: Math.max(0, diff) });
  }

  // Adaptive threshold: local mean + sensitivity * local stddev
  const windowSize = 50; // ~1 second at 20ms hop
  const onsets = [];
  const minGap = 0.15; // minimum 150ms between beats
  let lastOnset = -1;

  for (let i = windowSize; i < flux.length - windowSize; i++) {
    // Local statistics
    let sum = 0, sumSq = 0;
    for (let j = i - windowSize; j < i + windowSize; j++) {
      sum += flux[j].value;
      sumSq += flux[j].value * flux[j].value;
    }
    const n = windowSize * 2;
    const mean = sum / n;
    const stddev = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    const threshold = mean + sensitivity * stddev;

    if (flux[i].value > threshold && flux[i].time - lastOnset > minGap) {
      onsets.push(flux[i].time);
      lastOnset = flux[i].time;
    }
  }

  return onsets;
}

/**
 * Estimate BPM from beat timestamps using inter-onset intervals.
 */
function estimateBPM(onsets) {
  if (onsets.length < 4) return 120; // fallback

  // Collect inter-onset intervals
  const intervals = [];
  for (let i = 1; i < onsets.length; i++) {
    intervals.push(onsets[i] - onsets[i - 1]);
  }

  // Cluster intervals into likely beat periods (histogram approach)
  // BPM range: 60-200 → beat period: 0.3s - 1.0s
  const bins = {};
  const resolution = 0.02; // 20ms bins
  for (const iv of intervals) {
    if (iv < 0.25 || iv > 1.2) continue;
    const bin = Math.round(iv / resolution) * resolution;
    bins[bin] = (bins[bin] || 0) + 1;
  }

  // Find dominant period
  let bestBin = 0.5, bestCount = 0;
  for (const [bin, count] of Object.entries(bins)) {
    if (count > bestCount) { bestCount = count; bestBin = parseFloat(bin); }
  }

  const bpm = Math.round(60 / bestBin);
  // Clamp to reasonable range
  return Math.max(60, Math.min(200, bpm));
}

/**
 * Find energy peaks — the loudest moments (drops, hits).
 * Returns top N timestamps sorted by energy descending.
 */
function findPeaks(energyFrames, topN = 20) {
  // Smooth energy first
  const smoothed = [];
  const win = 10;
  for (let i = win; i < energyFrames.length - win; i++) {
    let sum = 0;
    for (let j = i - win; j <= i + win; j++) sum += energyFrames[j].rms;
    smoothed.push({ time: energyFrames[i].time, rms: sum / (win * 2 + 1) });
  }

  // Find local maxima
  const peaks = [];
  for (let i = 1; i < smoothed.length - 1; i++) {
    if (smoothed[i].rms > smoothed[i - 1].rms && smoothed[i].rms > smoothed[i + 1].rms) {
      peaks.push(smoothed[i]);
    }
  }

  // Sort by energy, return top N
  peaks.sort((a, b) => b.rms - a.rms);
  return peaks.slice(0, topN).sort((a, b) => a.time - b.time);
}

/**
 * Main entry: detect beats, BPM, and peaks from an audio file.
 * @param {string} audioPath - Path to mp3/wav/m4a
 * @param {object} opts - { sensitivity: 1.5, maxBeats: 500 }
 * @returns {{ bpm, beatTimestamps, peaks, durationSec, beatCount, avgBeatInterval }}
 */
async function detectBeats(audioPath, opts = {}) {
  const { sensitivity = 1.5, maxBeats = 500 } = opts;

  console.log(`[beat-detect] analyzing: ${path.basename(audioPath)}`);
  const durationSec = getAudioDuration(audioPath);
  console.log(`[beat-detect] duration: ${durationSec.toFixed(1)}s`);

  const energy = extractEnergy(audioPath);
  console.log(`[beat-detect] energy frames: ${energy.length}`);

  const onsets = detectOnsets(energy, sensitivity);
  const beatTimestamps = onsets.slice(0, maxBeats);
  const bpm = estimateBPM(beatTimestamps);
  const peaks = findPeaks(energy);

  const avgBeatInterval = beatTimestamps.length > 1
    ? (beatTimestamps[beatTimestamps.length - 1] - beatTimestamps[0]) / (beatTimestamps.length - 1)
    : 60 / bpm;

  console.log(`[beat-detect] BPM: ${bpm}, beats: ${beatTimestamps.length}, peaks: ${peaks.length}, avg interval: ${avgBeatInterval.toFixed(3)}s`);

  return { bpm, beatTimestamps, peaks, durationSec, beatCount: beatTimestamps.length, avgBeatInterval };
}

/**
 * Generate beat-synced timelines for CapCut or FFmpeg.
 * Groups beats into segments of minBeats-maxBeats, returns [{startSec, endSec}].
 */
function beatTimelines({ beatTimestamps, targetSec, minBeats = 1, maxBeats = 4, numSegments = null }) {
  if (beatTimestamps.length < 2) {
    // Fallback: even splits
    const segDur = targetSec / (numSegments || 10);
    const timelines = [];
    for (let t = 0; t < targetSec; t += segDur) {
      timelines.push({ startSec: t, endSec: Math.min(t + segDur, targetSec) });
    }
    return timelines;
  }

  const timelines = [];
  let i = 0;
  while (i < beatTimestamps.length) {
    const start = beatTimestamps[i];
    if (start >= targetSec) break;

    // Pick random number of beats for this segment
    const beats = minBeats + Math.floor(Math.random() * (maxBeats - minBeats + 1));
    const endIdx = Math.min(i + beats, beatTimestamps.length - 1);
    const end = Math.min(beatTimestamps[endIdx], targetSec);

    if (end - start > 0.1) {
      timelines.push({ startSec: start, endSec: end });
    }
    i = endIdx;
    if (i === beatTimestamps.length - 1) break;
  }

  return timelines;
}

/**
 * Convert beat timelines to CapCut microsecond format.
 */
function beatTimelinesUs(beatResult, opts) {
  const timelines = beatTimelines({ beatTimestamps: beatResult.beatTimestamps, ...opts });
  return timelines.map(t => ({
    start: Math.round(t.startSec * 1_000_000),
    end: Math.round(t.endSec * 1_000_000),
  }));
}

module.exports = { detectBeats, beatTimelines, beatTimelinesUs, estimateBPM, getAudioDuration };
