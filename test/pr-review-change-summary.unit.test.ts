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
  type SummaryRefusal,
  type Table,
  entityPattern,
  firstDifference,
  parseTsv,
  renderValue,
  serializeTsv,
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

// ---------------------------------------------------------------------------------------------
// Tab-separated tables
// ---------------------------------------------------------------------------------------------

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
// Keeps a leading byte order mark, which the default decoder would drop.
const dec = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

/** The refusal word a text gets, or null when it parsed. */
function tsvRefusal(input: string | Uint8Array): SummaryRefusal | null {
  const parsed = parseTsv(typeof input === "string" ? enc(input) : input);
  return parsed.ok ? null : parsed.refusal;
}

/** The table a text parses to; a refusal fails the test with its word. */
function tsvTable(text: string): Table {
  const parsed = parseTsv(enc(text));
  if (!parsed.ok) throw new Error(`refused as ${parsed.refusal}`);
  return parsed.value;
}

describe("parseTsv accepts and describes a plain table", () => {
  test("header, rows and the format of an LF file with a final newline", () => {
    const table = tsvTable("name\ttype\nA1\tEEG\nA2\tEMG\n");
    expect(table.header).toEqual(["name", "type"]);
    expect(table.rows).toEqual([
      ["A1", "EEG"],
      ["A2", "EMG"],
    ]);
    expect(table.format).toEqual({ bom: false, eol: "lf", finalNewline: true });
    expect(table.crByLine).toEqual([false, false, false]);
  });

  test("a header with no rows, with and without a final newline", () => {
    expect(tsvTable("a\tb\n").rows).toEqual([]);
    const bare = tsvTable("a\tb");
    expect(bare.rows).toEqual([]);
    expect(bare.format).toEqual({ bom: false, eol: "none", finalNewline: false });
    expect(bare.crByLine).toEqual([false]);
  });

  test("empty cells are cells: adjacent tabs, a leading tab and a trailing tab", () => {
    const table = tsvTable("a\tb\tc\n\t\t\n1\t\t3\n\t2\t\n");
    expect(table.rows).toEqual([
      ["", "", ""],
      ["1", "", "3"],
      ["", "2", ""],
    ]);
  });

  test("a quote that does not start a cell is data", () => {
    const table = tsvTable('a\tb\nsay "hi"\tit\'s\n');
    expect(table.rows).toEqual([['say "hi"', "it's"]]);
  });

  test("a blank line is a row with an empty cell in a one-column table, and 'a' + LF is not 'a' + blank", () => {
    expect(tsvTable("a\n").rows).toEqual([]);
    expect(tsvTable("a\n\n").rows).toEqual([[""]]);
    expect(tsvTable("a\n\n\n").rows).toEqual([[""], [""]]);
  });

  test("the first character of a file that is a second byte order mark is data, not a second BOM", () => {
    const table = tsvTable("\u{FEFF}\u{FEFF}a\tb\n");
    expect(table.format.bom).toBe(true);
    expect(table.header).toEqual(["\u{FEFF}a", "b"]);
  });
});

describe("parseTsv records the byte order mark and the line endings", () => {
  test("a BOM is removed from the first name and recorded", () => {
    const table = tsvTable("\u{FEFF}a\tb\n1\t2\n");
    expect(table.header).toEqual(["a", "b"]);
    expect(table.format).toEqual({ bom: true, eol: "lf", finalNewline: true });
  });

  test("CRLF throughout", () => {
    const table = tsvTable("a\tb\r\n1\t2\r\n");
    expect(table.format).toEqual({ bom: false, eol: "crlf", finalNewline: true });
    expect(table.crByLine).toEqual([true, true]);
    expect(table.header).toEqual(["a", "b"]);
    expect(table.rows).toEqual([["1", "2"]]);
  });

  test("mixed endings are kept line by line", () => {
    const table = tsvTable("a\tb\r\n1\t2\n3\t4\r\n5\t6\n");
    expect(table.format.eol).toBe("mixed");
    expect(table.crByLine).toEqual([true, false, true, false]);
    expect(dec(serializeTsv(table))).toBe("a\tb\r\n1\t2\n3\t4\r\n5\t6\n");
  });

  test("an unterminated last line has no ending, and the ones before it decide the style", () => {
    const lf = tsvTable("a\n1");
    expect(lf.format).toEqual({ bom: false, eol: "lf", finalNewline: false });
    expect(lf.crByLine).toEqual([false, false]);
    const crlf = tsvTable("a\r\n1\r\n2");
    expect(crlf.format).toEqual({ bom: false, eol: "crlf", finalNewline: false });
    expect(crlf.crByLine).toEqual([true, true, false]);
  });

  test("a file with no terminated line has no line ending", () => {
    expect(tsvTable("a\tb").format.eol).toBe("none");
  });

  test("a CR that is not the one before a terminating LF is refused, and the kept one is per line", () => {
    expect(tsvRefusal("a\tb\r\n1\t2\r\n")).toBeNull();
    expect(tsvRefusal("a\tb\r\r\n1\t2\n")).toBe("bare_cr");
  });
});

