/** The corrective-action ledger: its shape, and that nothing but counts and fixed words gets in. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEntry } from "../../scripts/scrub/contract";
import {
  LEDGER_REPO_PATH,
  LedgerRefused,
  appendLedger,
  changeLogEntry,
  ledgerLine,
  ledgerS3Key,
  parseLedgerText,
  readLedger,
  validateLedgerEntry,
} from "../../scripts/scrub/ledger";

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  version: 1,
  at: "2026-10-04T21:00:00.000Z",
  dataset: "nm000348",
  action: "headers-scrubbed",
  versions: ["v1.0.1", "v1.0.2", "v1.0.5"],
  counts: { fields_scrubbed: 525, files_removed: 7 },
  scanner: "identifier-scan@4758fcf",
  verification: "scanner-clean+payload-identical",
  actor: "yahya",
  ...over,
});

describe("a valid entry", () => {
  test("round-trips as one JSON line", () => {
    const line = ledgerLine(entry());
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual(entry());
  });

  test("lives at fixed locations", () => {
    expect(LEDGER_REPO_PATH).toBe(".nemar/corrections.jsonl");
    expect(ledgerS3Key("nm000348")).toBe("nm000348/corrections/ledger.jsonl");
  });

  test("appends to a file and reads back, validating every line", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    try {
      const path = join(dir, "a", "ledger.jsonl");
      appendLedger(path, entry());
      appendLedger(path, entry({ action: "history-rewritten" }));
      expect(readFileSync(path, "utf8").trim().split("\n").length).toBe(2);
      expect(readLedger(path).map((e) => e.action)).toEqual([
        "headers-scrubbed",
        "history-rewritten",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what the ledger refuses", () => {
  const refused = (over: Partial<LedgerEntry> | Record<string, unknown>, field: string) => {
    try {
      validateLedgerEntry({ ...entry(), ...over } as LedgerEntry);
      throw new Error("not refused");
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerRefused);
      expect((e as LedgerRefused).field).toBe(field);
    }
  };

  test("free text in verification, scanner or actor", () => {
    refused({ verification: "alice smith looked at it" }, "verification");
    refused({ verification: "scanner-clean+typo" }, "verification");
    refused({ scanner: "alice" }, "scanner");
    refused({ actor: "Alice Smith" }, "actor");
    refused({ actor: "" }, "actor");
  });

  test("a count that is not a non-negative number, or a per-file list", () => {
    refused({ counts: { files: -1 } }, "counts");
    refused({ counts: { files: "525" } as unknown as Record<string, number> }, "counts");
    refused({ counts: { Alice: 1 } }, "counts");
    refused({ counts: [1, 2] as unknown as Record<string, number> }, "counts");
  });

  test("a bad dataset, action, version or time, and any extra field", () => {
    refused({ dataset: "nm000348/../x" }, "dataset");
    refused({ action: "deleted-everything" as LedgerEntry["action"] }, "action");
    refused({ versions: ["latest"] }, "versions");
    refused({ at: "yesterday" }, "at");
    refused({ participants: ["x"] }, "extra-field");
    refused({ version: 2 as 1 }, "version");
  });

  test("a bad line makes the whole file refuse to read", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    try {
      const path = join(dir, "l.jsonl");
      appendLedger(path, entry());
      require("node:fs").appendFileSync(path, `${JSON.stringify({ ...entry(), actor: "A B" })}\n`);
      expect(() => readLedger(path)).toThrow(LedgerRefused);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the change-log sentence", () => {
  test("says that a privacy correction was made, to which versions, and nothing about what", () => {
    const text = changeLogEntry("2026-10-04", ["v1.0.1", "v1.0.2", "v1.0.5"]);
    expect(text).toContain("privacy correction");
    expect(text).toContain("v1.0.1 to v1.0.5");
    expect(text).toContain(LEDGER_REPO_PATH);
    expect(text).not.toMatch(/name|birth|patient|date of/i);
    expect(changeLogEntry("2026-10-04", ["v1.0.0"])).toContain("from v1.0.0.");
  });

  test("refuses a bad date or no versions", () => {
    expect(() => changeLogEntry("4 October", ["v1.0.0"])).toThrow(LedgerRefused);
    expect(() => changeLogEntry("2026-10-04", [])).toThrow(LedgerRefused);
    expect(() => changeLogEntry("2026-10-04", ["latest"])).toThrow(LedgerRefused);
  });
});

describe("a deletion line carries its proof (I9)", () => {
  const proof = "+proof-0123456789abcdef";
  test("old-versions-deleted needs the listing's word and a proof hash; nothing else may claim them", () => {
    const ok = entry({
      action: "old-versions-deleted",
      verification: `authoritative-listing-empty${proof}`,
    });
    expect(validateLedgerEntry(ok)).toEqual(ok);
    for (const [label, over] of [
      [
        "deletion without proof",
        { action: "old-versions-deleted", verification: "authoritative-listing-empty" },
      ],
      [
        "deletion, another word",
        { action: "old-versions-deleted", verification: `scanner-clean${proof}` },
      ],
      ["deletion, no word", { action: "old-versions-deleted", verification: "none" }],
      [
        "listing claimed by another action",
        { verification: `authoritative-listing-empty${proof}` },
      ],
      ["listing without proof elsewhere", { verification: "authoritative-listing-empty" }],
      ["proof on another word", { verification: `scanner-clean${proof}` }],
      [
        "proof not hex",
        {
          action: "old-versions-deleted",
          verification: "authoritative-listing-empty+proof-zzzzzzzzzzzzzzzz",
        },
      ],
      [
        "proof too long",
        { action: "old-versions-deleted", verification: `authoritative-listing-empty${proof}00` },
      ],
    ] as const) {
      expect(() => validateLedgerEntry(entry(over as Partial<LedgerEntry>)), label).toThrow(
        LedgerRefused,
      );
    }
  });
});

describe("parseLedgerText", () => {
  test("validates every line of the text it is given, and agrees with the file reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-parse-"));
    try {
      const text = `${ledgerLine(entry())}\n${ledgerLine(entry({ action: "files-removed" }))}\n`;
      expect(parseLedgerText(text).map((e) => e.action)).toEqual([
        "headers-scrubbed",
        "files-removed",
      ]);
      appendLedger(join(dir, "l.jsonl"), entry());
      expect(parseLedgerText(readFileSync(join(dir, "l.jsonl"), "utf8"))).toEqual(
        readLedger(join(dir, "l.jsonl")),
      );
      // One bad line refuses the whole text, the good one before it notwithstanding.
      const bad = `${ledgerLine(entry())}\n${JSON.stringify({ ...entry(), counts: { files_removed: -1 } })}\n`;
      expect(() => parseLedgerText(bad)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
