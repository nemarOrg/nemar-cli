/**
 * The per-isolate manifest answer memo (#1494 placement/trust-window
 * follow-up), in isolation from `readManifest` -- the LRU and byte-cap
 * mechanics on their own, so the memo's own bugs are not mistaken for a
 * manifest-reading bug (and vice versa; `manifest-source.test.ts` covers the
 * integration).
 */

import { describe, expect, test } from "bun:test";
import {
  MANIFEST_ANSWER_MEMO_CAP_BYTES,
  ManifestAnswerMemo,
} from "../src/services/manifest-answer-memo";

describe("ManifestAnswerMemo", () => {
  test("a stored value is recalled by the same key", () => {
    const memo = new ManifestAnswerMemo();
    memo.set("a", { hello: "world" });
    expect(memo.get("a")).toEqual({ hello: "world" });
    expect(memo.get("nope")).toBeUndefined();
  });

  test("re-setting a key does not double-count its bytes", () => {
    const memo = new ManifestAnswerMemo(1000);
    memo.set("a", "x".repeat(100));
    const afterFirst = memo.byteSize;
    memo.set("a", "x".repeat(100));
    expect(memo.byteSize).toBe(afterFirst);
    expect(memo.size).toBe(1);
  });

  test("LRU: the least recently used entry is evicted first", () => {
    // Each `"x".repeat(100)` estimates to 268 bytes (a 102-char JSON string
    // times 2, plus 64 overhead); a 600-byte cap holds exactly two.
    const memo = new ManifestAnswerMemo(600);
    memo.set("a", "x".repeat(100));
    memo.set("b", "x".repeat(100));
    // Touch "a" so "b" (not "a") is the least recently used going into the
    // next insertion.
    expect(memo.get("a")).toBeDefined();
    memo.set("c", "x".repeat(100)); // does not fit alongside both -> evicts "b"
    expect(memo.byteSize).toBeLessThanOrEqual(600);
    expect(memo.get("a")).toBeDefined();
    expect(memo.get("b")).toBeUndefined();
    expect(memo.get("c")).toBeDefined();
  });

  test("a value larger than half the cap is never stored", () => {
    const memo = new ManifestAnswerMemo(1000);
    memo.set("big", "x".repeat(10_000));
    expect(memo.size).toBe(0);
    expect(memo.byteSize).toBe(0);
    expect(memo.get("big")).toBeUndefined();
  });

  test("clear empties the memo", () => {
    const memo = new ManifestAnswerMemo();
    memo.set("a", "x");
    memo.set("b", "y");
    memo.clear();
    expect(memo.size).toBe(0);
    expect(memo.byteSize).toBe(0);
  });

  test("the default cap is the documented constant", () => {
    const memo = new ManifestAnswerMemo();
    // A value exactly at the boundary of the default single-entry fraction
    // should still be rejected once its estimate (UTF-16 length * 2 plus
    // overhead) exceeds half of MANIFEST_ANSWER_MEMO_CAP_BYTES.
    const tooLarge = "x".repeat(MANIFEST_ANSWER_MEMO_CAP_BYTES);
    memo.set("huge", tooLarge);
    expect(memo.size).toBe(0);
  });

  test("a value that cannot be serialized is never stored", () => {
    const memo = new ManifestAnswerMemo();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    memo.set("circular", circular);
    expect(memo.size).toBe(0);
  });
});
