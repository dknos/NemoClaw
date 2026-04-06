// CapCut Compose — builds CapCut Mate drafts with effects, filters, keyframes,
// transitions, beat sync, and lyrics. Separate pipeline from video-editor.js (FFmpeg).
//
// Phase 1: Creates CapCut draft via API. Rendering handled by desktop export or FFmpeg fallback.

const fs = require("fs");
const path = require("path");
const os = require("os");

const cc = require("./capcut-client");
const { startFileServer, writeMediaFiles } = require("./capcut-file-server");

// ── Presets (same dimensions/durations as video-editor.js) ──────────────────

const PRESETS = {
  short:           { w: 1080, h: 1920, targetSec: 14.7 },
  "short-long":    { w: 1080, h: 1920, targetSec: 59.7 },
  full:            { w: 1920, h: 1080, targetSec: 59.7 },
  "full-long":     { w: 1920, h: 1080, targetSec: 119.7 },
  vertical:        { w: 1080, h: 1920, targetSec: 59.7 },
  "vertical-long": { w: 1080, h: 1920, targetSec: 119.7 },
};

// ── Style → CapCut effect/filter mapping ────────────────────────────────────

const STYLE_MAP = {
  cinematic:  { filterNames: ["1980"],       effectNames: [],                      transition: "fade_black" },
  vibrant:    { filterNames: ["Ditto"],      effectNames: ["kirakira"],            transition: "fade_black" },
  moody:      { filterNames: ["ABG"],        effectNames: [],                      transition: "fade_black" },
  vintage:    { filterNames: ["VHS III"],    effectNames: ["70s", "betamax"],      transition: "fade_black" },
  dark:       { filterNames: ["KE1"],        effectNames: ["X-Signal"],            transition: "fade_black" },
  dreamy:     { filterNames: ["Lofi II"],    effectNames: [],                      transition: "fade_black" },
  bright:     { filterNames: [],             effectNames: [],                      transition: "fade_black" },
  clean:      { filterNames: [],             effectNames: [],                      transition: "fade_black" },
  brainslop:  { filterNames: [],             effectNames: ["CCD闪光", "RGB描边", "抖动"],          transition: null },
  ludicrous:  { filterNames: [],             effectNames: ["X-Signal", "抖动", "CCD闪光", "定格闪烁"], transition: null },
};

const BEAT_EFFECT_NAMES = ["CCD闪光", "抖动", "RGB描边", "定格闪烁", "X-Signal"];

// ── Effect/Filter catalog cache ─────────────────────────────────────────────

let effectCatalog = null;
let filterCatalog = null;

async function loadEffectCatalog() {
  if (effectCatalog) return effectCatalog;
  try {
    const effects = await cc.getEffects(2);
    effectCatalog = new Map();
    if (Array.isArray(effects)) {
      for (const e of effects) {
        const name = e.name || e.title || "";
        const id = e.id || e.effect_id || e.resource_id;
        if (name && id) effectCatalog.set(name, id);
      }
    }
    console.log(`[capcut-compose] loaded ${effectCatalog.size} effects`);
  } catch (e) {
    console.warn("[capcut-compose] failed to load effects:", e.message);
    effectCatalog = new Map();
  }
  return effectCatalog;
}

async function loadFilterCatalog() {
  if (filterCatalog) return filterCatalog;
  try {
    const filters = await cc.getFilters(2);
    filterCatalog = new Map();
    if (Array.isArray(filters)) {
      for (const f of filters) {
        const name = f.name || f.title || "";
        const id = f.id || f.filter_id || f.resource_id;
        if (name && id) filterCatalog.set(name, id);
      }
    }
    console.log(`[capcut-compose] loaded ${filterCatalog.size} filters`);
  } catch (e) {
    console.warn("[capcut-compose] failed to load filters:", e.message);
    filterCatalog = new Map();
  }
  return filterCatalog;
}

function findInCatalog(catalog, name) {
  if (!catalog) return null;
  if (catalog.has(name)) return catalog.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of catalog) {
    if (k.toLowerCase().includes(lower)) return v;
  }
  return null;
}

