// CapCut Compose — builds CapCut Mate drafts with effects, filters, keyframes,
// transitions, beat sync, and lyrics. Separate pipeline from video-editor.js (FFmpeg).
//
// Phase 1: Creates CapCut draft via API. Rendering handled by desktop export or FFmpeg fallback.

const fs = require("fs");
const path = require("path");
const os = require("os");

const cc = require("./capcut-client");
const { startFileServer, writeMediaFiles } = require("./capcut-file-server");
const { findFfprobe } = require("./ffmpeg-utils");

// Get video durations in microseconds using ffprobe
function getVideoDurationsUs(vidPaths) {
  const { execSync } = require("child_process");
  const ffprobe = findFfprobe();
  if (!ffprobe) return vidPaths.map(() => 0);
  return vidPaths.map(p => {
    try {
      const out = execSync(
        `"${ffprobe}" -v quiet -show_entries format=duration -of csv=p=0 "${p}"`,
        { timeout: 10000 }
      ).toString().trim();
      const dur = Math.round(parseFloat(out) * 1_000_000);
      return dur > 0 ? dur : 0;
    } catch { return 0; }
  });
}

// ── Presets (shared with video-editor.js) ───────────────────────────────────

const { resolvePreset, PRESETS } = require("./video-presets");

// ── Style → CapCut effect/filter mapping ────────────────────────────────────