describe("parseTsv refuses, with one closed word per fault", () => {
  test("too_large: one byte over 8 MiB, and exactly 8 MiB is read", () => {
    const limit = SUMMARY_LIMITS.maxBlobBytes;
    expect(tsvRefusal(new Uint8Array(limit + 1).fill(97))).toBe("too_large");
    const exact = enc(`a\n${"x".repeat(limit - 2)}`);
    expect(exact.length).toBe(limit);
    expect(tsvRefusal(exact)).toBeNull();
  });

  test("nul_byte", () => {
    expect(tsvRefusal("a\tb\n1\t\u{0}\n")).toBe("nul_byte");
    expect(tsvRefusal(Uint8Array.of(0))).toBe("nul_byte");
    expect(tsvRefusal(Uint8Array.of(0x61, 0x0a, 0x00))).toBe("nul_byte");
  });

  test("invalid_utf8: a stray byte, an overlong form, an encoded surrogate, a truncated sequence, too high", () => {
    for (const bad of [
      [0xff],
      [0x61, 0x09, 0x80, 0x0a],
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0xe2, 0x82],
      [0xf4, 0x90, 0x80, 0x80],
    ]) {
      expect(tsvRefusal(Uint8Array.from(bad)), bad.join(",")).toBe("invalid_utf8");
    }
    // Latin-1 and Shift-JIS bytes are the real cases (design section 3.3): the micro sign and a unit.
    expect(tsvRefusal(Uint8Array.from([0x61, 0x0a, 0xb5, 0x56, 0x0a]))).toBe("invalid_utf8");
    expect(tsvRefusal(Uint8Array.from([0x83, 0xca]))).toBe("invalid_utf8");
  });

  test("bare_cr: inside a line, before a CRLF, and ending an unterminated last line", () => {
    expect(tsvRefusal("a\tb\n1\r2\t3\n")).toBe("bare_cr");
    expect(tsvRefusal("a\tb\n1\t2\r")).toBe("bare_cr");
    expect(tsvRefusal("a\tb\r\n1\t2\r")).toBe("bare_cr");
    expect(tsvRefusal("a\r\rb\n")).toBe("bare_cr");
    expect(tsvRefusal("a\r\r\nb\n")).toBe("bare_cr");
    expect(tsvRefusal("\r")).toBe("bare_cr");
    expect(tsvRefusal("a\tb\r\n1\t2\r\n")).toBeNull();
  });

  test("empty: no bytes, and nothing after a byte order mark", () => {
    expect(tsvRefusal("")).toBe("empty");
    expect(tsvRefusal(new Uint8Array(0))).toBe("empty");
    expect(tsvRefusal("\u{FEFF}")).toBe("empty");
  });

  test("a lone line break is one empty line, whose header has an empty name", () => {
    expect(tsvRefusal("\n")).toBe("empty_column_name");
    expect(tsvRefusal("\r\n")).toBe("empty_column_name");
  });

  test("empty_column_name: in the middle, at the end and at the start", () => {
    expect(tsvRefusal("a\t\tb\n1\t2\t3\n")).toBe("empty_column_name");
    expect(tsvRefusal("a\t\n1\t2\n")).toBe("empty_column_name");
    expect(tsvRefusal("\tb\n1\t2\n")).toBe("empty_column_name");
  });

  test("duplicate_column", () => {
    expect(tsvRefusal("a\tb\ta\n1\t2\t3\n")).toBe("duplicate_column");
    expect(tsvRefusal("a\ta\n")).toBe("duplicate_column");
    // Names that differ only in case, or by a trailing space, are different names.
    expect(tsvRefusal("a\tA\ta \n")).toBeNull();
  });

  test("ragged_row: too few cells, too many, a blank line, and a trailing blank line", () => {
    expect(tsvRefusal("a\tb\n1\n")).toBe("ragged_row");
    expect(tsvRefusal("a\tb\n1\t2\t3\n")).toBe("ragged_row");
    expect(tsvRefusal("a\tb\n\n1\t2\n")).toBe("ragged_row");
    expect(tsvRefusal("a\tb\n1\t2\n\n")).toBe("ragged_row");
    expect(tsvRefusal("a\tb\n1\t2\n3")).toBe("ragged_row");
  });

  test("quoted_cell: in the header, in a cell, in the first and in a later column", () => {
    expect(tsvRefusal('"a"\tb\n1\t2\n')).toBe("quoted_cell");
    expect(tsvRefusal('a\t"b\n1\t2\n')).toBe("quoted_cell");
    expect(tsvRefusal('a\tb\n"1"\t2\n')).toBe("quoted_cell");
    expect(tsvRefusal('a\tb\n1\t"2\n')).toBe("quoted_cell");
    expect(tsvRefusal('a\tb\n1\t2\n3\t"4 5"\n')).toBe("quoted_cell");
    expect(tsvRefusal("a\tb\n1\t2\n3\t'4'\n")).toBeNull();
  });

  test("too_many_rows: 200,001 data rows are refused and 200,000 are read", () => {
    const rows = (n: number) => `a\n${"x\n".repeat(n)}`;
    expect(tsvRefusal(rows(SUMMARY_LIMITS.maxRows))).toBeNull();
    expect(tsvRefusal(rows(SUMMARY_LIMITS.maxRows + 1))).toBe("too_many_rows");
  });

  test("no_round_trip: a serializer that loses a byte is caught by the guard, which would otherwise pass", () => {
    const bytes = enc("a\tb\n1\t2\n3\t4\n");
    const honest = parseTsv(bytes);
    expect(honest.ok).toBe(true);

    const dropsARow = parseTsv(bytes, (t) => serializeTsv({ ...t, rows: t.rows.slice(1) }));
    expect(dropsARow).toEqual({ ok: false, refusal: "no_round_trip" });

    const losesTheFinalNewline = parseTsv(bytes, (t) =>
      serializeTsv({ ...t, format: { ...t.format, finalNewline: false } }),
    );
    expect(losesTheFinalNewline).toEqual({ ok: false, refusal: "no_round_trip" });

    const losesOneByte = parseTsv(bytes, (t) => serializeTsv(t).slice(0, -1));
    expect(losesOneByte).toEqual({ ok: false, refusal: "no_round_trip" });

    const changesOneByte = parseTsv(bytes, (t) => {
      const out = serializeTsv(t).slice();
      out[0] = 0x58;
      return out;
    });
    expect(changesOneByte).toEqual({ ok: false, refusal: "no_round_trip" });

    // The guard is the last step: a file with an earlier fault keeps that fault's word.
    expect(parseTsv(enc("a\ta\n"), () => new Uint8Array(0))).toEqual({
      ok: false,
      refusal: "duplicate_column",
    });
  });

  test("the guard is handed the parsed table and a faithful serializer passes", () => {
    const bytes = enc("\u{FEFF}a\tb\r\n1\t2\n");
    let seen: Table | null = null;
    const parsed = parseTsv(bytes, (t) => {
      seen = t;
      return serializeTsv(t);
    });
    expect(parsed.ok).toBe(true);
    expect((seen as Table | null)?.header).toEqual(["a", "b"]);
    expect((seen as Table | null)?.format.bom).toBe(true);
  });

  test("when a file has several faults the first step to fail names it", () => {
    // NUL before invalid UTF-8 before bare CR before empty names before duplicates before ragged
    // rows before quoted cells.
    expect(tsvRefusal(Uint8Array.from([0xff, 0x00]))).toBe("nul_byte");
    expect(tsvRefusal(Uint8Array.from([0x22, 0x0d, 0xff]))).toBe("invalid_utf8");
    expect(tsvRefusal('"a"\t\r\n')).toBe("empty_column_name");
    expect(tsvRefusal('"a"\tb\r1\n')).toBe("bare_cr");
    expect(tsvRefusal('\ta\ta\n"1"\n')).toBe("empty_column_name");
    expect(tsvRefusal('a\ta\n"1"\n')).toBe("duplicate_column");
    expect(tsvRefusal('a\tb\n"1"\n')).toBe("ragged_row");
    expect(tsvRefusal(`a\n${"x\n".repeat(SUMMARY_LIMITS.maxRows)}"y\ty\n`)).toBe("ragged_row");
    expect(tsvRefusal(`a\n${"x\n".repeat(SUMMARY_LIMITS.maxRows + 1)}"y\n`)).toBe("too_many_rows");
  });
});

