/**
 * The `.bidsignore` edit at its shared home (`shared/standard-edits/bidsignore.ts`).
 *
 * The two places that make this edit keep their own copies for now (the backend's enrichment
 * commit and the upload's metadata step); #1918 owns folding them into the shared function. The
 * upstream re-pull's planner (ADR 0111) recognizes the edit by calling the shared function, so
 * this file holds that function to BOTH copies, byte for byte, for each starting `.bidsignore`:
 *
 * - the upload's: the real `writeNemarMetadata` runs on a directory;
 * - the backend's: `commitEnrichmentWithBidsignore` reaches it only through GitHub, so its loop
 *   over the entries is taken from the parsed source of `backend/src/services/github/contents.ts`
 *   (comments dropped) and run as written, and the `.nemar/` entry its callers pass is read from
 *   their source too.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
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

const BACKEND = join(import.meta.dir, "../backend/src");

function parse(relative: string): ts.SourceFile {
  const path = join(BACKEND, relative);
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function nodesOf(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/**
 * The backend's copy of the rule, as it is written: the `for (const entry of
 * bidsignoreEntriesToIgnore)` loop inside `commitEnrichmentWithBidsignore`, printed without
 * comments, compiled, and run over the content and entries it is given.
 */
function backendRule(): (
  content: string,
  entries: string[],
) => { content: string; changed: boolean } {
  const file = parse("services/github/contents.ts");
  const fn = nodesOf(file).find(
    (n): n is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(n) && n.name?.text === "commitEnrichmentWithBidsignore",
  );
  if (!fn) throw new Error("commitEnrichmentWithBidsignore is not in contents.ts");
  const loops = nodesOf(fn).filter(
    (n): n is ts.ForOfStatement =>
      ts.isForOfStatement(n) && n.expression.getText(file) === "bidsignoreEntriesToIgnore",
  );
  if (loops.length !== 1)
    throw new Error(`expected one loop over the entries, found ${loops.length}`);
  const printed = ts
    .createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Unspecified, loops[0] as ts.Node, file);
  const js = ts.transpileModule(printed, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  const body = `let bidsignoreUpdated = false;\n${js.outputText}\nreturn { content: bidsignoreContent, changed: bidsignoreUpdated };`;
  return new Function("bidsignoreContent", "bidsignoreEntriesToIgnore", body) as (
    content: string,
    entries: string[],
  ) => { content: string; changed: boolean };
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

  const backend = backendRule();
  for (const [name, before] of Object.entries(STARTS)) {
    test(`matches the backend's copy byte for byte: ${name}`, () => {
      // The backend reads an absent .bidsignore as "", as the shared function is given here.
      for (const entries of [[NEMAR_BIDSIGNORE_ENTRY], ["nemar_metadata.json", ".nemar/"]]) {
        let content = before ?? "";
        let changed = false;
        for (const entry of entries) {
          const step = withBidsignoreEntry(content, entry);
          content = step.content;
          changed ||= step.changed;
        }
        expect(backend(before ?? "", entries), entries.join(",")).toEqual({ content, changed });
      }
    });
  }

  test("the backend's callers pass the shared entry", () => {
    // The enrichment pipeline's entry list, at its one call site.
    const enrich = parse("services/enrich-dataset.ts");
    const payloads = nodesOf(enrich).filter(
      (n): n is ts.CallExpression =>
        ts.isCallExpression(n) && n.expression.getText(enrich) === "buildEnrichmentCommitPayload",
    );
    expect(payloads.map((c) => (c.arguments[1] as ts.Node).getText(enrich))).toEqual([
      JSON.stringify([NEMAR_BIDSIGNORE_ENTRY]),
    ]);
    // The admin route's v2 branch (`isV2 ? [".nemar/"] : ["nemar_metadata.json"]`).
    const route = parse("routes/admin/doi.ts");
    const lists = nodesOf(route)
      .filter(ts.isVariableDeclaration)
      .filter((d) => d.name.getText(route) === "entriesToIgnore")
      .map((d) => d.initializer)
      .filter(
        (i): i is ts.ConditionalExpression => i !== undefined && ts.isConditionalExpression(i),
      )
      .map((i) => i.whenTrue.getText(route));
    expect(lists).toEqual([JSON.stringify([NEMAR_BIDSIGNORE_ENTRY])]);
  });

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