function findEffectId(name) { return findInCatalog(effectCatalog, name); }
function findFilterId(name) { return findInCatalog(filterCatalog, name); }

// ── Audio analysis helpers ──────────────────────────────────────────────────

async function analyzeAudio(audioPath, tmpDir, targetSec, lyrics, beattrack) {
  const { getAudioDuration: getLocalDuration } = require("./beat-detect");
  const audioDurSec = getLocalDuration(audioPath);
  let audioDurUs = Math.round(audioDurSec * 1_000_000);
  let transcript = null;
  let beats = null;

  if (lyrics) {
    transcript = await transcribeAndTrim(audioPath, tmpDir, audioDurSec, targetSec);
    if (transcript) {
      const newDur = getLocalDuration(audioPath);
      audioDurUs = Math.round(newDur * 1_000_000);
    }
  }

  if (beattrack) {
    try {
      const { detectBeats } = require("./beat-detect");
      beats = await detectBeats(audioPath);
    } catch (e) {
      console.warn("[capcut-compose] beat detection failed:", e.message);
    }
  }

  return { audioDurUs, transcript, beats };
}

async function transcribeAndTrim(audioPath, tmpDir, audioDurSec, targetSec) {
  try {
    const { transcribeAudio } = require("./lyrics-captions");
    const transcript = await transcribeAudio(audioPath);
    const firstWord = transcript.words?.find(w => w.word && w.word.trim().length > 0);

    if (firstWord && firstWord.start > 2.5 && targetSec < audioDurSec * 0.8) {
      const audioOffset = Math.max(0, firstWord.start - 1.0);
      console.log(`[capcut-compose] audio offset: skipping ${audioOffset.toFixed(1)}s intro`);
      const trimmedPath = path.join(tmpDir, "audio_trimmed.mp3");
      const { execSync } = require("child_process");
      execSync(`ffmpeg -y -ss ${audioOffset} -i "${audioPath}" -c copy "${trimmedPath}"`, { timeout: 30000, stdio: "pipe" });
      fs.copyFileSync(trimmedPath, audioPath);
      if (transcript.words) {
        for (const w of transcript.words) { w.start -= audioOffset; w.end -= audioOffset; }
      }
    }
    return transcript;
  } catch (e) {
    console.warn("[capcut-compose] transcription failed:", e.message);
    return null;
  }
}

// ── Timeline building ───────────────────────────────────────────────────────

async function buildTimelines(totalUs, mediaCount, beats, style) {
  if (beats && beats.beatTimestamps?.length > 2) {
    const { beatTimelinesUs } = require("./beat-detect");
    return beatTimelinesUs(beats, {
      targetSec: totalUs / 1_000_000,
      minBeats: 1,
      maxBeats: style === "ludicrous" ? 2 : style === "brainslop" ? 3 : 4,
    });
  }

  const timelines = await cc.getTimelines(totalUs, mediaCount * 2);
  if (timelines && timelines.length > 0) return timelines;

  const segDur = Math.round(totalUs / (mediaCount * 2));
  const fallback = [];
  for (let t = 0; t < totalUs; t += segDur) {
    fallback.push({ start: t, end: Math.min(t + segDur, totalUs) });
  }
  return fallback;
}

// ── Draft track adders ──────────────────────────────────────────────────────

async function addVideoTracks(draft, vidUrls, timelines, mediaCount, styleCfg, w, h) {
  const vidTimelines = timelines.filter((_, i) => i % mediaCount < vidUrls.length);
  if (vidTimelines.length === 0) return draft;

  const infos = await cc.videoInfos({
    videoUrls: vidUrls, timelines: vidTimelines,
    transition: styleCfg.transition,
    transitionDuration: styleCfg.transition ? 200000 : null,
    width: w, height: h,
  });
  const result = await cc.addVideos(draft, infos);
  console.log(`[capcut-compose] added ${vidUrls.length} videos on ${vidTimelines.length} segments`);
  return result.draftUrl;
}

