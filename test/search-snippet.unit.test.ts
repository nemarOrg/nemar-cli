/**
 * `src/lib/render/snippet.ts` -- D2 (render the FTS5 snippet, marked terms
 * emphasised, markers stripped), D3 (truncate token lists on the comma
 * boundary, never mid-token), and D7 (a malformed snippet degrades to no
 * snippet line, never a thrown exception) of epic #1144 phase 6 / issue
 * #1150.
 *
 * Content assertions strip any ANSI colour the ambient environment's ambient
 * `FORCE_COLOR` might apply (ANSI emission itself is exercised end-to-end,
 * over a real subprocess, by test/search-color.unit.test.ts) by reusing the
 * already-independently-tested `sanitizeSnippetText` as a normalizer -- this
 * file is about parsing/sanitisation correctness, not about whether chalk
 * decided to colour a given run.
 */

import { describe, expect, test } from "bun:test";
import {
  renderSnippetLine,
  sanitizeSnippetText,
  truncateTokenList,
} from "../src/lib/render/snippet";

/** Strip any ANSI colour so content assertions don't depend on whether this
 *  process's ambient environment happens to have colour forced on. */
function plain(text: string): string {
  return sanitizeSnippetText(text);
}

describe("sanitizeSnippetText (#1150 D2)", () => {
  test("strips an embedded ANSI escape sequence", () => {
    const esc = String.fromCharCode(27);
    const input = `hello ${esc}[31mworld${esc}[39m`;
    expect(sanitizeSnippetText(input)).toBe("hello world");
  });

  test("a carriage return is neutralised, not left able to move the cursor", () => {
    const cr = String.fromCharCode(13);
    expect(sanitizeSnippetText(`weird${cr}value`)).toBe("weird value");
  });

  test("a generic C0 control character (BEL) is removed outright", () => {
    const bel = String.fromCharCode(7);
    expect(sanitizeSnippetText(`a${bel}b`)).toBe("ab");
  });

  test("a NUL byte is removed outright", () => {
    const nul = String.fromCharCode(0);
    expect(sanitizeSnippetText(`a${nul}b`)).toBe("ab");
  });

  test("clean text with no control characters is left unchanged (trimmed)", () => {
    expect(sanitizeSnippetText("  Target (P300 expected)  ")).toBe("Target (P300 expected)");
  });

  test("ANSI and a carriage return together are both neutralised", () => {
    const esc = String.fromCharCode(27);
    const cr = String.fromCharCode(13);
    const input = `${esc}[2mdim${cr}text${esc}[22m`;
    expect(sanitizeSnippetText(input)).toBe("dim text");
  });
});

describe("renderSnippetLine (#1150 D2)", () => {
  test("marked terms are emphasised and the markers themselves are stripped", () => {
    const result = renderSnippetLine(
      "Target (<mark>P300</mark> expected) and Non-Target (no <mark>P300</mark>)",
    );
    expect(result).not.toBeNull();
    const content = plain(result as string);
    expect(content).toBe("Target (P300 expected) and Non-Target (no P300)");
    expect(content).not.toContain("<mark>");
    expect(content).not.toContain("</mark>");
  });

  test("a snippet with no <mark> at all still renders (whole line as one segment)", () => {
    const result = renderSnippetLine("no matches highlighted here");
    expect(result).not.toBeNull();
    expect(plain(result as string)).toBe("no matches highlighted here");
  });

  test("undefined snippet renders no line", () => {
    expect(renderSnippetLine(undefined)).toBeNull();
  });

  test("null snippet renders no line", () => {
    expect(renderSnippetLine(null)).toBeNull();
  });

  test("empty-string snippet renders no line", () => {
    expect(renderSnippetLine("")).toBeNull();
  });

  test("a snippet that is control characters only renders no line, not a blank one", () => {
    const onlyControl = String.fromCharCode(1) + String.fromCharCode(2) + String.fromCharCode(3);
    expect(renderSnippetLine(onlyControl)).toBeNull();
  });

  test("an unbalanced <mark> (no closing tag) does not throw and still renders", () => {
    expect(() => renderSnippetLine("start <mark>never closed")).not.toThrow();
    const result = renderSnippetLine("start <mark>never closed");
    expect(result).not.toBeNull();
  });

  test("an unbalanced </mark> (no opening tag) does not throw and still renders", () => {
    expect(() => renderSnippetLine("never opened</mark> end")).not.toThrow();
    const result = renderSnippetLine("never opened</mark> end");
    expect(result).not.toBeNull();
  });

  test("(#1150 D7) a non-string snippet (API/schema-drift shape) renders no line, does not throw", () => {
    const notAString = 12345 as unknown as string;
    expect(() => renderSnippetLine(notAString)).not.toThrow();
    expect(renderSnippetLine(notAString)).toBeNull();
  });

  test("(#1150 D7) a pathologically long snippet is bounded, not processed in full", () => {
    const long = "x".repeat(5000);
    expect(() => renderSnippetLine(long)).not.toThrow();
    const result = renderSnippetLine(long);
    expect(result).not.toBeNull();
    expect(plain(result as string).length).toBeLessThanOrEqual(400);
  });
});

describe("truncateTokenList (#1150 D3)", () => {
  test("a value within maxWidth is returned unchanged", () => {
    expect(truncateTokenList("eeg", 10)).toBe("eeg");
  });

  test("anat,eeg,fmap at width 10 keeps whole tokens and reports the true remainder", () => {
    // NOT the plan's illustrative "anat,eeg +2": with 3 tokens (anat=4,
    // eeg=3, fmap=4), "anat,eeg" (8 chars) fits within 10 but adding ",fmap"
    // (13 chars) does not, so exactly one token (fmap) is dropped, not two.
    // .rules/documentation.md STRICT: re-derive a plan's arithmetic before
    // repeating it -- this is the corrected, actually-derived value.
    expect(truncateTokenList("anat,eeg,fmap", 10)).toBe("anat,eeg +1");
  });

  test("never cuts a token in half: no result contains a truncated fragment mid-list", () => {
    const result = truncateTokenList("anat,eeg,fmap", 10);
    // The old buggy behaviour was the literal string "anat,eeg,f".
    expect(result).not.toBe("anat,eeg,f");
    for (const part of result.split(" +")[0].split(",")) {
      expect(["anat", "eeg", "fmap"]).toContain(part);
    }
  });

  test("a single token longer than maxWidth (no comma) is ellipsis-truncated", () => {
    const result = truncateTokenList("electroencephalography", 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result.endsWith("…")).toBe(true);
  });

  test("a single over-long leading token still reports the overflow count", () => {
    const result = truncateTokenList("electroencephalography,eeg", 10);
    expect(result).toContain("+1");
    expect(result.startsWith("electroen")).toBe(true);
  });

  test("(#1150 D7) a non-finite maxWidth returns the value unchanged rather than crashing", () => {
    expect(() => truncateTokenList("anat,eeg,fmap", Number.NaN)).not.toThrow();
    expect(truncateTokenList("anat,eeg,fmap", Number.NaN)).toBe("anat,eeg,fmap");
    expect(truncateTokenList("anat,eeg,fmap", Number.POSITIVE_INFINITY)).toBe("anat,eeg,fmap");
  });

  test("(#1150 D7) a zero or negative maxWidth returns the value unchanged rather than crashing", () => {
    expect(() => truncateTokenList("anat,eeg,fmap", 0)).not.toThrow();
    expect(truncateTokenList("anat,eeg,fmap", 0)).toBe("anat,eeg,fmap");
    expect(truncateTokenList("anat,eeg,fmap", -5)).toBe("anat,eeg,fmap");
  });
});
