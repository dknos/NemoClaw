#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# stream-headless.sh — Stream a localhost page to YouTube via isolated Chromium + FFmpeg
#
# Usage:
#   ./stream-headless.sh [options]
#
# Options:
#   --url URL           Page to stream (default: http://localhost:3001/weirdbox-lab.html)
#   --duration SECS     Auto-stop after N seconds (default: 7200 = 2hr)
#   --res WxH           Resolution (default: 1280x720)
#   --fps N             Frame rate (default: 30)
#   --bitrate KBPS      Video bitrate in kbps (default: 3000)
#   --music FILE        Single audio file, loops forever
#   --playlist FILE     Text file with one song path per line — plays through then loops
#   --music-volume N    Volume 0.0–1.0 (default: 0.4)
#
# Playlist file format (~/.nemoclaw/source/scripts/stream-playlist.txt):
#   /mnt/c/Users/rneeb/Downloads/EPIPHANY_KLICKAUD (1).mp3
#   /mnt/c/Users/rneeb/Music/another-track.mp3
#
# Requires:
#   - xvfb (sudo apt-get install -y xvfb)
#   - ffmpeg (~/.local/bin/ffmpeg — already installed)
#   - YOUTUBE_STREAM_KEY in ~/.nemoclaw_env
#
# Security notes:
#   - Chromium launches with --incognito and a throwaway --user-data-dir
#   - Your real browser profile, history, and cookies are NEVER touched
#   - Stream key is read from env file, never echoed to terminal or logs
#   - No inbound connections — purely outbound RTMP

set -euo pipefail

# ── Paths ─────────────────────────────────────────────────────────────────────
CHROMIUM_BIN="$HOME/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
FFMPEG_BIN="${FFMPEG_BIN:-/usr/bin/ffmpeg}"
ENV_FILE="$HOME/.nemoclaw_env"
LIVE_JSON_WB="$HOME/netify-dev/public/data/weirdbox-lab-live.json"
LIVE_JSON_MP="$HOME/netify-dev/public/data/mindpipes-live.json"

# ── Defaults ──────────────────────────────────────────────────────────────────
STREAM_URL="http://localhost:3001/workshop"
DURATION=7200
RES="1280x720"
FPS=20
BITRATE=3000
MUSIC_FILE=""     # single audio file, loops forever
MUSIC_PLAYLIST="" # text file with one song path per line
MUSIC_VOLUME=0.4  # 0.0 to 1.0

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --url)
      STREAM_URL="$2"
      shift 2
      ;;
    --duration)
      DURATION="$2"
      shift 2
      ;;
    --res)
      RES="$2"
      shift 2
      ;;
    --fps)
      FPS="$2"
      shift 2
      ;;
    --bitrate)
      BITRATE="$2"
      shift 2
      ;;
    --music)
      MUSIC_FILE="$2"
      shift 2
      ;;
    --playlist)
      MUSIC_PLAYLIST="$2"
      shift 2
      ;;
    --music-volume)
      MUSIC_VOLUME="$2"
      shift 2
      ;;
    *)
      echo "[stream] unknown arg: $1"
      exit 1
      ;;
  esac
done

WIDTH="${RES%%x*}"
HEIGHT="${RES##*x}"
BUFSIZE=$((BITRATE * 2))
GOP=$((FPS * 2))
DISPLAY_NUM=":99"

# ── Preflight checks ──────────────────────────────────────────────────────────
if [[ ! -x "$CHROMIUM_BIN" ]]; then
  echo "[stream] ERROR: Chromium not found at $CHROMIUM_BIN"
  exit 1
fi

if [[ ! -x "$FFMPEG_BIN" ]]; then
  echo "[stream] ERROR: ffmpeg not found at $FFMPEG_BIN"
  exit 1
fi

if ! command -v Xvfb &>/dev/null; then
  echo "[stream] ERROR: Xvfb not installed. Run:"
  echo "         sudo apt-get install -y xvfb"
  exit 1
fi

# ── Load stream key (never echo it) ──────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[stream] ERROR: $ENV_FILE not found"
  exit 1
fi

YOUTUBE_STREAM_KEY=""
while IFS='=' read -r key val; do
  [[ "$key" == "YOUTUBE_STREAM_KEY" ]] && YOUTUBE_STREAM_KEY="$val"
done < <(grep -v '^#' "$ENV_FILE")

