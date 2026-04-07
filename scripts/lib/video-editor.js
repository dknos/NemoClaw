// Video editor engine — timeline computation + FFmpeg rendering.
// Composes images (Ken Burns), video clips, and music into viral-ready videos.
// Short clips are stretched via loop, reverse, and pingpong to fill target duration.
// Fun effects (shake, pulse zoom, glitch, speed ramps) are applied per-segment.

const fs = require("fs");
const { execSync, execFileSync: _execFileSync } = require("child_process");

// ── Constants ───────────────────────────────────────────────────────────────

const FFMPEG_BIN = (() => {
  const candidates = ["/home/nemoclaw/.local/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (_e) { /* ignore */ } }
  return "ffmpeg";
})();
const FFPROBE_BIN = FFMPEG_BIN;

// Presets imported from shared module — single source of truth for resolution + bitrate.
const { resolvePreset, detectAspectRatio, adjustPresetForAspect, PRESETS } = require("./video-presets");

const STYLE_FILTERS = {
  cinematic:  "curves=vintage,colorbalance=rs=-0.05:gs=0:bs=0.05:rm=0:gm=0:bm=0:rh=0.05:gh=0:bh=-0.05,eq=contrast=1.1:brightness=-0.02:saturation=0.85",
  vibrant:    "eq=contrast=1.05:brightness=0.02:saturation=1.4,hue=s=1.2",
  moody:      "curves=darker,colorbalance=rs=-0.1:gs=-0.05:bs=0.1,eq=contrast=1.2:saturation=0.7",
  vintage:    "curves=vintage,hue=h=10:s=0.8,vignette=PI/4",
  dark:       "curves=darker,eq=contrast=1.3:brightness=-0.05:saturation=0.8",
  dreamy:     "gblur=sigma=0.8,eq=contrast=0.95:brightness=0.03:saturation=1.1,curves=lighter",
  bright:     "eq=contrast=1.0:brightness=0.06:saturation=1.15,curves=lighter",
  clean:      "eq=contrast=1.02:brightness=0.01:saturation=1.05,unsharp=3:3:0.5",
  brainslop:  "eq=contrast=1.15:brightness=-0.01:saturation=1.2,unsharp=5:5:0.8",
  ludicrous:  "eq=contrast=1.25:saturation=1.5:brightness=0.02,noise=alls=8:allf=t",
  "16bit-spiritual": "hue=s=0.6,eq=contrast=1.3:brightness=-0.03:saturation=0.65,noise=alls=12:allf=t,vignette=PI/3",
};

// ── Choppy style config ────────────────────────────────────────────────────
// These styles use jumpcut timelines instead of smooth crossfades.
// bpm: assumed music tempo. cutsPerMin: target number of cuts per 60s.
// minBeatLen/maxBeatLen: segment length range in beats.

const CHOPPY_STYLES = {
  brainslop: { bpm: 120, cutsPerMin: 45, minBeats: 1, maxBeats: 4 },   // beat-synced, 0.5-2s cuts
  ludicrous: { bpm: 120, cutsPerMin: 25, minBeats: 2, maxBeats: 8 },   // 20-30 cuts/min, varied lengths, some reversed
  "16bit-spiritual": { bpm: 110, cutsPerMin: 50, minBeats: 1, maxBeats: 3 }, // rapid jumpcuts, 90s geocities feel
};

const EXEC_TIMEOUT = 300000; // 5 min per FFmpeg call (zoompan on big images is slow)
const COMPOSE_TIMEOUT = 600000; // 10 min for the xfade chain

const TRANSITION_DUR = 0.5;
const IMG_MIN_DUR = 3;
const IMG_MAX_DUR = 7;
const IMG_DEFAULT_DUR = 4;

// ── FFmpeg exec with better error messages ─────────────────────────────────

// Build FFmpeg scale filter: crop (default) or stretch mode.
// Crop: scales up to fill, then crops overshoot — no black bars, may cut edges.
// Stretch: scales to exact dimensions — may distort, but no cropping.
function buildScaleFilter(w, h, fps, stretch = false) {
  if (stretch) return `scale=${w}:${h},fps=${fps}`;
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps}`;
}

function ffmpegExec(args, label, timeout = EXEC_TIMEOUT) {
  try {
    execSync(`"${FFMPEG_BIN}" ${args}`, { timeout, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().slice(-500) : "";
    const killed = err.killed || err.signal === "SIGTERM";
    if (killed) throw new Error(`FFmpeg timed out (${Math.round(timeout / 1000)}s) during: ${label}`, { cause: err });
    throw new Error(`FFmpeg failed during ${label}: ${stderr || err.message}`, { cause: err });
  }
}

// ── Pre-process: downscale images so zoompan doesn't choke on 4K ───────────

function downscaleImage(inputPath, maxDim, outputPath) {
  // Scale image down so the larger side is maxDim (zoompan is O(pixels²))
  try {
    execSync(
      `"${FFMPEG_BIN}" -y -i "${inputPath}" -vf "scale='if(gt(iw,ih),${maxDim},-2)':'if(gt(iw,ih),-2,${maxDim})'" "${outputPath}"`,
      { timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return outputPath;
  } catch {
    // If downscale fails, use original
    return inputPath;
  }
}

// ── Fun effects applied per-segment (FFmpeg filter snippets) ────────────────
// These are appended AFTER scale/crop/color but BEFORE encoding.
// Each returns a filter string or "" if not applicable.

const SEGMENT_EFFECTS = [
  // 0: None — clean pass
  () => "",
  // 1: Vignette pulse — breathing darkness at edges
  () => "vignette=PI/4+0.1*sin(2*PI*t)",
  // 2: Hue rotate — slow color cycle
  () => "hue=H=20*t",
  // 3: Film grain — organic texture
  () => "noise=alls=15:allf=t",
  // 4: RGB shift — glitchy chromatic aberration
  () => "rgbashift=rh=3:bh=-3:rv=-2:bv=2",
  // 5: Brightness pulse — rhythmic glow
  () => "eq=brightness=0.04*sin(3*PI*t)",
  // 6: Sharp vignette — cinematic letterbox feel
  () => "vignette=PI/3",
  // 7: Saturation wave — colors breathe
  () => "eq=saturation=1+0.3*sin(2*PI*t)",
  // 8: CCD Flash — bright burst on entry, decays over segment (CapCut CCD闪光)
  () => "eq=brightness='0.5*max(0,1-t*3)'",
  // 9: Screen Shake — random crop offset simulating camera shake (CapCut 振动)
  () => "crop=iw-20:ih-20:10+5*sin(30*t):10+5*cos(25*t)",
  // 10: Chromatic Aberration (strong) — wider channel split (CapCut RGB描边)
  () => "rgbashift=rh=8:bh=-8:rv=-5:bv=5",
  // 11: Freeze Flicker — low fps + brightness oscillation (CapCut 定格闪烁)
  () => "fps=4,eq=brightness='0.15*sin(8*PI*t)'",
  // 12: Negative Flash — brief negative inversion (CapCut 底片闪烁)
  () => "negate,eq=brightness=-0.1",
  // 13: Scanline CRT — dark horizontal lines every 4px (CapCut 扫描线)
  () => "geq=lum='lum(X,Y)*if(mod(Y,4),1,0.7)':cb='cb(X,Y)':cr='cr(X,Y)'",
  // 14: VHS — noise + color bleed + slight blur (CapCut VHS III)
  () => "noise=alls=20:allf=t,colorbalance=rs=0.1:gs=-0.05:bs=-0.05,gblur=sigma=0.5",
  // 15: Motion Blur — temporal blend (CapCut 运动模糊)
  () => "tblend=all_mode=average",
  // 16: Brightness Strobe — rapid on/off flash, beat-synced feel (CapCut 频闪)
  () => "eq=brightness='0.3*abs(sin(6*PI*t))'",
  // 17: Neon Edge Glow — sharpen + brighten edges for neon outline feel (CapCut 霓虹灯)
  () => "eq=brightness=0.1,unsharp=7:7:2.0",
  // 18: Glitch — heavy noise + strong RGB separation (CapCut 故障)
  () => "noise=alls=40:allf=t,rgbashift=rh=6:bh=-6:rv=4:bv=-4",
  // 19: Color Drift — RGB channel separation (rgbashift does not support time expressions)
  () => "rgbashift=rh=4:bh=-4:rv=3:bv=-3",
  // 20: Posterize — reduced color palette, retro/16bit feel (CapCut 90s Quality)
  () => "eq=contrast=1.3,hue=s=0.5,noise=alls=8:allf=t",
  // 21: Speed Pulse — alternating brightness+contrast to simulate tempo change
  () => "eq=brightness='0.05*sin(4*PI*t)':contrast='1+0.1*sin(4*PI*t)'",
  // 22: Heavy Grain — intense film grain (CapCut 画面噪波)
  () => "noise=alls=30:allf=t",
];

function pickEffect(segIndex, style) {
  // Each pool lists effect indices; 0s are filtered out.
  // Segments cycle through the pool: seg[i] gets pool[i % pool.length].
  const styleWeights = {
    cinematic: [0, 1, 0, 3, 0, 6, 0, 0, 15, 21],          // + motion blur, speed pulse
    vibrant:   [0, 0, 2, 0, 4, 5, 0, 7, 16, 21],          // + strobe, speed pulse
    moody:     [0, 1, 0, 3, 10, 0, 6, 0, 8, 12, 19],      // + chromatic, flash, negative, drift
    vintage:   [0, 1, 0, 3, 0, 0, 6, 0, 14, 20],          // + VHS, posterize
    dark:      [0, 1, 0, 3, 10, 0, 6, 0, 8, 12, 13],      // + chromatic, flash, negative, scanline
    dreamy:    [0, 1, 2, 0, 0, 5, 0, 7, 15, 19],          // + motion blur, color drift
    bright:    [0, 0, 2, 0, 0, 5, 0, 7, 16, 21],          // + strobe, speed pulse
    clean:     [0, 0, 0, 0, 0, 0, 0, 0],                   // no effects
    brainslop: [0, 0, 0, 3, 10, 5, 0, 7, 8, 9, 16, 19],   // + chromatic, flash, shake, strobe, drift
    ludicrous: [0, 1, 2, 3, 10, 5, 0, 7, 8, 9, 11, 18, 16, 22],  // everything chaotic + freeze, glitch, strobe, heavy grain
    "16bit-spiritual": [0, 13, 0, 3, 4, 11, 0, 20, 14, 22], // scanline, grain, rgb, freeze, posterize, VHS, heavy grain
  };
  const pool = (styleWeights[style] || styleWeights.cinematic).filter(i => i > 0);
  if (pool.length === 0) return 0;
  return pool[segIndex % pool.length];
}

function getEffectFilter(effectIdx, fps) {
  const fn = SEGMENT_EFFECTS[effectIdx];
  return fn ? fn(fps) : "";
}

// ── Transition variety ──────────────────────────────────────────────────────

const XFADE_TRANSITIONS = [
  "fadeblack", "fadewhite", "slideleft", "slideright",
  "slideup", "slidedown", "circlecrop", "dissolve",
  "pixelize", "wipeleft", "wiperight", "wipetl",
];

function pickTransition(segIndex) {
  return XFADE_TRANSITIONS[segIndex % XFADE_TRANSITIONS.length];
}

// ── FFprobe helper ──────────────────────────────────────────────────────────

function probeDuration(filePath) {
  try {
    const out = execSync(
      `"${FFMPEG_BIN}" -i "${filePath}" 2>&1 || true`,
      { encoding: "utf-8", timeout: 10000 }
    );
    const m = out.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 100;
    return 5;
  } catch {
    return 5;
  }
}

// ── Stretch strategies for short clips ──────────────────────────────────────
// Given a clip of `clipDur` seconds, produce a clip of `targetDur` seconds.

function stretchVideo(inputPath, outputPath, clipDur, targetDur, w, h, fps, colorFilter, effectFilter, tmpDir, segIdx, stretchMode = false) {
  if (clipDur <= 0) clipDur = 5;
  const ratio = targetDur / clipDur;
  const scaleFilter = buildScaleFilter(w, h, fps, stretchMode);
  const extraFilters = [colorFilter, effectFilter].filter(Boolean).join(",");
  const vf = extraFilters ? `${scaleFilter},${extraFilters}` : scaleFilter;

  if (ratio <= 1.1) {
    // Clip is long enough — just trim to targetDur
    ffmpegExec(`-y -i "${inputPath}" -t ${targetDur} -vf "${vf}" -c:v libx264 -crf 23 -preset fast -an "${outputPath}"`, `trim seg#${segIdx}`);
    return "trim";
  }

  if (ratio <= 2.2) {
    // Pingpong: play forward then reverse (doubles length)
    const fwd = `${tmpDir}/pp_fwd_${segIdx}.mp4`;
    const rev = `${tmpDir}/pp_rev_${segIdx}.mp4`;
    ffmpegExec(`-y -i "${inputPath}" -vf "${vf}" -c:v libx264 -crf 23 -preset fast -an "${fwd}"`, `pingpong-fwd seg#${segIdx}`);
    ffmpegExec(`-y -i "${fwd}" -vf "reverse" -c:v libx264 -crf 23 -preset fast -an "${rev}"`, `pingpong-rev seg#${segIdx}`);
    const listPath = `${tmpDir}/pp_list_${segIdx}.txt`;
    fs.writeFileSync(listPath, `file '${fwd}'\nfile '${rev}'\n`);
    ffmpegExec(`-y -f concat -safe 0 -i "${listPath}" -t ${targetDur} -c:v libx264 -crf 23 -preset fast -an "${outputPath}"`, `pingpong-concat seg#${segIdx}`);
    return "pingpong";
  }

  if (ratio <= 4.5) {
    // Pingpong + loop: fwd-rev-fwd-rev...
    const fwd = `${tmpDir}/ppl_fwd_${segIdx}.mp4`;
    const rev = `${tmpDir}/ppl_rev_${segIdx}.mp4`;
    ffmpegExec(`-y -i "${inputPath}" -vf "${vf}" -c:v libx264 -crf 23 -preset fast -an "${fwd}"`, `pploop-fwd seg#${segIdx}`);
    ffmpegExec(`-y -i "${fwd}" -vf "reverse" -c:v libx264 -crf 23 -preset fast -an "${rev}"`, `pploop-rev seg#${segIdx}`);
    const reps = Math.ceil(ratio / 2);
    const listPath = `${tmpDir}/ppl_list_${segIdx}.txt`;
    const entries = [];
    for (let r = 0; r < reps; r++) { entries.push(`file '${fwd}'`); entries.push(`file '${rev}'`); }
    fs.writeFileSync(listPath, entries.join("\n") + "\n");
    ffmpegExec(`-y -f concat -safe 0 -i "${listPath}" -t ${targetDur} -c:v libx264 -crf 23 -preset fast -an "${outputPath}"`, `pploop-concat seg#${segIdx}`);
    return "pingpong-loop";
  }

  // Very short clip — slow down 0.5x + loop
  const slowPath = `${tmpDir}/slow_${segIdx}.mp4`;
  ffmpegExec(`-y -i "${inputPath}" -vf "${vf},setpts=2*PTS" -r ${fps} -c:v libx264 -crf 23 -preset fast -an "${slowPath}"`, `slow seg#${segIdx}`);
  const slowDur = probeDuration(slowPath);
  const loopCount = Math.ceil(targetDur / slowDur);
  const listPath = `${tmpDir}/sloop_list_${segIdx}.txt`;
  fs.writeFileSync(listPath, Array(loopCount).fill(`file '${slowPath}'`).join("\n") + "\n");
  ffmpegExec(`-y -f concat -safe 0 -i "${listPath}" -t ${targetDur} -c:v libx264 -crf 23 -preset fast -an "${outputPath}"`, `slow-loop-concat seg#${segIdx}`);
  return "slow-loop";
}

