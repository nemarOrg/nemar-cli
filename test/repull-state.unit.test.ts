/**
 * The states of an upstream re-pull and the edges between them (epic #1046 phase 6, #1912;
 * ADR 0111, decision 3), on the pure module the Worker and the CLI share.
 *
 * The edge table is checked against an independent list written out here edge by edge, so a
 * change to the table must also change the test. Every other pair of the 17 x 17 is asserted
 * refused, which is what makes "the only edges a write may take" a tested sentence.
 */

import { describe, expect, test } from "bun:test";
import {
  DIGEST_RE,
  IMMUTABLE_ONCE_SET,
  REPULL_COUNT_KEYS,
  REPULL_STATUSES,
  REPULL_TRANSITIONS,
  type RepullStatus,
  SCREEN_GATED_STATUSES,
  SELF_EDGE_FIELDS,
  TERMINAL_STATUSES,
  TRANSITION_FIELDS,
  VERIFIED_ONLY_STATUSES,
  canTransition,
  fieldProblem,
  fieldsFor,
  isTerminal,
  nextMajorVersion,
  patchVersionOf,
} from "../shared/repull-state";

/** The edges, written out once more so the table cannot drift unseen. */
const EDGES: ReadonlyArray<readonly [RepullStatus, RepullStatus]> = [
  ["planned", "planned"],
  ["planned", "prepared"],
  ["prepared", "prepared"],
  ["prepared", "copied"],
  ["copied", "registered"],
  ["registered", "pr_open"],
  ["pr_open", "pr_open"],
  ["pr_open", "gates_clear"],
  ["gates_clear", "pr_open"],
  ["gates_clear", "gates_clear"],
  ["gates_clear", "merged"],
  ["merged", "released"],
  ["released", "released"],
  ["released", "complete"],
  ["released", "patch_synthesized"],
  ["patch_synthesized", "patch_synthesized"],
  ["patch_synthesized", "patch_gates_clear"],
  ["patch_gates_clear", "patch_synthesized"],
  ["patch_gates_clear", "patch_gates_clear"],
  ["patch_gates_clear", "patch_merged"],
  ["patch_merged", "patch_released"],
  ["patch_released", "complete"],
  // abandoned and superseded: before N.0.0 merges
  ...(["planned", "prepared", "copied", "registered", "pr_open", "gates_clear"] as const).flatMap(
    (s) =>
      [
        [s, "abandoned"],
        [s, "superseded"],
      ] as const,
  ),
  // patch_declined: N.0.0 released, N.0.1 not yet merged
  ["released", "patch_declined"],
  ["patch_synthesized", "patch_declined"],
  ["patch_gates_clear", "patch_declined"],
  // failed: any non-terminal state
  ...(
    [
      "planned",
      "prepared",
      "copied",
      "registered",
      "pr_open",
      "gates_clear",
      "merged",
      "released",
      "patch_synthesized",
      "patch_gates_clear",
      "patch_merged",
      "patch_released",
    ] as const
  ).map((s) => [s, "failed"] as const),
];

describe("the edges", () => {
  test("there are 17 states and 289 ordered pairs", () => {
    expect(REPULL_STATUSES).toHaveLength(17);
    expect(new Set(REPULL_STATUSES).size).toBe(17);
  });

  test("every listed edge is allowed", () => {
    for (const [from, to] of EDGES) expect(canTransition(from, to)).toBe(true);
  });

  test("every other pair of the 289 is refused", () => {
    const allowed = new Set(EDGES.map(([a, b]) => `${a}>${b}`));
    expect(allowed.size).toBe(EDGES.length);
    let refused = 0;
    for (const from of REPULL_STATUSES) {
      for (const to of REPULL_STATUSES) {
        if (allowed.has(`${from}>${to}`)) continue;
        expect(canTransition(from, to)).toBe(false);
        refused++;
      }
    }
    expect(refused).toBe(289 - EDGES.length);
  });

  test("a terminal state has no edge out", () => {
    for (const s of TERMINAL_STATUSES) expect(REPULL_TRANSITIONS[s]).toEqual([]);
  });

  test("the terminal set is the five the ADR names", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ["abandoned", "complete", "failed", "patch_declined", "superseded"].sort(),
    );
    for (const s of REPULL_STATUSES) {
      expect(isTerminal(s)).toBe((TERMINAL_STATUSES as readonly string[]).includes(s));
    }
  });

  test("a merged N.0.0 can be neither abandoned nor superseded", () => {
    for (const from of ["merged", "released", "patch_synthesized"] as const) {
      expect(canTransition(from, "abandoned")).toBe(false);
      expect(canTransition(from, "superseded")).toBe(false);
    }
  });

  test("an N.0.1 that has merged cannot be declined", () => {
    expect(canTransition("patch_merged", "patch_declined")).toBe(false);
    expect(canTransition("patch_released", "patch_declined")).toBe(false);
  });
});

