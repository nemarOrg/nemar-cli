/**
 * shared/repull-bids-override.ts: when an administrator's merge of a re-pull pull request over a
 * failed BIDS validation may be made (ADR 0111, the Phase 7g amendment and the amendment of
 * 2026-10-27), the one rule the Worker's claim, `resume`'s gates and the merge gate ask. The inputs
 * are GitHub's answers in the shapes its REST API sends (`GET .../commits/<sha>/check-runs` and
 * `GET .../commits/<sha>/status`), so the reading is pinned with the rule.
 *
 * The property that matters most: BIDS validation is the one thing that fails. A head where another
 * check or status does not pass, or has not finished, is not BIDS-only, and neither is one whose
 * answers cannot be read.
 */

import { describe, expect, test } from "bun:test";
import { BIDS_CHECK_NAME, LEGACY_BIDS_CHECK_NAME, bidsCheckName } from "../shared/dataset-checks";
import { NEMAR_APP_ID } from "../shared/nemar-app";
import {
  bidsOnlyFault,
  bidsOverrideFault,
  checkFactOf,
  othersNotPassing,
} from "../shared/repull-bids-override";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "f".repeat(40);
const DS = "on098831";
/** GitHub Actions' App, which posts a workflow's own job runs. */
const ACTIONS = 15368;

type Run = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  app?: number;
  head?: string;
};
const answer = (runs: Run[]) => ({
  total_count: runs.length,
  check_runs: runs.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    head_sha: r.head ?? SHA,
    app: { id: r.app ?? NEMAR_APP_ID },
  })),
});
const statusAnswer = (statuses: Array<{ context: string; state: string }>) => ({
  state: statuses.length === 0 ? "pending" : "success",
  total_count: statuses.length,
  statuses,
});
const bidsFailed: Run = {
  id: 31,
  name: BIDS_CHECK_NAME,
  status: "completed",
  conclusion: "failure",
};
const versionPassed: Run = {
  id: 32,
  name: "version-check",
  status: "completed",
  conclusion: "success",
};
const NONE = statusAnswer([]);

describe("checkFactOf: the App's latest run of a name at the head", () => {
  test("the App's run, the latest by id; another App's, name or head is not read", () => {
    const runs = answer([
      { id: 5, name: BIDS_CHECK_NAME, status: "completed", conclusion: "success" },
      { id: 9, name: BIDS_CHECK_NAME, status: "completed", conclusion: "failure" },
      { id: 12, name: BIDS_CHECK_NAME, status: "completed", conclusion: "success", app: 42 },
      {
        id: 13,
        name: BIDS_CHECK_NAME,
        status: "completed",
        conclusion: "success",
        head: OTHER_SHA,
      },
      { id: 14, name: "Run BIDS validation", status: "completed", conclusion: "success" },
    ]);
    expect(checkFactOf(runs, BIDS_CHECK_NAME, SHA)).toEqual({
      status: "completed",
      conclusion: "failure",
    });
  });

  test("absent, queued and running", () => {
    expect(checkFactOf(answer([]), BIDS_CHECK_NAME, SHA)).toEqual({
      status: "absent",
      conclusion: null,
    });
    for (const status of ["queued", "waiting", "requested", "pending"]) {
      expect(
        checkFactOf(
          answer([{ id: 1, name: BIDS_CHECK_NAME, status, conclusion: null }]),
          BIDS_CHECK_NAME,
          SHA,
        ),
      ).toEqual({ status: "queued", conclusion: null });
    }
    expect(
      checkFactOf(
        answer([{ id: 1, name: BIDS_CHECK_NAME, status: "in_progress", conclusion: null }]),
        BIDS_CHECK_NAME,
        SHA,
      ),
    ).toEqual({ status: "in_progress", conclusion: null });
  });

  test("an answer that is not of its shape, or not all of it, is unreadable, never absent", () => {
    const unreadable = { status: "unreadable", conclusion: null };
    const one = answer([bidsFailed]);
    for (const body of [
      null,
      "runs",
      [],
      { check_runs: one.check_runs },
      { ...one, total_count: 2 },
      { total_count: 1, check_runs: [{ ...one.check_runs[0], id: 0 }] },
      { total_count: 1, check_runs: [{ ...one.check_runs[0], app: null }] },
      { total_count: 1, check_runs: [{ ...one.check_runs[0], status: 3 }] },
      { total_count: 1, check_runs: [{ ...one.check_runs[0], conclusion: 1 }] },
      answer([{ id: 1, name: BIDS_CHECK_NAME, status: "stalled", conclusion: null }]),
    ]) {
      expect(checkFactOf(body, BIDS_CHECK_NAME, SHA)).toEqual(unreadable);
    }
  });
});

