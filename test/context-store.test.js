// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "vitest";
import { ContextStore } from "../scripts/lib/context-store.js";

describe("ContextStore", () => {
  const stores = [];
  const make = (opts) => {
    const s = new ContextStore(opts);
    stores.push(s);
    return s;
  };
  afterEach(() => {
    stores.forEach((s) => s.destroy());
    stores.length = 0;
  });

  it("basic set/get/delete", () => {
    const s = make({ name: "test" });
    s.set("a", { prompt: "hello" });
    expect(s.get("a")).toEqual({ prompt: "hello" });
    expect(s.has("a")).toBe(true);
    s.delete("a");
    expect(s.get("a")).toBeUndefined();
    expect(s.has("a")).toBe(false);
  });

  it("enforces maxSize (evicts oldest)", () => {
    const s = make({ name: "cap", maxSize: 3, ttlMs: 60000 });
    s.set("a", 1);
    s.set("b", 2);
    s.set("c", 3);
    s.set("d", 4); // should evict "a"
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")).toBe(2);
    expect(s.get("d")).toBe(4);
    expect(s.size).toBe(3);
  });

  it("re-setting a key refreshes its position (not evicted first)", () => {
    const s = make({ name: "refresh", maxSize: 3, ttlMs: 60000 });
    s.set("a", 1);
    s.set("b", 2);
    s.set("c", 3);
    s.set("a", 10); // refresh "a" — now "b" is oldest
    s.set("d", 4); // should evict "b"
    expect(s.get("a")).toBe(10);
    expect(s.get("b")).toBeUndefined();
  });

  it("TTL expiry — expired entries return undefined", () => {
    const s = make({ name: "ttl", maxSize: 100, ttlMs: 1 }); // 1ms TTL
    s.set("x", "val");
    // Burn a tiny bit of time
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }
    expect(s.get("x")).toBeUndefined();
    expect(s.has("x")).toBe(false);
  });

  it("stats returns correct info", () => {
    const s = make({ name: "stats", maxSize: 50, ttlMs: 5000 });
    s.set("a", 1);
    s.set("b", 2);
    const st = s.stats();
    expect(st.name).toBe("stats");
    expect(st.size).toBe(2);
    expect(st.maxSize).toBe(50);
  });

  it("clear removes all entries", () => {
    const s = make({ name: "clear" });
    s.set("a", 1);
    s.set("b", 2);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.get("a")).toBeUndefined();
  });

  it("setWithTTL uses custom TTL", () => {
    const s = make({ name: "customTTL", maxSize: 100, ttlMs: 60000 });
    s.setWithTTL("fast", "gone", 1); // 1ms custom TTL
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }
    expect(s.get("fast")).toBeUndefined();
    // Regular entries still alive
    s.set("normal", "here");
    expect(s.get("normal")).toBe("here");
  });
});