async function addImageTracks(draft, imgUrls, timelines, mediaCount, vidCount, styleCfg, w, h) {
  const imgTimelines = vidCount > 0
    ? timelines.filter((_, i) => i % mediaCount >= vidCount)
    : timelines;
  if (imgTimelines.length === 0) return draft;

  const infos = await cc.imgsInfos({
    imgs: imgUrls, timelines: imgTimelines, width: w, height: h,
    transition: styleCfg.transition,
    transitionDuration: styleCfg.transition ? 200000 : null,
    inAnimation: "zoom_in", inAnimationDuration: 500000,
    outAnimation: "fade_out", outAnimationDuration: 300000,
  });
  const result = await cc.addImages(draft, infos);
  console.log(`[capcut-compose] added ${imgUrls.length} images on ${imgTimelines.length} segments`);
  return result.draftUrl;
}

async function addAudioTrack(draft, audioUrl, totalUs) {
  const audioStr = await cc.audioInfos({ mp3Urls: [audioUrl], timelines: [{ start: 0, end: totalUs }], volume: 1.0 });
  const result = await cc.addAudios(draft, audioStr);
  console.log("[capcut-compose] added audio track");
  return result.draftUrl;
}

async function addStyleFilter(draft, styleCfg, totalUs) {
  if (styleCfg.filterNames.length === 0) return draft;
  try {
    const filterId = findFilterId(styleCfg.filterNames[0]);
    if (!filterId) return draft;
    const filterInfoStr = await cc.capcutPost("/filter_infos", {
      filter_id: filterId, timelines: [{ start: 0, end: totalUs }],
    });
    if (filterInfoStr.infos) {
      const result = await cc.addFilters(draft, filterInfoStr.infos);
      console.log(`[capcut-compose] applied filter: ${styleCfg.filterNames[0]}`);
      return result.draftUrl;
    }
  } catch (e) {
    console.warn("[capcut-compose] filter failed:", e.message);
  }
  return draft;
}

// ── Beat-reactive effects ───────────────────────────────────────────────────

function distributePeaks(beats, videoEndSec) {
  let peakTimes = beats.peaks.map(p => p.time).filter(t => t < videoEndSec);
  if (peakTimes.length === 0) return peakTimes;

  const midpoint = videoEndSec / 2;
  const peaksInFirstHalf = peakTimes.filter(t => t < midpoint).length;
  if (peaksInFirstHalf <= peakTimes.length * 0.7) return peakTimes;

  const desiredCount = Math.min(peakTimes.length, Math.ceil(videoEndSec / 3));
  const spacing = videoEndSec / (desiredCount + 1);
  const synthetic = [];
  for (let i = 1; i <= desiredCount; i++) synthetic.push(spacing * i);
  return synthetic;
}

async function addBeatEffects(draft, beats, totalUs) {
  const peakTimes = distributePeaks(beats, totalUs / 1_000_000);
  const effectsToApply = BEAT_EFFECT_NAMES.map(n => ({ name: n, id: findEffectId(n) })).filter(e => e.id);
  if (effectsToApply.length === 0) return draft;

  let current = draft;
  const count = Math.min(peakTimes.length, 15);
  for (let i = 0; i < count; i++) {
    const effect = effectsToApply[i % effectsToApply.length];
    const peakUs = Math.round(peakTimes[i] * 1_000_000);
    try {
      const effectStr = await cc.capcutPost("/effect_infos", {
        effect_id: effect.id,
        timelines: [{ start: peakUs, end: Math.min(peakUs + 300000, totalUs) }],
      });
      if (effectStr.infos) {
        const result = await cc.addEffects(current, effectStr.infos);
        current = result.draftUrl;
      }
    } catch (e) {
      console.warn(`[capcut-compose] beat effect ${effect.name} failed:`, e.message);
    }
  }
  console.log(`[capcut-compose] added ${count} beat effects`);
  return current;
}

async function addStyleEffects(draft, styleCfg, totalUs) {
  let current = draft;
  for (const effectName of styleCfg.effectNames) {
    try {
      const effectId = findEffectId(effectName);
      if (!effectId) continue;
      const effectStr = await cc.capcutPost("/effect_infos", {
        effect_id: effectId, timelines: [{ start: 0, end: totalUs }],
      });
      if (effectStr.infos) {
        const result = await cc.addEffects(current, effectStr.infos);
        current = result.draftUrl;
        console.log(`[capcut-compose] applied effect: ${effectName}`);
      }
    } catch (e) {
      console.warn(`[capcut-compose] effect ${effectName} failed:`, e.message);
    }
  }
  return current;
}