describe("bidsOverrideFault: the facts every reader has, in their order", () => {
  const failed = { status: "completed", conclusion: "failure" } as const;
  const passed = { status: "completed", conclusion: "success" } as const;
  const facts = {
    origin: "administrator",
    mergeableState: "unstable",
    bids: failed,
    versionCheck: passed,
  };

  test("an administrator's record, unstable, BIDS failed and version-check passed: it holds", () => {
    expect(bidsOverrideFault(facts)).toBeNull();
  });

  test("each fact that does not hold, and the first one wins", () => {
    expect(bidsOverrideFault({ ...facts, origin: "automatic" })).toBe("automatic");
    expect(bidsOverrideFault({ ...facts, origin: "automatic", mergeableState: "blocked" })).toBe(
      "automatic",
    );
    expect(bidsOverrideFault({ ...facts, bids: { status: "unreadable", conclusion: null } })).toBe(
      "unreadable",
    );
    expect(bidsOverrideFault({ ...facts, mergeableState: "blocked" })).toBe("blocked");
    for (const state of ["clean", "unknown", "dirty", "behind", null, "UNSTABLE"]) {
      expect([state, bidsOverrideFault({ ...facts, mergeableState: state })]).toEqual([
        state,
        "not-unstable",
      ]);
    }
    for (const bids of [
      passed,
      { status: "completed", conclusion: "timed_out" },
      { status: "completed", conclusion: "cancelled" },
      { status: "completed", conclusion: "skipped" },
      { status: "in_progress", conclusion: null },
      { status: "absent", conclusion: null },
    ] as const) {
      expect(bidsOverrideFault({ ...facts, bids })).toBe("bids");
    }
    for (const versionCheck of [
      failed,
      { status: "completed", conclusion: "skipped" },
      { status: "queued", conclusion: null },
    ] as const) {
      expect(bidsOverrideFault({ ...facts, versionCheck })).toBe("version-check");
    }
  });
});

