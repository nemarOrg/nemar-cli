/**
 * `nemar admin repull merge <id> --bids-failure-reason "<text>"`: an administrator's merge of a
 * re-pull pull request over a failed BIDS validation (ADR 0111, the Phase 7g amendment; epic
 * #1046 phase 7, #1913), driven through the real entry point against `repull-pr-world.ts` (a
 * re-pull executed to `pr_open` by the real `execute`, taken to `gates_clear` by the real `resume`;
 * the real API over bun:sqlite on a loopback port; stand-ins for GitHub and S3 only,
 * GitHub's squash merge committing onto the bare origin's `main`). No mocks.
 *
 * The properties, each with a test of its own:
 *  - with BIDS validation failed, `version-check` passed and GitHub's `unstable`, the merge is
 *    claimed with the reason, sent as a squash at the screened `sha`, recorded, and the reason is
 *    written in its own audit row with the claim;
 *  - `blocked` (a rule requires the check: a merge would be a bypass), `clean` (no override is
 *    needed) and a fork's head are refused before any request that writes;
 *  - a BIDS validation that did not complete with `failure` (running, passed, timed out, canceled,
 *    skipped) and a `version-check` that did not complete with `success` (failed, running, skipped,
 *    canceled) are refused by the Worker's claim, which writes nothing;
 *  - without the reason the ordinary gate refuses `unstable`; a reason outside the length rule and
 *    a re-pull the automatic path opened are refused before anything is written;
 *  - in the normal order (ADR 0111, the #1983 review amendment): with BIDS validation the one check
 *    that fails at an `unstable` head, `resume` records the gates and the merge goes over it with the
 *    reason; another check or status that does not pass, a `version-check` that failed, a BIDS
 *    validation that passed, and a re-pull the automatic path opened are not gated; `clean` is gated
 *    as before and reads no check; a merge without the reason refuses the head gated over the
 *    failure; and the merge gate refuses, before anything is written, a head where another check
 *    fails, read again under the lock before the claim, so a check that starts failing after the
 *    gate's read is refused; the ordinary merge of a clean head reads no check.
 *  - a second resume at the gates names `--bids-failure-reason` while BIDS validation alone fails,
 *    in its ready line and as `bids_failure` in `--json`, and the ordinary merge once it passes.
 *
 * What only the first production use can check: that GitHub reports `unstable`, and not `blocked`,
 * for an unprotected mirror whose BIDS validation failed, as `nm000413#3` read for a held review,
 * and that its merge endpoint merges an `unstable` pull request with `sha` as the stand-in does.
 *
 * CI TIER: unit-pure. Hermetic: every server the suite starts or reaches listens on loopback.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { which } from "bun";
import { NEMAR_APP_ID } from "../shared/nemar-app";
import { ADMIN_TOKEN } from "./helpers/github-standin";
import { ADMIN_ID, type RepullWorld, prKey, startRepullWorld } from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

let w: RepullWorld;

beforeAll(async () => {
  if (awsInstalled) w = await startRepullWorld();
});
afterAll(() => w?.stop());
beforeEach(async () => {
  if (awsInstalled) await w.restore();
});

const REASON = "The validator flags a sidecar upstream ships this way; read and accepted.";
/** GitHub Actions' App, which posts a dataset workflow's own job runs. */
const GITHUB_ACTIONS = 15368;

const resume = () => w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes"]);
/** `resume --json`: the record and the outcome on standard output, every other line on standard error. */
const resumeJson = async () => {
  const run = await w.cli([
    "repull",
    "resume",
    w.fx.datasetId,
    "--wait-minutes",
    "0",
    "--yes",
    "--json",
  ]);
  return { run, json: JSON.parse(run.stdout) as Record<string, unknown> };
};
const merge = (extra: string[] = []) =>
  w.cli(["repull", "merge", w.fx.datasetId, "--yes", ...extra]);
const overrideMerge = (reason = REASON) => merge(["--bids-failure-reason", reason]);

