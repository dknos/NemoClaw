// Lyrics/caption engine — Whisper transcription + FFmpeg/CapCut integration.
// Transcribes audio, generates word-timed captions, and syncs effects to lyrics.
//
// Usage:
//   const { transcribeAudio, generateLyricCaptions, addLyricEffects } = require("./lyrics-captions");
//   const transcript = await transcribeAudio("/tmp/song.mp3");
//   const assPath = generateLyricCaptions(transcript, { width: 1080, height: 1920, style: "karaoke" });

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const WHISPER_SCRIPT = path.join(__dirname, "whisper-transcribe.py");

/**
 * Transcribe audio using faster-whisper.
 * @param {string} audioPath - Path to audio file
 * @param {object} opts - { model: "base", timeout: 120000 }
 * @returns {{ language, duration, segments: [{start, end, text}], words: [{word, start, end, probability}] }}
 */
async function transcribeAudio(audioPath, opts = {}) {
  const { model = "base", timeout = 120000 } = opts;
  console.log(`[lyrics] transcribing: ${path.basename(audioPath)} (model: ${model})`);

  const result = execSync(
    `python3 "${WHISPER_SCRIPT}" "${audioPath}" ${model}`,
    { encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
  );

  const transcript = JSON.parse(result);
  console.log(`[lyrics] ${transcript.words.length} words, ${transcript.segments.length} segments, lang=${transcript.language}`);
  return transcript;
}

// ── Caption Styles ──────────────────────────────────────────────────────────

const CAPTION_STYLES = {
  // Karaoke: word-by-word highlight, big bold text bottom center
  karaoke: {
    fontName: "Arial",
    fontSize: 58,
    primaryColor: "&H00FFFFFF",    // white
    highlightColor: "&H0000F5FF",  // electric teal (#00F5D4 in BGR)
    outlineColor: "&H00000000",
    backColor: "&H80000000",
    bold: true,
    outline: 3,
    shadow: 2,
    alignment: 2, // bottom center
    marginV: 80,
    wordsPerLine: 5,
  },
  // Subtitles: standard subtitle look
  subtitles: {
    fontName: "Arial",
    fontSize: 42,
    primaryColor: "&H00FFFFFF",
    highlightColor: null,
    outlineColor: "&H00000000",
    backColor: "&H80000000",
    bold: false,
    outline: 2,
    shadow: 1,
    alignment: 2,
    marginV: 60,
    wordsPerLine: 8,
  },
  // Viral: large centered, one word at a time
  viral: {
    fontName: "Impact",
    fontSize: 72,
    primaryColor: "&H00FFFFFF",
    highlightColor: "&H000080FF",  // orange
    outlineColor: "&H00000000",
    backColor: "&H00000000",
    bold: true,
    outline: 4,
    shadow: 0,
    alignment: 5, // center
    marginV: 0,
    wordsPerLine: 2,
  },
};

/**
 * Generate an ASS subtitle file from transcript with word-level timing.
 * @param {object} transcript - Output from transcribeAudio
 * @param {object} opts - { width, height, style: "karaoke"|"subtitles"|"viral", outputPath }
 * @returns {string} Path to generated .ass file
 */
function generateLyricCaptions(transcript, opts = {}) {
  const {
    width = 1080, height = 1920,
    style = "karaoke",
    outputPath = `/tmp/lyrics-${Date.now()}.ass`,
  } = opts;

  const cfg = CAPTION_STYLES[style] || CAPTION_STYLES.karaoke;
  const words = transcript.words || [];
  if (words.length === 0) {
    console.warn("[lyrics] no words in transcript, generating from segments");
    // Fall back to segment-level timing
    for (const seg of transcript.segments || []) {
      words.push({ word: seg.text, start: seg.start, end: seg.end, probability: 1 });
    }
  }

  // ASS header
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${cfg.fontName},${cfg.fontSize},${cfg.primaryColor},${cfg.highlightColor || cfg.primaryColor},${cfg.outlineColor},${cfg.backColor},${cfg.bold ? -1 : 0},0,0,0,100,100,0,0,1,${cfg.outline},${cfg.shadow},${cfg.alignment},20,20,${cfg.marginV},1
${cfg.highlightColor ? `Style: Highlight,${cfg.fontName},${Math.round(cfg.fontSize * 1.1)},${cfg.highlightColor},${cfg.primaryColor},${cfg.outlineColor},${cfg.backColor},${cfg.bold ? -1 : 0},0,0,0,100,100,0,0,1,${cfg.outline + 1},${cfg.shadow},${cfg.alignment},20,20,${cfg.marginV},1` : ""}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Group words into lines
  const lines = [];
  let lineWords = [];
  for (const w of words) {
    lineWords.push(w);
    if (lineWords.length >= cfg.wordsPerLine || w.word.endsWith(".") || w.word.endsWith("?") || w.word.endsWith("!") || w.word.endsWith(",")) {
      lines.push([...lineWords]);
      lineWords = [];
    }
  }
  if (lineWords.length > 0) lines.push(lineWords);

  // Generate dialogue events
  const events = [];
  for (const line of lines) {
    const start = line[0].start;
    const end = line[line.length - 1].end;

    if (style === "karaoke" && cfg.highlightColor) {
      // Karaoke: use \k tags for word-by-word highlight
      let karaText = "";
      for (let i = 0; i < line.length; i++) {
        const w = line[i];
        const dur = Math.round((w.end - w.start) * 100); // centiseconds
        karaText += `{\\kf${dur}}${w.word} `;
      }
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${karaText.trim()}`);
    } else if (style === "viral") {
      // Viral: each word gets its own event, centered
      for (const w of line) {
        const text = w.word.toUpperCase();
        events.push(`Dialogue: 0,${assTime(w.start)},${assTime(w.end)},Default,,0,0,0,,{\\fscx120\\fscy120\\t(0,50,\\fscx100\\fscy100)}${text}`);
      }
    } else {
      // Subtitles: whole line
      const text = line.map(w => w.word).join(" ");
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
    }
  }

  const ass = header + events.join("\n") + "\n";
  fs.writeFileSync(outputPath, ass);
  console.log(`[lyrics] generated ${style} captions: ${events.length} events → ${outputPath}`);
  return outputPath;
}

/**
 * Format seconds to ASS timestamp: H:MM:SS.cc
 */
function assTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Generate lyric-synced effects list for CapCut or FFmpeg.
 * Returns effects that should fire on specific words/phrases.
 * @param {object} transcript
 * @param {object} opts - { effectWords: ["drop", "fire", "boom"], effectType: "flash" }
 */
function lyricEffectTimestamps(transcript, opts = {}) {
  const {
    effectWords = ["drop", "fire", "boom", "bang", "break", "hit", "bass", "yeah", "go", "woah", "oh"],
    minGap = 2.0, // minimum seconds between effects
  } = opts;

  const triggers = [];
  let lastTrigger = -Infinity;

  for (const w of transcript.words || []) {
    const lower = w.word.toLowerCase().replace(/[^a-z]/g, "");
    if (effectWords.some(ew => lower.includes(ew)) && w.start - lastTrigger >= minGap) {
      triggers.push({ time: w.start, word: w.word, duration: Math.max(0.3, w.end - w.start) });
      lastTrigger = w.start;
    }
  }

  console.log(`[lyrics] found ${triggers.length} effect trigger words`);
  return triggers;
}

/**
 * Add lyric captions to CapCut draft.
 */
async function addLyricsToCapcutDraft(draftUrl, transcript, opts = {}) {
  const capcut = require("./capcut-client");

  const words = transcript.words || [];
  if (words.length === 0) return draftUrl;

  // Group into lines of ~5 words
  const lines = [];
  for (let i = 0; i < words.length; i += 5) {
    const chunk = words.slice(i, i + 5);
    lines.push({
      text: chunk.map(w => w.word).join(" "),
      start: Math.round(chunk[0].start * 1_000_000),
      end: Math.round(chunk[chunk.length - 1].end * 1_000_000),
    });
  }

  const captionInfoStr = await capcut.capcutPost("/caption_infos", { captions: lines });
  const result = await capcut.addCaptions(draftUrl, captionInfoStr.infos, {
    fontSize: opts.fontSize || 48,
    bold: true,
    textColor: opts.textColor || "#FFFFFF",
    borderColor: "#000000",
    transformY: opts.transformY || -0.35,
    ...(opts.textEffect ? { textEffect: opts.textEffect } : {}),
  });

  console.log(`[lyrics] added ${lines.length} caption lines to CapCut draft`);
  return result.draftUrl;
}

module.exports = {
  transcribeAudio,
  generateLyricCaptions,
  lyricEffectTimestamps,
  addLyricsToCapcutDraft,
  CAPTION_STYLES,
};
