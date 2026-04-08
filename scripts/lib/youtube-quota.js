// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// youtube-quota.js — shared daily-quota tracker for every script that hits
// the YouTube Data API. Prevents us from ever blowing through the 10k/day
// cap again. State is persisted to /tmp/youtube-quota.json so it survives
// script restarts. Resets at midnight PACIFIC TIME (Google's quota window).
//
// Usage:
//   const q = require("./lib/youtube-quota");
//   if (!q.canSpend(q.COST_INSERT)) { /* skip */ }
//   q.record(q.COST_INSERT);
//
// Costs are documented at: https://developers.google.com/youtube/v3/determine_quota_cost

"use strict";

const fs = require("fs");

const QUOTA_FILE = "/tmp/youtube-quota.json";
const DAILY_CAP  = 10_000;
// Hard stops BEFORE the real cap so we always have emergency headroom.
// The poller will stop EVERYTHING at HARD_STOP; inserts (posts) stop earlier.
const HARD_STOP       = 9_500;  // no more API calls of any kind
const INSERT_SOFT_STOP = 7_000; // no more chat posts; keep polling to show chat on overlay

// Per-call costs from the YouTube Data API docs
const COST_LIST_LIVECHAT    = 5;
const COST_INSERT_LIVECHAT  = 50;
const COST_LIST_VIDEOS      = 1;
const COST_SEARCH           = 100;

// Google's quota window is midnight Pacific. Return a YYYY-MM-DD string for
// the current day in that timezone so we can detect rollover.
function pacificDayKey() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date()); // "YYYY-MM-DD"
}

function load() {
  try {
    const raw = fs.readFileSync(QUOTA_FILE, "utf8");
    const s = JSON.parse(raw);
    if (s && typeof s.day === "string" && typeof s.used === "number") return s;
  } catch (_e) { /* fall through */ }
  return { day: pacificDayKey(), used: 0 };
}

function save(state) {
  try {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(state));
  } catch (_e) { /* disk full / read-only, swallow — tracker is best-effort */ }
}

// Ensure the state is for today (Pacific). Resets if the day has rolled over.
function current() {
  const s = load();
  const today = pacificDayKey();
  if (s.day !== today) {
    const fresh = { day: today, used: 0 };
    save(fresh);
    return fresh;
  }
  return s;
}

// Can we afford to spend `cost` units? For insert costs, also enforce the
// soft stop so we stop posting early and keep polling headroom.
function canSpend(cost) {
  const s = current();
  const afterHard   = s.used + cost > HARD_STOP;
  const isInsertCost = cost >= COST_INSERT_LIVECHAT;
  const afterSoft   = isInsertCost && (s.used + cost > INSERT_SOFT_STOP);
  return !afterHard && !afterSoft;
}

// Hard stop regardless of call type — used by the poller to stop polling
// entirely when we're out of budget.
function isHardStopped() {
  return current().used >= HARD_STOP;
}

// Record that we actually made an API call of the given cost. Call this
// AFTER the HTTP request returns (success OR documented quota-eating failure
// like 403), so we're tracking real usage not intent.
function record(cost) {
  const s = current();
  s.used += cost;
  save(s);
  return s.used;
}

// Called when an API response comes back with 403 + quotaExceeded. This
// means our local counter is out of sync with Google's real server-side
// count (usually because calls were made before the tracker existed). We
// mark the tracker as fully exhausted for the rest of the day so nothing
// else bothers to try — saves us from spinning on 403s.
function markExhausted(reason = "quotaExceeded") {
  const s = current();
  s.used = HARD_STOP;
  s.exhaustedReason = reason;
  s.exhaustedAt = new Date().toISOString();
  save(s);
  return s;
}

// Inspect an API response object `{status, body}` and if it looks like a
// quota exhaustion 403, mark the tracker exhausted. Returns true if it
// was a quota-exhausted response.
function detectExhaustion(status, body) {
  if (status !== 403) return false;
  const text = typeof body === "string" ? body : JSON.stringify(body || "");
  if (/quotaExceeded|exceeded your.*quota/i.test(text)) {
    markExhausted();
    return true;
  }
  return false;
}

function status() {
  const s = current();
  return {
    day:              s.day,
    used:             s.used,
    cap:              DAILY_CAP,
    hardStop:         HARD_STOP,
    insertSoftStop:   INSERT_SOFT_STOP,
    remaining:        Math.max(0, HARD_STOP - s.used),
    hardStopped:      s.used >= HARD_STOP,
    insertStopped:    s.used >= INSERT_SOFT_STOP,
    exhaustedReason:  s.exhaustedReason || null,
    exhaustedAt:      s.exhaustedAt || null,
  };
}

module.exports = {
  DAILY_CAP,
  HARD_STOP,
  INSERT_SOFT_STOP,
  COST_LIST_LIVECHAT,
  COST_INSERT_LIVECHAT,
  COST_LIST_VIDEOS,
  COST_SEARCH,
  canSpend,
  isHardStopped,
  record,
  status,
  markExhausted,
  detectExhaustion,
};