const STYLE_MAP = {
  cinematic:     { filterNames: ["1980"],       effectNames: [],                                                          transition: "fade_black" },
  vibrant:       { filterNames: ["Ditto"],      effectNames: ["kirakira"],                                                transition: "fade_black" },
  moody:         { filterNames: ["ABG"],        effectNames: [],                                                          transition: "fade_black" },
  vintage:       { filterNames: ["VHS III"],    effectNames: ["70s", "betamax"],                                          transition: "fade_black" },
  dark:          { filterNames: ["KE1"],        effectNames: ["X-Signal"],                                                transition: "fade_black" },
  dreamy:        { filterNames: ["Lofi II"],    effectNames: [],                                                          transition: "fade_black" },
  bright:        { filterNames: [],             effectNames: [],                                                          transition: "fade_black" },
  clean:         { filterNames: [],             effectNames: [],                                                          transition: "fade_black" },
  // NOTE: Effect names are CapCut's Chinese catalog IDs — translations in comments.
  // CCD闪光=CCD Flash, RGB描边=RGB Outline, 抖动=Shake, 定格闪烁=Freeze Flicker,
  // 故障=Glitch, 色差故障=Chromatic Aberration, 横纹故障=Scanline Glitch,
  // 像素震闪=Pixel Shock, 荧幕噪点=Screen Noise, 霓虹灯=Neon Light,
  // 霓虹投影=Neon Projection, 光晕 II=Halo II, 仙尘闪闪=Fairy Dust Sparkle,
  // 下雨=Rain, 浓雾=Dense Fog, 雾气=Mist, 落叶=Falling Leaves, 流星雨=Meteor Shower,
  // 雪花=Snowflakes, 复古DV=Retro DV, 胶片漏光=Film Light Leak, 90s画质=90s Quality,
  // 冲刺 III=Dash III, 动感模糊=Motion Blur, 震动=Vibration, 旋转变焦=Spin Zoom,
  // 抖动模糊=Shake Blur, 摇晃运镜=Shaky Camera, 漫画=Comic, 复古漫画=Retro Comic,
  // 动感色卡=Motion Color Card, 冲刺=Dash, 星光闪耀=Starlight Shine,
  // 丁达尔光线=Tyndall Light, 光斑飘落=Light Spots Falling, 胶片=Film, 晴天光线=Sunny Rays,
  // 三屏=Triple Screen, 分屏开幕=Split Screen Open, 两屏=Dual Screen,
  // 冲击波=Shockwave, 闪光震动=Flash Shake, 负片闪烁=Negative Flicker
  brainslop:     { filterNames: [],             effectNames: ["CCD闪光", "RGB描边", "抖动"],                              transition: null },              // CCD Flash, RGB Outline, Shake
  ludicrous:     { filterNames: [],             effectNames: ["X-Signal", "抖动", "CCD闪光", "定格闪烁"],                 transition: null },              // X-Signal, Shake, CCD Flash, Freeze Flicker
  glitchpunk:    { filterNames: ["2077"],       effectNames: ["RGB描边", "故障", "色差故障", "横纹故障", "像素震闪", "荧幕噪点"], transition: null },        // RGB Outline, Glitch, Chromatic Aberration, Scanline Glitch, Pixel Shock, Screen Noise
  neondream:     { filterNames: ["City Walk"],  effectNames: ["霓虹灯", "霓虹投影", "光晕 II", "kirakira", "仙尘闪闪"],  transition: "fade_black" },      // Neon Light, Neon Projection, Halo II, kirakira, Fairy Dust
  weatherwitch:  { filterNames: ["ABG"],        effectNames: ["下雨", "浓雾", "雾气", "落叶", "流星雨", "雪花"],          transition: "fade_black" },      // Rain, Dense Fog, Mist, Falling Leaves, Meteor Shower, Snowflakes
  retrofuture:   { filterNames: ["VHS III", "90s"], effectNames: ["复古DV", "VCR", "胶片漏光", "90s画质", "荧幕噪点"],    transition: "fade_black" },      // Retro DV, VCR, Film Light Leak, 90s Quality, Screen Noise
  motionsick:    { filterNames: ["KV5D"],       effectNames: ["冲刺 III", "动感模糊", "震动", "旋转变焦", "抖动模糊", "摇晃运镜"], transition: null },      // Dash III, Motion Blur, Vibration, Spin Zoom, Shake Blur, Shaky Camera
  animecore:     { filterNames: ["Ditto"],      effectNames: ["漫画", "复古漫画", "动感色卡", "冲刺", "星光闪耀"],        transition: "fade_black" },      // Comic, Retro Comic, Motion Color Card, Dash, Starlight Shine
  goldenhour:    { filterNames: ["1980"],       effectNames: ["丁达尔光线", "光斑飘落", "胶片", "晴天光线"],              transition: "fade_black" },      // Tyndall Light, Light Spots Falling, Film, Sunny Rays
  splitreality:  { filterNames: ["KE1"],        effectNames: ["三屏", "分屏开幕", "两屏", "RGB描边", "故障"],             transition: null },              // Triple Screen, Split Screen Open, Dual Screen, RGB Outline, Glitch
  "16bit-spiritual": { filterNames: ["VHS III", "90s"], effectNames: ["像素震闪", "荧幕噪点", "复古DV", "90s画质", "定格闪烁", "故障"], transition: null }, // Pixel Shock, Screen Noise, Retro DV, 90s Quality, Freeze Flicker, Glitch
};

// Beat-synced effects — triggered on detected beats. Names are CapCut catalog IDs.
// CCD Flash, Shake, RGB Outline, Freeze Flicker, X-Signal, Glitch, Chromatic Aberration,
// Shockwave, Flash Shake, Vibration, Pixel Shock, Negative Flicker
const BEAT_EFFECT_NAMES = ["CCD闪光", "抖动", "RGB描边", "定格闪烁", "X-Signal", "故障", "色差故障", "冲击波", "闪光震动", "震动", "像素震闪", "负片闪烁"];

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
      const { findFfmpeg } = require("./ffmpeg-utils");
      const ffmpeg = findFfmpeg();
      if (!ffmpeg) throw new Error("ffmpeg not found — cannot trim audio");
      execSync(`"${ffmpeg}" -y -ss ${audioOffset} -i "${audioPath}" -c copy "${trimmedPath}"`, { timeout: 30000, stdio: "pipe" });
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

