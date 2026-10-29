/**
 * The upstream re-pull's review waiver (ADR 0116): the one pure rule the Worker's review, its queue
 * and the machine-clean facts ask whether a pull request at a head is an open re-pull's own, at the
 * head NEMAR's tools recorded for it.
 *
 * Each condition is flipped alone from a record and a pull request that match, and each must turn
 * the waiver off with its own word: a pull request that merely names its branch like a release, a
 * fork, a record of another dataset or at another status, and a head the record does not hold are
 * all reviewed as any other.
 */

import { describe, expect, test } from "bun:test";
import {
  WAIVER_ANY_STATUS,
  WAIVER_STATUSES,
  type WaiverMiss,
  type WaiverRecord,
  type WaiverSubject,
  repullReviewWaiver,
  repullReviewWaiverOf,
} from "../shared/repull-review-waiver";
import { REPULL_STATUSES, type RepullStatus } from "../shared/repull-state";

const DS = "on004362";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const PATCH_HEAD = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

function record(over: Partial<WaiverRecord> = {}): WaiverRecord {
  return {
    id: 41,
    dataset_id: DS,
    status: "pr_open",
    origin: "administrator",
    branch: "release/v2.0.0",
    pr_number: 7,
    head_sha: HEAD,
    patch_branch: null,
    patch_pr_number: null,
    patch_head_sha: null,
    ...over,
  };
}

function subject(over: Partial<WaiverSubject> = {}): WaiverSubject {
  return {
    datasetId: DS,
    prNumber: 7,
    headSha: HEAD,
    ownRepository: true,
    headRef: "release/v2.0.0",
    baseRef: "main",
    ...over,
  };
}

describe("the waiver of an open re-pull's own pull request", () => {
  test("N.0.0's pull request at the recorded head is waived, at pr_open and at gates_clear", () => {
    for (const status of ["pr_open", "gates_clear"] as const) {
      expect(repullReviewWaiver(record({ status }), subject())).toEqual({
        waived: true,
        repullId: 41,
        pr: "n0",
        origin: "administrator",
      });
    }
  });

  test("N.0.1's pull request at its recorded head is waived, at patch_synthesized and patch_gates_clear", () => {
    const patch = {
      patch_branch: "release/v2.0.1",
      patch_pr_number: 9,
      patch_head_sha: PATCH_HEAD,
    };
    for (const status of ["patch_synthesized", "patch_gates_clear"] as const) {
      expect(
        repullReviewWaiver(
          record({ status, origin: "automatic", ...patch }),
          subject({ prNumber: 9, headSha: PATCH_HEAD, headRef: "release/v2.0.1" }),
        ),
      ).toEqual({ waived: true, repullId: 41, pr: "n1", origin: "automatic" });
    }
    // N.0.0's pull request, merged by then, is not waived at N.0.1's statuses.
    expect(
      repullReviewWaiver(record({ status: "patch_synthesized", ...patch }), subject()),
    ).toEqual({ waived: false, why: "not-open" });
  });

  test("a caller that did not read the branch or the base decides on the number and the head", () => {
    expect(repullReviewWaiver(record(), subject({ headRef: null, baseRef: null })).waived).toBe(
      true,
    );
  });

  test("the statuses that waive are exactly the open pull request's, of each", () => {
    expect([...WAIVER_ANY_STATUS].sort() as string[]).toEqual(
      ["gates_clear", "patch_gates_clear", "patch_synthesized", "pr_open"].sort(),
    );
    expect(WAIVER_STATUSES.n0).toEqual(["pr_open", "gates_clear"]);
    expect(WAIVER_STATUSES.n1).toEqual(["patch_synthesized", "patch_gates_clear"]);
  });
});

describe("everything else is reviewed, each for its own reason", () => {
  const cases: Array<[string, Partial<WaiverRecord>, Partial<WaiverSubject>, WaiverMiss]> = [
    ["a record of another dataset", { dataset_id: "on004363" }, {}, "other-dataset"],
    [
      "a pull request that merely names its branch like the release, at another number",
      {},
      { prNumber: 8 },
      "other-pull-request",
    ],
    ["a fork, even at the recorded number and head", {}, { ownRepository: false }, "fork"],
    ["the recorded number from another branch", {}, { headRef: "release/v9.0.0" }, "other-branch"],
    ["the recorded number into another base", {}, { baseRef: "dev" }, "other-base"],
    [
      "a head the record does not hold (moved by someone, or not recorded yet)",
      {},
      { headSha: OTHER },
      "head-not-recorded",
    ],
    ["a record with no head yet", { head_sha: null }, {}, "head-not-recorded"],
    ["a record whose head is not a commit id", { head_sha: "HEAD" }, {}, "head-not-recorded"],
    ["a record with no branch, when the caller read one", { branch: null }, {}, "other-branch"],
    ["a record with no pull request yet", { pr_number: null }, {}, "other-pull-request"],
  ];
  for (const [name, rec, sub, why] of cases) {
    test(`${name}: ${why}`, () => {
      expect(repullReviewWaiver(record(rec), subject(sub))).toEqual({ waived: false, why });
    });
  }

  test("a record at any status but the open pull request's waives nothing", () => {
    const open = new Set<string>(WAIVER_STATUSES.n0);
    const others = REPULL_STATUSES.filter((s) => !open.has(s)) as RepullStatus[];
    expect(others.length).toBeGreaterThan(10);
    for (const status of others) {
      expect(repullReviewWaiver(record({ status }), subject()), status).toEqual({
        waived: false,
        why: "not-open",
      });
    }
  });
});

describe("over the records a caller read", () => {
  test("the first record that waives decides; none, or none that waives, is not waived", () => {
    expect(repullReviewWaiverOf([], subject())).toEqual({
      waived: false,
      why: "other-pull-request",
    });
    expect(
      repullReviewWaiverOf([record({ status: "abandoned" }), record({ id: 42 })], subject()),
    ).toMatchObject({ waived: true, repullId: 42 });
    expect(repullReviewWaiverOf([record({ head_sha: OTHER })], subject())).toEqual({
      waived: false,
      why: "head-not-recorded",
    });
  });
});
