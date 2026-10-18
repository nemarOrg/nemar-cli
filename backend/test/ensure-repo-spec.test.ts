/**
 * Unit tests for the green-gate predicate (epic #713, phase #717).
 * Pure, no network, no mocks: assert `isRequiredCheckGreen` — the predicate
 * that decides whether `ensureRepoToSpec` applies branch protection. The full
 * ensureRepoToSpec composition is exercised end-to-end by the live flows; here
 * we pin the gate that prevents bricking a repo whose check is red/missing.
 *
 * The second half runs the real `ensureRepoToSpec` against a stateful GitHub
 * stand-in (helpers/github-rulesets.ts) for the one step it adds in ADR 0107,
 * the required pull-request review: what `review` of `require`, `remove` and
 * `undefined` leaves on a public and on a private repository.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  BRANCH_RULESET_NAME,
  NEMAR_APP_ID,
  REVIEW_RULESET_NAME,
  type RequiredCheck,
  ensureRepoToSpec,
  ensureReviewRuleset,
  isRequiredCheckGreen,
} from "../src/services/github";
import { type RulesetStandIn, startRulesetStandIn } from "./helpers/github-rulesets";

const BIDS: RequiredCheck = { context: "Run BIDS Validation", integration_id: NEMAR_APP_ID };

function run(name: string, conclusion: string | null, app_id: number | null = NEMAR_APP_ID) {
  return { name, conclusion, app_id };
}

describe("isRequiredCheckGreen", () => {
  test("matching App check-run with success is green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "success")], [])).toBe(true);
  });

  test("matching check-run with failure is not green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "failure")], [])).toBe(false);
  });

  test("missing check is not green (fail-closed)", () => {
    expect(isRequiredCheckGreen(BIDS, [run("something else", "success")], [])).toBe(false);
  });

  test("in-progress check (null conclusion) is not green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", null)], [])).toBe(false);
  });

  test("neutral and skipped count as green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "neutral")], [])).toBe(true);
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "skipped")], [])).toBe(true);
  });

  test("wrong integration_id does not satisfy a pinned check (spoof-resistant)", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "success", 9999)], [])).toBe(
      false,
    );
  });

  test("unpinned check matches by name regardless of source", () => {
    const vc: RequiredCheck = { context: "version-check" };
    expect(isRequiredCheckGreen(vc, [run("version-check", "success", 15368)], [])).toBe(true);
  });

  test("falls back to a legacy commit status with state=success", () => {
    const legacy: RequiredCheck = { context: "bids-validation" };
    expect(
      isRequiredCheckGreen(legacy, [], [{ context: "bids-validation", state: "success" }]),
    ).toBe(true);
    expect(
      isRequiredCheckGreen(legacy, [], [{ context: "bids-validation", state: "failure" }]),
    ).toBe(false);
  });
});

describe("ensureRepoToSpec and the required review", () => {
  const PAT = "ghp_ensure_repo_spec_test";
  const REPO = "nm000201";
  let standIn: RulesetStandIn;

  beforeAll(() => {
    standIn = startRulesetStandIn();
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = standIn.url;
  });

  afterAll(() => {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
    standIn.stop();
  });

  beforeEach(() => {
    standIn.reset();
  });

  const heldBy = (repo = REPO) => (standIn.rulesets.get(repo) ?? []).map((r) => r.name).sort();

  test("require puts the review ruleset on a public repository, next to the branch ruleset", async () => {
    const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });

    expect(result.steps.review_ruleset).toEqual({ status: "ok", detail: "created" });
    expect(result.steps.branch_ruleset).toEqual({ status: "ok" });
    expect(heldBy()).toContain(REVIEW_RULESET_NAME);
    expect(heldBy()).toContain(BRANCH_RULESET_NAME);
  });

  test("require does not wait for the BIDS check: a red repository still gets the review", async () => {
    standIn.bidsConclusion.set(REPO, "failure");

    const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });

    expect(result.steps.branch_ruleset).toEqual({
      status: "skipped",
      detail: "RED_REQUIRED_CHECK",
    });
    expect(result.steps.review_ruleset).toEqual({ status: "ok", detail: "created" });
    expect(heldBy()).toEqual([REVIEW_RULESET_NAME]);
  });

  test("an undefined review leaves the review ruleset exactly as it is, and says nothing about it", async () => {
    await ensureReviewRuleset(REPO, PAT);
    const held = standIn.rulesets.get(REPO)?.[0];
    if (!held) throw new Error("the ruleset was not created");
    // An administrator's break-glass: switched off, not deleted.
    held.body = { ...held.body, enforcement: "disabled" };
    const before = structuredClone(held);
    standIn.calls.length = 0;

    const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public" });

    expect(result.steps.review_ruleset).toBeUndefined();
    expect(standIn.rulesets.get(REPO)?.find((r) => r.name === REVIEW_RULESET_NAME)).toStrictEqual(
      before,
    );
    // Nothing wrote to it, and nothing deleted it.
    expect(
      standIn.rulesetWrites().filter((w) => w.path.endsWith(`/rulesets/${before.id}`)),
    ).toHaveLength(0);
  });

  test("remove takes the review ruleset off and leaves the branch ruleset", async () => {
    await ensureReviewRuleset(REPO, PAT);

    const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "remove" });

    expect(result.steps.review_ruleset).toEqual({ status: "ok", detail: "removed" });
    expect(heldBy()).toContain(BRANCH_RULESET_NAME);
    expect(heldBy()).not.toContain(REVIEW_RULESET_NAME);
  });

  test("on a private repository require is read as remove: nothing there publishes the check", async () => {
    await ensureReviewRuleset(REPO, PAT);

    const result = await ensureRepoToSpec(REPO, PAT, { visibility: "private", review: "require" });

    expect(result.steps.review_ruleset).toEqual({ status: "ok", detail: "removed (private)" });
    expect(heldBy()).toEqual([]);
    // And a private repository that never had one is left with none, not given one.
    const clean = await ensureRepoToSpec("nm000202", PAT, {
      visibility: "private",
      review: "require",
    });
    expect(clean.steps.review_ruleset).toEqual({
      status: "ok",
      detail: "nothing to remove (private)",
    });
    expect(heldBy("nm000202")).toEqual([]);
  });

  test("a review step that fails is recorded and does not stop the rest", async () => {
    await ensureReviewRuleset(REPO, PAT);
    // The review ruleset exists, so its write is the only PUT; the branch ruleset is a POST.
    standIn.failNext("PUT", /\/rulesets\/\d+$/, 403);

    const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });

    expect(result.steps.review_ruleset?.status).toBe("failed");
    expect(result.steps.review_ruleset?.detail).toContain("Review ruleset update failed");
    expect(result.steps.branch_ruleset).toEqual({ status: "ok" });
    expect(result.steps.tag_ruleset).toEqual({ status: "ok" });
  });

  test("a dry run reports what each intent would do and writes nothing", async () => {
    const create = await ensureRepoToSpec(REPO, PAT, {
      visibility: "public",
      review: "require",
      dryRun: true,
    });
    expect(create.steps.review_ruleset).toEqual({ status: "ok", detail: "would create" });

    await ensureReviewRuleset(REPO, PAT);
    standIn.calls.length = 0;
    const update = await ensureRepoToSpec(REPO, PAT, {
      visibility: "public",
      review: "require",
      dryRun: true,
    });
    expect(update.steps.review_ruleset).toEqual({ status: "ok", detail: "would update" });
    const remove = await ensureRepoToSpec(REPO, PAT, {
      visibility: "private",
      review: "require",
      dryRun: true,
    });
    expect(remove.steps.review_ruleset).toEqual({ status: "ok", detail: "would remove (private)" });
    expect(standIn.writes()).toHaveLength(0);
  });

  test("a dry run says a repository on another default branch would be skipped", async () => {
    standIn.defaultBranches.set(REPO, "master");

    const result = await ensureRepoToSpec(REPO, PAT, {
      visibility: "public",
      review: "require",
      dryRun: true,
    });

    expect(result.steps.review_ruleset).toEqual({
      status: "skipped",
      detail: "default branch is master, not main",
    });
    expect(standIn.writes()).toHaveLength(0);
  });
});
