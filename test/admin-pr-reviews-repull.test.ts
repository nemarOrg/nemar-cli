/**
 * `nemar admin pr-reviews` on an upstream re-pull's pull request (ADR 0111, decision 7; ADR 0093;
 * epic #1046 phase 6, #1912): `approve --merge` and `y` in `next` merge it only through the
 * re-pull's gate, whose checks run before the approval is written, and an ordinary release pull
 * request is merged as before. Driven through the real entry point against `repull-pr-world.ts`
 * (the real `execute`, `resume` and API, reached through TEST_API_URL in the child's environment;
 * stand-ins for GitHub and S3 only). No mocks.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - `approve --merge` on a re-pull pull request approves, then claims the cap and squash-merges
 *    at the screened head with the gate's message, and the merge is recorded;
 *  - a gate that refuses writes no approval;
 *  - an explicit `--method` other than squash is refused before anything is written;
 *  - an ordinary `release/*` pull request (no re-pull record names it) is merged as before;
 *  - a NEMAR API that cannot say whether a `release/*` pull request is a re-pull's refuses its
 *    merge, and approves nothing;
 *  - `y` in `next` merges a re-pull pull request through the gate.
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
import { prNode, seedReview } from "../backend/test/helpers/pr-queue-fixtures";
import { ADMIN_TOKEN } from "./helpers/github-standin";
import { gitIn } from "./helpers/repull-fixture";
import { type RepullWorld, prKey, startRepullWorld } from "./helpers/repull-pr-world";
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

async function toGates(): Promise<string> {
  const head = w.row().head_sha as string;
  await resume();
  await w.reportScreen(head, "clean");
  const ready = await resume();
  expect(ready.exitCode, ready.all).toBe(0);
  return head;
}

const approve = (pr: number, extra: string[] = []) =>
  w.cli(["pr-reviews", "approve", w.fx.datasetId, String(pr), "--merge", "--yes", ...extra]);
const reviewPosts = () =>
  w.gh.seen.filter((s) => s.method === "POST" && s.path.endsWith("/reviews"));
const merges = () => w.gh.seen.filter((s) => s.method === "PUT" && s.path.endsWith("/merge"));

describe.skipIf(!awsInstalled)("approve --merge", () => {
  test("approves, then merges a re-pull pull request through its gate", async () => {
    const head = await toGates();
    const pr = w.row().pr_number as number;
    const run = await approve(pr);
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("through the re-pull's gate");
    expect(reviewPosts()).toHaveLength(1);
    expect(reviewPosts()[0]).toMatchObject({ token: ADMIN_TOKEN, body: { commit_id: head } });
    expect(merges()).toHaveLength(1);
    expect(merges()[0]?.body).toMatchObject({
      sha: head,
      merge_method: "squash",
      commit_title: `Release v2.0.0 (#${pr})`,
    });
    expect(String(merges()[0]?.body?.commit_message)).toMatch(
      /\n\nUpstream-Snapshot: ds099999@1\.1\.0\nRepull-Plan: sha256:[0-9a-f]{64}$/,
    );
    // The cap was claimed before the merge, and the merge is recorded.
    expect(w.row()).toMatchObject({ status: "merged", merge_claim_sha: head });
  });

  test("a gate that refuses writes no approval", async () => {
    // Not gates_clear: the screen and GitHub's state were never recorded.
    const run = await approve(w.row().pr_number as number);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merges only through its gate");
    expect(run.all).toContain("Nothing was approved or merged");
    expect(reviewPosts()).toEqual([]);
    expect(merges()).toEqual([]);
  });

  test("an explicit --method other than squash is refused before anything is written", async () => {
    await toGates();
    const run = await approve(w.row().pr_number as number, ["--method", "merge"]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("squash-merged");
    expect(reviewPosts()).toEqual([]);
    expect(merges()).toEqual([]);
  });

  test("an ordinary release pull request is merged as before", async () => {
    const other = (w.row().pr_number as number) + 10;
    // A release branch of the dataset's own, as `nemar dataset release` pushes one.
    await gitIn(w.fx.originRepo, ["update-ref", "refs/heads/release/v1.0.1", w.row().base_sha]);
    w.gh.pulls[`${w.fx.datasetId}#${other}`] = {
      sha: w.row().base_sha,
      headRef: "release/v1.0.1",
      author: "alice",
    };
    const run = await approve(other);
    expect(run.exitCode, run.all).toBe(0);
    expect(reviewPosts()).toHaveLength(1);
    expect(merges()).toHaveLength(1);
    expect(merges()[0]?.body).toMatchObject({ merge_method: "merge" });
    expect(merges()[0]?.body).not.toHaveProperty("commit_message");
    // The re-pull's record is untouched.
    expect(w.row()).toMatchObject({ status: "pr_open", merge_claim_sha: null });
  });

  test("a NEMAR API that cannot say whether it is a re-pull's refuses the merge, and approves nothing", async () => {
    await toGates();
    w.setApiOverride((req) =>
      req.method === "GET" && new URL(req.url).pathname === "/admin/repulls"
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : null,
    );
    const run = await approve(w.row().pr_number as number);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("Could not tell whether this is an upstream re-pull's pull request");
    expect(reviewPosts()).toEqual([]);
    expect(merges()).toEqual([]);
  });
});

describe.skipIf(!awsInstalled)("approve --merge, what refuses", () => {
  test("a pull request whose head branch GitHub does not name is refused, and approves nothing", async () => {
    const other = (w.row().pr_number as number) + 20;
    w.gh.pulls[`${w.fx.datasetId}#${other}`] = {
      sha: w.row().base_sha,
      headRef: "",
      author: "alice",
    };
    const run = await approve(other);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("did not name the pull request's head branch");
    expect(reviewPosts()).toEqual([]);
    expect(merges()).toEqual([]);
  });

  test("a re-pull's N.0.1 pull request is refused: merging N.0.1 is not built", async () => {
    await toGates();
    const n1 = (w.row().pr_number as number) + 30;
    w.db().run(
      "UPDATE upstream_repulls SET patch_version = '2.0.1', patch_branch = 'release/v2.0.1', patch_pr_number = ?",
      [n1],
    );
    w.gh.pulls[`${w.fx.datasetId}#${n1}`] = {
      sha: w.row().head_sha as string,
      headRef: "release/v2.0.1",
      author: "alice",
    };
    const run = await approve(n1);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("N.0.1");
    expect(reviewPosts()).toEqual([]);
    expect(merges()).toEqual([]);
  });

  test("the gate runs again after the confirmation: a head that moved meanwhile approves nothing", async () => {
    await toGates();
    const ref = `refs/heads/${w.row().branch}`;
    let lists = 0;
    w.setApiHook(async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/admin/repulls") {
        lists++;
        // The second look is the one after the confirmation: a push lands just before it.
        if (lists === 2) await w.commitOnto(ref, "README.md", "Pushed meanwhile.\n");
      }
    });
    const run = await approve(w.row().pr_number as number);
    expect(run.exitCode, run.all).toBe(1);
    expect(lists).toBe(2);
    expect(run.all).toContain("Nothing was approved or merged");
    expect(reviewPosts()).toEqual([]);
    expect(merges()).toEqual([]);
  });
});

describe.skipIf(!awsInstalled)("next", () => {
  test("y merges a re-pull pull request through its gate", async () => {
    const head = await toGates();
    const pr = w.row().pr_number as number;
    // The queue lists the pull request with both checks green and a passing review of its head.
    Object.assign(w.gh.pulls[prKey(w)] as object, { author: "alice" });
    w.gh.searchPages = [
      [
        prNode({
          ds: w.fx.datasetId,
          n: pr,
          sha: head,
          branch: "release/v2.0.0",
          author: "alice",
          authorId: 42,
        }),
      ],
    ];
    seedReview(w.db(), {
      ds: w.fx.datasetId,
      n: pr,
      sha: head,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    const run = await w.cli(["pr-reviews", "next", "--dataset", w.fx.datasetId], {}, "y\n");
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("through the re-pull's gate");
    expect(reviewPosts()).toHaveLength(1);
    expect(merges()).toHaveLength(1);
    expect(merges()[0]?.body).toMatchObject({ sha: head, merge_method: "squash" });
    expect(w.row()).toMatchObject({ status: "merged" });
  });
});
