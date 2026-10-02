/**
 * The participants.tsv reader (epic #1586, phase 1).
 *
 * It must read a table the way `pandas.read_csv(sep="\t", keep_default_na=False,
 * dtype=str)` does, because that is how `bagel pheno` reads it.
 * That agreement was measured once, cell by cell, over every participants.tsv in
 * the public catalog at the time of writing (732 files, 0 disagreements, the
 * byte order mark aside, which this reader drops on purpose); the real fixtures
 * and the recorded bagel runs (neurobagel-oracle.unit.test.ts) keep it honest
 * afterwards.
 * The inline tables below are SYNTHETIC: they pin one behaviour each.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_ROOT } from "../scripts/neurobagel/fixtures-io";
import { parseTsv } from "../shared/neurobagel/tsv";

const table = (text: string) => {
  const result = parseTsv(text);
  if (!result.ok) throw new Error(`expected a table, got ${result.error}`);
  return result.table;
};

describe("parseTsv", () => {
  test("cells are the exact text between tabs: n/a stays n/a, numbers stay text", () => {
    expect(table("a\tb\n1\tn/a\n002\t 3\n").rows).toEqual([
      ["1", "n/a"],
      ["002", " 3"],
    ]);
  });

  test("a byte order mark is dropped and reported", () => {
    const result = parseTsv("﻿participant_id\tage\nsub-1\t20\n");
    expect(result.ok && result.bomStripped).toBe(true);
    expect(result.ok && result.table.header).toEqual(["participant_id", "age"]);
  });

  test("CRLF, LF and CR-only line endings all end a record", () => {
    for (const eol of ["\r\n", "\n", "\r"]) {
      expect(table(`a\tb${eol}1\t2${eol}3\t4${eol}`).rows).toEqual([
        ["1", "2"],
        ["3", "4"],
      ]);
    }
  });

  test("blank lines are skipped, and a missing final newline does not matter", () => {
    expect(table("a\tb\n\n1\t2\n\n3\t4").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("a field is quoted only when it STARTS with a quote; inside, tabs, newlines and doubled quotes are data", () => {
    expect(table('a\tb\n"x\ty"\t"line1\nline2"\n"say ""hi"""\tz\n').rows).toEqual([
      ["x\ty", "line1\nline2"],
      ['say "hi"', "z"],
    ]);
    // A quote in the middle of a field is an ordinary character, as in pandas' C tokenizer.
    expect(table('a\tb\n5\'10"\tx"y\n').rows).toEqual([["5'10\"", 'x"y']]);
  });

  test("a short row is padded with empty cells; a trailing tab is an empty last cell", () => {
    expect(table("a\tb\tc\n1\n2\t3\t\n").rows).toEqual([
      ["1", "", ""],
      ["2", "3", ""],
    ]);
  });

  test("a row longer than the header is an error, as it is in pandas", () => {
    const result = parseTsv("a\tb\n1\t2\t3\n");
    expect(result).toEqual({ ok: false, error: "ragged_row", line: 2 });
  });

  test("an unterminated quote is an error, not a swallowed file", () => {
    expect(parseTsv('a\tb\n"1\t2\n')).toEqual({ ok: false, error: "unterminated_quote", line: 2 });
  });

  test("an empty file, or one that is only blank lines, is an error", () => {
    expect(parseTsv("").ok).toBe(false);
    expect(parseTsv("\n\n").ok).toBe(false);
  });

  test("a header with no rows is a table with no rows", () => {
    expect(table("participant_id\tage\n").rows).toEqual([]);
  });

  test("a real quoted field with commas inside survives (nm000229, MEG-MASC)", () => {
    const text = readFileSync(join(FIXTURE_ROOT, "nm000229", "participants.tsv"), "utf8");
    const parsed = table(text);
    const column = parsed.header.indexOf("task_order");
    expect(column).toBeGreaterThan(0);
    expect(parsed.rows[0][column]).toBe("[0, 1, 2, 3]");
    expect(parsed.rows.every((row) => row.length === parsed.header.length)).toBe(true);
  });

  test("a real CR-only file (on002712) reads as separate rows", () => {
    const text = readFileSync(join(FIXTURE_ROOT, "on002712", "participants.tsv"), "utf8");
    // Records are separated by a lone CR; the only LF is the one that ends the file.
    expect(text.trimEnd()).not.toContain("\n");
    expect(table(text).rows.length).toBe(28);
  });
});