async function buildTimelines(totalUs, mediaCount, beats, style, vidDurationsUs = []) {
  if (beats && beats.beatTimestamps?.length > 2) {
    const { beatTimelinesUs } = require("./beat-detect");
    return beatTimelinesUs(beats, {
      targetSec: totalUs / 1_000_000,
      minBeats: 1,
      maxBeats: style === "ludicrous" ? 2 : style === "brainslop" ? 3 : 4,
    });
  }

  // Compute segment count targeting 20-30 cuts/min.
  // High-energy styles: 2s segments (~30/min). Others: 3s (~20/min).
  const HIGH_ENERGY = ["brainslop", "ludicrous", "glitchpunk", "motionsick", "splitreality", "16bit-spiritual"];
  const targetSegDurSec = HIGH_ENERGY.includes(style) ? 2 : 3;
  const byTarget = Math.ceil((totalUs / 1_000_000) / targetSegDurSec);
  let numSegments = Math.max(mediaCount, byTarget);
  if (vidDurationsUs.length > 0) {
    const validDurs = vidDurationsUs.filter(d => d > 0);
    if (validDurs.length > 0) {
      const minDurUs = Math.min(...validDurs);
      // Never request more segments than source clips can fill (each seg needs ≥0.5s of unique content)
      const maxByContent = Math.floor((minDurUs / 1_000_000) / 0.5) * validDurs.length;
      numSegments = Math.min(numSegments, Math.max(mediaCount, maxByContent));
      console.log(`[capcut-compose] segment count: ${numSegments} (${targetSegDurSec}s target, min clip ${(minDurUs/1e6).toFixed(1)}s, total ${(totalUs/1e6).toFixed(1)}s)`);
    }
  }

  const timelines = await cc.getTimelines(totalUs, numSegments);
  if (timelines && timelines.length > 0) return timelines;

  const segDur = Math.round(totalUs / numSegments);
  const fallback = [];
  for (let t = 0; t < totalUs; t += segDur) {
    fallback.push({ start: t, end: Math.min(t + segDur, totalUs) });
  }
  return fallback;
}

// ── Draft track adders ──────────────────────────────────────────────────────

// Pre-trim source clips to slot duration so CapCut makes clean cuts.
// CapCut plays each clip in full regardless of the timeline slot endpoint,
// so we must trim before passing to the API.
// Returns one URL per timeline slot — each clip appearance uses a different start offset
// so repeated clips show different windows rather than the same 6s every time.
async function trimClipsToSegDur(vidUrls, vidTimelines, tmpDir) {
  const { findFfmpeg } = require("./ffmpeg-utils");
  const { execSync } = require("child_process");
  const ffmpeg = findFfmpeg();
  if (!ffmpeg || vidTimelines.length === 0) return vidUrls;

  const segDurSec = (vidTimelines[0].end - vidTimelines[0].start) / 1_000_000;
  const baseUrl = vidUrls[0].substring(0, vidUrls[0].lastIndexOf("/"));
  const srcDurCache = {};
  const appearanceCount = {};
  const result = [];

  for (let i = 0; i < vidTimelines.length; i++) {
    const url = vidUrls[i % vidUrls.length];
    const filename = url.split("/").pop();
    const srcPath = path.join(tmpDir, filename);

    if (!(filename in srcDurCache)) {
      srcDurCache[filename] = (getVideoDurationsUs([srcPath])[0] || 0) / 1_000_000;
    }
    const srcDurSec = srcDurCache[filename];

    if (srcDurSec <= segDurSec) {
      result.push(url);
      continue;
    }

    const n = appearanceCount[filename] || 0;
    appearanceCount[filename] = n + 1;
    const maxStart = srcDurSec - segDurSec;
    const startSec = Math.min(n * segDurSec, maxStart);

    const trimName = filename.replace(/\.mp4$/i, `_seg${i}.mp4`);
    const trimPath = path.join(tmpDir, trimName);
    try {
      execSync(
        `"${ffmpeg}" -y -ss ${startSec.toFixed(3)} -t ${segDurSec.toFixed(3)} -i "${srcPath}" -c copy -avoid_negative_ts 1 "${trimPath}"`,
        { timeout: 30000, stdio: "pipe" }
      );
      result.push(`${baseUrl}/${trimName}`);
      console.log(`[capcut-compose] trimmed ${filename} slot${i}: ${startSec.toFixed(1)}s+${segDurSec.toFixed(1)}s`);
    } catch (e) {
      console.warn(`[capcut-compose] trim failed for ${filename} slot ${i}:`, e.message);
      result.push(url);
    }
  }
  return result; // already expanded — one URL per slot
}

