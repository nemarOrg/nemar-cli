/**
 * The re-pull plan file's digest and the planner's read-only guard (ADR 0111, epic #1046 phase 5).
 *
 * The digest binds a reviewed plan to `--execute` (ADR 0111, decision 2), so it must be the same
 * for the same body whatever the key order, and it must not move with what a re-run legitimately
 * changes (when, where, and the preflight answers, which depend on the operator's token). The guard
 * is what makes "read-only" a property of the code rather than of each caller.
 */

import { describe, expect, test } from "bun:test";
import {
  PLAN_FILE_VERSION,
  PLAN_SCHEMA,
  type PlanBody,
  type PlanFile,
  VOLATILE_FIELDS,
  planDigest,
  planFileJson,
  readPlanFile,
} from "../src/lib/repull/digest";
import { ReadOnlyViolation, assertReadOnlyGit, readOnlyFetch } from "../src/lib/repull/read-only";

const BODY: PlanBody = {
  planner: 1,
  dataset: "on099999",
  upstream: { ds: "ds099999", from_tag: "1.0.0", to_tag: "1.1.0" },
  paths: [
    {
      path: "a.tsv",
      class: "take-theirs",
      delta: true,
      target: { kind: "git", oid: "0".repeat(40) },
    },
  ],
  counts: { added: 1, data_changing: false },
  refusals: [],
};

function fileOf(body: PlanBody, over: Partial<PlanFile> = {}): PlanFile {
  return {
    schema: PLAN_SCHEMA,
    version: PLAN_FILE_VERSION,
    digest: planDigest(body),
    created_at: "2026-10-24T00:00:00.000Z",
    environment: "https://api.nemar.org",
    preflight: [{ name: "release-pr", status: "unchecked", code: "no-token" }],
    executable: false,
    body,
    ...over,
  };
}

describe("the plan digest", () => {
  test("does not depend on the order keys were written in", () => {
    const reordered: PlanBody = {
      refusals: [],
      counts: { data_changing: false, added: 1 },
      paths: [
        {
          target: { oid: "0".repeat(40), kind: "git" },
          delta: true,
          class: "take-theirs",
          path: "a.tsv",
        },
      ],
      upstream: { to_tag: "1.1.0", from_tag: "1.0.0", ds: "ds099999" },
      dataset: "on099999",
      planner: 1,
    };
    expect(planDigest(reordered)).toBe(planDigest(BODY));
    expect(planDigest(BODY)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("moves with any body field, including an array's order", () => {
    expect(planDigest({ ...BODY, dataset: "on999998" })).not.toBe(planDigest(BODY));
    expect(planDigest({ ...BODY, refusals: [{ code: "gitlink", detail: "1" }] })).not.toBe(
      planDigest(BODY),
    );
    const two = {
      ...BODY,
      renames: [
        { from: "a", to: "b" },
        { from: "c", to: "d" },
      ],
    };
    const swapped = {
      ...BODY,
      renames: [
        { from: "c", to: "d" },
        { from: "a", to: "b" },
      ],
    };
    expect(planDigest(two)).not.toBe(planDigest(swapped));
  });

  test("a written file reads back to the same digest, whatever its volatile fields say", () => {
    const a = readPlanFile(planFileJson(fileOf(BODY)));
    const b = readPlanFile(
      planFileJson(
        fileOf(BODY, {
          created_at: "2031-01-01T00:00:00.000Z",
          environment: "http://127.0.0.1:1",
          preflight: [{ name: "release-pr", status: "ok" }],
          executable: true,
        }),
      ),
    );
    expect(a.digest).toBe(planDigest(BODY));
    expect(b.digest).toBe(a.digest);
    expect(a.file.digest).toBe(a.digest);
    for (const field of VOLATILE_FIELDS) expect(Object.keys(a.body)).not.toContain(field);
  });

  test("a body may not carry a volatile field, which the digest would then skip", () => {
    expect(() => planFileJson(fileOf({ ...BODY, created_at: "x" }))).toThrow(
      /volatile field created_at/,
    );
  });
});

describe("the read-only guard", () => {
  test("allows the planner's reads", () => {
    for (const args of [
      ["clone", "--bare", "--filter=blob:limit=1m", "u", "d"],
      ["fetch", "--quiet", "origin"],
      ["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--stdin"],
      ["ls-remote", "--refs", "u"],
      ["cat-file", "--batch"],
      ["ls-tree", "-r", "-z", "HEAD"],
      ["rev-parse", "--verify", "HEAD"],
      ["rev-list", "--objects", "--missing=print", "HEAD"],
      ["for-each-ref"],
    ]) {
      expect(() => assertReadOnlyGit(args)).not.toThrow();
    }
  });

  test("refuses anything that could write or run a program", () => {
    for (const args of [
      ["push", "origin", "main"],
      ["annex", "copy", "--to", "nemar-s3"],
      ["config", "user.name", "x"],
      ["update-ref", "refs/heads/main", "0"],
      ["-c", "core.sshCommand=evil", "fetch"],
      ["clone", "--upload-pack=evil", "u", "d"],
      ["fetch", "-u", "evil", "origin"],
      ["clone", "--template=/tmp/hooks", "u", "d"],
      ["clone", "--config", "core.hooksPath=/tmp", "u", "d"],
      ["clone", "-c", "core.hooksPath=/tmp", "u", "d"],
      [],
    ]) {
      expect(() => assertReadOnlyGit(args)).toThrow(ReadOnlyViolation);
    }
  });

  test("HTTP is GET and HEAD only", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(readOnlyFetch("http://127.0.0.1:9/x", { method })).rejects.toThrow(
        ReadOnlyViolation,
      );
    }
  });
});