// ── Timeline computation ────────────────────────────────────────────────────

function computeTimeline({ imagePaths, videoPaths, targetSec }) {
  const videoDurations = videoPaths.map(p => probeDuration(p));
  const _totalNativeMedia = videoDurations.reduce((s, d) => s + d, 0) + imagePaths.length * IMG_DEFAULT_DUR;
  const numSegments = imagePaths.length + videoPaths.length;
  if (numSegments === 0) return { segments: [], totalDurationSec: 0, transitionDurSec: TRANSITION_DUR };

  const transitionOverlap = Math.max(0, numSegments - 1) * TRANSITION_DUR;

  // Decide how much time each segment should fill
  // Distribute target duration proportionally, with images getting 3-7s and videos getting stretched
  const effectiveTarget = targetSec + transitionOverlap;
  const totalParts = imagePaths.length + videoPaths.length;
  const perSegment = effectiveTarget / totalParts;

  const segments = [];
  let imgIdx = 0, vidIdx = 0;

  while (imgIdx < imagePaths.length || vidIdx < videoPaths.length) {
    const imgProgress = imagePaths.length > 0 ? imgIdx / imagePaths.length : 1;
    const vidProgress = videoPaths.length > 0 ? vidIdx / videoPaths.length : 1;

    if (imgIdx < imagePaths.length && imgProgress <= vidProgress) {
      const dur = Math.min(IMG_MAX_DUR, Math.max(IMG_MIN_DUR, perSegment));
      segments.push({ type: "image", index: imgIdx, durationSec: dur, filePath: imagePaths[imgIdx], nativeDur: dur });
      imgIdx++;
    } else if (vidIdx < videoPaths.length) {
      const nativeDur = videoDurations[vidIdx];
      // Video gets at least its native duration, stretched up to perSegment if short
      const allocDur = Math.max(nativeDur, perSegment);
      segments.push({ type: "video", index: vidIdx, durationSec: allocDur, filePath: videoPaths[vidIdx], nativeDur });
      vidIdx++;
    } else if (imgIdx < imagePaths.length) {
      const dur = Math.min(IMG_MAX_DUR, Math.max(IMG_MIN_DUR, perSegment));
      segments.push({ type: "image", index: imgIdx, durationSec: dur, filePath: imagePaths[imgIdx], nativeDur: dur });
      imgIdx++;
    }
  }

  // Adjust durations so total matches target
  const rawTotal = segments.reduce((s, seg) => s + seg.durationSec, 0) - transitionOverlap;
  if (rawTotal > 0 && Math.abs(rawTotal - targetSec) > 1) {
    const scale = (targetSec + transitionOverlap) / (rawTotal + transitionOverlap);
    for (const seg of segments) {
      seg.durationSec = Math.max(seg.type === "image" ? IMG_MIN_DUR : seg.nativeDur, seg.durationSec * scale);
    }
  }

  // Compute absolute times
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    segments[i].startSec = cursor;
    segments[i].endSec = cursor + segments[i].durationSec;
    cursor += segments[i].durationSec - (i < segments.length - 1 ? TRANSITION_DUR : 0);
  }

  return { segments, totalDurationSec: cursor, transitionDurSec: TRANSITION_DUR };
}