if [[ -z "$YOUTUBE_STREAM_KEY" ]]; then
  echo "[stream] ERROR: YOUTUBE_STREAM_KEY not set in $ENV_FILE"
  echo "         Add it manually: echo 'YOUTUBE_STREAM_KEY=xxxx-xxxx-xxxx-xxxx' >> ~/.nemoclaw_env"
  exit 1
fi

RTMP_URL="rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}"

# ── Temp isolated profile (deleted on exit) ───────────────────────────────────
TMPPROFILE=$(mktemp -d /tmp/stream-chrome-XXXXXX)

# ── Cleanup on any exit ───────────────────────────────────────────────────────
CHROME_PID=""
XVFB_PID=""
SILENCE_FILE=""

cleanup() {
  echo ""
  echo "[stream] shutting down..."
  [[ -n "$CHROME_PID" ]] && kill "$CHROME_PID" 2>/dev/null || true
  [[ -n "$XVFB_PID" ]] && kill "$XVFB_PID" 2>/dev/null || true
  rm -rf "$TMPPROFILE"
  [[ -n "${FFMPEG_CONCAT_FILE:-}" ]] && rm -f "$FFMPEG_CONCAT_FILE"
  [[ -n "${SILENCE_FILE:-}" ]] && rm -f "$SILENCE_FILE"
  # Write idle to both live JSONs so SwarmStatus knows stream ended
  for f in "$LIVE_JSON_WB" "$LIVE_JSON_MP"; do
    [[ -f "$f" ]] && python3 -c "
import json,sys
d=json.load(open('$f'))
d['stream']={'live':False}
json.dump(d,open('$f','w'))
" 2>/dev/null || true
  done
  echo "[stream] done"
}
trap cleanup EXIT INT TERM

# ── Mark stream as live in the active build's JSON ────────────────────────────
mark_live() {
  for f in "$LIVE_JSON_WB" "$LIVE_JSON_MP"; do
    [[ -f "$f" ]] && python3 -c "
import json
d=json.load(open('$f'))
d['stream']={'live':True,'url':'$STREAM_URL'}
json.dump(d,open('$f','w'))
" 2>/dev/null || true
  done
}

# ── Start Xvfb ────────────────────────────────────────────────────────────────
echo "[stream] starting Xvfb on $DISPLAY_NUM (${WIDTH}x${HEIGHT}x24)..."
Xvfb "$DISPLAY_NUM" -screen 0 "${WIDTH}x${HEIGHT}x24" -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1

# Verify Xvfb started
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[stream] ERROR: Xvfb failed to start (display $DISPLAY_NUM already in use?)"
  echo "         Try: DISPLAY_NUM=:98 ./stream-headless.sh"
  exit 1
fi

# ── Launch isolated Chromium ──────────────────────────────────────────────────
echo "[stream] launching isolated Chromium → $STREAM_URL"
echo "[stream] (incognito, throwaway profile at $TMPPROFILE — not your real browser)"

DISPLAY="$DISPLAY_NUM" "$CHROMIUM_BIN" \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --use-gl=swiftshader \
  --enable-webgl \
  --ignore-gpu-blocklist \
  --enable-unsafe-swiftshader \
  --window-size="${WIDTH},${HEIGHT}" \
  --window-position=0,0 \
  --no-first-run \
  --no-default-browser-check \
  --incognito \
  --user-data-dir="$TMPPROFILE" \
  --disable-extensions \
  --disable-plugins \
  --disable-background-networking \
  --disable-sync \
  --disable-translate \
  --disable-logging \
  --remote-debugging-port=9222 \
  --app="$STREAM_URL" \
  2>/tmp/stream-chrome.log &
CHROME_PID=$!

echo "[stream] Chromium PID: $CHROME_PID — waiting for page load..."
sleep 8

if ! kill -0 "$CHROME_PID" 2>/dev/null; then
  echo "[stream] ERROR: Chromium crashed on startup. Log:"
  cat /tmp/stream-chrome.log 2>/dev/null | tail -20
  exit 1
fi

mark_live

# ── Start FFmpeg ──────────────────────────────────────────────────────────────
echo "[stream] starting FFmpeg → YouTube RTMP"
echo "[stream] resolution: ${WIDTH}x${HEIGHT} @ ${FPS}fps | bitrate: ${BITRATE}k | duration: ${DURATION}s"

# Build audio: playlist > single file > silence
FFMPEG_CONCAT_FILE=""
AUDIO_INPUT_ARGS=()
AUDIO_FILTER=()