// ── Caption / lyrics ────────────────────────────────────────────────────────

async function addCaptionOverlay(draft, caption, totalUs) {
  try {
    const captionInfoStr = await cc.capcutPost("/caption_infos", {
      captions: [{ text: caption, start: 0, end: Math.min(4_000_000, totalUs) }],
    });
    if (captionInfoStr.infos) {
      const result = await cc.addCaptions(draft, captionInfoStr.infos, {
        fontSize: 48, bold: true, textColor: "#FFFFFF",
        borderColor: "#000000", transformY: -0.35,
      });
      console.log("[capcut-compose] added caption");
      return result.draftUrl;
    }
  } catch (e) {
    console.warn("[capcut-compose] caption failed:", e.message);
  }
  return draft;
}

function buildLyricsCaptions(transcript, lyricsStyle) {
  const captions = [];
  if (lyricsStyle === "viral") {
    for (const w of transcript.words) {
      if (!w.word || w.word.trim().length === 0 || w.start < 0) continue;
      captions.push({
        text: w.word.trim().toUpperCase(),
        start: Math.round(w.start * 1_000_000),
        end: Math.round(w.end * 1_000_000),
      });
    }
  } else {
    const wordsPerLine = lyricsStyle === "karaoke" ? 4 : 6;
    for (let i = 0; i < transcript.words.length; i += wordsPerLine) {
      const chunk = transcript.words.slice(i, i + wordsPerLine).filter(w => w.word && w.start >= 0);
      if (chunk.length === 0) continue;
      captions.push({
        text: chunk.map(w => w.word.trim()).join(" "),
        start: Math.round(chunk[0].start * 1_000_000),
        end: Math.round(chunk[chunk.length - 1].end * 1_000_000),
      });
    }
  }
  return captions.slice(0, 100);
}

async function addLyricsCaptions(draft, transcript, lyricsStyle) {
  try {
    const captions = buildLyricsCaptions(transcript, lyricsStyle);
    if (captions.length === 0) return draft;

    const captionInfoStr = await cc.capcutPost("/caption_infos", { captions });
    if (captionInfoStr.infos) {
      const result = await cc.addCaptions(draft, captionInfoStr.infos, {
        fontSize: lyricsStyle === "viral" ? 72 : 36,
        bold: lyricsStyle === "viral",
        textColor: "#FFFFFF", borderColor: "#000000",
        transformY: lyricsStyle === "viral" ? 0 : 0.35,
      });
      console.log(`[capcut-compose] added ${captions.length} lyrics captions (${lyricsStyle})`);
      return result.draftUrl;
    }
  } catch (e) {
    console.warn("[capcut-compose] lyrics failed:", e.message);
  }
  return draft;
}

// ── Media preparation ───────────────────────────────────────────────────────

async function prepareMedia(images, videos, audioBuffer, tmpDir) {
  const imgNames = writeMediaFiles(images, "img", ".png", tmpDir);
  const vidNames = writeMediaFiles(videos, "vid", ".mp4", tmpDir);
  let audioName = null;
  if (audioBuffer) {
    audioName = "audio.mp3";
    fs.writeFileSync(path.join(tmpDir, audioName), audioBuffer);
  }

  const fileServer = await startFileServer(tmpDir);
  const baseUrl = fileServer.url;
  return {
    imgUrls: imgNames.map(n => `${baseUrl}/${n}`),
    vidUrls: vidNames.map(n => `${baseUrl}/${n}`),
    audioUrl: audioName ? `${baseUrl}/${audioName}` : null,
    audioName,
    fileServer,
  };
}

function computeTotalUs(audioBuffer, audioDurUs, targetSec) {
  const targetUs = Math.round(targetSec * 1_000_000);
  return audioBuffer ? Math.min(audioDurUs, targetUs) : targetUs;
}

// ── Draft assembly (adds all tracks, effects, captions) ─────────────────────