/** The record taken to gates_clear the way an administrator takes it: resume, the screen, resume. */
async function toGates(): Promise<string> {
  const head = w.row().head_sha as string;
  expect((await resume()).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  const ready = await resume();
  expect(ready.exitCode, ready.all).toBe(0);
  expect(w.row()).toMatchObject({ status: "gates_clear", gates_sha: head });
  return head;
}

/** GitHub as it is for a pull request whose BIDS validation failed and is not required. */
function bidsFailed(
  head: string,
  o: {
    bids?: [string, string | null];
    versionCheck?: [string, string | null];
    state?: string;
  } = {},
): void {
  const [bidsStatus, bidsConclusion] = o.bids ?? ["completed", "failure"];
  const [vcStatus, vcConclusion] = o.versionCheck ?? ["completed", "success"];
  w.gh.checkRuns[`${w.fx.datasetId}@${head}`] = [
    {
      id: 31,
      name: "Run BIDS Validation",
      status: bidsStatus,
      conclusion: bidsConclusion,
      app_id: NEMAR_APP_ID,
    },
    {
      id: 32,
      name: "version-check",
      status: vcStatus,
      conclusion: vcConclusion,
      app_id: NEMAR_APP_ID,
    },
  ];
  Object.assign(w.gh.pulls[prKey(w)] as object, { mergeableState: o.state ?? "unstable" });
}

/** A check of the dataset's own workflow, posted by GitHub Actions, that failed at `head`. */
function otherFailing(head: string): void {
  w.gh.checkRuns[`${w.fx.datasetId}@${head}`]?.push({
    id: 33,
    name: "lint",
    status: "completed",
    conclusion: "failure",
    app_id: GITHUB_ACTIONS,
  });
}

/** What an administrator's own token read of the head's checks and statuses. */
const checkReads = () =>
  w.gh.seen.filter(
    (s) =>
      s.method === "GET" &&
      s.token === ADMIN_TOKEN &&
      (s.path.endsWith("/check-runs") || s.path.endsWith("/status")),
  );

const merges = () => w.gh.seen.filter((s) => s.method === "PUT" && s.path.endsWith("/merge"));
const transitions = () => w.apiWrites.filter((x) => x.endsWith("/transition")).length;
const auditOf = (action: string) =>
  (
    w.db().query("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action) as Array<
      Record<string, unknown>
    >
  ).map((a) => ({ ...a, details: JSON.parse(String(a.details)) as Record<string, unknown> }));

describe.skipIf(!awsInstalled)("a merge over a failed BIDS validation", () => {
  test("failed, version-check passed, unstable and a reason: merged, and the reason recorded with the claim", async () => {
    const head = await toGates();
    bidsFailed(head);
    const run = await overrideMerge();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("over a failed BIDS validation");

    const sent = merges();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.token).toBe(ADMIN_TOKEN);
    expect(sent[0]?.body).toMatchObject({ sha: head, merge_method: "squash" });
    expect(w.row()).toMatchObject({ status: "merged", merge_claim_sha: head });

    const [override] = auditOf("repull_bids_override");
    expect(auditOf("repull_bids_override")).toHaveLength(1);
    expect(override).toMatchObject({ user_id: ADMIN_ID, resource_id: String(w.row().id) });
    expect(override?.details).toEqual({
      dataset_id: w.fx.datasetId,
      pr: "n0",
      sha: head,
      reason: REASON,
      bids_validation: "failure",
      version_check: "success",
      mergeable_state: "unstable",
    });
    const claims = auditOf("repull_transition").filter(
      (a) => a.details.from === "gates_clear" && a.details.to === "gates_clear",
    );
    expect(claims.map((a) => a.details.bids_override)).toEqual([true]);
  });

  test("blocked is refused before any request that writes: merging would be a bypass", async () => {
    const head = await toGates();
    bidsFailed(head, { state: "blocked" });
    const writes = w.apiWrites.length;
    const run = await overrideMerge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(bids)");
    expect(run.all).toContain("would be a bypass");
    expect(w.apiWrites.length).toBe(writes);
    expect(merges()).toEqual([]);
    expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: null });
  });

  test("a fork's head is refused before any request that writes", async () => {
    const head = await toGates();
    bidsFailed(head);
    Object.assign(w.gh.pulls[prKey(w)] as object, { headRepo: `someone/${w.fx.datasetId}` });
    const writes = w.apiWrites.length;
    const run = await overrideMerge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("a fork's pull request is never merged");
    expect(w.apiWrites.length).toBe(writes);
    expect(merges()).toEqual([]);
    expect(auditOf("repull_bids_override")).toEqual([]);
  });

  test("clean is refused before any request that writes: the override is not needed", async () => {
    const head = await toGates();
    bidsFailed(head, { state: "clean" });
    const writes = w.apiWrites.length;
    const run = await overrideMerge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(bids)");
    expect(w.apiWrites.length).toBe(writes);
    expect(merges()).toEqual([]);
  });

  for (const [name, facts, word] of [
    ["BIDS validation still running", { bids: ["in_progress", null] }, "bids-override-bids"],
    ["BIDS validation passed", { bids: ["completed", "success"] }, "bids-override-bids"],
    [
      "version-check failed",
      { versionCheck: ["completed", "failure"] },
      "bids-override-version-check",
    ],
    ["BIDS validation timed out", { bids: ["completed", "timed_out"] }, "bids-override-bids"],
    ["BIDS validation was canceled", { bids: ["completed", "cancelled"] }, "bids-override-bids"],
    ["BIDS validation was skipped", { bids: ["completed", "skipped"] }, "bids-override-bids"],
    [
      "version-check still running",
      { versionCheck: ["in_progress", null] },
      "bids-override-version-check",
    ],
    [
      "version-check was skipped",
      { versionCheck: ["completed", "skipped"] },
      "bids-override-version-check",
    ],
    [
      "version-check was canceled",
      { versionCheck: ["completed", "cancelled"] },
      "bids-override-version-check",
    ],
  ] as const) {
    test(`${name}: the Worker's claim refuses it, and writes nothing`, async () => {
      const head = await toGates();
      bidsFailed(head, facts as Parameters<typeof bidsFailed>[1]);
      const run = await overrideMerge();
      expect(run.exitCode, run.all).toBe(1);
      expect(run.all).toContain("(bids)");
      expect(run.all).toContain(word);
      expect(merges()).toEqual([]);
      expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: null });
      expect(auditOf("repull_bids_override")).toEqual([]);
    });
  }

  test("without the reason the ordinary gate refuses unstable, before the claim", async () => {
    const head = await toGates();
    bidsFailed(head);
    const before = transitions();
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(github)");
    expect(transitions()).toBe(before);
    expect(merges()).toEqual([]);
  });

  test("a reason outside the publication path's length rule is refused before anything", async () => {
    await toGates();
    const writes = w.apiWrites.length;
    for (const reason of ["too short", "x".repeat(501), "         "]) {
      const run = await overrideMerge(reason);
      expect([reason.length, run.exitCode]).toEqual([reason.length, 1]);
      expect(run.all).toContain("10 to 500 characters");
    }
    expect(w.apiWrites.length).toBe(writes);
  });

  test("a re-pull the automatic path opened is never merged over a failed BIDS validation", async () => {
    const head = await toGates();
    bidsFailed(head);
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    const writes = w.apiWrites.length;
    const run = await overrideMerge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(bids)");
    expect(run.all).toContain("automatic path");
    expect(w.apiWrites.length).toBe(writes);
    expect(merges()).toEqual([]);
  });

  test("a claim already held is not used for it: exit 3, and nothing is sent", async () => {
    const head = await toGates();
    bidsFailed(head);
    w.db().run(
      "UPDATE upstream_repulls SET merge_claimed_at = datetime('now', '-2 minutes'), merge_claim_sha = gates_sha",
    );
    const run = await overrideMerge();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("a claim of its own");
    expect(merges()).toEqual([]);
    expect(auditOf("repull_bids_override")).toEqual([]);
  });

  test("a state that turns blocked after the claim is not merged, and the claim is kept", async () => {
    const head = await toGates();
    bidsFailed(head);
    // A rule that requires the check lands between the claim, once the Worker has recorded it,
    // and the merge's last look.
    w.setApiAfter((req) => {
      if (req.method === "POST" && new URL(req.url).pathname.endsWith("/transition")) {
        Object.assign(w.gh.pulls[prKey(w)] as object, { mergeableState: "blocked" });
      }
      return null;
    });
    const run = await overrideMerge();
    expect(run.exitCode, run.all).toBe(3);
    expect(merges()).toEqual([]);
    expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: head });
  });

  test("another check that fails at the head is refused before any request that writes", async () => {
    const head = await toGates();
    bidsFailed(head);
    otherFailing(head);
    const writes = w.apiWrites.length;
    const run = await overrideMerge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(bids)");
    expect(run.all).toContain("another check");
    expect(run.all).toContain("lint");
    expect(w.apiWrites.length).toBe(writes);
    expect(merges()).toEqual([]);
    expect(auditOf("repull_bids_override")).toEqual([]);
  });

  test("a check that starts failing after the gate's read is refused under the lock, before the claim", async () => {
    const head = await toGates();
    bidsFailed(head);
    // The gate reads the checks at its step 7, then the review is read again before the
    // confirmation and the lock: the failing check lands between the two reads of the checks.
    let reviewReads = 0;
    w.setApiHook(async (req) => {
      if (req.method === "GET" && new URL(req.url).pathname.startsWith("/admin/pr-reviews/")) {
        reviewReads++;
        if (reviewReads === 2) otherFailing(head);
      }
    });
    const before = transitions();
    const run = await overrideMerge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(bids)");
    expect(run.all).toContain("another check");
    expect(run.all).toContain("lint");
    expect(reviewReads).toBe(2);
    // The gate's read passed it; the read under the lock refused it, so nothing was claimed.
    expect(checkReads().filter((s) => s.path.endsWith("/check-runs"))).toHaveLength(2);
    expect(transitions()).toBe(before);
    expect(merges()).toEqual([]);
    expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: null });
    expect(auditOf("repull_bids_override")).toEqual([]);
  });

  test("the ordinary merge of a clean head reads no check, as before", async () => {
    const head = await toGates();
    const run = await merge();
    expect(run.exitCode, run.all).toBe(0);
    expect(merges()).toHaveLength(1);
    expect(merges()[0]?.body).toMatchObject({ sha: head, merge_method: "squash" });
    expect(checkReads()).toEqual([]);
    expect(w.row()).toMatchObject({ status: "merged" });
    expect(auditOf("repull_bids_override")).toEqual([]);
  });
});

