#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# launch-breakroom.sh
# Complete breakroom stream setup: Next.js, API server, chat bridge, and stream

set -e

HOME="${HOME:-/home/nemoclaw}"
NETIFY_DEV="$HOME/netify-dev"
SCRIPTS_DIR="$HOME/.nemoclaw/source/scripts"

echo "🚀 Breakroom Launcher"
echo "===================="
echo ""

# ── 1. Next.js dev server (port 3001) ──────────────────────────────────────
echo "▶️  Starting Next.js dev server (http://localhost:3001)..."
cd "$NETIFY_DEV"
pkill -f "next dev" 2>/dev/null || true
sleep 1
npm run dev >/tmp/nextdev.log 2>&1 &
NEXTPID=$!
echo "   PID: $NEXTPID"
sleep 5

# ── 2. Breakroom API server (port 3003) ───────────────────────────────────
echo "▶️  Starting breakroom API server (http://localhost:3003)..."
pkill -f "breakroom-api-server" 2>/dev/null || true
sleep 0.5
node "$SCRIPTS_DIR/breakroom-api-server.js" >/tmp/breakroom-api.log 2>&1 &
APIPID=$!
echo "   PID: $APIPID"
sleep 2

# ── 3. Chat bridge ────────────────────────────────────────────────────────
echo "▶️  Starting chat bridge (watches live-session.json)..."
pkill -f "breakroom-chat-bridge" 2>/dev/null || true
sleep 0.5
nohup node "$SCRIPTS_DIR/breakroom-chat-bridge.js" >/tmp/breakroom-bridge.log 2>&1 &
BRIDGEPID=$!
echo "   PID: $BRIDGEPID"

# ── 4. Kill old Xvfb/stream processes ──────────────────────────────────────
echo "▶️  Cleaning up old stream processes..."
pkill -f "stream-headless\|ffmpeg.*rtmp" 2>/dev/null || true
pgrep -i "[Xx]vfb" | xargs kill 2>/dev/null || true
rm -f /tmp/.X99-lock /tmp/.X98-lock 2>/dev/null || true
sleep 1

# ── 5. Launch stream (Xvfb + Chromium + FFmpeg) ────────────────────────────
echo "▶️  Starting livestream (http://localhost:3001/breakroom)..."
nohup bash "$SCRIPTS_DIR/stream-headless.sh" \
  --url http://localhost:3001/breakroom \
  --playlist "$SCRIPTS_DIR/stream-playlist.txt" \
  --fps 20 --bitrate 2500 >/tmp/stream.log 2>&1 &
STREAMPID=$!
echo "   PID: $STREAMPID"
sleep 10

# ── Status check ──────────────────────────────────────────────────────────
echo ""
echo "✅ Breakroom is launching!"
echo ""
echo "📋 Process Summary:"
echo "   Next.js dev:        PID $NEXTPID (port 3001)"
echo "   API server:         PID $APIPID (port 3003)"
echo "   Chat bridge:        PID $BRIDGEPID"
echo "   Stream:             PID $STREAMPID"
echo ""
echo "📍 URLs:"
echo "   Game page:          http://localhost:3001/breakroom"
echo "   API (commands):     http://localhost:3003/api/breakroom-chat"
echo "   API (events):       http://localhost:3003/api/breakroom-event"
echo "   API (image gen):    http://localhost:3003/api/breakroom-gen"
echo ""
echo "📊 Logs:"
echo "   Next.js:            tail -f /tmp/nextdev.log"
echo "   API:                tail -f /tmp/breakroom-api.log"
echo "   Bridge:             tail -f /tmp/breakroom-bridge.log"
echo "   Stream:             tail -f /tmp/stream.log"
echo ""
echo "🎮 Stream encoding starting... (check /tmp/stream.log for 'frame=' output)"
sleep 5
strings /tmp/stream.log | grep "frame=" | tail -1 || echo "   [waiting for first frame...]"
echo ""
echo "🎬 You can now:"
echo "   • Visit http://localhost:3001/breakroom to see the breakroom"
echo "   • Send commands: curl -X POST http://localhost:3003/api/breakroom-chat -H 'Content-Type: application/json' -d '{\"commands\":[{\"type\":\"raw_chat\",\"args\":{\"text\":\"!fight\",\"user\":\"[you]\"}}]}'"
echo "   • Reload the stream: node $HOME/.nemoclaw/source/scripts/reload-stream.js"
echo ""
