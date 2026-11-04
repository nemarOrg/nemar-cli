/**
 * `terminalSafeText` (epic #1893, phase 4): text from outside, such as a mail subject or body,
 * keeps its newlines and tabs and loses everything that could drive a terminal or reorder what a
 * person reads. CI TIER: unit-pure.
 */

import { describe, expect, test } from "bun:test";
import { displayName, terminalSafeText } from "../src/lib/display-name";

describe("terminalSafeText", () => {
  test("keeps newlines and tabs and ordinary text, including non-ASCII letters", () => {
    expect(terminalSafeText("line one\n\tline two\nnaïve 日本語")).toBe(
      "line one\n\tline two\nnaïve 日本語",
    );
  });

  test("escapes the ESCAPE that starts a terminal sequence", () => {
    expect(terminalSafeText("a\u001b[2Jb")).toBe("a\\x1b[2Jb");
  });

  test("escapes the carriage return, NUL, DEL and a C1 control", () => {
    expect(terminalSafeText("x\ry\u0000z\u007f\u009b")).toBe("x\\ry\\x00z\\x7f\\x9b");
  });

  test("escapes bidirectional overrides, embeddings and isolates, and the line separators", () => {
    expect(terminalSafeText("a\u202eb\u202ac\u2066d\u2069e\u2028f\u2029g")).toBe(
      "a\\u202eb\\u202ac\\u2066d\\u2069e\\u2028f\\u2029g",
    );
  });

  test("escapes direction marks and invisible characters, in both functions", () => {
    const text = "a\u200eb\u200fc\u061cd\u200be\u200cf\u200dg\u2060h\ufeffi";
    const expected = "a\\u200eb\\u200fc\\u061cd\\u200be\\u200cf\\u200dg\\u2060h\\ufeffi";
    expect(terminalSafeText(text)).toBe(expected);
    expect(displayName(text)).toBe(expected);
  });

  test("escapes the other format and look-alike invisible characters", () => {
    const text = "a\u00adb\u034fc\u2061d\u180ee\u115ff\u3164g\ufe0fh\u{e0041}i\u{e0100}j";
    const expected =
      "a\\xadb\\u034fc\\u2061d\\u180ee\\u115ff\\u3164g\\ufe0fh\\u{e0041}i\\u{e0100}j";
    expect(terminalSafeText(text)).toBe(expected);
    expect(displayName(text)).toBe(expected);
  });

  test("keeps ordinary letters from other scripts", () => {
    const text = "Shir\u0101z\u012b \u0634\u06cc\u0631\u0627\u0632 \u5317\u4eac";
    expect(terminalSafeText(text)).toBe(text);
  });

  test("writes every escape the way displayName does", () => {
    const hostile = "\u001b\r\u0000\u007f\u009b\u202e\u2066\u2028";
    expect(terminalSafeText(hostile)).toBe(displayName(hostile));
  });

  test("leaves nothing behind that displayName would escape, apart from newline and tab", () => {
    const all = Array.from({ length: 0xa0 }, (_, i) => String.fromCharCode(i)).join("");
    const out = terminalSafeText(all);
    expect(out.replace(/[\n\t]/g, "")).toBe(displayName(all.replace(/[\n\t]/g, "")));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the point of the test
    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out)).toBe(false);
  });
});