describe.skipIf(!awsInstalled)("the override in the normal order: resume, then the merge", () => {
  test("BIDS validation alone fails: resume records the gates, and the merge goes over it with the reason", async () => {
    const head = w.row().head_sha as string;
    bidsFailed(head);
    // The screen is dispatched and waited for; GitHub's `unstable` is not what it waits for.
    const first = await resume();
    expect(first.exitCode, first.all).toBe(3);
    expect(first.all).toContain(`identifier screen of ${head.slice(0, 12)}`);
    expect(first.all).not.toContain("clean (it reports");
    await w.reportScreen(head, "clean");
    const ready = await resume();
    expect(ready.exitCode, ready.all).toBe(0);
    expect(ready.all).toContain("unstable only because BIDS validation failed");
    expect(ready.all).toContain(
      `Ready to merge over the failed BIDS validation: nemar admin repull merge ${w.fx.datasetId} --bids-failure-reason`,
    );
    expect(w.row()).toMatchObject({ status: "gates_clear", gates_sha: head, last_error: null });
    // Resume read the head's checks and statuses with the administrator's own token, and merged nothing.
    expect(checkReads().length).toBeGreaterThanOrEqual(2);
    expect(merges()).toEqual([]);

    const run = await overrideMerge();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("over a failed BIDS validation");
    const sent = merges();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.token).toBe(ADMIN_TOKEN);
    expect(sent[0]?.body).toMatchObject({ sha: head, merge_method: "squash" });
    expect(w.row()).toMatchObject({ status: "merged", merge_claim_sha: head });
    expect(auditOf("repull_bids_override")).toHaveLength(1);
  });

  const notBidsOnly: Array<[string, (head: string) => void, string]> = [
    ["another check fails", (head) => otherFailing(head), "another check"],
    [
      "a commit status fails",
      (head) => {
        w.gh.statuses[`${w.fx.datasetId}@${head}`] = [{ context: "ci/external", state: "failure" }];
      },
      "ci/external",
    ],
    [
      "another check is still running",
      (head) => {
        w.gh.checkRuns[`${w.fx.datasetId}@${head}`]?.push({
          id: 34,
          name: "slow",
          status: "in_progress",
          conclusion: null,
          app_id: GITHUB_ACTIONS,
        });
      },
      "slow",
    ],
    [
      "version-check failed too",
      (head) => bidsFailed(head, { versionCheck: ["completed", "failure"] }),
      "version-check",
    ],
    [
      "BIDS validation passed, so something else makes it unstable",
      (head) => bidsFailed(head, { bids: ["completed", "success"] }),
      "BIDS validation",
    ],
  ];
  for (const [name, flip, word] of notBidsOnly) {
    test(`unstable where ${name}: resume does not record the gates`, async () => {
      const head = w.row().head_sha as string;
      bidsFailed(head);
      flip(head);
      expect((await resume()).exitCode).toBe(3);
      await w.reportScreen(head, "clean");
      const run = await resume();
      expect(run.exitCode, run.all).toBe(3);
      expect(run.all).toContain("it reports 'unstable'");
      expect(run.all).toContain(word);
      expect(w.row()).toMatchObject({ status: "pr_open", gates_sha: null });
    });
  }

  test("unstable only because the review check fails: resume names that check and the start that publishes the waiver (ADR 0117)", async () => {
    const head = w.row().head_sha as string;
    // BIDS validation and version-check pass; the review the contributor rules failed is the one
    // check that does not, which is what a re-pull's head showed before the waiver existed.
    bidsFailed(head, { bids: ["completed", "success"] });
    w.gh.checkRuns[`${w.fx.datasetId}@${head}`]?.push({
      id: 35,
      name: "NEMAR PR Review",
      status: "completed",
      conclusion: "failure",
      app_id: NEMAR_APP_ID,
    });
    expect((await resume()).exitCode).toBe(3);
    await w.reportScreen(head, "clean");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("it reports 'unstable'");
    expect(run.all).toContain(
      `BIDS validation of ${head.slice(0, 12)} has not failed; what does not pass there is: NEMAR PR Review`,
    );
    expect(run.all).toContain(
      `nemar admin pr-reviews start ${w.fx.datasetId} ${w.row().pr_number}`,
    );
    // Not the words that sent an administrator after BIDS validation, which passed.
    expect(run.all).not.toContain("has not completed with failure");
    expect(w.row()).toMatchObject({ status: "pr_open", gates_sha: null });
  });

  test("BIDS validation and the review check both fail: resume names the review check and the start that publishes the waiver (ADR 0117)", async () => {
    const head = w.row().head_sha as string;
    bidsFailed(head);
    w.gh.checkRuns[`${w.fx.datasetId}@${head}`]?.push({
      id: 35,
      name: "NEMAR PR Review",
      status: "completed",
      conclusion: "failure",
      app_id: NEMAR_APP_ID,
    });
    expect((await resume()).exitCode).toBe(3);
    await w.reportScreen(head, "clean");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain(
      `another check of ${head.slice(0, 12)} does not pass (NEMAR PR Review)`,
    );
    expect(run.all).toContain(
      `run nemar admin pr-reviews start ${w.fx.datasetId} ${w.row().pr_number} to publish the waiver, then run this command again`,
    );
    // The waiver is a 0.10.27 Worker's; the hint does not claim one from an older Worker.
    expect(run.all).toContain("an older Worker does not publish the waiver");
    expect(w.row()).toMatchObject({ status: "pr_open", gates_sha: null });
  });

  test("BIDS validation and another check fail: resume names that check, and no start", async () => {
    const head = w.row().head_sha as string;
    bidsFailed(head);
    otherFailing(head);
    expect((await resume()).exitCode).toBe(3);
    await w.reportScreen(head, "clean");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain(`another check of ${head.slice(0, 12)} does not pass (lint)`);
    expect(run.all).not.toContain("pr-reviews start");
  });

  test("unstable because a check other than BIDS validation fails: resume names that check, not BIDS validation", async () => {
    const head = w.row().head_sha as string;
    bidsFailed(head, { bids: ["completed", "success"] });
    w.gh.statuses[`${w.fx.datasetId}@${head}`] = [{ context: "ci/external", state: "failure" }];
    expect((await resume()).exitCode).toBe(3);
    await w.reportScreen(head, "clean");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain(
      `BIDS validation of ${head.slice(0, 12)} has not failed; what does not pass there is: ci/external`,
    );
    expect(run.all).not.toContain("has not completed with failure");
    // No review check fails, so the waiver is not named.
    expect(run.all).not.toContain("pr-reviews start");
  });

  test("clean is gated as before: no read of the checks, and the ordinary merge is named", async () => {
    const head = w.row().head_sha as string;
    expect((await resume()).exitCode).toBe(3);
    await w.reportScreen(head, "clean");
    const ready = await resume();
    expect(ready.exitCode, ready.all).toBe(0);
    expect(ready.all).toContain(`Ready to merge: nemar admin repull merge ${w.fx.datasetId}`);
    expect(ready.all).not.toContain("BIDS");
    expect(checkReads()).toEqual([]);
    expect(w.row()).toMatchObject({ status: "gates_clear", gates_sha: head });
  });

  test("a re-pull the automatic path opened is not gated on unstable, BIDS validation alone failing", async () => {
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    const head = w.row().head_sha as string;
    bidsFailed(head);
    expect((await resume()).exitCode).toBe(3);
    await w.reportScreen(head, "clean");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("it reports 'unstable'");
    expect(checkReads()).toEqual([]);
    expect(w.row()).toMatchObject({ status: "pr_open", gates_sha: null });
  });

  test("gated over a failed BIDS validation, the merge without the reason refuses unstable", async () => {
    const head = w.row().head_sha as string;
    bidsFailed(head);
    expect((await resume()).exitCode).toBe(3);
    await w.reportScreen(head, "clean");
    expect((await resume()).exitCode).toBe(0);
    expect(w.row()).toMatchObject({ status: "gates_clear", gates_sha: head });
    const before = transitions();
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(github)");
    expect(run.all).toContain("'unstable'");
    expect(transitions()).toBe(before);
    expect(merges()).toEqual([]);
    expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: null });
  });

  test("a second resume at the gates names the override while BIDS validation alone fails, and so does --json", async () => {
    const head = w.row().head_sha as string;
    bidsFailed(head);
    expect((await resume()).exitCode).toBe(3);
    await w.reportScreen(head, "clean");
    // The gates recorded over the failed validation, read as JSON.
    const gated = await resumeJson();
    expect(gated.run.exitCode, gated.run.all).toBe(0);
    expect(gated.json).toMatchObject({ outcome: "ready", bids_failure: true, waiting_for: null });
    expect(w.row()).toMatchObject({ status: "gates_clear", gates_sha: head });

    // A second resume takes the record at gates_clear, where nothing is recorded again.
    const ready = `Ready to merge: nemar admin repull merge ${w.fx.datasetId}`;
    const over = `Ready to merge over the failed BIDS validation: nemar admin repull merge ${w.fx.datasetId} --bids-failure-reason`;
    const again = await resume();
    expect(again.exitCode, again.all).toBe(0);
    expect(again.all).toContain(over);
    expect(again.all).not.toContain(ready);
    const againJson = await resumeJson();
    expect(againJson.run.exitCode, againJson.run.all).toBe(0);
    expect(againJson.json).toMatchObject({
      outcome: "ready",
      bids_failure: true,
      waiting_for: null,
      repull: { status: "gates_clear" },
    });
    expect(againJson.run.stderr).toContain(over);

    // Once BIDS validation passes, GitHub reports clean and the ordinary merge is named.
    bidsFailed(head, { bids: ["completed", "success"], state: "clean" });
    const clean = await resume();
    expect(clean.exitCode, clean.all).toBe(0);
    expect(clean.all).toContain(ready);
    expect(clean.all).not.toContain("--bids-failure-reason");
    expect((await resumeJson()).json).toMatchObject({ outcome: "ready", bids_failure: false });
    expect(w.row()).toMatchObject({ status: "gates_clear", gates_sha: head });
  });
});