describe("serializeTsv and parseTsv round-trip every table the parser accepts", () => {
  test("hand-made files of every style come back byte for byte", () => {
    for (const text of [
      "a\tb\n1\t2\n",
      "a\tb\r\n1\t2\r\n",
      "a\tb\r\n1\t2\n3\t4\r\n",
      "a\tb\n1\t2",
      "a\tb\r\n1\t2",
      "a\tb",
      "a\n",
      "a\n\n",
      "a",
      "\u{FEFF}a\tb\n1\t2\n",
      "\u{FEFF}a\tb\r\n1\t2",
      "a\tb\n\t\n\t",
      "\u{E9}\t\u{65E5}\u{672C}\n\u{1F600}\t\u{200B}\n",
      "a\u{FEFF}\tb\n1\t2\n",
    ]) {
      const bytes = enc(text);
      const parsed = parseTsv(bytes);
      if (!parsed.ok) throw new Error(`${JSON.stringify(text)} was refused as ${parsed.refusal}`);
      expect(dec(serializeTsv(parsed.value)), JSON.stringify(text)).toBe(text);
    }
  });

  test("a generated table of every style parses to its cells and serializes to its bytes", () => {
    const random = seeded(20261020);
    const cases = 3000;
    const seen = { bom: 0, lf: 0, crlf: 0, mixed: 0, none: 0, noFinal: 0, emptyCell: 0, wide: 0 };

    for (let n = 0; n < cases; n++) {
      const made = generateTable(random);
      const bytes = enc(made.text);
      const parsed = parseTsv(bytes);
      if (!parsed.ok) {
        throw new Error(`case ${n}: ${JSON.stringify(made.text)} refused as ${parsed.refusal}`);
      }

      expect(parsed.value.header, `case ${n}`).toEqual(made.header);
      expect(parsed.value.rows, `case ${n}`).toEqual(made.rows);
      expect(parsed.value.format, `case ${n}`).toEqual(made.format);
      expect(parsed.value.crByLine, `case ${n}`).toEqual(made.crByLine);

      const back = serializeTsv(parsed.value);
      expect(sameBytes(back, bytes), `case ${n}: ${JSON.stringify(made.text)}`).toBe(true);

      const again = parseTsv(back);
      expect(again.ok, `case ${n}`).toBe(true);
      if (again.ok) expect(again.value, `case ${n}`).toEqual(parsed.value);

      if (made.format.bom) seen.bom++;
      seen[made.format.eol]++;
      if (!made.format.finalNewline) seen.noFinal++;
      if (made.rows.some((row) => row.includes(""))) seen.emptyCell++;
      if (made.header.length >= 5) seen.wide++;
    }

    // The generator reaches every style, so the loop above is a test of all of them.
    for (const [style, count] of Object.entries(seen)) expect(count, style).toBeGreaterThan(50);
  });
});

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** A small seeded generator (mulberry32), so a failing case can be reproduced from its number. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELL_POOL = [
  "",
  "",
  "",
  " ",
  "n/a",
  "0",
  "-3",
  "1.5",
  "x",
  "word",
  "two words",
  "trailing ",
  " leading",
  "\u{E9}",
  "\u{65E5}\u{672C}",
  "\u{1F600}",
  'a"b',
  "it's",
  "\\",
  '{"k": 1}',
  "=1",
  "\u{200B}",
  "\u{A0}x",
  "a,b",
  ";",
  "\u{FEFF}",
  "a\u{FEFF}",
];

