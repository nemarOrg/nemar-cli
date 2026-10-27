/**
 * How execution compares the reviewed plan with the plan made again from live sources (ADR 0111,
 * decision 2; epic #1046 phase 6): `comparePlans`, and the `.nemar/**` rule it hands the clone.
 *
 * The integration suite (`repull-execute-prepare.test.ts`) moves a real `main` and a real
 * git-annex branch; this pins the three answers and the edges of the path rule on their own.
 */

import { describe, expect, test } from "bun:test";
import type { PlanBody } from "../src/lib/repull/digest";
import { changedPaths, comparePlans, onlyNemarMoved } from "../src/lib/repull/execute/verify-plan";

function body(over: { main?: string; tree?: string; annex?: string; to?: string } = {}): PlanBody {
  return {
    planner: 2,
    dataset: "xx099999",
    upstream: { ds: "ds099999", from_tag: "1.0.0", to_tag: over.to ?? "1.1.0" },
    nemar: {
      main_commit: over.main ?? "a".repeat(40),
      main_tree: over.tree ?? "b".repeat(40),
      annex_commit: over.annex ?? "c".repeat(40),
      concept_doi: "10.82901/nemar.xx099999",
    },
    paths: [{ path: "README.md", delta: true }],
  };
}

describe("comparePlans", () => {
  test("the same body is equal", () => {
    expect(comparePlans(body(), body())).toBe("equal");
  });

  test("a body that differs only in main's commit and tree is a move of main", () => {
    expect(comparePlans(body(), body({ main: "d".repeat(40), tree: "e".repeat(40) }))).toBe(
      "nemar-only-moved",
    );
  });

  test("a moved git-annex branch is different, even with main moved too", () => {
    expect(comparePlans(body(), body({ annex: "f".repeat(40) }))).toBe("different");
    expect(
      comparePlans(
        body(),
        body({ main: "d".repeat(40), tree: "e".repeat(40), annex: "f".repeat(40) }),
      ),
    ).toBe("different");
  });

  test("any other field that moved is different", () => {
    expect(comparePlans(body(), body({ to: "1.2.0" }))).toBe("different");
    const live = body({ main: "d".repeat(40) });
    (live.paths as Array<Record<string, unknown>>).push({ path: "CHANGES", delta: true });
    expect(comparePlans(body(), live)).toBe("different");
  });
});

describe("the .nemar/** rule", () => {
  test("only paths under .nemar/ other than the privacy ledger let execution rebase", () => {
    expect(onlyNemarMoved([".nemar/metadata.json"])).toBe(true);
    expect(onlyNemarMoved([".nemar/metadata.json", ".nemar/other.json"])).toBe(true);
    expect(onlyNemarMoved([".nemar/corrections.jsonl"])).toBe(false);
    expect(onlyNemarMoved([".nemar/metadata.json", ".nemar/corrections.jsonl"])).toBe(false);
    expect(onlyNemarMoved([".github/workflows/validate.yml"])).toBe(false);
    expect(onlyNemarMoved(["README.md"])).toBe(false);
    expect(onlyNemarMoved([".nemarish/x"])).toBe(false);
    // Nothing changed is not a move (the bodies would have been equal).
    expect(onlyNemarMoved([])).toBe(false);
  });

  test("changed paths are adds, removals and changes, mode included", () => {
    const a = new Map([
      ["kept", { mode: "100644", oid: "1" }],
      ["changed", { mode: "100644", oid: "2" }],
      ["mode", { mode: "100644", oid: "3" }],
      ["removed", { mode: "100644", oid: "4" }],
    ]);
    const b = new Map([
      ["kept", { mode: "100644", oid: "1" }],
      ["changed", { mode: "100644", oid: "9" }],
      ["mode", { mode: "100755", oid: "3" }],
      ["added", { mode: "100644", oid: "5" }],
    ]);
    expect(changedPaths(a, b)).toEqual(["added", "changed", "mode", "removed"]);
  });
});
