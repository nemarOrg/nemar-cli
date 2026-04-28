import { afterEach, describe, expect, test } from "bun:test";
import { isVerbose, setVerbose, vlog } from "../src/lib/verbose.js";

afterEach(() => {
  setVerbose(false);
});

describe("verbose flag", () => {
  test("defaults to false", () => {
    expect(isVerbose()).toBe(false);
  });

  test("setVerbose toggles state", () => {
    setVerbose(true);
    expect(isVerbose()).toBe(true);
    setVerbose(false);
    expect(isVerbose()).toBe(false);
  });
});

describe("vlog", () => {
  function captureStderr(fn: () => void): string {
    const original = process.stderr.write.bind(process.stderr);
    let captured = "";
    // biome-ignore lint/suspicious/noExplicitAny: stderr.write is overloaded
    (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      fn();
    } finally {
      process.stderr.write = original;
    }
    return captured;
  }

  test("writes to stderr when verbose is on", () => {
    setVerbose(true);
    const out = captureStderr(() => vlog("hello"));
    expect(out).toBe("hello\n");
  });

  test("is a no-op when verbose is off", () => {
    setVerbose(false);
    const out = captureStderr(() => vlog("hello"));
    expect(out).toBe("");
  });
});
