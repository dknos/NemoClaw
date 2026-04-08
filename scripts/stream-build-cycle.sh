#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# stream-build-cycle.sh — one build cycle for the live stream
#
# Run by cron every 25 min while a stream is live. Each cycle:
#   1. Read the current chat vote (topic + mood) from live-session.json
#   2. Post "Building X now..." to YouTube live chat
#   3. Run workshop-builder.js with a 15-min hard cap
#   4. Post "What should I build next? Vote..." to YouTube live chat
#
# Skips the whole cycle if the stream is not live (no ffmpeg hitting RTMP).

set -u

LOG=/tmp/stream-build-cycle.log
SCRIPTS=/home/nemoclaw/.nemoclaw/source/scripts
LIVE_JSON=/home/nemoclaw/netify-dev/public/data/live-session.json
OVERLAY_JSON=/home/nemoclaw/netify-dev/public/data/stream-overlay.json
ACTIVE_JSON=/home/nemoclaw/netify-dev/public/data/workshop/active.json
GALLERY_JSON=/home/nemoclaw/netify-dev/public/data/workshop/gallery.json
NODE=/usr/bin/node
BUILD_SLOT_SECS=900 # 15 min hard cap

log() { echo "[cycle] $(date -Is) $*" >>"$LOG"; }

# finalize_stale_build — if active.json is stuck in "building" state from a
# crashed prior cycle, save the current HTML to the gallery and mark it
# complete so the next build starts clean. Without this the workshop page
# freezes on the crashed build forever.
finalize_stale_build() {
  AJ="$ACTIVE_JSON" GJ="$GALLERY_JSON" "$NODE" -e "
    const fs = require('fs');
    const AJ = process.env.AJ;
    const GJ = process.env.GJ;
    if (!fs.existsSync(AJ)) process.exit(0);
    let active;
    try { active = JSON.parse(fs.readFileSync(AJ, 'utf8')); } catch (_e) { process.exit(0); }
    if (!active || active.status !== 'building') process.exit(0);
    // Grace window: don't touch builds younger than the slot length + a small buffer
    const ageMs = Date.now() - (active.startTime || 0);
    if (ageMs < 60 * 1000) process.exit(0);

    // Finalize — mark complete, add to gallery
    active.status = 'complete';
    active.endTime = Date.now();
    active.crashed = true;

    let gallery = [];
    if (fs.existsSync(GJ)) {
      try { gallery = JSON.parse(fs.readFileSync(GJ, 'utf8')); if (!Array.isArray(gallery)) gallery = []; } catch (_e) {}
    }
    // Avoid duplicate gallery entries for the same build
    if (!gallery.some(g => g.buildId === active.buildId)) {
      gallery.unshift({
        buildId:    active.buildId,
        topic:      active.topic || 'freestyle',
        html:       active.currentHtml || '',
        iterations: (active.iterations || []).length,
        startTime:  active.startTime,
        endTime:    active.endTime,
        crashed:    true,
      });
      if (gallery.length > 50) gallery = gallery.slice(0, 50);
      fs.writeFileSync(GJ, JSON.stringify(gallery, null, 2));
    }
    fs.writeFileSync(AJ, JSON.stringify(active, null, 2));
    console.log('[finalize-stale] saved ' + active.buildId + ' (age ' + Math.round(ageMs/1000) + 's)');
  " 2>>"$LOG" || log "finalize_stale_build failed"
}

# flash_overlay TEXT ACCENT TTL_MS — writes a flash layer to stream-overlay.json
# without clobbering .base. Env-var passthrough avoids shell-escaping the text.
# Read-modify-write, so chat flashes can still race with banners — last writer
# wins, which is fine for a banner system.
export OV="$OVERLAY_JSON"
flash_overlay() {
  FT="$1" FA="$2" FTTL="$3" "$NODE" -e "
    const fs = require('fs');
    const OV = process.env.OV;
    let cur = { base: { visible: true, text: 'chat is cool', accent: '#00f5d4' }, flash: null };
    try { cur = JSON.parse(fs.readFileSync(OV, 'utf8')) || cur; } catch (_e) {}
    cur.flash = {
      visible: true,
      text:    process.env.FT,
      accent:  process.env.FA,
      until:   new Date(Date.now() + Number(process.env.FTTL)).toISOString(),
    };
    fs.writeFileSync(OV, JSON.stringify(cur, null, 2));
  " 2>>"$LOG" || log "flash_overlay write failed"
}

# Abort if no stream is live right now
if ! pgrep -f "ffmpeg.*rtmp.*youtube" >/dev/null; then
  log "no ffmpeg→rtmp process; skipping cycle"
  exit 0
fi

# Abort if live-session.json is missing or inactive
if [[ ! -f "$LIVE_JSON" ]]; then
  log "live-session.json missing; skipping"
  exit 0
fi
if ! "$NODE" -e "process.exit(JSON.parse(require('fs').readFileSync('$LIVE_JSON','utf8')).active?0:1)" 2>/dev/null; then
  log "live session inactive; skipping"
  exit 0