describe("othersNotPassing: nothing but the App's two runs may fail", () => {
  const head = (runs: Run[], statuses = NONE) => ({
    datasetId: DS,
    sha: SHA,
    runs: answer([bidsFailed, versionPassed, ...runs]),
    statuses,
  });

  test("the App's BIDS and version-check runs are left to the facts; passing others are nothing", () => {
    expect(othersNotPassing(head([]))).toEqual([]);
    expect(
      othersNotPassing(
        head(
          [
            { id: 40, name: "NEMAR PR Review", status: "completed", conclusion: "skipped" },
            { id: 41, name: "dispatch", status: "completed", conclusion: "success", app: ACTIONS },
            { id: 42, name: "notes", status: "completed", conclusion: "neutral", app: ACTIONS },
          ],
          statusAnswer([{ context: "ci/external", state: "success" }]),
        ),
      ),
    ).toEqual([]);
  });

  test("a check that failed, or has not finished, is named; so is a status that is not success", () => {
    expect(
      othersNotPassing(
        head([
          { id: 40, name: "NEMAR PR Review", status: "completed", conclusion: "action_required" },
          { id: 41, name: "lint", status: "completed", conclusion: "failure", app: ACTIONS },
          { id: 42, name: "slow", status: "in_progress", conclusion: null, app: ACTIONS },
          { id: 43, name: "gone", status: "completed", conclusion: "cancelled", app: ACTIONS },
        ]),
      ),
    ).toEqual(["NEMAR PR Review", "gone", "lint", "slow"]);
    for (const state of ["failure", "error", "pending"]) {
      expect(othersNotPassing(head([], statusAnswer([{ context: "ci/external", state }])))).toEqual(
        ["ci/external"],
      );
    }
  });

  test("the latest run of a name and App speaks; another App's run of the BIDS name is another check", () => {
    const rerun = (first: string, then: string) =>
      othersNotPassing(
        head([
          { id: 50, name: "lint", status: "completed", conclusion: first, app: ACTIONS },
          { id: 51, name: "lint", status: "completed", conclusion: then, app: ACTIONS },
        ]),
      );
    expect(rerun("failure", "success")).toEqual([]);
    expect(rerun("success", "failure")).toEqual(["lint"]);
    expect(
      othersNotPassing(
        head([
          { id: 60, name: BIDS_CHECK_NAME, status: "completed", conclusion: "failure", app: 42 },
        ]),
      ),
    ).toEqual([BIDS_CHECK_NAME]);
    // A run of another commit is not this head's.
    expect(
      othersNotPassing(
        head([
          { id: 61, name: "lint", status: "completed", conclusion: "failure", head: OTHER_SHA },
        ]),
      ),
    ).toEqual([]);
  });

  test("answers that cannot be read are unreadable, never nothing", () => {
    const one = answer([bidsFailed]);
    for (const runs of [
      null,
      { ...one, total_count: 5 },
      { total_count: 1, check_runs: [{ ...one.check_runs[0], name: 7 }] },
      { total_count: 1, check_runs: [{ ...one.check_runs[0], app: {} }] },
    ]) {
      expect(othersNotPassing({ datasetId: DS, sha: SHA, runs, statuses: NONE })).toBe(
        "unreadable",
      );
    }
    for (const statuses of [
      null,
      { state: "pending", statuses: [] },
      { total_count: 2, statuses: [{ context: "a", state: "success" }] },
      { total_count: 1, statuses: [{ context: "a" }] },
    ]) {
      expect(othersNotPassing({ datasetId: DS, sha: SHA, runs: one, statuses })).toBe("unreadable");
    }
  });
});

describe("bidsOnlyFault: the whole rule, which resume's gates record on", () => {
  const ask = (over: Partial<Parameters<typeof bidsOnlyFault>[0]> = {}) =>
    bidsOnlyFault({
      datasetId: DS,
      sha: SHA,
      origin: "administrator",
      mergeableState: "unstable",
      runs: answer([bidsFailed, versionPassed]),
      statuses: NONE,
      ...over,
    });

  test("BIDS validation failed, version-check passed, nothing else fails: it holds", () => {
    expect(ask()).toBeNull();
  });

  test("another failing check is named, and is not BIDS-only", () => {
    const runs = answer([
      bidsFailed,
      versionPassed,
      { id: 41, name: "lint", status: "completed", conclusion: "failure", app: ACTIONS },
    ]);
    expect(ask({ runs })).toEqual({ fault: "others", others: ["lint"] });
  });

  test("the facts come first, read from the same unfiltered answer", () => {
    expect(ask({ origin: "automatic" })).toEqual({ fault: "automatic" });
    expect(ask({ mergeableState: "clean" })).toEqual({ fault: "not-unstable" });
    expect(ask({ mergeableState: "blocked" })).toEqual({ fault: "blocked" });
    expect(ask({ runs: answer([versionPassed]) })).toEqual({ fault: "bids" });
    expect(
      ask({ runs: answer([bidsFailed, { ...versionPassed, conclusion: "failure" }]) }),
    ).toEqual({ fault: "version-check" });
    expect(ask({ runs: { total_count: 3, check_runs: [] } })).toEqual({ fault: "unreadable" });
    expect(ask({ statuses: null })).toEqual({ fault: "unreadable" });
  });

  test("a legacy repository's BIDS check is GitHub Actions', so it is never the App's failure", () => {
    expect(bidsCheckName("nm000103")).toBe(LEGACY_BIDS_CHECK_NAME);
    expect(bidsCheckName(DS)).toBe(BIDS_CHECK_NAME);
    const runs = answer([
      {
        id: 31,
        name: LEGACY_BIDS_CHECK_NAME,
        status: "completed",
        conclusion: "failure",
        app: ACTIONS,
      },
      versionPassed,
    ]);
    expect(ask({ datasetId: "nm000103", runs })).toEqual({ fault: "bids" });
  });
});
