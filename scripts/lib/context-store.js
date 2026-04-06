// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// TTL + max-size Map wrapper for managing generation contexts, pending maps,
// and dedup caches. Prevents unbounded memory growth in long-lived PM2 processes.

class ContextStore {
  /**
   * @param {object} opts
   * @param {string}  opts.name      - namespace for logging
   * @param {number}  opts.maxSize   - max entries before LRU eviction (default 500)
   * @param {number}  opts.ttlMs     - per-entry TTL in ms (default 30 min)
   */
  constructor({ name = "store", maxSize = 500, ttlMs = 30 * 60 * 1000 } = {}) {
    this.name = name;
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this._map = new Map(); // key → { value, ts }
    this._evictTimer = setInterval(() => this._evictExpired(), Math.min(ttlMs, 60000));
    if (this._evictTimer.unref) this._evictTimer.unref(); // don't keep process alive
  }

  get size() { return this._map.size; }

  set(key, value) {
    // Delete first so re-insertion moves key to end (Map insertion order = LRU)
    this._map.delete(key);
    this._map.set(key, { value, ts: Date.now() });
    this._enforceCap();
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > (entry.customTTL || this.ttlMs)) {
      this._map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    return this._map.delete(key);
  }

  /** Set with a custom TTL (overrides the store default for this entry). */
  setWithTTL(key, value, ttlMs) {
    this._map.delete(key);
    this._map.set(key, { value, ts: Date.now(), customTTL: ttlMs });
    this._enforceCap();
  }

  /** Get the raw timestamp for a key (for timeout comparisons). */
  getTs(key) {
    const entry = this._map.get(key);
    return entry ? entry.ts : undefined;
  }

  clear() { this._map.clear(); }

  destroy() {
    clearInterval(this._evictTimer);
    this._map.clear();
  }

  stats() {
    return { name: this.name, size: this._map.size, maxSize: this.maxSize, ttlMs: this.ttlMs };
  }

  // ── Internal ──────────────────────────────────────────────────────

  _enforceCap() {
    while (this._map.size > this.maxSize) {
      // Delete oldest (first key in Map insertion order)
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }

  _evictExpired() {
    const now = Date.now();
    for (const [key, entry] of this._map) {
      const ttl = entry.customTTL || this.ttlMs;
      if (now - entry.ts > ttl) this._map.delete(key);
    }
  }
}

module.exports = { ContextStore };