fi

# Clean up any stale "building" state left over from a crashed prior cycle.
# Without this the workshop page stays frozen on the dead build forever.
finalize_stale_build

# Pick a build kind for variety. The kind drives the entire build — chat
# influence is now mid-build only (via "LATEST AUDIENCE NOTES" injection in
# workshop-builder.js's improvement loop), not vision-time. The list mirrors
# BUILD_KIND_PROMPTS in workshop-builder.js — keep them in sync.
KINDS=(sequencer synth generative threejs physics drawing game quiz fakeOS visualizer memegen textadv dashboard clock landing)
PICKED_KIND="${KINDS[$((RANDOM % ${#KINDS[@]}))]}"
log "build kind: $PICKED_KIND"

# Friendly labels for the chat announcement
declare -A KIND_LABEL=(
  [sequencer]="🥁 a drum machine"
  [synth]="🎹 a playable synth"
  [generative]="🌀 generative art"
  [threejs]="🌐 a 3D scene"
  [physics]="⚗️ a physics sandbox"
  [drawing]="🎨 a drawing app"
  [game]="🎮 a playable game"
  [quiz]="❓ a quiz"
  [fakeOS]="🖥 a fake desktop OS"
  [visualizer]="🎵 an audio visualizer"
  [memegen]="🤡 a meme generator"
  [textadv]="📜 a text adventure"
  [dashboard]="📊 a fake telemetry dashboard"
  [clock]="⏰ an animated clock"
  [landing]="✨ a landing page"
)
KIND_LBL="${KIND_LABEL[$PICKED_KIND]:-$PICKED_KIND}"

# Announce — kind-driven, no more "shout topics" framing. Chat is invited
# to play games + use !filter / !image commands instead.
case $((RANDOM % 4)) in
  0) START_MSG="🔨 Building $KIND_LBL this round. Play the games on the left, type !filter neon, or !image <prompt> to gen art" ;;
  1) START_MSG="✨ This round: $KIND_LBL. While the swarm cooks, try !shake, !flip, !filter retro, or !image <anything>" ;;
  2) START_MSG="🧪 Workshop is making $KIND_LBL. Chat: play the games, use !filter or !image, watch it build" ;;
  *) START_MSG="🚀 Next up: $KIND_LBL. Commands: !filter neon · !shake · !add <text> · !image <prompt> · play the games on screen" ;;
esac
"$NODE" "$SCRIPTS/stream-chat-post.js" "$START_MSG" >>"$LOG" 2>&1 || log "start announcement failed"
flash_overlay "🔨 BUILDING $(echo "$KIND_LBL" | tr '[:lower:]' '[:upper:]')" "#fb923c" 14000

# Run the build. Topic is now the kind label so the builder doesn't think
# it's making "crowdwork" forever. The kind arg drives the vision phase.
timeout "$BUILD_SLOT_SECS" "$NODE" "$SCRIPTS/workshop-builder.js" \
  --topic "$PICKED_KIND" \
  --kind "$PICKED_KIND" \
  --new \
  --user "live-stream-cron" \
  >>"$LOG" 2>&1
RC=$?
if [[ $RC -eq 124 ]]; then
  log "build hit 15-min cap, killed"
  flash_overlay "⏱️ BUILD TIMED OUT — saving & resetting" "#f87171" 15000
  finalize_stale_build
elif [[ $RC -ne 0 ]]; then
  log "build exited rc=$RC"
  flash_overlay "⚠️ BUILD ERROR (rc=$RC) — saving & next cycle soon" "#f87171" 15000
  finalize_stale_build
else
  log "build done ok"
  flash_overlay "✨ BUILD DONE — next in ~10 min" "#4ade80" 15000
fi

# Post-build prompt — point chat at the games + commands instead of
# shouting topics. The kind rotation handles variety now.
case $((RANDOM % 5)) in
  0) NEXT_MSG="✅ Build done! Next round in ~10 min. While you wait: play the games on the left, !image <prompt> for art, or !filter neon" ;;
  1) NEXT_MSG="🎮 Build complete. Try the games on screen, gen an image with !image <prompt>, or hit the build with !filter / !shake / !flip" ;;
  2) NEXT_MSG="✨ Done! Chat commands: !image <prompt> · !filter neon/retro/glow/dark · !shake · !flip · !add <text> · or just play the games" ;;
  3) NEXT_MSG="🔨 Build wrapped. Commands you can use right now: !image, !filter, !shake, !zoom, !flip, !add — or play the live games on screen" ;;
  *) NEXT_MSG="Build done! Type !image <anything> for AI art, !filter neon to recolor the page, or !shake to chaos it. Games on the left, always." ;;
esac
"$NODE" "$SCRIPTS/stream-chat-post.js" "$NEXT_MSG" >>"$LOG" 2>&1 || log "next-prompt failed"

log "cycle done"
