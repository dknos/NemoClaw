// CapCut Mate API client — wraps localhost:30000/openapi/capcut-mate/v1
// All times in MICROSECONDS (1 second = 1_000_000).
// Info endpoints return JSON *strings* that feed directly into add_* endpoints.

const CAPCUT_BASE = process.env.CAPCUT_API_BASE || "http://localhost:30000/openapi/capcut-mate/v1";

async function capcutPost(endpoint, body) {
  const res = await fetch(`${CAPCUT_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`CapCut ${endpoint}: ${json.message || "unknown error"}`);
  return json;
}

// ── Draft lifecycle ─────────────────────────────────────────────────────────

async function createDraft(width = 1280, height = 720) {
  const r = await capcutPost("/create_draft", { width, height });
  return { draftUrl: r.draft_url };
}

async function saveDraft(draftUrl) {
  const r = await capcutPost("/save_draft", { draft_url: draftUrl });
  return { draftUrl: r.draft_url };
}

// ── Timeline helper ──────────────────────────────��──────────────────────────

async function getTimelines(durationUs, num, start = 0, type = 0) {
  const r = await capcutPost("/timelines", { duration: durationUs, num, start, type });
  return r.timelines; // [{start, end}, ...]
}

// ── Info builders (return JSON strings for add_* endpoints) ─────────────────

async function videoInfos({ videoUrls, timelines, transition = null, transitionDuration = null, volume = 1.0, width = null, height = null }) {
  const body = { video_urls: videoUrls, timelines };
  if (transition) body.transition = transition;
  if (transitionDuration != null) body.transition_duration = transitionDuration;
  if (volume != null) body.volume = volume;
  if (width) body.width = width;
  if (height) body.height = height;
  const r = await capcutPost("/video_infos", body);
  return r.infos; // JSON string
}

// eslint-disable-next-line complexity
async function imgsInfos({ imgs, timelines, width = null, height = null, inAnimation = null, inAnimationDuration = null, outAnimation = null, outAnimationDuration = null, loopAnimation = null, loopAnimationDuration = null, transition = null, transitionDuration = null }) {
  const body = { imgs, timelines };
  if (width) body.width = width;
  if (height) body.height = height;
  if (inAnimation) body.in_animation = inAnimation;
  if (inAnimationDuration != null) body.in_animation_duration = inAnimationDuration;
  if (outAnimation) body.out_animation = outAnimation;
  if (outAnimationDuration != null) body.out_animation_duration = outAnimationDuration;
  if (loopAnimation) body.loop_animation = loopAnimation;
  if (loopAnimationDuration != null) body.loop_animation_duration = loopAnimationDuration;
  if (transition) body.transition = transition;
  if (transitionDuration != null) body.transition_duration = transitionDuration;
  const r = await capcutPost("/imgs_infos", body);
  return r.infos;
}

async function audioInfos({ mp3Urls, timelines, volume = null }) {
  const body = { mp3_urls: mp3Urls, timelines };
  if (volume != null) body.volume = volume;
  const r = await capcutPost("/audio_infos", body);
  return r.infos;
}

// ── Track adders ────────────────────────────────────────────────────────────

async function addVideos(draftUrl, videoInfosStr, opts = {}) {
  const body = { draft_url: draftUrl, video_infos: videoInfosStr };
  if (opts.scaleX) body.scale_x = opts.scaleX;
  if (opts.scaleY) body.scale_y = opts.scaleY;
  const r = await capcutPost("/add_videos", body);
  return { draftUrl: r.draft_url, trackId: r.track_id, videoIds: r.video_ids, segmentIds: r.segment_ids };
}

async function addImages(draftUrl, imageInfosStr, opts = {}) {
  const body = { draft_url: draftUrl, image_infos: imageInfosStr };
  if (opts.alpha != null) body.alpha = opts.alpha;
  if (opts.scaleX) body.scale_x = opts.scaleX;
  if (opts.scaleY) body.scale_y = opts.scaleY;
  const r = await capcutPost("/add_images", body);
  return { draftUrl: r.draft_url, trackId: r.track_id, imageIds: r.image_ids, segmentIds: r.segment_ids };
}

async function addAudios(draftUrl, audioInfosStr) {
  const body = { draft_url: draftUrl, audio_infos: audioInfosStr };
  const r = await capcutPost("/add_audios", body);
  return { draftUrl: r.draft_url, trackId: r.track_id, audioIds: r.audio_ids };
}

async function addCaptions(draftUrl, captionsStr, opts = {}) {
  const body = { draft_url: draftUrl, captions: captionsStr };
  if (opts.textColor) body.text_color = opts.textColor;
  if (opts.fontSize) body.font_size = opts.fontSize;
  if (opts.bold != null) body.bold = opts.bold;
  if (opts.borderColor) body.border_color = opts.borderColor;
  if (opts.textEffect) body.text_effect = opts.textEffect;
  if (opts.transformY != null) body.transform_y = opts.transformY;
  const r = await capcutPost("/add_captions", body);
  return { draftUrl: r.draft_url, trackId: r.track_id, textIds: r.text_ids, segmentIds: r.segment_ids };
}

async function addEffects(draftUrl, effectInfosStr) {
  const body = { draft_url: draftUrl, effect_infos: effectInfosStr };
  const r = await capcutPost("/add_effects", body);
  return { draftUrl: r.draft_url, trackId: r.track_id, effectIds: r.effect_ids };
}

async function addFilters(draftUrl, filterInfosStr) {
  const body = { draft_url: draftUrl, filter_infos: filterInfosStr };
  const r = await capcutPost("/add_filters", body);
  return { draftUrl: r.draft_url, trackId: r.track_id, filterIds: r.filter_ids };
}

// ── Catalog queries ───────────────────────────��─────────────────────────────

async function getEffects(mode = 2) {
  const r = await capcutPost("/get_effects", { mode });
  return r.effects;
}

async function getFilters(mode = 2) {
  const r = await capcutPost("/get_filters", { mode });
  return r.filters;
}

async function getImageAnimations(type = "in", mode = 2) {
  const r = await capcutPost("/get_image_animations", { type, mode });
  return r.effects;
}

async function getTextAnimations(type = "in", mode = 2) {
  const r = await capcutPost("/get_text_animations", { type, mode });
  return r.effects;
}

async function getAudioDuration(mp3Url) {
  const r = await capcutPost("/get_audio_duration", { mp3_url: mp3Url });
  return r.duration; // microseconds
}

// ── Beat-synced CapCut draft creation ────────────────────────────────────────
// Creates a CapCut draft with cuts aligned to detected beats.
// Requires beat-detect.js for audio analysis.

// eslint-disable-next-line complexity
async function createBeatSyncedDraft({
  audioUrl,        // URL to mp3 (accessible from CapCut container)
  audioPath,       // Local path to mp3 (for beat detection)
  videoUrls = [],  // Video clip URLs
  imageUrls = [],  // Image URLs
  width = 720,
  height = 1280,
  caption = null,
  transition = "fade_black",
  transitionDuration = 200000, // 0.2s in microseconds
  minBeats = 1,
  maxBeats = 4,
}) {
  const { detectBeats, beatTimelinesUs } = require("./beat-detect");

  // 1. Detect beats
  const beats = await detectBeats(audioPath);
  const totalUs = Math.round(beats.durationSec * 1_000_000);

  // 2. Create draft
  const { draftUrl } = await createDraft(width, height);

  // 3. Build beat-synced timelines for media
  const mediaCount = videoUrls.length + imageUrls.length;
  if (mediaCount === 0) throw new Error("Need at least one video or image URL");

  const targetSec = beats.durationSec;
  const timelines = beatTimelinesUs(beats, { targetSec, minBeats, maxBeats });

  // 4. Add videos on beat timelines
  let result = { draftUrl };
  if (videoUrls.length > 0) {
    // Distribute timelines across videos (round-robin)
    const vidTimelines = timelines.filter((_, i) => i % mediaCount < videoUrls.length);
    if (vidTimelines.length > 0) {
      const infos = await videoInfos({
        videoUrls, timelines: vidTimelines,
        transition, transitionDuration, width, height,
      });
      result = await addVideos(result.draftUrl, infos);
    }
  }

  // 5. Add images on remaining beat timelines
  if (imageUrls.length > 0) {
    const imgTimelines = timelines.filter((_, i) => i % mediaCount >= videoUrls.length);
    if (imgTimelines.length > 0) {
      const infos = await imgsInfos({
        imgs: imageUrls, timelines: imgTimelines,
        width, height, transition, transitionDuration,
        inAnimation: "zoom_in", inAnimationDuration: 500000,
      });
      result = await addImages(result.draftUrl, infos);
    }
  }

  // 6. Add audio
  const audioTimeline = [{ start: 0, end: totalUs }];
  const audioStr = await audioInfos({ mp3Urls: [audioUrl], timelines: audioTimeline, volume: 1.0 });
  result = await addAudios(result.draftUrl, audioStr);

  // 7. Add caption if provided
  if (caption) {
    const captionInfoStr = await capcutPost("/caption_infos", {
      texts: [caption],
      timelines: [{ start: 0, end: Math.min(4_000_000, totalUs) }],
    });
    result = await addCaptions(result.draftUrl, captionInfoStr.infos, {
      fontSize: 48, bold: true, textColor: "#FFFFFF",
      borderColor: "#000000", transformY: -0.35,
    });
  }

  // 8. Add flash effects on energy peaks
  if (beats.peaks && beats.peaks.length > 0) {
    try {
      const effects = await getEffects();
      const flashEffect = effects?.find(e => e.name?.toLowerCase().includes("flash")) || effects?.[0];
      if (flashEffect) {
        const peakTimelines = beats.peaks.slice(0, 10).map(p => ({
          start: Math.round(p.time * 1_000_000),
          end: Math.round((p.time + 0.3) * 1_000_000),
        }));
        const effectStr = await capcutPost("/effect_infos", {
          effects: [flashEffect.name || flashEffect.title || "CCD闪光"],
          timelines: peakTimelines,
        });
        if (effectStr.infos) {
          await addEffects(result.draftUrl, effectStr.infos);
        }
      }
    } catch (e) {
      console.warn("[capcut] could not add peak effects:", e.message);
    }
  }

  // 9. Save
  await saveDraft(result.draftUrl);

  return {
    draftUrl: result.draftUrl,
    beats,
    timelineCount: timelines.length,
    peakCount: beats.peaks?.length || 0,
  };
}

module.exports = {
  capcutPost,
  createDraft, saveDraft,
  getTimelines,
  videoInfos, imgsInfos, audioInfos,
  addVideos, addImages, addAudios, addCaptions, addEffects, addFilters,
  getEffects, getFilters, getImageAnimations, getTextAnimations, getAudioDuration,
  createBeatSyncedDraft,
  CAPCUT_BASE,
};
