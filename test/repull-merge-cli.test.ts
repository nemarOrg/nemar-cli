/**
 * `nemar admin repull merge <id>`: the one gate a re-pull's pull request merges through (ADR 0111,
 * decisions 1, 6 and 7; epic #1046 phase 6, #1912), driven through the real entry point against
 * `repull-pr-world.ts` (a re-pull executed to `pr_open` by the real `execute`, then taken to
 * `gates_clear` by the real `resume`; the real API over bun:sqlite; stand-ins for GitHub and S3
 * only, GitHub's squash merge committing onto the bare origin's `main`). No mocks.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - the merge is a squash at the screened `sha`, sent after the claim, with a message whose last
 *    paragraph is both of the re-pull commit's trailers as git reads them, and is recorded;
 *  - a cap that is used up sends no merge; a `main` moved by a commit enrichment does not make, a
 *    state that is not `clean`, and a review that is still running are refused before the claim;
 *  - a squash message without both trailers as its last paragraph is refused at the gate;
 *  - a head that moves between the gate's last read and the merge is refused by GitHub, because
 *    the merge carries the screened `sha`, and the claim is then kept, not repeated;
 *  - a merge whose answer is lost keeps its claim, and the next `resume` records the merge.
 *
 * What only the canary and the first production runs can check: that GitHub's real merge endpoint
 * refuses a moved head for `sha` as the stand-in does (a 409), that it writes `commit_title` and
 * `commit_message` as the squash commit's message unchanged, and how it answers a ruleset.
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
import { seedReview } from "../backend/test/helpers/pr-queue-fixtures";
import { ADMIN_TOKEN } from "./helpers/github-standin";
import { gitIn } from "./helpers/repull-fixture";
import {
  type RepullWorld,
  enrichedMetadata,
  prKey,
  startRepullWorld,
} from "./helpers/repull-pr-world";
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

const resume = () => w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes"]);
const merge = (extra: string[] = []) =>
  w.cli(["repull", "merge", w.fx.datasetId, "--yes", ...extra]);

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

const merges = () => w.gh.seen.filter((s) => s.method === "PUT" && s.path.endsWith("/merge"));
const mainOf = async () => (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();

describe.skipIf(!awsInstalled)("the merge", () => {
  test("squashes at the screened sha after the claim, its message ends with both trailers, and is recorded", async () => {
    const head = await toGates();
    const mainBefore = await mainOf();
    // When the claim reaches the API, no merge has been sent yet.
    let mergesAtClaim = -1;
    w.setApiHook(async (req) => {
      if (req.method === "POST" && new URL(req.url).pathname.endsWith("/transition")) {
        const body = (await req.json()) as { fields?: Record<string, unknown> };
        if (body.fields?.merge_claim_sha) mergesAtClaim = merges().length;
      }
    });
    const run = await merge();
    expect(run.exitCode, run.all).toBe(0);
    expect(mergesAtClaim).toBe(0);

    const sent = merges();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.token).toBe(ADMIN_TOKEN);
    expect(sent[0]?.body).toMatchObject({
      sha: head,
      merge_method: "squash",
      commit_title: `Release v2.0.0 (#${w.row().pr_number})`,
    });
    // On main: one squash commit, the synthesized tree, both trailers as git reads them.
    const mainAfter = await mainOf();
    expect((await gitIn(w.fx.originRepo, ["rev-parse", `${mainAfter}^@`])).trim()).toBe(mainBefore);
    expect((await gitIn(w.fx.originRepo, ["rev-parse", `${mainAfter}^{tree}`])).trim()).toBe(
      w.row().synth_tree,
    );
    const trailers = (
      await gitIn(w.fx.originRepo, ["log", "-1", "--format=%(trailers:only,unfold)", mainAfter])
    )
      .trim()
      .split("\n");
    const synthTrailers = (
      await gitIn(w.fx.originRepo, [
        "log",
        "-1",
        "--format=%(trailers:only,unfold)",
        w.row().synth_sha,
      ])
    )
      .trim()
      .split("\n");
    expect(trailers).toEqual(synthTrailers);
    expect(trailers).toHaveLength(2);

    expect(w.row()).toMatchObject({
      status: "merged",
      merge_sha: mainAfter,
      merge_claim_sha: head,
    });
    // A claim was held and the head was the screened one: neither count is written.
    expect(JSON.parse(w.row().counts)).not.toHaveProperty("merged_outside_tool");
    expect(JSON.parse(w.row().counts)).not.toHaveProperty("merged_unscreened_head");
  });

  test("a cap that is used up sends no merge", async () => {
    await toGates();
    w.workerEnv.REPULL_DAILY_MERGE_CAP = "0";
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(cap)");
    expect(merges()).toEqual([]);
    expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: null });
  });

  test("main moved by a commit enrichment does not make: refused before the claim", async () => {
    await toGates();
    await w.commitOnto("refs/heads/main", "README.md", "A change by hand.\n");
    const writes = w.apiWrites.length;
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(main-moved)");
    expect(w.apiWrites.length).toBe(writes);
    expect(merges()).toEqual([]);
  });

  test("main moved by enrichment only is merged", async () => {
    await toGates();
    await w.commitOnto(
      "refs/heads/main",
      ".nemar/metadata.json",
      await enrichedMetadata(w.fx.originRepo, "refs/heads/main"),
      "enrichment",
    );
    const run = await merge();
    expect(run.exitCode, run.all).toBe(0);
    expect(w.row().status).toBe("merged");
  });

  test("a state that is not clean is refused before the claim", async () => {
    await toGates();
    Object.assign(w.gh.pulls[prKey(w)] as object, { mergeableState: "blocked" });
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(github)");
    expect(w.row().merge_claim_sha).toBeNull();
    expect(merges()).toEqual([]);
  });

  test("the review is read at the merge: one still running needs --force", async () => {
    const head = await toGates();
    // A stored pass reset to running on the same head (`pr-reviews start --redo`).
    seedReview(w.db(), {
      ds: w.fx.datasetId,
      n: w.row().pr_number as number,
      sha: head,
      state: "dispatched",
    });
    const refused = await merge();
    expect(refused.exitCode, refused.all).toBe(1);
    expect(refused.all).toContain("(review)");
    expect(w.row().merge_claim_sha).toBeNull();
    const forced = await merge(["--force"]);
    expect(forced.exitCode, forced.all).toBe(0);
    expect(w.row().status).toBe("merged");
  });

  test("a record that is not gates_clear is not ready, and names resume", async () => {
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(not-ready)");
    expect(run.all).toContain(`nemar admin repull resume ${w.fx.datasetId}`);
    expect(merges()).toEqual([]);
  });

  test("a squash message without both trailers as its last paragraph is refused at the gate", async () => {
    await toGates();
    // A record whose tag the ledger proof's pattern cannot read as a trailer value: the message the
    // gate would send could not prove the commit is the re-pull's.
    w.db().run("UPDATE upstream_repulls SET to_tag = '1.1.0 (final)'");
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(message)");
    expect(w.row().merge_claim_sha).toBeNull();
    expect(merges()).toEqual([]);
  });
});

describe.skipIf(!awsInstalled)("what GitHub answers after the claim", () => {
  test("a head that moves between the gate and the merge is refused by GitHub, and the claim is kept", async () => {
    const head = await toGates();
    const ref = `refs/heads/${w.row().branch}`;
    const mainBefore = await mainOf();
    w.gh.beforeMerge = async () => {
      w.gh.beforeMerge = null;
      await w.commitOnto(
        ref,
        ".nemar/metadata.json",
        await enrichedMetadata(w.fx.originRepo, ref),
        "enrichment",
      );
    };
    const run = await merge();
    expect(run.exitCode, run.all).toBe(3);
    expect(merges()).toHaveLength(1);
    expect(merges()[0]?.body?.sha).toBe(head);
    expect(await mainOf()).toBe(mainBefore);
    // The claim is kept (it is younger than the Worker's bound), so the unit is not repeated.
    expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: head });
    // Merging again is not ready (the head moved since the gates), and makes no second claim.
    const claims = () => w.apiWrites.filter((x) => x.endsWith("/transition")).length;
    const before = claims();
    const again = await merge();
    expect(again.exitCode, again.all).toBe(1);
    expect(again.all).toContain("(not-ready)");
    expect(claims()).toBe(before);
    expect(merges()).toHaveLength(1);
  });

  test("a merge whose answer is lost keeps its claim, and the next resume records the merge", async () => {
    const head = await toGates();
    w.gh.lostMergeAnswers = true;
    const run = await merge();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("may have merged it");
    expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: head });
    const mainNow = await mainOf();
    expect(mainNow).not.toBe(w.row().base_sha);
    const next = await resume();
    expect(next.all).toContain("is merged");
    expect(w.row()).toMatchObject({ status: "merged", merge_sha: mainNow });
    expect(JSON.parse(w.row().counts)).not.toHaveProperty("merged_outside_tool");
  });
});