interface GeneratedTable extends Table {
  text: string;
}

/**
 * A table built from its cells, with the text WRITTEN BY THIS FUNCTION (not by `serializeTsv`), so
 * the parse is checked against an oracle that shares no code with the serializer: cells from a pool
 * that holds empty cells, non-ASCII and invisible characters and quotes that do not start a cell;
 * tabs only as separators; a byte order mark, LF, CRLF or per-line mixed endings, and a missing
 * final newline, each at random.
 */
function generateTable(random: () => number): GeneratedTable {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const columns = 1 + Math.floor(random() * 6);
  const header = Array.from(
    { length: columns },
    (_, i) => `${i}_${pick(["id", "name", "\u{E9}t\u{E9}", "x y"])}`,
  );
  const rowCount = Math.floor(random() * 9);
  const rows = Array.from({ length: rowCount }, () =>
    Array.from({ length: columns }, () => pick(CELL_POOL)),
  );

  const bom = random() < 0.35;
  const finalNewline = random() < 0.7;
  const style = pick(["lf", "crlf", "mixed"] as const);

  // An unterminated last line holding only an empty cell is no line at all, so it cannot be one.
  const last = rows.length > 0 ? rows[rows.length - 1] : header;
  if (!finalNewline && columns === 1 && last?.[0] === "") (last as string[])[0] = "x";

  const lines = [header, ...rows];
  const crByLine: boolean[] = [];
  let text = bom ? "\u{FEFF}" : "";
  let terminated = 0;
  let crlf = 0;
  lines.forEach((cells, i) => {
    const ended = i < lines.length - 1 || finalNewline;
    const cr = ended && (style === "crlf" || (style === "mixed" && random() < 0.5));
    crByLine.push(cr);
    text += cells.join("\t") + (ended ? (cr ? "\r\n" : "\n") : "");
    if (ended) terminated++;
    if (cr) crlf++;
  });
  const eol =
    terminated === 0 ? "none" : crlf === 0 ? "lf" : crlf === terminated ? "crlf" : "mixed";
  return { text, header, rows, crByLine, format: { bom, eol, finalNewline } };
}