describe("the columns an edge writes", () => {
  test("every state has an entry, and what an edge must write it may write", () => {
    for (const s of REPULL_STATUSES) {
      const spec = TRANSITION_FIELDS[s];
      expect(spec).toBeDefined();
      for (const column of spec.must) expect(spec.may).toContain(column);
    }
  });

  test("a state only a verified route writes is not a state a caller states", () => {
    expect([...VERIFIED_ONLY_STATUSES].sort()).toEqual(
      ["merged", "patch_merged", "patch_released", "released"].sort(),
    );
    expect([...SCREEN_GATED_STATUSES].sort()).toEqual(["gates_clear", "patch_gates_clear"].sort());
  });

  test("the immutable columns are columns an edge may set", () => {
    const writable = new Set(Object.values(TRANSITION_FIELDS).flatMap((s) => s.may));
    for (const column of IMMUTABLE_ONCE_SET) expect(writable.has(column)).toBe(true);
  });

  test("the edges that repeat a state to write one thing say what they write", () => {
    expect(Object.keys(SELF_EDGE_FIELDS).sort()).toEqual(
      ["gates_clear", "patch_gates_clear", "planned", "released"].sort(),
    );
    for (const [status, spec] of Object.entries(SELF_EDGE_FIELDS)) {
      expect(REPULL_TRANSITIONS[status as RepullStatus]).toContain(status);
      for (const column of spec.must) expect(spec.may).toContain(column);
    }
    // The same status reached from another status is the state's own edge, not the override.
    expect(fieldsFor("released", "released")).toBe(SELF_EDGE_FIELDS.released);
    expect(fieldsFor("merged", "released")).toBe(TRANSITION_FIELDS.released);
    expect(fieldsFor("pr_open", "gates_clear")).toBe(TRANSITION_FIELDS.gates_clear);
    expect(fieldsFor("gates_clear", "gates_clear").must).toEqual([
      "merge_claimed_at",
      "merge_claim_sha",
    ]);
    // The claim is recorded on the edge that repeats gates_clear and nowhere else.
    for (const status of REPULL_STATUSES) {
      for (const column of [
        "merge_claimed_at",
        "merge_claim_sha",
        "patch_merge_claimed_at",
        "patch_merge_claim_sha",
      ]) {
        const claimEdge = status === "gates_clear" || status === "patch_gates_clear";
        expect(TRANSITION_FIELDS[status].may.includes(column)).toBe(false);
        expect(!!SELF_EDGE_FIELDS[status]?.may.includes(column)).toBe(
          claimEdge && column.startsWith(status === "gates_clear" ? "merge" : "patch"),
        );
      }
    }
  });

  test("an edge into failed, and the planned self-edge, must say why", () => {
    expect(TRANSITION_FIELDS.failed.requiresError).toBe(true);
    expect(SELF_EDGE_FIELDS.planned?.requiresError).toBe(true);
    expect(TRANSITION_FIELDS.abandoned.requiresError).toBeUndefined();
  });

  test("the columns that leave a state are cleared when the row goes back", () => {
    expect(TRANSITION_FIELDS.pr_open.reset).toContain("gates_sha");
    expect(TRANSITION_FIELDS.patch_synthesized.reset).toContain("patch_gates_sha");
  });
});

describe("versions", () => {
  test("a re-pull's N.0.0 is the next major, and its corrections are N.0.1", () => {
    expect(nextMajorVersion("1.0.0")).toBe("2.0.0");
    expect(nextMajorVersion("2.3.4")).toBe("3.0.0");
    expect(nextMajorVersion("9.9.9")).toBe("10.0.0");
    expect(patchVersionOf("2.0.0")).toBe("2.0.1");
    expect(patchVersionOf("10.0.0")).toBe("10.0.1");
  });

  test("a string that is not N.N.N has no next major", () => {
    for (const v of [
      "",
      "1.0",
      "v1.0.0",
      "1.0.0-rc1",
      "1.0.0 ",
      "a.b.c",
      "99999999999999999.0.0",
    ]) {
      expect(nextMajorVersion(v)).toBeNull();
    }
    expect(patchVersionOf("2.0")).toBeNull();
  });
});

