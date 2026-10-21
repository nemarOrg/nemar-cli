/**
 * The pure half of the mechanical change summary (design `.context/plans/pr-review-change-summary.md`
 * sections 2.3, 3, 8.2 and 12): the closed vocabulary, the path shape, how a value is shown to the
 * model, and where two look-alike values first differ. Bytes and strings in, bytes and strings out;
 * nothing here touches git or a file.
 */

import { describe, expect, test } from "bun:test";
import {
  SUMMARY_LIMITS,
  SUMMARY_REFUSALS,
  entityPattern,
  firstDifference,
  renderValue,
} from "../scripts/ci/pr-review-summary";

/** The text exactly as written, backslashes and all: the expectations below are about backslashes. */
const raw = String.raw;

describe("the limits and the refusal words", () => {
  test("the limits are the numbers of design section 5.2, and every one is a positive integer", () => {
    expect(SUMMARY_LIMITS).toEqual({
      maxBlobBytes: 8 * 1024 * 1024,
      maxRows: 200_000,
      maxJsonDepth: 64,
      maxJsonNodes: 200_000,
      maxKeyChars: 128,
      maxRuns: 24,
      maxTotalBytes: 256 * 1024 * 1024,
      maxSummaryChars: 30_000,
      maxClasses: 120,
      maxPairsPerClass: 12,
      maxValueChars: 300,
      samplesPerClass: 2,
      timeReserveMs: 40_000,
    });
    for (const [name, value] of Object.entries(SUMMARY_LIMITS)) {
      expect(Number.isInteger(value) && value > 0, name).toBe(true);
    }
  });

  test("the refusal words are the closed list of design section 10.1, each once and in snake case", () => {
    expect([...SUMMARY_REFUSALS]).toEqual([
      "too_large",
      "nul_byte",
      "invalid_utf8",
      "bare_cr",
      "empty",
      "empty_column_name",
      "duplicate_column",
      "ragged_row",
      "quoted_cell",
      "too_many_rows",
      "no_round_trip",
      "not_json",
      "duplicate_key",
      "too_deep",
      "too_many_nodes",
      "blob_missing",
      "internal_mismatch",
    ]);
    expect(new Set(SUMMARY_REFUSALS).size).toBe(SUMMARY_REFUSALS.length);
    for (const word of SUMMARY_REFUSALS) expect(word).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
  });
});

