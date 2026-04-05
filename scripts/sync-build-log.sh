#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# ─────────────────────────────────────────────────────────────────────────────
#  sync-build-log.sh
#  Copies the MrBigPipes build log to Firebase Hosting and redeploys.
#  The file is then publicly accessible for Vertex AI Search indexing.
#
#  Public URL: https://drivenemo.web.app/docs/build-log.txt
#
#  Usage:  bash sync-build-log.sh
#  Auto:   add to cron — crontab -e → 0 * * * * bash /path/to/sync-build-log.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SRC="${BUILD_LOG_SRC:-}"
OUT_DIR="/tmp/netify-build/out/docs"
DEST="$OUT_DIR/build-log.txt"

echo "[sync] Copying build log..."
mkdir -p "$OUT_DIR"
cp "$SRC" "$DEST"
echo "[sync] Size: $(du -h "$DEST" | cut -f1)"

echo "[sync] Deploying to Firebase Hosting..."
cd /tmp/netify-build
firebase deploy --only hosting 2>&1 | grep -E "✔|✗|error|Error|release complete|Deploy complete"

echo ""
echo "[sync] Done."
echo "[sync] Public URL: https://drivenemo.web.app/docs/build-log.txt"
echo ""
echo "[sync] For Vertex AI Search — add this as a website data source:"
echo "       https://drivenemo.web.app/docs/build-log.txt"