describe("the shape of a value", () => {
  const row = { to_version: "2.0.0", patch_version: null };
  const SHA = "a".repeat(40);

  test("a sha is 40 lowercase hex digits", () => {
    expect(fieldProblem("head_sha", SHA, row)).toBeNull();
    for (const bad of ["", "A".repeat(40), "a".repeat(39), "a".repeat(41), 5, null]) {
      expect(fieldProblem("head_sha", bad, row)).not.toBeNull();
    }
  });

  test("a digest is sha256: and 64 hex digits", () => {
    expect(DIGEST_RE.test(`sha256:${"0".repeat(64)}`)).toBe(true);
    expect(fieldProblem("manifest_digest", `sha256:${"0".repeat(64)}`, row)).toBeNull();
    expect(fieldProblem("manifest_digest", `sha1:${"0".repeat(64)}`, row)).not.toBeNull();
    expect(fieldProblem("manifest_digest", `sha256:${"0".repeat(63)}`, row)).not.toBeNull();
  });

  test("a branch is the release branch of the version it carries, and no other", () => {
    expect(fieldProblem("branch", "release/v2.0.0", row)).toBeNull();
    for (const bad of ["main", "release/v2.0.1", "release/v3.0.0", "refs/heads/release/v2.0.0"]) {
      expect(fieldProblem("branch", bad, row)).not.toBeNull();
    }
    expect(fieldProblem("patch_version", "2.0.1", row)).toBeNull();
    expect(fieldProblem("patch_version", "2.1.0", row)).not.toBeNull();
    expect(
      fieldProblem("patch_branch", "release/v2.0.1", row, { patch_version: "2.0.1" }),
    ).toBeNull();
    expect(fieldProblem("patch_branch", "release/v2.0.1", row)).not.toBeNull();
    expect(fieldProblem("patch_branch", "main", { ...row, patch_version: "2.0.1" })).not.toBeNull();
  });

  test("a workflow run is an https URL, and nothing else", () => {
    expect(
      fieldProblem("workflow_run_url", "https://github.com/o/r/actions/runs/1", row),
    ).toBeNull();
    for (const bad of [
      "http://github.com/o/r/actions/runs/1",
      "ftp://github.com/x",
      "https://",
      "https://a b",
      `https://${"a".repeat(500)}`,
      "javascript:alert(1)",
      "",
      null,
    ]) {
      expect(fieldProblem("workflow_run_url", bad, row)).not.toBeNull();
    }
  });

  test("a merge claim time is a UTC datetime in the shape SQLite writes", () => {
    for (const column of ["merge_claimed_at", "patch_merge_claimed_at"]) {
      expect(fieldProblem(column, "2026-10-24 01:02:03", row)).toBeNull();
      for (const bad of [
        "2026-10-24T01:02:03Z",
        "2026-10-24",
        "yesterday",
        "2026-10-24 01:02",
        "",
        5,
        null,
      ]) {
        expect(fieldProblem(column, bad, row)).not.toBeNull();
      }
    }
  });

  test("a pull request number is a positive integer", () => {
    expect(fieldProblem("pr_number", 12, row)).toBeNull();
    for (const bad of [0, -1, 1.5, "12", null]) {
      expect(fieldProblem("pr_number", bad, row)).not.toBeNull();
    }
  });

  test("counts hold only the declared keys, as non-negative integers", () => {
    expect(fieldProblem("counts", { written: 3, deleted: 0 }, row)).toBeNull();
    expect(fieldProblem("counts", {}, row)).toBeNull();
    expect(fieldProblem("counts", { path: 1 }, row)).toMatch(/unknown key/);
    expect(fieldProblem("counts", { written: -1 }, row)).not.toBeNull();
    expect(fieldProblem("counts", { written: 1.5 }, row)).not.toBeNull();
    expect(fieldProblem("counts", { written: "3" }, row)).not.toBeNull();
    expect(fieldProblem("counts", [1], row)).not.toBeNull();
    expect(fieldProblem("counts", null, row)).not.toBeNull();
  });

  test("no count key names a path, a key or a person", () => {
    for (const key of REPULL_COUNT_KEYS) expect(key).toMatch(/^[a-z_]+$/);
  });

  test("a column no edge writes is refused by name", () => {
    expect(fieldProblem("status", "merged", row)).toMatch(/not a column/);
    expect(fieldProblem("id", 1, row)).toMatch(/not a column/);
  });
});