async function addVideoTracks(draft, vidUrls, timelines, mediaCount, styleCfg, w, h, hasAudio = false, tmpDir = null) {
  const vidTimelines = timelines.filter((_, i) => i % mediaCount < vidUrls.length);
  if (vidTimelines.length === 0) return draft;

  // Pre-trim clips per slot with offset spreading — returns one URL per slot already
  const expandedUrls = tmpDir
    ? await trimClipsToSegDur(vidUrls, vidTimelines, tmpDir)
    : vidTimelines.map((_, i) => vidUrls[i % vidUrls.length]);

  const infos = await cc.videoInfos({
    videoUrls: expandedUrls, timelines: vidTimelines,
    transition: styleCfg.transition,
    transitionDuration: styleCfg.transition ? 200000 : null,
    width: w, height: h,
    volume: hasAudio ? 0 : 1.0,
  });
  const result = await cc.addVideos(draft, infos);
  console.log(`[capcut-compose] added ${vidUrls.length} videos on ${vidTimelines.length} segments (${expandedUrls.length} slots @ ${((vidTimelines[0]?.end - vidTimelines[0]?.start) / 1e6 || 0).toFixed(1)}s each)`);
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
    const filterInfoStr = await cc.capcutPost("/filter_infos", {
      filters: styleCfg.filterNames,
      timelines: [{ start: 0, end: totalUs }],
    });
    if (filterInfoStr.infos) {
      const result = await cc.addFilters(draft, filterInfoStr.infos);
      console.log(`[capcut-compose] applied filter: ${styleCfg.filterNames.join(", ")}`);
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
  if (BEAT_EFFECT_NAMES.length === 0 || peakTimes.length === 0) return draft;

  let current = draft;
  const count = Math.min(peakTimes.length, 15);
  let added = 0;
  for (let i = 0; i < count; i++) {
    const effectName = BEAT_EFFECT_NAMES[i % BEAT_EFFECT_NAMES.length];
    const peakUs = Math.round(peakTimes[i] * 1_000_000);
    try {
      const effectStr = await cc.capcutPost("/effect_infos", {
        effects: [effectName],
        timelines: [{ start: peakUs, end: Math.min(peakUs + 300000, totalUs) }],
      });
      if (effectStr.infos) {
        const result = await cc.addEffects(current, effectStr.infos);
        current = result.draftUrl;
        added++;
      }
    } catch (e) {
      console.warn(`[capcut-compose] beat effect ${effectName} failed:`, e.message);
    }
  }
  console.log(`[capcut-compose] added ${added}/${count} beat effects`);
  return current;
}

async function addStyleEffects(draft, styleCfg, totalUs) {
  if (styleCfg.effectNames.length === 0) return draft;
  // API takes 1 effect + 1 timeline per call (same pattern as beat effects)
  let current = draft;
  let added = 0;
  for (const effectName of styleCfg.effectNames) {
    try {
      const effectStr = await cc.capcutPost("/effect_infos", {
        effects: [effectName],
        timelines: [{ start: 0, end: totalUs }],
      });
      if (effectStr.infos) {
        const result = await cc.addEffects(current, effectStr.infos);
        current = result.draftUrl;
        added++;
      }
    } catch (e) {
      console.warn(`[capcut-compose] effect ${effectName} failed:`, e.message);
    }
  }
  if (added > 0) console.log(`[capcut-compose] applied ${added}/${styleCfg.effectNames.length} effects: ${styleCfg.effectNames.join(", ")}`);
  return current;
}

// ── Caption / lyrics ────────────────────────────────────────────────────────

async function addCaptionOverlay(draft, caption, totalUs) {
  try {
    const captionInfoStr = await cc.capcutPost("/caption_infos", {
      texts: [caption],
      timelines: [{ start: 0, end: Math.min(4_000_000, totalUs) }],
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

    const texts = captions.map(c => c.text);
    const timelines = captions.map(c => ({ start: c.start, end: c.end }));
    const captionInfoStr = await cc.capcutPost("/caption_infos", { texts, timelines });
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
    const rawAudioPath = path.join(tmpDir, "audio_raw.mp3");
    const finalAudioPath = path.join(tmpDir, audioName);
    fs.writeFileSync(rawAudioPath, audioBuffer);
    // Re-encode to ensure proper MP3 headers (pymediainfo in CapCut needs valid Xing/VBRI headers)
    try {
      const { findFfmpeg } = require("./ffmpeg-utils");
      const ffmpeg = findFfmpeg();
      if (ffmpeg) {
        require("child_process").execSync(
          `"${ffmpeg}" -y -i "${rawAudioPath}" -c:a libmp3lame -b:a 192k -write_xing 1 "${finalAudioPath}"`,
          { timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }
        );
        console.log("[capcut-compose] re-encoded audio with proper MP3 headers");
      } else {
        fs.copyFileSync(rawAudioPath, finalAudioPath);
      }
    } catch (e) {
      console.warn("[capcut-compose] audio re-encode failed, using raw:", e.message);
      fs.copyFileSync(rawAudioPath, finalAudioPath);
    }
  }

  const vidDurationsUs = vidNames.length > 0
    ? getVideoDurationsUs(vidNames.map(n => path.join(tmpDir, n)))
    : [];

  const fileServer = await startFileServer(tmpDir);
  const baseUrl = fileServer.url;
  return {
    imgUrls: imgNames.map(n => `${baseUrl}/${n}`),
    vidUrls: vidNames.map(n => `${baseUrl}/${n}`),
    audioUrl: audioName ? `${baseUrl}/${audioName}` : null,
    audioName,
    fileServer,
    vidDurationsUs,
  };
}

function computeTotalUs(audioBuffer, audioDurUs, targetSec) {
  const targetUs = Math.round(targetSec * 1_000_000);
  return audioBuffer ? Math.min(audioDurUs, targetUs) : targetUs;
}

// ── Draft assembly (adds all tracks, effects, captions) ─────────────────────

async function assembleDraft(draft, ctx) {
  let current = draft;
  const { vidUrls, imgUrls, audioUrl, timelines, mediaCount, styleCfg, w, h, totalUs, tmpDir } = ctx;

  if (vidUrls.length > 0) current = await addVideoTracks(current, vidUrls, timelines, mediaCount, styleCfg, w, h, !!audioUrl, tmpDir);
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
  resolution: undefined, customAr: undefined,
};

async function capcutCompose(opts) {
  const o = { ...COMPOSE_DEFAULTS, ...opts };
  const { images, videos, audioBuffer, caption, lyrics, lyricsStyle, beattrack } = o;
  const presetCfg = resolvePreset(o.preset, o.resolution, o.customAr);
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

    const { draftUrl } = await cc.createDraft(w, h);
    const totalUs = computeTotalUs(audioBuffer, analysis.audioDurUs, targetSec);
    const mediaCount = media.imgUrls.length + media.vidUrls.length;
    const timelines = await buildTimelines(totalUs, mediaCount, analysis.beats, style, media.vidDurationsUs);
    console.log(`[capcut-compose] ${timelines.length} timeline segments, ${(totalUs / 1_000_000).toFixed(1)}s total`);

    const ctx = { ...media, timelines, mediaCount, styleCfg, w, h, totalUs, tmpDir, beattrack, ...analysis, caption, lyrics, lyricsStyle };
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
