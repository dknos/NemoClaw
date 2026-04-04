#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

echo "[smoke] waiting for bridge to start..."
sleep 4

HEALTH=$(curl -sf --max-time 5 http://127.0.0.1:9341/health 2>/dev/null) || {
  echo "❌ Health endpoint unreachable (port 9341)"
  exit 1
}

node -e "
const d = JSON.parse('$HEALTH');
if (!d.ok) { console.error('❌ Bridge reports not ok'); process.exit(1); }
if (!d.discord?.connected && d.discord?.connected !== undefined) { console.error('❌ Discord not connected'); process.exit(1); }
console.log('✅ Bridge healthy — pid:' + d.pid + ' uptime:' + d.uptime + 's ping:' + (d.discord?.ping ?? '?') + 'ms queue:' + d.queue);
" || exit 1
