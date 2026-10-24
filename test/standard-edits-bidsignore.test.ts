/**
 * The `.bidsignore` edit at its shared home (`shared/standard-edits/bidsignore.ts`).
 *
 * The two places that make this edit keep their own copies for now (the backend's enrichment
 * commit and the upload's metadata step). The upstream re-pull's planner (ADR 0111) recognizes
 * the edit by calling the shared function, so this file holds that function to the upload's copy:
 * it runs the real `writeNemarMetadata` on a directory for each starting `.bidsignore` and
 * compares the bytes it leaves with what the shared function returns.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEMAR_BIDSIGNORE_ENTRY, withBidsignoreEntry } from "../shared/standard-edits/bidsignore";
import { initUploadProgress } from "../src/lib/upload-progress";
import { writeNemarMetadata } from "../src/lib/upload/finalize";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const ENRICHMENT = { version: "2.0" as const, authors: { "A. Author": {} } };

/** What the upload's metadata step leaves in `.bidsignore`, starting from `before` (null: absent). */
function viaUpload(before: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "standard-edits-bidsignore-"));
  scratch.push(dir);
  if (before !== null) writeFileSync(join(dir, ".bidsignore"), before);
  const progress = initUploadProgress(dir, "nm000001", [{ path: "sub-01/x.edf", size: 1 }]);
  writeNemarMetadata(dir, ENRICHMENT, progress);
  const path = join(dir, ".bidsignore");
  if (!existsSync(path)) throw new Error("the upload step left no .bidsignore");
  return readFileSync(path, "utf8");
}

describe("withBidsignoreEntry", () => {
  test("the entry is .nemar/", () => {
    expect(NEMAR_BIDSIGNORE_ENTRY).toBe(".nemar/");
  });

  const STARTS: Record<string, string | null> = {
    absent: null,
    empty: "",
    "whitespace only": "  \n\t",
    "one line, no newline": "derivatives/",
    "one line, newline": "derivatives/\n",
    "trailing blank lines": "derivatives/\n\n\n",
    "CRLF endings": "derivatives/\r\nsourcedata/\r\n",
    "already there": "derivatives/\n.nemar/\n",
    "already there inside another line": "# keep .nemar/ out\n",
    "a similar entry only": "nemar_metadata.json\n.nemar\n",
    "non-ASCII": "données/\n",
  };

  for (const [name, before] of Object.entries(STARTS)) {
    test(`matches the upload's copy byte for byte: ${name}`, () => {
      const shared = withBidsignoreEntry(before ?? "", NEMAR_BIDSIGNORE_ENTRY);
      expect(viaUpload(before)).toBe(shared.content);
      expect(shared.changed).toBe(shared.content !== (before ?? ""));
    });
  }

  test("an entry already present changes nothing and returns the same text", () => {
    const before = "derivatives/\n.nemar/\n";
    expect(withBidsignoreEntry(before, NEMAR_BIDSIGNORE_ENTRY)).toEqual({
      content: before,
      changed: false,
    });
  });

  test("applying it twice is applying it once", () => {
    const once = withBidsignoreEntry("derivatives/  \n\n", NEMAR_BIDSIGNORE_ENTRY);
    expect(once).toEqual({ content: "derivatives/\n.nemar/\n", changed: true });
    expect(withBidsignoreEntry(once.content, NEMAR_BIDSIGNORE_ENTRY)).toEqual({
      content: once.content,
      changed: false,
    });
  });

  test("several entries in turn, as the backend's enrichment commit applies its list", () => {
    let content = "";
    for (const entry of ["nemar_metadata.json", ".nemar/"]) {
      content = withBidsignoreEntry(content, entry).content;
    }
    expect(content).toBe("nemar_metadata.json\n.nemar/\n");
  });
});