// ── Ken Burns zoompan variants ──────────────────────────────────────────────

function kenBurnsFilter(index, frames, w, h) {
  const variant = index % 4;
  const common = `d=${frames}:s=${w}x${h}:fps=24`;
  switch (variant) {
    case 0: return `zoompan=z='min(zoom+0.0015,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${common}`;
    case 1: return `zoompan=z='if(eq(on,1),1.5,max(zoom-0.0015,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${common}`;
    case 2: return `zoompan=z='1.3':x='(iw-iw/zoom)*on/(${frames})':y='ih/2-(ih/zoom/2)':${common}`;
    case 3: return `zoompan=z='1.3':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/(${frames})':${common}`;
  }
}

// ── FFmpeg render pipeline ──────────────────────────────────────────────────

async function renderTimeline(plan, { style = "cinematic", caption = null, audioPath = null, tmpDir, lyricsAssPath = null, stretch = false }) {
  const { segments, totalDurationSec, transitionDurSec } = plan;
  const preset = plan.preset || PRESETS.short;
  const { w, h, fps, videoBitrateK } = preset;
  const colorFilter = STYLE_FILTERS[style] || STYLE_FILTERS.cinematic;
  // Intermediate segments use CRF 23; final uses bitrate cap if set, otherwise CRF 18 (high quality)
  const finalEncode = videoBitrateK > 0
    ? `-b:v ${videoBitrateK}k -maxrate ${Math.round(videoBitrateK * 1.5)}k -bufsize ${videoBitrateK * 2}k -preset fast`
    : "-crf 18 -preset fast";

  // Stage 1: Normalize + stretch each segment
  const normalizedPaths = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const outPath = `${tmpDir}/norm_${i}.mp4`;
    const effectIdx = pickEffect(i, style);
    const effectFilter = getEffectFilter(effectIdx, fps);

    if (seg.type === "video") {
      const strategy = stretchVideo(seg.filePath, outPath, seg.nativeDur, seg.durationSec, w, h, fps, colorFilter, effectFilter, tmpDir, i, stretch);
      console.log(`[video-editor] segment ${i + 1}/${segments.length} video: ${seg.nativeDur.toFixed(1)}s → ${seg.durationSec.toFixed(1)}s (${strategy}) fx=${effectIdx}`);
    } else {
      // Image → video with Ken Burns + effect
      const frames = Math.ceil(seg.durationSec * fps);
      const kb = kenBurnsFilter(seg.index, frames, w, h);
      const filters = [kb, colorFilter, effectFilter].filter(Boolean).join(",");
      ffmpegExec(`-y -loop 1 -i "${seg.filePath}" -vf "${filters}" -c:v libx264 -preset fast -crf 18 -t ${seg.durationSec} -an "${outPath}"`, `kenburns seg#${i}`);
      console.log(`[video-editor] segment ${i + 1}/${segments.length} image: ${seg.durationSec.toFixed(1)}s (kenburns-${seg.index % 4}) fx=${effectIdx}`);
    }
    normalizedPaths.push(outPath);
  }

  // Stage 2: Crossfade composition with varied transitions
  let composedPath;
  if (normalizedPaths.length === 1) {
    composedPath = normalizedPaths[0];
  } else {
    composedPath = `${tmpDir}/composed.mp4`;
    const durations = normalizedPaths.map(p => probeDuration(p));
    const inputs = normalizedPaths.map(p => `-i "${p}"`).join(" ");

    let filterComplex = "";
    let prevLabel = "[0:v]";
    let offset = durations[0] - transitionDurSec;
    for (let i = 1; i < normalizedPaths.length; i++) {
      const nextLabel = i < normalizedPaths.length - 1 ? `[v${i}]` : "[vout]";
      const trans = pickTransition(i);
      filterComplex += `${prevLabel}[${i}:v]xfade=transition=${trans}:duration=${transitionDurSec}:offset=${offset.toFixed(3)}${nextLabel};`;
      prevLabel = nextLabel;
      offset += durations[i] - transitionDurSec;
    }
    ffmpegExec(`-y ${inputs} -filter_complex "${filterComplex.replace(/;$/, "")}" -map "[vout]" -c:v libx264 ${finalEncode} "${composedPath}"`, "xfade-compose", COMPOSE_TIMEOUT);
    console.log(`[video-editor] ${normalizedPaths.length} segments crossfaded (varied transitions)`);
  }

  // Stage 3: Caption overlay via ASS subtitles
  let withTextPath = composedPath;
  if (caption) {
    withTextPath = `${tmpDir}/captioned.mp4`;
    const safeText = caption.replace(/[\\{}]/g, "").slice(0, 120);
    const assPath = `${tmpDir}/caption.ass`;
    const assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,20,20,${Math.floor(h * 0.1)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:04.00,Default,,0,0,0,,${safeText}
`;
    fs.writeFileSync(assPath, assContent);
    ffmpegExec(`-y -i "${composedPath}" -vf "ass=${assPath}" -c:v libx264 ${finalEncode} -an "${withTextPath}"`, "caption-overlay");
    console.log("[video-editor] caption overlay added (ASS)");
  }

  // Stage 4: Lyrics overlay (if transcribed)
  let withLyricsPath = withTextPath;
  if (lyricsAssPath && fs.existsSync(lyricsAssPath)) {
    withLyricsPath = `${tmpDir}/with_lyrics.mp4`;
    ffmpegExec(`-y -i "${withTextPath}" -vf "ass=${lyricsAssPath}" -c:v libx264 ${finalEncode} -an "${withLyricsPath}"`, "lyrics-overlay");
    console.log("[video-editor] lyrics overlay burned");
  }

  // Stage 5: Audio mix
  let finalPath;
  if (audioPath) {
    finalPath = `${tmpDir}/final.mp4`;
    ffmpegExec(`-y -i "${withLyricsPath}" -stream_loop -1 -i "${audioPath}" -map 0:v:0 -map 1:a:0 -shortest -c:v copy -c:a aac -b:a 192k "${finalPath}"`, "audio-mix");
    console.log("[video-editor] audio mixed");
  } else {
    finalPath = withLyricsPath;
  }

  // Size guard: re-encode if over 24MB (Discord bot limit)
  let finalSize = fs.statSync(finalPath).size;
  console.log(`[video-editor] final output: ${(finalSize / 1024 / 1024).toFixed(1)}MB`);
  if (finalSize > 24 * 1024 * 1024) {
    const shrunkPath = `${tmpDir}/shrunk.mp4`;
    const targetBitrate = Math.floor((22 * 8000) / totalDurationSec);
    console.log(`[video-editor] over 24MB, re-encoding at ${targetBitrate}k to fit Discord limit`);
    ffmpegExec(`-y -i "${finalPath}" -c:v libx264 -b:v ${targetBitrate}k -maxrate ${targetBitrate}k -bufsize ${targetBitrate * 2}k -preset fast -c:a copy "${shrunkPath}"`, "size-guard");
    finalPath = shrunkPath;
    finalSize = fs.statSync(finalPath).size;
    console.log(`[video-editor] shrunk to: ${(finalSize / 1024 / 1024).toFixed(1)}MB`);
  }

  return fs.readFileSync(finalPath);
}

// ── Choppy timeline (brainslop / ludicrous) ────────────────────────────────
// Instead of playing clips sequentially, chops source media into many short
// random segments from different starting points → hard-cut concat.

// eslint-disable-next-line complexity
function computeChoppyTimeline({ imagePaths, videoPaths, targetSec, style, beats = null }) {
  const cfg = CHOPPY_STYLES[style];
  if (!cfg) return null; // not a choppy style
  // Use real BPM from beat detection if available, else fallback to config
  const bpm = beats?.bpm || cfg.bpm;
  const beatSec = 60 / bpm;
  const numCuts = Math.round((targetSec / 60) * cfg.cutsPerMin);
  const videoDurations = videoPaths.map(p => probeDuration(p));
  console.log(`[video-editor] choppy: bpm=${bpm}${beats ? " (detected)" : " (default)"}, beatSec=${beatSec.toFixed(3)}s`);

  const sources = [
    ...videoPaths.map((p, i) => ({ type: "video", path: p, dur: videoDurations[i], index: i })),
    ...imagePaths.map((p, i) => ({ type: "image", path: p, dur: 999, index: i })),
  ];
  if (sources.length === 0) return { segments: [], totalDurationSec: 0, transitionDurSec: 0, choppy: true };

  const segments = [];
  let cursor = 0;

  // If we have real beat timestamps, snap cuts to them
  const realBeats = beats?.beatTimestamps?.filter(t => t < targetSec) || [];
  const useRealBeats = realBeats.length >= 4;

  if (useRealBeats) {
    // Build segments between detected beats, grouping minBeats-maxBeats together
    let beatIdx = 0;
    for (let i = 0; i < numCuts && beatIdx < realBeats.length - 1 && cursor < targetSec; i++) {
      const groupSize = cfg.minBeats + Math.floor(Math.random() * (cfg.maxBeats - cfg.minBeats + 1));
      const endBeatIdx = Math.min(beatIdx + groupSize, realBeats.length - 1);
      const segStart = realBeats[beatIdx];
      const segEnd = Math.min(realBeats[endBeatIdx], targetSec);
      const segDur = segEnd - segStart;
      if (segDur < 0.15) { beatIdx = endBeatIdx; continue; }

      const videoSources = sources.filter(s => s.type === "video");
      const pool = videoSources.length > 0 && Math.random() < 0.8 ? videoSources : sources;
      const src = pool[Math.floor(Math.random() * pool.length)];
      const reverse = style === "ludicrous" && Math.random() < 0.2;
      // Mark segments on energy peaks for effects
      const onPeak = beats.peaks?.some(p => p.time >= segStart && p.time < segEnd) || false;

      if (src.type === "video") {
        const maxStart = Math.max(0, src.dur - segDur - 0.1);
        const startAt = Math.random() * maxStart;
        segments.push({
          type: "video-slice", filePath: src.path,
          startAt, durationSec: segDur, reverse, onPeak,
          startSec: cursor, endSec: cursor + segDur, index: src.index,
        });
      } else {
        segments.push({
          type: "image", filePath: src.path,
          durationSec: segDur, reverse: false, onPeak,
          startSec: cursor, endSec: cursor + segDur, index: src.index,
        });
      }
      cursor += segDur;
      beatIdx = endBeatIdx;
    }
  } else {
    // Fallback: random beat-aligned durations (original behavior)
    for (let i = 0; i < numCuts && cursor < targetSec; i++) {
      const numBeats = cfg.minBeats + Math.floor(Math.random() * (cfg.maxBeats - cfg.minBeats + 1));
      const segDur = Math.min(numBeats * beatSec, targetSec - cursor);
      if (segDur < 0.2) break;

      const videoSources = sources.filter(s => s.type === "video");
      const pool = videoSources.length > 0 && Math.random() < 0.8 ? videoSources : sources;
      const src = pool[Math.floor(Math.random() * pool.length)];
      const reverse = style === "ludicrous" && Math.random() < 0.2;

      if (src.type === "video") {
        const maxStart = Math.max(0, src.dur - segDur - 0.1);
        const startAt = Math.random() * maxStart;
        segments.push({
          type: "video-slice", filePath: src.path,
          startAt, durationSec: segDur, reverse,
          startSec: cursor, endSec: cursor + segDur, index: src.index,
        });
      } else {
        segments.push({
          type: "image", filePath: src.path,
          durationSec: segDur, reverse: false,
          startSec: cursor, endSec: cursor + segDur, index: src.index,
        });
      }
      cursor += segDur;
    }
  }

  // Distribute onPeak effects evenly throughout the video.
  // Audio peaks may cluster (e.g. intro drop), causing effects only at the start.
  // Ensure at least 1 peak effect every 3-4 segments for visual rhythm throughout.
  const peakCount = segments.filter(s => s.onPeak).length;
  const desiredPeaks = Math.max(3, Math.ceil(segments.length / 3.5));
  if (peakCount < desiredPeaks && segments.length > 2) {
    // Space peaks evenly through the timeline
    const spacing = Math.max(2, Math.floor(segments.length / desiredPeaks));
    for (let i = 0; i < segments.length; i++) {
      segments[i].onPeak = (i % spacing === Math.floor(spacing / 2)); // offset by half so first peak isn't seg 0
    }
    console.log(`[video-editor] redistributed peaks: ${segments.filter(s => s.onPeak).length} effects across ${segments.length} segments (was ${peakCount})`);
  }

  console.log(`[video-editor] choppy timeline (${style}): ${segments.length} cuts, ${cursor.toFixed(1)}s, bpm=${bpm}${useRealBeats ? " (beat-synced)" : ""}`);
  return { segments, totalDurationSec: cursor, transitionDurSec: 0, choppy: true };
}

// Render a choppy timeline: normalize each slice then hard-cut concat (no xfade)
async function renderChoppyTimeline(plan, { style, caption, audioPath, tmpDir, lyricsAssPath = null, stretch = false }) {
  const preset = plan.preset || PRESETS.short;
  const { w, h, fps, videoBitrateK } = preset;
  const colorFilter = STYLE_FILTERS[style] || STYLE_FILTERS.cinematic;
  const { segments, totalDurationSec } = plan;
  const finalEncode = videoBitrateK > 0
    ? `-b:v ${videoBitrateK}k -maxrate ${Math.round(videoBitrateK * 1.5)}k -bufsize ${videoBitrateK * 2}k -preset fast`
    : "-crf 18 -preset fast";
  const scaleFilter = buildScaleFilter(w, h, fps, stretch);

  // Stage 1: Extract each slice as a normalized mp4
  const slicePaths = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const outPath = `${tmpDir}/slice_${i}.mp4`;

    // Beat-reactive effects: on peak segments add CCD flash + per-segment effect
    const effectIdx = pickEffect(i, style);
    const effectFilter = getEffectFilter(effectIdx, fps);
    const peakFlash = seg.onPeak ? ",eq=brightness='0.4*max(0,1-t*6)'" : "";

    if (seg.type === "video-slice") {
      const extras = [colorFilter, effectFilter, peakFlash.replace(/^,/, "")].filter(Boolean).join(",");
      const vf = extras ? `${scaleFilter},${extras}` : scaleFilter;
      const seekArg = seg.startAt > 0.1 ? `-ss ${seg.startAt.toFixed(3)}` : "";
      ffmpegExec(`-y ${seekArg} -i "${seg.filePath}" -t ${seg.durationSec.toFixed(3)} -vf "${vf}" -c:v libx264 -crf 23 -preset fast -an "${outPath}"`, `slice seg#${i} fx=${effectIdx}`);
      if (seg.reverse) {
        const revPath = `${tmpDir}/slice_rev_${i}.mp4`;
        ffmpegExec(`-y -i "${outPath}" -vf "reverse" -c:v libx264 -crf 23 -preset fast -an "${revPath}"`, `reverse seg#${i}`);
        fs.unlinkSync(outPath);
        fs.renameSync(revPath, outPath);
      }
    } else {
      // Image: fast Ken Burns or static — with per-segment effect + flash on peaks
      const frames = Math.ceil(seg.durationSec * fps);
      const kb = kenBurnsFilter(i, frames, w, h);
      const extras = [colorFilter, effectFilter, peakFlash.replace(/^,/, "")].filter(Boolean).join(",");
      const filters = extras ? `${kb},${extras}` : kb;
      ffmpegExec(`-y -loop 1 -i "${seg.filePath}" -vf "${filters}" -c:v libx264 -crf 23 -preset fast -t ${seg.durationSec.toFixed(3)} -an "${outPath}"`, `img-slice seg#${i} fx=${effectIdx}`);
    }
    slicePaths.push(outPath);
  }

  console.log(`[video-editor] ${slicePaths.length} slices normalized`);

  // Stage 2: Hard-cut concat (no transitions — that's the jumpcut feel)
  let composedPath;
  if (slicePaths.length === 1) {
    composedPath = slicePaths[0];
  } else {
    composedPath = `${tmpDir}/composed.mp4`;
    const listPath = `${tmpDir}/concat_list.txt`;
    fs.writeFileSync(listPath, slicePaths.map(p => `file '${p}'`).join("\n") + "\n");
    ffmpegExec(`-y -f concat -safe 0 -i "${listPath}" -c:v libx264 ${finalEncode} "${composedPath}"`, "choppy-concat", COMPOSE_TIMEOUT);
    console.log(`[video-editor] ${slicePaths.length} slices hard-cut concatenated`);
  }

  // Stage 3: Caption
  let withTextPath = composedPath;
  if (caption) {
    withTextPath = `${tmpDir}/captioned.mp4`;
    const safeText = caption.replace(/[\\{}]/g, "").slice(0, 120);
    const assPath = `${tmpDir}/caption.ass`;
    const assContent = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,20,20,${Math.floor(h * 0.1)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:04.00,Default,,0,0,0,,${safeText}\n`;
    fs.writeFileSync(assPath, assContent);
    ffmpegExec(`-y -i "${composedPath}" -vf "ass=${assPath}" -c:v libx264 ${finalEncode} -an "${withTextPath}"`, "choppy-caption");
  }

  // Stage 4: Lyrics overlay
  let withLyricsPath = withTextPath;
  if (lyricsAssPath && fs.existsSync(lyricsAssPath)) {
    withLyricsPath = `${tmpDir}/with_lyrics.mp4`;
    ffmpegExec(`-y -i "${withTextPath}" -vf "ass=${lyricsAssPath}" -c:v libx264 ${finalEncode} -an "${withLyricsPath}"`, "choppy-lyrics");
    console.log("[video-editor] lyrics overlay burned");
  }

  // Stage 5: Audio
  let finalPath;
  if (audioPath) {
    finalPath = `${tmpDir}/final.mp4`;
    ffmpegExec(`-y -i "${withLyricsPath}" -stream_loop -1 -i "${audioPath}" -map 0:v:0 -map 1:a:0 -shortest -c:v copy -c:a aac -b:a 192k "${finalPath}"`, "choppy-audio");
    console.log("[video-editor] audio mixed");
  } else {
    finalPath = withLyricsPath;
  }

  // Size guard
  let finalSize = fs.statSync(finalPath).size;
  console.log(`[video-editor] final output: ${(finalSize / 1024 / 1024).toFixed(1)}MB`);
  if (finalSize > 24 * 1024 * 1024) {
    const shrunkPath = `${tmpDir}/shrunk.mp4`;
    const targetBitrate = Math.floor((22 * 8000) / totalDurationSec);
    console.log(`[video-editor] over 24MB, re-encoding at ${targetBitrate}k`);
    ffmpegExec(`-y -i "${finalPath}" -c:v libx264 -b:v ${targetBitrate}k -maxrate ${targetBitrate}k -bufsize ${targetBitrate * 2}k -preset fast -c:a copy "${shrunkPath}"`, "choppy-size-guard");
    finalPath = shrunkPath;
    finalSize = fs.statSync(finalPath).size;
    console.log(`[video-editor] shrunk to: ${(finalSize / 1024 / 1024).toFixed(1)}MB`);
  }

  return fs.readFileSync(finalPath);
}

// ── Main export ─────────────────────────────────────────────────────────────

// eslint-disable-next-line complexity
async function editVideo({ images = [], videos = [], audioBuffer = null, preset = "short", style = "cinematic", caption = null, lyrics = false, lyricsStyle = "karaoke", resolution, customAr, autoAspect = false, stretch = false }) {
  let effectivePreset = preset;

  // Auto aspect ratio: detect source media orientation and switch preset if needed
  if (autoAspect && videos.length > 0) {
    // Write video buffers to temp files for probing
    const probeTmp = `/tmp/nemoclaw-probe-${Date.now()}`;
    fs.mkdirSync(probeTmp, { recursive: true });
    try {
      const { getMediaDimensions } = require("./ffmpeg-utils");
      const probePaths = videos.map((buf, i) => {
        const p = `${probeTmp}/probe_${i}.mp4`;
        fs.writeFileSync(p, buf);
        return p;
      });
      const detected = detectAspectRatio(probePaths, getMediaDimensions);
      if (detected) {
        effectivePreset = adjustPresetForAspect(effectivePreset, detected);
        if (effectivePreset !== preset) console.log(`[video-editor] auto-aspect: ${preset} → ${effectivePreset} (detected ${detected})`);
      }
    } catch (e) { console.warn(`[video-editor] auto-aspect detection failed:`, e.message); }
    finally { try { fs.rmSync(probeTmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  }

  const presetCfg = resolvePreset(effectivePreset, resolution, customAr);
  const ts = Date.now();
  const tmpDir = `/tmp/nemoclaw-edit-${ts}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Downscale images to ~2x target resolution (zoompan on big images is brutal)
    const maxImgDim = Math.max(presetCfg.w, presetCfg.h) * 2;
    const imagePaths = images.map((buf, i) => {
      const raw = `${tmpDir}/img_raw_${i}.png`;
      const scaled = `${tmpDir}/img_${i}.png`;
      fs.writeFileSync(raw, buf);
      return downscaleImage(raw, maxImgDim, scaled);
    });
    const videoPaths = videos.map((buf, i) => {
      const p = `${tmpDir}/vid_${i}.mp4`;
      fs.writeFileSync(p, buf);
      return p;
    });
    let audioPath = null;
    if (audioBuffer) {
      audioPath = `${tmpDir}/audio.mp3`;
      fs.writeFileSync(audioPath, audioBuffer);
    }

    // Smart audio offset: skip intro when video is shorter than song.
    // Transcribe first to find vocal onset, then trim audio so the video
    // starts where the vocals are instead of wasting time on an intro.
    let audioOffset = 0;
    let transcript = null;
    let lyricsAssPath = null;

    if (lyrics && audioPath) {
      try {
        const { transcribeAudio, generateLyricCaptions } = require("./lyrics-captions");
        transcript = await transcribeAudio(audioPath);
        const audioDur = transcript.duration || 0;
        const firstWord = transcript.words?.[0];

        // If video is shorter than audio and vocals start late, skip the intro
        if (firstWord && firstWord.start > 2.5 && presetCfg.targetSec < audioDur * 0.8) {
          audioOffset = Math.max(0, firstWord.start - 1.0);
          console.log(`[video-editor] audio offset: skipping ${audioOffset.toFixed(1)}s intro (vocals at ${firstWord.start.toFixed(1)}s, video=${presetCfg.targetSec}s, song=${audioDur.toFixed(1)}s)`);

          // Trim audio to start at offset
          const trimmedPath = `${tmpDir}/audio_trimmed.mp3`;
          ffmpegExec(`-y -ss ${audioOffset.toFixed(3)} -i "${audioPath}" -c copy "${trimmedPath}"`, "trim-audio-intro");
          audioPath = trimmedPath;

          // Shift transcript timestamps
          for (const w of transcript.words) { w.start -= audioOffset; w.end -= audioOffset; }
          for (const s of transcript.segments) { s.start -= audioOffset; s.end -= audioOffset; }
          transcript.words = transcript.words.filter(w => w.start >= 0);
          transcript.segments = transcript.segments.filter(s => s.start >= 0);
        }

        lyricsAssPath = generateLyricCaptions(transcript, {
          width: presetCfg.w, height: presetCfg.h, style: lyricsStyle,
          outputPath: `${tmpDir}/lyrics.ass`,
        });
        console.log(`[video-editor] lyrics: ${transcript.words.length} words, style=${lyricsStyle}`);
      } catch (e) {
        console.warn("[video-editor] lyrics transcription failed:", e.message);
      }
    }

    // Beat detection on (possibly trimmed) audio
    let beats = null;
    if (audioPath) {
      try {
        const { detectBeats } = require("./beat-detect");
        beats = await detectBeats(audioPath);
      } catch (e) {
        console.warn("[video-editor] beat detection failed, using defaults:", e.message);
      }
    }

    // Choppy styles (brainslop, ludicrous) use jumpcut timeline
    const choppyPlan = computeChoppyTimeline({ imagePaths, videoPaths, targetSec: presetCfg.targetSec, style, beats });
    const plan = choppyPlan || computeTimeline({ imagePaths, videoPaths, targetSec: presetCfg.targetSec });
    if (beats) plan.beats = beats;
    plan.preset = presetCfg;
    console.log(`[video-editor] timeline: ${plan.segments.length} segments, ${plan.totalDurationSec.toFixed(1)}s target=${presetCfg.targetSec}s${plan.choppy ? " (choppy)" : ""}`);

    const videoBuffer = plan.choppy
      ? await renderChoppyTimeline(plan, { style, caption, audioPath, tmpDir, lyricsAssPath, stretch })
      : await renderTimeline(plan, { style, caption, audioPath, tmpDir, lyricsAssPath, stretch });
    const sizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
    console.log(`[video-editor] render complete: ${sizeMB}MB`);

    return { videoBuffer, totalDurationSec: plan.totalDurationSec };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
}

module.exports = { editVideo, computeTimeline, computeChoppyTimeline, renderTimeline, renderChoppyTimeline, PRESETS, STYLE_FILTERS, CHOPPY_STYLES, FFMPEG_BIN, FFPROBE_BIN };
// Re-export beat-detect for convenience
try { Object.assign(module.exports, require("./beat-detect")); } catch (_e) { /* ignore */ }