if [[ -n "$MUSIC_PLAYLIST" ]]; then
  if [[ ! -f "$MUSIC_PLAYLIST" ]]; then
    echo "[stream] WARNING: playlist not found: $MUSIC_PLAYLIST — silence"
  else
    # Build an FFmpeg concat file from the playlist, looping the whole list
    # Add 500ms silence between tracks to prevent audio discontinuities
    FFMPEG_CONCAT_FILE=$(mktemp /tmp/stream-playlist-XXXXXX.txt)
    SILENCE_FILE=$(mktemp /tmp/stream-silence-XXXXXX.mp3)

    # Generate 500ms silence file (safe for all codecs via lavfi)
    ffmpeg -f lavfi -i "anullsrc=r=44100:cl=stereo" -t 0.5 -q:a 9 -acodec libmp3lame "$SILENCE_FILE" 2>/dev/null

    # Write each valid file entry, inserting silence after each track
    first=1
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" || "$line" == \#* ]] && continue
      if [[ -f "$line" ]]; then
        [[ "$first" -eq 0 ]] && printf "file '%s'\n" "$SILENCE_FILE" >>"$FFMPEG_CONCAT_FILE"
        printf "file '%s'\n" "$line" >>"$FFMPEG_CONCAT_FILE"
        first=0
      else
        echo "[stream] WARNING: skipping missing file: $line"
      fi
    done <"$MUSIC_PLAYLIST"
    track_count=$(grep -c "^file" "$FFMPEG_CONCAT_FILE" 2>/dev/null || echo 0)
    if [[ "$track_count" -eq 0 ]]; then
      echo "[stream] WARNING: playlist has no valid files — silence"
      rm -f "$FFMPEG_CONCAT_FILE"
      FFMPEG_CONCAT_FILE=""
    elif [[ "$track_count" -eq 1 ]]; then
      # Single-track playlist: use seamless stream_loop on the file directly.
      # The concat demuxer reseeks between loops, causing a brief audio/video
      # stall at the boundary — stream_loop on a plain input is gapless.
      single_track=$(awk -F"'" '/^file /{print $2; exit}' "$FFMPEG_CONCAT_FILE")
      rm -f "$FFMPEG_CONCAT_FILE"
      FFMPEG_CONCAT_FILE=""
      echo "[stream] playlist: 1 track → seamless loop ($(basename "$single_track"), volume: ${MUSIC_VOLUME})"
      AUDIO_INPUT_ARGS=(-stream_loop -1 -i "$single_track")
      AUDIO_FILTER=(-af "aresample=async=1000,volume=${MUSIC_VOLUME}")
    else
      echo "[stream] playlist: $track_count tracks (volume: ${MUSIC_VOLUME})"
      AUDIO_INPUT_ARGS=(-stream_loop -1 -f concat -safe 0 -i "$FFMPEG_CONCAT_FILE")
      AUDIO_FILTER=(-af "aresample=async=1000,volume=${MUSIC_VOLUME}")
    fi
  fi
fi

if [[ -z "${AUDIO_INPUT_ARGS[*]}" && -n "$MUSIC_FILE" ]]; then
  if [[ ! -f "$MUSIC_FILE" ]]; then
    echo "[stream] WARNING: music file not found: $MUSIC_FILE — silence"
  else
    echo "[stream] music: $(basename "$MUSIC_FILE") (volume: ${MUSIC_VOLUME}, looping)"
    AUDIO_INPUT_ARGS=(-stream_loop -1 -i "$MUSIC_FILE")
    AUDIO_FILTER=(-af "aresample=async=1000,volume=${MUSIC_VOLUME}")
  fi
fi

if [[ -z "${AUDIO_INPUT_ARGS[*]}" ]]; then
  echo "[stream] audio: silence"
  AUDIO_INPUT_ARGS=(-f lavfi -i "anullsrc=r=44100:cl=stereo")
fi

echo "[stream] ─────────────────────────────────────────────"

# Per-leg cap (each ffmpeg invocation lasts at most this long, then we cycle).
# Long enough to be invisible to viewers, short enough that audio drift from
# -stream_loop rewinds can't accumulate into a frozen-AAC death (~5 min in
# the wild — see incident 2026-04-07). Still wrapped in a restart loop in
# case ffmpeg crashes early or the audio watchdog kills it.
LEG_SECS="${LEG_SECS:-1500}"   # 25 min
DEADLINE=$(( $(date +%s) + DURATION ))
WATCHDOG_PID=""

