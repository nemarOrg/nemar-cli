/**
 * `nemar admin repull merge <id> --bids-failure-reason "<text>"`: an administrator's merge of a
 * re-pull pull request over a failed BIDS validation (ADR 0111, the Phase 7g amendment; epic
 * #1046 phase 7, #1913), driven through the real entry point against `repull-pr-world.ts` (a
 * re-pull executed to `pr_open` by the real `execute`, taken to `gates_clear` by the real `resume`;
 * the real API over bun:sqlite, reached through TEST_API_URL; stand-ins for GitHub and S3 only,
 * GitHub's squash merge committing onto the bare origin's `main`). No mocks.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - with BIDS validation failed, `version-check` passed and GitHub's `unstable`, the merge is
 *    claimed with the reason, sent as a squash at the screened `sha`, recorded, and the reason is
 *    written in its own audit row with the claim;
 *  - `blocked` (a rule requires the check: a merge would be a bypass) and `clean` (no override is
 *    needed) are refused before any request that writes;
 *  - BIDS validation still running, and a failed `version-check`, are refused by the Worker's claim,
 *    which writes nothing;
 *  - without the reason the ordinary gate refuses `unstable`; a reason outside the length rule and
 *    a re-pull the automatic path opened are refused before anything is written.
 *
 * What only the first production use can check: that GitHub reports `unstable`, and not `blocked`,
 * for an unprotected mirror whose BIDS validation failed, as `nm000413#3` read for a held review,
 * and that its merge endpoint merges an `unstable` pull request with `sha` as the stand-in does.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
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

const resume = () => w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes"]);
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
});
