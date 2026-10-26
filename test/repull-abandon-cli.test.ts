/**
 * `nemar admin repull abandon <id>` (ADR 0111, decision 3; epic #1046 phase 6, #1912), driven
 * through the real entry point against `repull-pr-world.ts` (a re-pull executed to `pr_open` by the
 * real `execute`; the real API over bun:sqlite through TEST_API_URL in the child's environment;
 * stand-ins for GitHub and S3 only). No mocks.
 *
 * The properties, each with a test:
 *  - before the merge, the pull request is closed, the release branch deleted, the orphans equal
 *    what the copy and the uploads wrote (objects and bytes, nothing deleted from the bucket), the
 *    record ends `abandoned`, and a new attempt at the tag is then allowed;
 *  - a release branch whose head is not the re-pull's commit or enrichment's is kept, and said;
 *  - a pull request GitHub merged while the record is still `pr_open` is never abandoned: nothing
 *    is closed or deleted and the record stays open, for resume to record the merge;
 *  - between the merge and the release abandon is refused (`wait-for-release`);
 *  - a held claim to merge is refused (`merge-claim-held`);
 *  - the recorded pull request is read by its number even when the list by head misses it;
 *  - a merge found after the close stops the record from being ended;
 *  - a branch that moved after it was judged the re-pull's is not deleted (the delete is leased);
 *  - a page of 100 or more pull requests is not read as whole, and nothing is closed;
 *  - the record's checkpoint is removed when it ends.
 *
 * What only the first production runs can check: that GitHub closes a pull request and deletes a
 * branch of a dataset repository as the stand-in does, and lists a branch's pull requests by its
 * `head` filter.
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
import { existsSync } from "node:fs";
import { which } from "bun";
import { defaultPlanPath } from "../src/lib/repull/digest";
import { workPaths } from "../src/lib/repull/execute/workdir";
import { TAG_B, gitIn } from "./helpers/repull-fixture";
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

const abandon = () => w.cli(["repull", "abandon", w.fx.datasetId, "--yes"]);
const resume = () => w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes"]);
const hasRef = async (ref: string) =>
  (await gitIn(w.fx.originRepo, ["for-each-ref", "--format=%(refname)", ref])).trim() !== "";

/** The objects the copy and the uploads wrote, from the staging manifest, and their bytes. */
function written(): { objects: number; bytes: number } {
  const staging = w.s3.current("nemar", `${w.fx.datasetId}/staging/repull-${TAG_B}.json`);
  if (!staging) throw new Error("the copy left no staging manifest");
  const m = JSON.parse(Buffer.from(staging.data).toString("utf8")) as {
    items: Array<{ key: string }>;
    local: Array<{ key: string }>;
  };
  const keys = [...new Set([...m.items, ...m.local].map((i) => i.key))];
  let bytes = 0;
  for (const k of keys)
    bytes += w.s3.current("nemar", `${w.fx.datasetId}/objects/${k}`)?.data.length ?? 0;
  return { objects: keys.length, bytes };
}