# Video freeze watchdog: checks whether ffmpeg's frame counter is still
# advancing. If the same frame count is reported in two consecutive 30s
# windows the video output is frozen (x11grab stopped feeding, e.g. its -t
# expired while the audio loop kept ffmpeg alive). Kill so the leg loop
# respawns clean. DTS rewind warnings from stream_loop audio are benign and
# intentionally NOT used as a kill trigger.
start_audio_watchdog() {
  local target_pid="$1" leglog="$2"
  (
    sleep 30  # let ffmpeg get past the warm-up jitter
    local last_frame=0 stuck_count=0
    while kill -0 "$target_pid" 2>/dev/null; do
      sleep 30
      local cur_frame
      cur_frame=$(grep -oE 'frame= *[0-9]+' "$leglog" 2>/dev/null | tail -1 | grep -oE '[0-9]+' || echo 0)
      if [[ "$cur_frame" -gt 0 && "$cur_frame" -eq "$last_frame" ]]; then
        stuck_count=$(( stuck_count + 1 ))
        if [[ "$stuck_count" -ge 2 ]]; then
          echo "[stream-watchdog] video frozen at frame=$cur_frame — killing ffmpeg $target_pid" >&2
          kill "$target_pid" 2>/dev/null
          return 0
        fi
      else
        stuck_count=0
      fi
      last_frame="$cur_frame"
    done
  ) &
  WATCHDOG_PID=$!
}

LEG=0
while :; do
  NOW=$(date +%s)
  REMAINING=$(( DEADLINE - NOW ))
  if [[ $REMAINING -le 10 ]]; then
    echo "[stream] reached total DURATION (${DURATION}s) — stopping"
    break
  fi
  THIS_LEG=$LEG_SECS
  [[ $THIS_LEG -gt $REMAINING ]] && THIS_LEG=$REMAINING
  LEG=$(( LEG + 1 ))
  LEG_LOG=$(mktemp /tmp/stream-leg-XXXXXX.log)
  echo "[stream] leg $LEG starting (${THIS_LEG}s, log=$LEG_LOG)"

  # NOTE: -t MUST be an OUTPUT option (after all -i inputs), not an input
  # option. Placing it before -i x11grab only caps the x11grab input — the
  # audio loop with -stream_loop -1 keeps ffmpeg alive after x11grab expires,
  # which freezes the video on the last grabbed frame for the rest of the
  # leg. Output-side -t terminates the whole encode.
  "$FFMPEG_BIN" \
    -loglevel warning \
    -stats \
    \
    -thread_queue_size 1024 \
    -use_wallclock_as_timestamps 1 \
    -f x11grab \
    -framerate "$FPS" \
    -s "${WIDTH}x${HEIGHT}" \
    -i "${DISPLAY_NUM}.0+0,0" \
    \
    -thread_queue_size 1024 \
    "${AUDIO_INPUT_ARGS[@]}" \
    \
    -t "$THIS_LEG" \
    -c:v libx264 \
    -preset veryfast \
    -x264-params "nal-hrd=cbr" \
    -b:v "${BITRATE}k" \
    -minrate "${BITRATE}k" \
    -maxrate "${BITRATE}k" \
    -bufsize "${BUFSIZE}k" \
    -g "$GOP" \
    -keyint_min "$GOP" \
    -sc_threshold 0 \
    -pix_fmt yuv420p \
    -r "$FPS" \
    \
    -c:a aac \
    -b:a 128k \
    -ar 44100 \
    "${AUDIO_FILTER[@]}" \
    \
    -f flv \
    -flvflags no_duration_filesize \
    "$RTMP_URL" 2> >(tee "$LEG_LOG" >&2) &
  FFMPEG_PID=$!
  start_audio_watchdog "$FFMPEG_PID" "$LEG_LOG"
  wait "$FFMPEG_PID"
  RC=$?
  [[ -n "$WATCHDOG_PID" ]] && kill "$WATCHDOG_PID" 2>/dev/null
  WATCHDOG_PID=""
  rm -f "$LEG_LOG"
  echo "[stream] leg $LEG ended rc=$RC"

  # Tiny backoff so a tight crash loop doesn't hammer YouTube
  sleep 2
done

echo "[stream] FFmpeg finished (duration reached or stream ended)"