/**
 * GitHub failing one of the two reads the override rests on (`src/lib/repull/bids-only.ts`: every
 * check run of the head, and its combined status), with the administrator's own token. The stand-in
 * answers that read with an HTTP error, an error-path fixture; unknown is never BIDS-only.
 */
describe.skipIf(!awsInstalled)(
  "an HTTP error on a read of the head's checks refuses the override",
  () => {
    const reads = [
      ["check-runs", "the check runs of"],
      ["status", "the commit statuses of"],
    ] as const;

    for (const [read, words] of reads) {
      test(`the ${read} read answers 500: the merge over BIDS is refused before anything is written`, async () => {
        const head = await toGates();
        bidsFailed(head);
        w.gh.readFaults[`${w.fx.datasetId}@${head}/${read}`] = 500;
        const writes = w.apiWrites.length;
        const run = await overrideMerge();
        expect(run.exitCode, run.all).toBe(1);
        expect(run.all).toContain("(github)");
        expect(run.all).toContain(`${words} ${head.slice(0, 12)} could not be read`);
        expect(run.all).toContain("HTTP 500");
        expect(w.apiWrites.length).toBe(writes);
        expect(merges()).toEqual([]);
        expect(auditOf("repull_bids_override")).toEqual([]);
        expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: null });
      });

      test(`the ${read} read answers 500: resume does not record the gates of a BIDS-only head`, async () => {
        const head = w.row().head_sha as string;
        bidsFailed(head);
        w.gh.readFaults[`${w.fx.datasetId}@${head}/${read}`] = 500;
        expect((await resume()).exitCode).toBe(3);
        await w.reportScreen(head, "clean");
        const run = await resume();
        expect(run.exitCode, run.all).toBe(3);
        expect(run.all).toContain("it reports 'unstable'");
        expect(run.all).toContain(`${words} ${head.slice(0, 12)} could not be read`);
        expect(w.row()).toMatchObject({ status: "pr_open", gates_sha: null });
      });
    }
  },
);