async function assembleDraft(draft, ctx) {
  let current = draft;
  const { vidUrls, imgUrls, audioUrl, timelines, mediaCount, styleCfg, w, h, totalUs } = ctx;

  if (vidUrls.length > 0) current = await addVideoTracks(current, vidUrls, timelines, mediaCount, styleCfg, w, h);
  if (imgUrls.length > 0) current = await addImageTracks(current, imgUrls, timelines, mediaCount, vidUrls.length, styleCfg, w, h);
  if (audioUrl) current = await addAudioTrack(current, audioUrl, totalUs);
  current = await addStyleFilter(current, styleCfg, totalUs);
  return current;
}

async function applyEffects(draft, ctx) {
  const { beattrack, beats, styleCfg, totalUs } = ctx;
  if (beattrack && beats?.peaks?.length > 0) return addBeatEffects(draft, beats, totalUs);
  if (styleCfg.effectNames.length > 0) return addStyleEffects(draft, styleCfg, totalUs);
  return draft;
}

async function applyCaptions(draft, ctx) {
  let current = draft;
  const { caption, lyrics, transcript, lyricsStyle, totalUs } = ctx;
  if (caption) current = await addCaptionOverlay(current, caption, totalUs);
  if (lyrics && transcript?.words?.length > 0) current = await addLyricsCaptions(current, transcript, lyricsStyle);
  return current;
}

// ── Main compose function ───────────────────────────────────────────────────

const COMPOSE_DEFAULTS = {
  images: [], videos: [], audioBuffer: null,
  preset: "short", style: "cinematic", caption: null,
  lyrics: false, lyricsStyle: "karaoke", beattrack: false,
};

async function capcutCompose(opts) {
  const o = { ...COMPOSE_DEFAULTS, ...opts };
  const { images, videos, audioBuffer, caption, lyrics, lyricsStyle, beattrack } = o;
  const presetCfg = PRESETS[o.preset] || PRESETS.short;
  const styleCfg = STYLE_MAP[o.style] || STYLE_MAP.cinematic;
  const style = o.style;
  const { w, h, targetSec } = presetCfg;

  if (images.length === 0 && videos.length === 0) {
    throw new Error("Need at least one image or video");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "capcut-"));
  const media = await prepareMedia(images, videos, audioBuffer, tmpDir);

  try {
    const audioPath = media.audioName ? path.join(tmpDir, media.audioName) : null;
    const analysis = audioPath
      ? await analyzeAudio(audioPath, tmpDir, targetSec, lyrics, beattrack)
      : { beats: null, transcript: null, audioDurUs: 0 };

    await Promise.all([loadEffectCatalog(), loadFilterCatalog()]);

    const { draftUrl } = await cc.createDraft(w, h);
    const totalUs = computeTotalUs(audioBuffer, analysis.audioDurUs, targetSec);
    const mediaCount = media.imgUrls.length + media.vidUrls.length;
    const timelines = await buildTimelines(totalUs, mediaCount, analysis.beats, style);
    console.log(`[capcut-compose] ${timelines.length} timeline segments, ${(totalUs / 1_000_000).toFixed(1)}s total`);

    const ctx = { ...media, timelines, mediaCount, styleCfg, w, h, totalUs, beattrack, ...analysis, caption, lyrics, lyricsStyle };
    let draft = await assembleDraft(draftUrl, ctx);
    draft = await applyEffects(draft, ctx);
    draft = await applyCaptions(draft, ctx);

    await cc.saveDraft(draft);
    const draftId = draft.split("/").filter(Boolean).pop() || draft;
    console.log(`[capcut-compose] draft saved: ${draftId}`);

    return {
      draftUrl: draft, draftId, beats: analysis.beats,
      timelineCount: timelines.length, peakCount: analysis.beats?.peaks?.length || 0,
      presetCfg, style, tmpDir, fileServer: media.fileServer,
    };
  } catch (e) {
    media.fileServer.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    throw e;
  }
}

function cleanupCompose(result) {
  if (result.fileServer) {
    try { result.fileServer.close(); } catch { /* cleanup */ }
  }
  if (result.tmpDir) {
    try { fs.rmSync(result.tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
}

module.exports = { capcutCompose, cleanupCompose, PRESETS, STYLE_MAP };
