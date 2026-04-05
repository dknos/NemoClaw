# MEMO.md — Reasoning Ledger (2026-03-28)

## Current State
- Gemini 3.1 Flash-Lite Preview on Vertex AI Cloud ($300 credits)
- Imagen 4 Fast Cloud-only (no AI Studio fallback anywhere)
- 13 slash commands + 2-row interactive buttons + modal popups
- 4 video modes (T2V/I2V/Combi/Story) + 3 chain modes + FFmpeg stitching
- 49 issues resolved, implicit caching at 85-93% hit rate
- YouTube tools (search/transcript/batch), XPOZ trends, Qdrant memory
- Instagram posting owner-only via Buffer.com

## What Just Happened
- Added FFmpeg video stitching with rootId tracking across chain clicks
- Fixed chain prompts to be 10-second aware (gradual endings, not abrupt)
- Fixed stitch button not showing (rootId propagation through context)
- Saved comprehensive memories to Claude Code memory system

## Active Issues
- Render times creeping (80s→180s) — likely x2 upscaler in T2V/I2V workflows
- Could switch to x1.5 upscaler for faster renders (user's choice)
- Gemini implicit caching works but explicit caching blocked by SA token type

## Key Commands
- Restart: `~/.local/bin/pm2 restart discord-bridge`
- Full restart: `bash ~/start-all.sh`
- Restore sandbox: `bash ~/restore-sandbox.sh`
- Apply policy: `openshell policy set my-assistant --policy ~/nemoclaw-persist/policy.yaml --wait`
- Clear sessions: SSH into sandbox → `find /sandbox/.openclaw-data -name "*.jsonl" -delete`
- Check logs: `tail -20 /tmp/discord-bridge.log`
- Check cache: `grep "CACHE HIT\|tokens:" /tmp/discord-bridge.log | tail -10`

## Detailed Build Log
See your local build logs directory.
