#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

cd "$(dirname "$0")/.."

echo "[pre-restart] syntax check..."
node --check scripts/discord-bridge.js || {
  echo "❌ SYNTAX ERROR — aborting restart"
  exit 1
}

echo "[pre-restart] running bridge unit tests..."
npx vitest run --project bridge --reporter=dot 2>&1 || {
  echo "❌ TESTS FAILED — aborting restart"
  exit 1
}

echo "✅ All checks passed. Safe to restart."