describe("entityPattern", () => {
  test("every entity value in every segment becomes a star, directories and file name alike", () => {
    expect(entityPattern("sub-001/ses-01/ieeg/sub-001_ses-01_task-sleep_run-01_channels.tsv")).toBe(
      "sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv",
    );
  });

  test("the last entity before the extension is replaced, and values may mix letters and digits", () => {
    expect(entityPattern("sub-A01/eeg/sub-A01_task-rest2_eeg.json")).toBe(
      "sub-*/eeg/sub-*_task-*_eeg.json",
    );
    expect(entityPattern("sub-01_task-sleep.json")).toBe("sub-*_task-*.json");
    expect(entityPattern("Sub-001_x.tsv")).toBe("Sub-*_x.tsv");
  });

  test("the same edit in two subjects has one shape; a different file name has another", () => {
    const a = entityPattern("sub-001/ses-01/eeg/sub-001_ses-01_task-x_channels.tsv");
    const b = entityPattern("sub-125/ses-02/eeg/sub-125_ses-02_task-x_channels.tsv");
    const c = entityPattern("sub-125/ses-02/eeg/sub-125_ses-02_task-x_electrodes.tsv");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("a name without the entity shape is not changed", () => {
    for (const unchanged of [
      "",
      "dataset_description.json",
      "participants.tsv",
      "README",
      "CHANGES",
      "sub-001", // nothing follows the value, so it is not followed by a separator
      "task-sleep",
      "T1-w_x.json", // the label has a digit
      "sub-a-b_x.tsv", // the value is followed by a hyphen
      "task-_x.tsv", // no value
      "sourcedata/raw/events.tsv",
    ]) {
      expect(entityPattern(unchanged), unchanged).toBe(unchanged);
    }
    // With a separator after it the same name is an entity, which is what the exclusions above rest on.
    expect(entityPattern("sub-001/")).toBe("sub-*/");
  });

  test("a shape is stable under a second application", () => {
    const once = entityPattern("sub-001/ses-01/sub-001_ses-01_task-x_run-01_events.tsv");
    expect(entityPattern(once)).toBe(once);
  });
});

describe("renderValue", () => {
  test("a plain value is quoted and not cut", () => {
    expect(renderValue("good")).toEqual({ text: '"good"', cut: false });
    expect(renderValue("")).toEqual({ text: '""', cut: false });
    expect(renderValue("a b")).toEqual({ text: '"a b"', cut: false });
  });

  test("non-ASCII letters that are visible stay as they are", () => {
    expect(renderValue("café 日本 \u{430}").text).toBe('"café 日本 \u{430}"');
  });

  test("a zero-width space is written out, so good and go<ZWSP>od are told apart", () => {
    expect(renderValue("go\u{200B}od").text).toBe(raw`"go\u{200B}od"`);
    expect(renderValue("go\u{200B}od").text).not.toBe(renderValue("good").text);
    expect(renderValue("\u{200D}\u{2060}\u{FEFF}").text).toBe(raw`"\u{200D}\u{2060}\u{FEFF}"`);
  });

  test("a bidi override is written out", () => {
    expect(renderValue("a\u{202E}b").text).toBe(raw`"a\u{202E}b"`);
    expect(renderValue("\u{2066}x\u{2069}").text).toBe(raw`"\u{2066}x\u{2069}"`);
  });

  test("a no-break space is written out, an ordinary space is not", () => {
    expect(renderValue("a\u{A0}b").text).toBe(raw`"a\u{A0}b"`);
    expect(renderValue("a b").text).toBe('"a b"');
    expect(renderValue("a\u{2003}b\u{3000}c\u{2028}d").text).toBe(
      raw`"a\u{2003}b\u{3000}c\u{2028}d"`,
    );
  });

  test("a soft hyphen is written out", () => {
    expect(renderValue("a\u{AD}b").text).toBe(raw`"a\u{AD}b"`);
  });

  test("a lone surrogate is written out and cannot reach the model as a raw code unit", () => {
    const rendered = renderValue("a\uD800b\uDC00").text;
    expect(rendered).toBe(raw`"a\ud800b\udc00"`);
    // Every code unit of the output is a plain one: nothing unpaired is left to be re-encoded.
    for (let i = 0; i < rendered.length; i++) {
      const unit = rendered.charCodeAt(i);
      expect(unit >= 0xd800 && unit <= 0xdfff).toBe(false);
    }
  });

  test("a newline, a carriage return and a tab are escaped, so no value can start a line", () => {
    expect(renderValue("a\nb").text).toBe(raw`"a\nb"`);
    expect(renderValue("a\r\nb").text).toBe(raw`"a\r\nb"`);
    expect(renderValue("a\tb").text).toBe(raw`"a\tb"`);
    expect(renderValue("\u0001\u001F").text).toBe(raw`"\u0001\u001f"`);
    expect(renderValue("a\nC9 | x").text).not.toContain("\n");
  });

  test("other control, private-use and unassigned characters are written out", () => {
    expect(renderValue("\u007F").text).toBe(raw`"\u{7F}"`);
    expect(renderValue("\u0085").text).toBe(raw`"\u{85}"`);
    expect(renderValue("\u{E000}").text).toBe(raw`"\u{E000}"`);
    expect(renderValue("\u{E0001}").text).toBe(raw`"\u{E0001}"`);
    expect(renderValue("\u{378}").text).toBe(raw`"\u{378}"`); // unassigned
  });

  test("a quote and a backslash are escaped, so a value cannot close its own quotes", () => {
    expect(renderValue('say "hi"').text).toBe(raw`"say \"hi\""`);
    expect(renderValue("a\\b").text).toBe(raw`"a\\b"`);
    expect(renderValue('"," -> "').text).toBe(raw`"\",\" -> \""`);
  });

  test("text that spells an escape the platform writes is told from the escape itself", () => {
    // The author typed backslash, u, brace, 200B, brace: six visible characters, doubled backslash.
    const typed = raw`\u{200B}`;
    expect(renderValue(typed).text).toBe(raw`"\\u{200B}"`);
    expect(renderValue(typed).text).not.toBe(renderValue("\u{200B}").text);
    expect(renderValue(raw`\n`).text).toBe(raw`"\\n"`);
    expect(renderValue(raw`\n`).text).not.toBe(renderValue("\n").text);
  });

  test("a value cut at the limit is marked outside its quotes, and the marker is the only thing outside", () => {
    const long = "a".repeat(305);
    const out = renderValue(long);
    expect(out.cut).toBe(true);
    expect(out.text).toBe(`"${"a".repeat(300)}"...(cut)`);
    expect(out.text.endsWith('"...(cut)')).toBe(true);
    expect(renderValue("abcd", 3)).toEqual({ text: '"abc"...(cut)', cut: true });
  });

  test("a value exactly at the limit is not cut, and one more is", () => {
    expect(renderValue("a".repeat(300))).toEqual({ text: `"${"a".repeat(300)}"`, cut: false });
    expect(renderValue("a".repeat(301)).cut).toBe(true);
    expect(renderValue("abc", 3).cut).toBe(false);
    expect(renderValue("abc", 2).cut).toBe(true);
    expect(renderValue("x", 0)).toEqual({ text: '""...(cut)', cut: true });
    expect(renderValue("", 0)).toEqual({ text: '""', cut: false });
  });

  test("a short value that ends in the literal marker is quoted, not cut", () => {
    expect(renderValue("good...(cut)")).toEqual({ text: '"good...(cut)"', cut: false });
    expect(renderValue("...(cut)").cut).toBe(false);
  });

  test("a cut value that already ends in the marker still shows the real marker after the quote", () => {
    const out = renderValue("...(cut)zzzz", 8);
    expect(out.cut).toBe(true);
    expect(out.text).toBe('"...(cut)"...(cut)');
  });

  test("the cut is counted in code points: an astral character is one, and a pair is never split", () => {
    const grin = "\u{1F600}";
    expect(renderValue(grin.repeat(300))).toEqual({ text: `"${grin.repeat(300)}"`, cut: false });
    expect(renderValue(grin.repeat(301)).cut).toBe(true);
    expect(renderValue(`a${grin}b`, 2)).toEqual({ text: `"a${grin}"...(cut)`, cut: true });
    expect(renderValue(`a${grin}b`, 3)).toEqual({ text: `"a${grin}b"`, cut: false });
  });

  test("a lone surrogate counts as one code point toward the cut", () => {
    expect(renderValue("\uD800\uD800x", 2)).toEqual({
      text: raw`"\ud800\ud800"...(cut)`,
      cut: true,
    });
  });

  test("the cut is made before the escapes, so escapes never eat into the limit", () => {
    // 300 newlines render as 600 characters of escapes, and are still not a cut value.
    const out = renderValue("\n".repeat(300));
    expect(out.cut).toBe(false);
    expect(out.text).toBe(`"${raw`\n`.repeat(300)}"`);
    expect(renderValue("\n".repeat(301)).cut).toBe(true);
  });
});

describe("firstDifference", () => {
  test("equal strings have none", () => {
    expect(firstDifference("", "")).toBeNull();
    expect(firstDifference("good", "good")).toBeNull();
    expect(firstDifference("a\u{1F600}b", "a\u{1F600}b")).toBeNull();
  });

  test("the first differing character is named by its 1-based position and both code points", () => {
    expect(firstDifference("abcd", "abXd")).toBe(
      "first difference at character 3: U+0063 to U+0058",
    );
    expect(firstDifference("a", "b")).toBe("first difference at character 1: U+0061 to U+0062");
    expect(firstDifference("good", "go\u{200B}od")).toBe(
      "first difference at character 3: U+006F to U+200B",
    );
  });

  test("hex is uppercase and at least four digits", () => {
    expect(firstDifference("\u0001", "\u0002")).toBe(
      "first difference at character 1: U+0001 to U+0002",
    );
    expect(firstDifference("\u{E9}", "e")).toBe(
      "first difference at character 1: U+00E9 to U+0065",
    );
    expect(firstDifference("a", "\u{430}")).toBe(
      "first difference at character 1: U+0061 to U+0430",
    );
  });

  test("a side that has ended is the word end", () => {
    expect(firstDifference("abc", "abcA")).toBe("first difference at character 4: end to U+0041");
    expect(firstDifference("abcd", "abc")).toBe("first difference at character 4: U+0064 to end");
    expect(firstDifference("", "x")).toBe("first difference at character 1: end to U+0078");
    expect(firstDifference("x", "")).toBe("first difference at character 1: U+0078 to end");
  });

  test("positions count code points, not code units, and a five-digit code point is not padded", () => {
    const grin = "\u{1F600}";
    expect(firstDifference(`a${grin}b`, `a${grin}c`)).toBe(
      "first difference at character 3: U+0062 to U+0063",
    );
    expect(firstDifference(`a${grin}`, "a\u{1F601}")).toBe(
      "first difference at character 2: U+1F600 to U+1F601",
    );
    expect(firstDifference(`${grin}`, "")).toBe("first difference at character 1: U+1F600 to end");
    expect(firstDifference(`${grin}${grin}`, grin)).toBe(
      "first difference at character 2: U+1F600 to end",
    );
  });

  test("a lone surrogate is its own character", () => {
    expect(firstDifference("a\uD800", "a\uD801")).toBe(
      "first difference at character 2: U+D800 to U+D801",
    );
    expect(firstDifference("\uD83D", "\u{1F600}")).toBe(
      "first difference at character 1: U+D83D to U+1F600",
    );
  });
});
