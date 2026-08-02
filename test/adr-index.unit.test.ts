/**
 * Keeps `.context/decisions/README.md` honest about what is actually on disk.
 *
 * The index is the entry point agents and humans are told to read first
 * (AGENTS.md "START HERE"), so an ADR missing from it is invisible, and an
 * entry pointing at a deleted or renamed file sends the reader nowhere. Both
 * failures are silent — nothing else reads this directory — so a hand-
 * maintained list would rot within a few PRs.
 *
 * Real filesystem, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DECISIONS_DIR = join(import.meta.dir, "../.context/decisions");
const README = join(DECISIONS_DIR, "README.md");

/** Every ADR file on disk, excluding the template and the index itself. */
function adrFiles(): string[] {
  return readdirSync(DECISIONS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md" && f !== "0000-template.md")
    .sort();
}

/** Files linked from the README's index, in the order they appear. */
function indexedFiles(readme: string): string[] {
  return [...readme.matchAll(/\]\((\d{4}-[a-z0-9-]+\.md)\)/g)].map((m) => m[1]);
}

describe("ADR index", () => {
  const readme = readFileSync(README, "utf8");
  const onDisk = adrFiles();
  const indexed = indexedFiles(readme);

  test("there are ADRs to check (guards a silently-vacuous pass)", () => {
    expect(onDisk.length).toBeGreaterThan(0);
  });

  test("every ADR on disk is listed in the index", () => {
    const missing = onDisk.filter((f) => !indexed.includes(f));
    expect(missing).toEqual([]);
  });

  test("every index entry points at a file that exists", () => {
    const dangling = indexed.filter((f) => !onDisk.includes(f));
    expect(dangling).toEqual([]);
  });

  test("the index is in ascending ADR-number order", () => {
    // Reading order is the numbering, so an out-of-order entry means someone
    // appended rather than inserted and the next reader will miss it.
    expect(indexed).toEqual([...indexed].sort());
  });

  test("ADR numbers are unique and gapless from 0001", () => {
    const nums = onDisk.map((f) => Number(f.slice(0, 4)));
    expect(new Set(nums).size).toBe(nums.length);
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1));
  });

  test("every ADR carries a Status and a Date", () => {
    const bad: string[] = [];
    for (const f of onDisk) {
      const body = readFileSync(join(DECISIONS_DIR, f), "utf8");
      if (!/^\*\*Status:\*\*/m.test(body) || !/^\*\*Date:\*\*/m.test(body)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });

  test("every ADR's Status is one of the documented values", () => {
    // proposed | accepted | superseded by ADR-NNNN. A typo here silently
    // removes an ADR from any status-based reading.
    const bad: { file: string; status: string }[] = [];
    for (const f of onDisk) {
      const body = readFileSync(join(DECISIONS_DIR, f), "utf8");
      const status = /^\*\*Status:\*\*\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";
      if (!/^(proposed|accepted|superseded by ADR-\d{4}(\s+and\s+ADR-\d{4})*)$/.test(status)) {
        bad.push({ file: f, status });
      }
    }
    expect(bad).toEqual([]);
  });

  test("a superseded ADR names a target that exists", () => {
    const dangling: string[] = [];
    for (const f of onDisk) {
      const body = readFileSync(join(DECISIONS_DIR, f), "utf8");
      const status = /^\*\*Status:\*\*\s*(.+)$/m.exec(body)?.[1] ?? "";
      for (const [, num] of status.matchAll(/ADR-(\d{4})/g)) {
        if (!onDisk.some((o) => o.startsWith(num))) dangling.push(`${f} -> ADR-${num}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});