describe.skipIf(!awsInstalled)("abandon", () => {
  test("before the merge: closes the pull request, deletes the branch, reports the orphans, and a new attempt is allowed", async () => {
    const pr = w.row().pr_number as number;
    expect(
      existsSync(workPaths(w.configDir, w.fx.datasetId, w.row().plan_digest as string).bundle),
    ).toBe(true);
    const orphans = written();
    expect(orphans.objects).toBeGreaterThan(0);
    const before = w.s3.keys("nemar", `${w.fx.datasetId}/`).length;
    const deletes = w.s3.calls("DeleteObject").length;
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(0);
    const row = w.row();
    expect(row.status).toBe("abandoned");
    expect(w.gh.pulls[`${w.fx.datasetId}#${pr}`]?.state).toBe("closed");
    expect(w.gh.pulls[`${w.fx.datasetId}#${pr}`]?.merged).not.toBe(true);
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(false);
    expect(JSON.parse(row.counts)).toMatchObject({
      orphan_objects: orphans.objects,
      orphan_bytes: orphans.bytes,
    });
    expect(run.all).toContain(`${orphans.objects} object(s), ${orphans.bytes} byte(s)`);
    // Nothing is deleted from the bucket, the staging manifest included.
    expect(w.s3.keys("nemar", `${w.fx.datasetId}/`).length).toBe(before);
    expect(w.s3.calls("DeleteObject").length).toBe(deletes);
    // Main and the tags are untouched.
    expect(await hasRef("refs/tags/v1.0.0")).toBe(true);
    // The checkpoint and the working directory went with the record.
    const paths = workPaths(w.configDir, w.fx.datasetId, row.plan_digest as string);
    expect(existsSync(paths.bundle)).toBe(false);
    expect(existsSync(paths.root)).toBe(false);

    // A new attempt at the tag: planned again (the registration moved NEMAR's git-annex branch).
    const planned = await w.cli(["repull", "plan", w.fx.datasetId, "--json"]);
    expect(planned.exitCode, planned.all).toBe(0);
    const digest = (JSON.parse(planned.stdout) as { digest: string }).digest;
    const file = defaultPlanPath(w.configDir, w.fx.datasetId, TAG_B, digest);
    const again = await w.cli(["repull", "execute", file, "--until", "planned", "--yes"]);
    expect(again.exitCode, again.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "planned", attempt: 2, to_tag: TAG_B });
  });

  test("a release branch holding a commit that is not the re-pull's is kept, and said", async () => {
    await w.commitOnto("refs/heads/release/v2.0.0", "README.md", "Someone else's change.\n");
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(0);
    expect(w.row().status).toBe("abandoned");
    expect(run.all).toContain("The release branch was kept");
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });

  test("a pull request GitHub merged while the record is pr_open is never abandoned", async () => {
    const pr = w.gh.pulls[prKey(w)];
    if (!pr) throw new Error("no pull request");
    // Merged on GitHub's page: the record does not know yet.
    Object.assign(pr, { merged: true, state: "closed", mergeCommitSha: "e".repeat(40) });
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("pull-request-merged");
    expect(w.row().status).toBe("pr_open");
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
    expect(w.gh.seen.filter((s) => s.method === "PATCH")).toEqual([]);
  });

  test("the recorded pull request is read by its number when the list by head misses it", async () => {
    const pr = w.gh.pulls[prKey(w)];
    if (!pr) throw new Error("no pull request");
    // Merged, and listed under another head: the list by release/v2.0.0 does not name it.
    Object.assign(pr, {
      merged: true,
      state: "closed",
      mergeCommitSha: "e".repeat(40),
      headRef: "renamed-on-github",
    });
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("pull-request-merged");
    expect(w.row().status).toBe("pr_open");
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });

  test("a merge found after the close is not ended: the record stays open for resume", async () => {
    const n = w.row().pr_number as number;
    w.gh.beforeClose = async (_dataset, number) => {
      const p = w.gh.pulls[`${w.fx.datasetId}#${number}`];
      if (p && number === n) Object.assign(p, { merged: true, mergeCommitSha: "e".repeat(40) });
    };
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("pull-request-merged");
    expect(w.row().status).toBe("pr_open");
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });

  test("a branch that moved after it was judged the re-pull's is not deleted: the delete is leased", async () => {
    let moved = "";
    w.gh.beforeClose = async () => {
      moved = await w.commitOnto("refs/heads/release/v2.0.0", ".nemar/x.json", "{}\n");
    };
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("branch-moved");
    expect((await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.0"])).trim()).toBe(
      moved,
    );
    expect(w.row().status).toBe("pr_open");
  });

  test("a page of 100 or more pull requests is not read as whole: nothing is closed", async () => {
    const base = (w.row().pr_number as number) + 100;
    for (let i = 0; i < 100; i++) {
      w.gh.pulls[`${w.fx.datasetId}#${base + i}`] = {
        sha: w.row().base_sha,
        headRef: "release/v2.0.0",
        state: "closed",
      };
    }
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("github-unreadable");
    expect(run.all).toContain("100 or more");
    expect(w.gh.seen.filter((s) => s.method === "PATCH")).toEqual([]);
    expect(w.row().status).toBe("pr_open");
  });

  test("between the merge and the release it is refused: wait-for-release", async () => {
    const head = w.row().head_sha as string;
    expect((await resume()).exitCode).toBe(3);
    await w.reportScreen(head, "clean");
    expect((await resume()).exitCode).toBe(0);
    expect((await w.cli(["repull", "merge", w.fx.datasetId, "--yes"])).exitCode).toBe(0);
    expect(w.row().status).toBe("merged");
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("wait-for-release");
    expect(w.row().status).toBe("merged");
  });

  test("a held claim to merge is refused: merge-claim-held", async () => {
    const head = w.row().head_sha as string;
    expect((await resume()).exitCode).toBe(3);
    await w.reportScreen(head, "clean");
    expect((await resume()).exitCode).toBe(0);
    w.db().run(
      "UPDATE upstream_repulls SET merge_claim_sha = ?, merge_claimed_at = datetime('now')",
      [head],
    );
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-claim-held");
    expect(w.row().status).toBe("gates_clear");
    expect(w.gh.seen.filter((s) => s.method === "PATCH")).toEqual([]);
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });
});
