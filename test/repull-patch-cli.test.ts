/**
 * N.0.1: NEMAR's corrections replayed onto the released N.0.0 (ADR 0111, decisions 1 and 3; epic
 * #1046 phase 6, #1912), driven through the real entry point against `repull-pr-world.ts` with its
 * default fixture: NEMAR edited a sidecar and added a description key (two corrections) and edited
 * `participants.tsv`, which upstream changed too (a conflict). N.0.0 is merged by the real gate;
 * the test plays the dataset workflow (the tag) and the DOI's callback (the version row); every
 * step of the re-pull itself is the real CLI and the real Worker routes over bun:sqlite, reached
 * through TEST_API_URL in the child's environment. GitHub and S3 are stand-ins. No mocks.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - after the release and the lock, a plan with conflicts waits for an administrator's decision,
 *    and nothing is pushed;
 *  - with `--keep-upstream`, N.0.1 replays the sidecar byte for byte and the description key, says
 *    2.0.1, leaves the conflict on upstream's side, scrubs and copies nothing, and opens a second
 *    pull request; it then goes through the same screen, gates, merge (claiming the cap as N.0.1)
 *    and release as N.0.0, to `complete`, and `pr-reviews approve --merge` merges it through that
 *    same gate;
 *  - with `--take-ours participants.tsv`, the conflict is replayed as NEMAR had it;
 *  - a `--take-ours` that names no conflict refuses before anything is written;
 *  - abandon after the release declines N.0.1 (`patch_declined`), closing its pull request and
 *    deleting its branch when they exist.
 *
 * What only the canary and the first production runs can check: that GitHub opens and squash-merges
 * a second release pull request on the same repository as the stand-in does, and that the dataset
 * workflows tag v2.0.1 and mint its DOI as they do any other patch release.
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
import { PATHS, gitIn } from "./helpers/repull-fixture";
import { type RepullWorld, startRepullWorld } from "./helpers/repull-pr-world";
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

const resume = (extra: string[] = []) =>
  w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes", ...extra]);
const show = (rev: string, path: string) => gitIn(w.fx.originRepo, ["show", `${rev}:${path}`]);
const oid = async (rev: string, path: string) =>
  (await gitIn(w.fx.originRepo, ["rev-parse", `${rev}:${path}`])).trim();
const hasRef = async (ref: string) =>
  (await gitIn(w.fx.originRepo, ["for-each-ref", "--format=%(refname)", ref])).trim() !== "";
const S3_WRITES = ["PutObject", "CopyObject", "UploadPartCopy", "CreateMultipartUpload"] as const;
const s3Writes = () => S3_WRITES.flatMap((op) => w.s3.calls(op));

/** N.0.0 merged by the real gate, tagged v2.0.0 and its version row written: the record merged. */
async function releasedN0(): Promise<void> {
  const head = w.row().head_sha as string;
  expect((await resume()).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  expect((await resume()).exitCode).toBe(0);
  const merged = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
  expect(merged.exitCode, merged.all).toBe(0);
  await w.tagMain("2.0.0");
  w.insertVersionRow("2.0.0");
}

describe.skipIf(!awsInstalled)("N.0.1", () => {
  test("after the release, conflicts wait for a decision and nothing is pushed", async () => {
    expect(JSON.parse(w.row().counts)).toMatchObject({ corrections: 2, conflicts: 1 });
    await releasedN0();
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("--take-ours");
    expect(run.all).toContain("--keep-upstream");
    const row = w.row();
    expect(row.status).toBe("released");
    expect(JSON.parse(row.counts).locked).toBeGreaterThan(0);
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(false);
    expect(Object.values(w.gh.pulls).filter((p) => p.headRef === "release/v2.0.1")).toEqual([]);
  });

  test("--keep-upstream replays the corrections byte for byte, and N.0.1 goes to complete through the same gates", async () => {
    await releasedN0();
    const base = w.row().base_sha;
    const mergeN0 = w.row().merge_sha as string;
    const writesBefore = s3Writes().length;
    const made = await resume(["--keep-upstream"]);
    // It stops waiting for N.0.1's identifier screen.
    expect(made.exitCode, made.all).toBe(3);
    const row = w.row();
    expect(row).toMatchObject({
      status: "patch_synthesized",
      patch_version: "2.0.1",
      patch_branch: "release/v2.0.1",
    });
    expect(JSON.parse(row.counts)).toMatchObject({ resolutions: 0 });
    const patch = (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.1"])).trim();
    expect(row.patch_head_sha).toBe(patch);
    // One commit on the merged N.0.0 (main at the merge), by the re-pull's identity.
    expect((await gitIn(w.fx.originRepo, ["rev-parse", `${patch}^@`])).trim()).toBe(
      row.patch_base_sha as string,
    );
    expect(row.patch_base_sha).toBe(mergeN0);
    // The sidecar NEMAR edited is NEMAR's blob again, byte for byte.
    expect(await oid(patch, PATHS.sidecar)).toBe(await oid(base, PATHS.sidecar));
    expect(await oid(mergeN0, PATHS.sidecar)).not.toBe(await oid(base, PATHS.sidecar));
    // The description: NEMAR's key back, N.0.1's version, upstream's GeneratedBy kept.
    const desc = JSON.parse(await show(patch, PATHS.description));
    expect(desc).toMatchObject({
      Version: "2.0.1",
      HowToAcknowledge: "Cite the NEMAR mirror.",
      GeneratedBy: [{ Name: "fixture-pipeline" }],
    });
    // The conflict stays on upstream's side, as N.0.0 holds it.
    expect(await oid(patch, PATHS.participants)).toBe(await oid(mergeN0, PATHS.participants));
    // Only those two paths differ from N.0.0.
    const changed = (await gitIn(w.fx.originRepo, ["diff", "--name-only", mergeN0, patch]))
      .trim()
      .split("\n")
      .sort();
    expect(changed).toEqual([PATHS.description, PATHS.sidecar].sort());
    // Its message ends with the trailers, N.0.1's own beside them.
    const trailers = (
      await gitIn(w.fx.originRepo, ["log", "-1", "--format=%(trailers:only,unfold)", patch])
    ).trim();
    expect(trailers).toContain(`Repull-Plan: ${row.plan_digest}`);
    expect(trailers).toContain("Repull-Patch: corrections=2");
    // Nothing scrubbed and nothing copied: no S3 write since N.0.0's lock.
    expect(s3Writes().length).toBe(writesBefore);
    // A second pull request, into main.
    const prs = Object.entries(w.gh.pulls).filter(([, p]) => p.headRef === "release/v2.0.1");
    expect(prs).toHaveLength(1);
    expect(prs[0]?.[1].base).toBe("main");
    expect(row.patch_pr_number).toBe(Number(prs[0]?.[0].split("#")[1]));

    // The same screen and gates as N.0.0's, on N.0.1's head.
    await w.reportScreen(patch, "clean");
    const ready = await resume();
    expect(ready.exitCode, ready.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "patch_gates_clear", patch_gates_sha: patch });

    // The merge claims the cap as N.0.1's and squash-merges with the trailers last.
    const merged = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
    expect(merged.exitCode, merged.all).toBe(0);
    const after = w.row();
    expect(after.status).toBe("patch_merged");
    expect(after.patch_merge_claimed_at).not.toBeNull();
    expect(after.merge_claimed_at).not.toBeNull();
    const squash = (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
    expect(after.patch_merge_sha).toBe(squash);
    expect(
      (await gitIn(w.fx.originRepo, ["log", "-1", "--format=%(trailers:only,unfold)", squash]))
        .trim()
        .split("\n"),
    ).toContain("Repull-Patch: corrections=2");

    // The release of v2.0.1, then complete; N.0.1 locks nothing of its own.
    const locksBefore = w.s3.calls("PutObjectRetention").length;
    await w.tagMain("2.0.1");
    w.insertVersionRow("2.0.1");
    const done = await resume();
    expect(done.exitCode, done.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "complete", last_error: null });
    expect(w.row().patch_tag_sha).not.toBeNull();
    expect(w.s3.calls("PutObjectRetention").length).toBe(locksBefore);
  });

  test("--take-ours replays the conflict as NEMAR had it", async () => {
    await releasedN0();
    const base = w.row().base_sha;
    const run = await resume(["--take-ours", PATHS.participants]);
    expect(run.exitCode, run.all).toBe(3);
    const row = w.row();
    expect(row.status).toBe("patch_synthesized");
    expect(JSON.parse(row.counts)).toMatchObject({ resolutions: 1 });
    const patch = row.patch_head_sha as string;
    expect(await oid(patch, PATHS.participants)).toBe(await oid(base, PATHS.participants));
  });

  test("a --take-ours that names no conflict refuses before anything is written", async () => {
    await releasedN0();
    const writes = () => w.apiWrites.filter((x) => x.endsWith("/transition")).length;
    // The lock is recorded by a first run; the refusal comes on the second.
    expect((await resume()).exitCode).toBe(3);
    const before = writes();
    for (const name of [PATHS.sidecar, "no/such/path.json", "dataset_description.json#Name"]) {
      const run = await resume(["--take-ours", name]);
      expect(run.exitCode, run.all).toBe(1);
      expect(run.all).toContain("take-ours-invalid");
    }
    expect(writes()).toBe(before);
    expect(w.row().status).toBe("released");
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(false);
  });

  test("pr-reviews approve --merge squash-merges N.0.1's pull request through the same gate, as N.0.1", async () => {
    await releasedN0();
    expect((await resume(["--keep-upstream"])).exitCode).toBe(3);
    const patch = w.row().patch_head_sha as string;
    await w.reportScreen(patch, "clean");
    expect((await resume()).exitCode).toBe(0);
    const pr = w.row().patch_pr_number as number;
    const run = await w.cli([
      "pr-reviews",
      "approve",
      w.fx.datasetId,
      String(pr),
      "--merge",
      "--yes",
    ]);
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("through the re-pull's gate");
    const sent = w.gh.seen.filter(
      (x) => x.method === "PUT" && x.path.endsWith(`/pulls/${pr}/merge`),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      sha: patch,
      merge_method: "squash",
      commit_title: `Release v2.0.1 (#${pr})`,
    });
    expect(String(sent[0]?.body?.commit_message)).toMatch(
      /\n\nUpstream-Snapshot: ds099999@1\.1\.0\nRepull-Plan: sha256:[0-9a-f]{64}\nRepull-Patch: corrections=2$/,
    );
    expect(w.row()).toMatchObject({ status: "patch_merged", patch_merge_claim_sha: patch });
  });

  test("abandon after the release declines N.0.1; with its pull request open, it is closed and its branch deleted", async () => {
    await releasedN0();
    expect((await resume()).exitCode).toBe(3);
    const declined = await w.cli(["repull", "abandon", w.fx.datasetId, "--yes"]);
    expect(declined.exitCode, declined.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "patch_declined", tag_sha: expect.any(String) });

    await w.restore();
    await releasedN0();
    expect((await resume(["--keep-upstream"])).exitCode).toBe(3);
    const pr = w.row().patch_pr_number as number;
    const run = await w.cli(["repull", "abandon", w.fx.datasetId, "--yes"]);
    expect(run.exitCode, run.all).toBe(0);
    expect(w.row().status).toBe("patch_declined");
    expect(w.gh.pulls[`${w.fx.datasetId}#${pr}`]?.state).toBe("closed");
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(false);
    // N.0.0 stays released: its tag is where it was.
    expect(await hasRef("refs/tags/v2.0.0")).toBe(true);
  });
});
