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
STREAM_URL="http://localhost:3001/weirdbox-lab.html"
DURATION=7200
RES="1280x720"
FPS=30
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

cleanup() {
  echo ""
  echo "[stream] shutting down..."
  [[ -n "$CHROME_PID" ]] && kill "$CHROME_PID" 2>/dev/null || true
  [[ -n "$XVFB_PID" ]] && kill "$XVFB_PID" 2>/dev/null || true
  rm -rf "$TMPPROFILE"
  [[ -n "${FFMPEG_CONCAT_FILE:-}" ]] && rm -f "$FFMPEG_CONCAT_FILE"
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
  --disable-software-rasterizer \
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
    FFMPEG_CONCAT_FILE=$(mktemp /tmp/stream-playlist-XXXXXX.txt)
    # Write each valid file entry twice (first pass + loop pass) then use -stream_loop
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" || "$line" == \#* ]] && continue
      if [[ -f "$line" ]]; then
        printf "file '%s'\n" "$line" >>"$FFMPEG_CONCAT_FILE"
      else
        echo "[stream] WARNING: skipping missing file: $line"
      fi
    done <"$MUSIC_PLAYLIST"
    track_count=$(grep -c "^file" "$FFMPEG_CONCAT_FILE" 2>/dev/null || echo 0)
    if [[ "$track_count" -eq 0 ]]; then
      echo "[stream] WARNING: playlist has no valid files — silence"
      rm -f "$FFMPEG_CONCAT_FILE"
      FFMPEG_CONCAT_FILE=""
    else
      echo "[stream] playlist: $track_count tracks (volume: ${MUSIC_VOLUME})"
      AUDIO_INPUT_ARGS=(-stream_loop -1 -f concat -safe 0 -i "$FFMPEG_CONCAT_FILE")
      AUDIO_FILTER=(-filter:a "volume=${MUSIC_VOLUME}")
    fi
  fi
fi

if [[ -z "${AUDIO_INPUT_ARGS[*]}" && -n "$MUSIC_FILE" ]]; then
  if [[ ! -f "$MUSIC_FILE" ]]; then
    echo "[stream] WARNING: music file not found: $MUSIC_FILE — silence"
  else
    echo "[stream] music: $(basename "$MUSIC_FILE") (volume: ${MUSIC_VOLUME}, looping)"
    AUDIO_INPUT_ARGS=(-stream_loop -1 -i "$MUSIC_FILE")
    AUDIO_FILTER=(-filter:a "volume=${MUSIC_VOLUME}")
  fi
fi

if [[ -z "${AUDIO_INPUT_ARGS[*]}" ]]; then
  echo "[stream] audio: silence"
  AUDIO_INPUT_ARGS=(-f lavfi -i "anullsrc=r=44100:cl=stereo")
fi

echo "[stream] ─────────────────────────────────────────────"

"$FFMPEG_BIN" \
  -loglevel warning \
  -stats \
  -t "$DURATION" \
  \
  -f x11grab \
  -r "$FPS" \
  -s "${WIDTH}x${HEIGHT}" \
  -i "${DISPLAY_NUM}.0+0,0" \
  \
  "${AUDIO_INPUT_ARGS[@]}" \
  \
  -c:v libx264 \
  -preset veryfast \
  -tune zerolatency \
  -b:v "${BITRATE}k" \
  -maxrate "${BITRATE}k" \
  -bufsize "${BUFSIZE}k" \
  -g "$GOP" \
  -keyint_min "$FPS" \
  -sc_threshold 0 \
  -pix_fmt yuv420p \
  \
  -c:a aac \
  -b:a 128k \
  -ar 44100 \
  "${AUDIO_FILTER[@]}" \
  \
  -f flv \
  "$RTMP_URL"

echo "[stream] FFmpeg finished (duration reached or stream ended)"
