/**
 * The release of a merged re-pull, as `nemar admin repull resume <id>` takes it on (ADR 0111,
 * decisions 2, 4 and 8; epic #1046 phase 6, #1912), driven through the real entry point against
 * `repull-pr-world.ts` with a plan that has no corrections, so the record can reach `complete`.
 *
 * After the real merge gate merges the pull request, the test plays the dataset workflow
 * (`run-pr-merge` tags `v2.0.0` at `main`) and the version DOI's callback (the version row with its
 * DOI and its upstream tag, as `/webhooks/manifest-ready` writes it); everything the re-pull does
 * itself is real: the Worker's verified release route reads the tag and the comparison on the
 * GitHub stand-in, and the lock is the real s3-lock route, signing its requests to the S3
 * stand-in through the test endpoint override. The API is reached through TEST_API_URL in the
 * child's environment. No mocks.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - resume waits for the tag, then for the version row, records the release with `lineage` for
 *    2.0.0 (the tagged tree is the synthesized one outside NEMAR's paths), re-arms the dataset's
 *    four sweep stamps, locks every object under the dataset's prefix, records the count, and
 *    completes;
 *  - a tag on another commit leaves the record `merged`, with why recorded;
 *  - a tagged tree that is not the synthesized one is released without lineage;
 *  - a lock that does not complete leaves the record `released` without its count, and the next
 *    run locks again and completes;
 *  - a record with corrections stays `released` (N.0.1 is not built).
 *
 * What only the canary and the first production release can check: that the dataset workflows tag
 * the squash merge of a re-pull as they tag other merges, that GitHub's tag read and comparison
 * answer as the stand-in does, and that the real bucket answers PutObjectRetention on a copied
 * object as the stand-in does (in particular the s3-lock route's reading of a 403 as "already
 * locked").
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
import { TAG_B, gitIn } from "./helpers/repull-fixture";
import { type RepullWorld, type WorldPoint, startRepullWorld } from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

let w: RepullWorld;
/** The record merged by the real gate, reached once (`driveMerged`): where most cases start. */
let mergedPoint: WorldPoint;

beforeAll(async () => {
  if (!awsInstalled) return;
  w = await startRepullWorld({ fixture: { noContributorEdits: true } });
  await driveMerged();
  mergedPoint = await w.save();
});
afterAll(() => w?.stop());
beforeEach(async () => {
  if (awsInstalled) await w.restore();
});

const resume = () => w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes"]);

const STAMPS = {
  hed_checked_at: "2026-10-01 00:00:00",
  channel_montage_checked_at: "2026-10-01 00:00:00",
  data_checked_at: "2026-10-01 00:00:00",
  availability_report_at: "2026-10-01 00:00:00",
  zarr_requeue_at: "2026-10-01 00:00:00",
};

/** The record merged by the real gate, its sweep stamps set as the sweeps left them. */
async function driveMerged(): Promise<void> {
  const head = w.row().head_sha as string;
  expect((await resume()).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  expect((await resume()).exitCode).toBe(0);
  const run = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
  expect(run.exitCode, run.all).toBe(0);
  expect(w.row().status).toBe("merged");
  w.db().run("UPDATE datasets SET sweep_stamps = ?", [JSON.stringify(STAMPS)]);
}

/** The same, from the point `driveMerged` reached once. */
const merged = () => w.restore(mergedPoint);

const objectsOf = () => w.s3.keys("nemar", `${w.fx.datasetId}/objects/`);

/** The keys the copy and the uploads wrote, from the staging manifest the copy left in the bucket. */
function writtenKeys(): string[] {
  const staging = w.s3.current("nemar", `${w.fx.datasetId}/staging/repull-${TAG_B}.json`);
  if (!staging) throw new Error("the copy left no staging manifest");
  const m = JSON.parse(Buffer.from(staging.data).toString("utf8")) as {
    items: Array<{ key: string }>;
    local: Array<{ key: string }>;
  };
  return [...m.items, ...m.local].map((i) => `${w.fx.datasetId}/objects/${i.key}`);
}

const lockOf = (key: string) => w.s3.current("nemar", key)?.lock?.mode;

/** Tag v2.0.0 at main and write its version row, as the dataset workflow and the DOI leave them. */
async function tagged(): Promise<void> {
  await w.tagMain("2.0.0");
  w.insertVersionRow("2.0.0");
}

describe.skipIf(!awsInstalled)("the release", () => {
  test("waits for the tag and the version row, records the release with lineage, locks and completes", async () => {
    expect(JSON.parse(w.row().counts)).toMatchObject({ corrections: 0 });
    await merged();
    const noTag = await resume();
    expect(noTag.exitCode, noTag.all).toBe(3);
    expect(noTag.all).toContain("the tag v2.0.0");

    const tagged = await w.tagMain("2.0.0");
    const noRow = await resume();
    expect(noRow.exitCode, noRow.all).toBe(3);
    expect(noRow.all).toContain("the version row of v2.0.0");
    expect(w.row().status).toBe("merged");

    w.insertVersionRow("2.0.0");
    const done = await resume();
    expect(done.exitCode, done.all).toBe(0);
    expect(done.all).toContain("is complete");
    const row = w.row();
    expect(row).toMatchObject({ status: "complete", tag_sha: tagged, last_error: null });
    // Lineage: the tagged tree is the synthesized one outside NEMAR's paths.
    expect(
      w
        .db()
        .query(
          "SELECT source_version, source_version_basis FROM dataset_versions WHERE version = '2.0.0'",
        )
        .get(),
    ).toEqual({ source_version: TAG_B, source_version_basis: "lineage" });
    // The four sweep stamps are re-armed; the others stay.
    const stamps = JSON.parse(
      (w.db().query("SELECT sweep_stamps FROM datasets").get() as { sweep_stamps: string })
        .sweep_stamps,
    );
    expect(stamps).toEqual({ zarr_requeue_at: STAMPS.zarr_requeue_at });
    // The objects the copy and the uploads wrote are under the governance lock, through the real
    // route, and no other object under the dataset's prefix is (the earlier versions' objects are
    // their publication's to lock).
    expect(w.apiWrites).toContain(`POST /admin/datasets/${w.fx.datasetId}/s3-lock`);
    const written = writtenKeys();
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) expect([key, lockOf(key)]).toEqual([key, "GOVERNANCE"]);
    const others = objectsOf().filter((k) => !written.includes(k));
    expect(others.length).toBeGreaterThan(0);
    for (const key of others) expect([key, lockOf(key)]).toEqual([key, undefined]);
    expect(JSON.parse(row.counts).locked).toBe(written.length);
  });

  test("a tag on another commit leaves the record merged, with why recorded", async () => {
    await merged();
    const base = w.row().base_sha;
    await gitIn(w.fx.originRepo, ["tag", "v2.0.0", base]);
    w.insertVersionRow("2.0.0");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(w.row()).toMatchObject({ status: "merged", tag_sha: null });
    expect(w.row().last_error).toStartWith("[release:tag-mismatch]");
    expect(w.s3.calls("PutObjectRetention")).toEqual([]);
  });

  test("a tagged tree that is not the synthesized one is released without lineage", async () => {
    await merged();
    await w.commitOnto("refs/heads/main", "README.md", "Changed after the merge.\n");
    await w.tagMain("2.0.0");
    w.insertVersionRow("2.0.0");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("lineage is not recorded");
    expect(w.row().status).toBe("complete");
    expect(
      w
        .db()
        .query("SELECT source_version_basis FROM dataset_versions WHERE version = '2.0.0'")
        .get(),
    ).toEqual({ source_version_basis: "doi" });
  });

  test("a lock that does not complete leaves the record released, and the next run locks again", async () => {
    await merged();
    await tagged();
    w.s3.inject("PutObjectRetention", { code: "InternalError", status: 500, times: 1 });
    const first = await resume();
    expect(first.exitCode, first.all).toBe(3);
    expect(first.all).toContain("lock-incomplete");
    const held = w.row();
    expect(held.status).toBe("released");
    expect(JSON.parse(held.counts)).not.toHaveProperty("locked");
    expect(held.last_error).toStartWith("[lock:lock-incomplete]");
    // No key in the record: counts only.
    for (const key of objectsOf()) expect(held.last_error).not.toContain(key.split("/").pop());

    const second = await resume();
    expect(second.exitCode, second.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "complete", last_error: null });
    for (const key of writtenKeys()) expect(lockOf(key)).toBe("GOVERNANCE");
  });

  test("a 403 on every lock is not a lock: the record stays released with lock-incomplete", async () => {
    await merged();
    await tagged();
    // What a credential without s3:PutObjectRetention answers, for every object.
    w.s3.inject("PutObjectRetention", { code: "AccessDenied", status: 403 });
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("lock-incomplete");
    const held = w.row();
    expect(held.status).toBe("released");
    expect(JSON.parse(held.counts)).not.toHaveProperty("locked");
    expect(held.last_error).toStartWith("[lock:lock-incomplete]");
    for (const key of writtenKeys()) expect(lockOf(key)).toBeUndefined();
    // Every 403 was read back, and none was taken on its word.
    expect(w.s3.calls("GetObjectRetention").length).toBe(writtenKeys().length);
  });

  test("a 403 whose read-back confirms the lock counts as locked, and the record completes", async () => {
    await merged();
    await tagged();
    const until = new Date();
    until.setFullYear(until.getFullYear() + 100);
    for (const key of writtenKeys()) {
      const v = w.s3.current("nemar", key);
      if (v) w.s3.setLock("nemar", key, v.versionId, "GOVERNANCE", until);
    }
    w.s3.inject("PutObjectRetention", { code: "AccessDenied", status: 403 });
    const run = await resume();
    expect(run.exitCode, run.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "complete", last_error: null });
    expect(JSON.parse(w.row().counts).locked).toBe(writtenKeys().length);
  });

  test("a 403 whose read-back is a short retention is not a lock this route sets", async () => {
    await merged();
    await tagged();
    // A retention a test or a mistake set: a lock, but not the 100 years this route asks for.
    const until = new Date();
    until.setFullYear(until.getFullYear() + 1);
    for (const key of writtenKeys()) {
      const v = w.s3.current("nemar", key);
      if (v) w.s3.setLock("nemar", key, v.versionId, "GOVERNANCE", until);
    }
    w.s3.inject("PutObjectRetention", { code: "AccessDenied", status: 403 });
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("lock-incomplete");
    expect(w.row().status).toBe("released");
    expect(JSON.parse(w.row().counts)).not.toHaveProperty("locked");
  });

  test("a staging manifest that is not the recorded one locks nothing: manifest-mismatch", async () => {
    await merged();
    await tagged();
    // The manifest in the bucket names one more object than the copy recorded at prepared wrote.
    const key = `${w.fx.datasetId}/staging/repull-${TAG_B}.json`;
    const staging = w.s3.current("nemar", key);
    if (!staging) throw new Error("the copy left no staging manifest");
    const m = JSON.parse(Buffer.from(staging.data).toString("utf8"));
    const other = objectsOf().find((k) => !writtenKeys().includes(k));
    if (!other) throw new Error("the fixture has no earlier version's object");
    m.items.push({ ...m.items[0], key: other.split("/objects/")[1] });
    w.s3.putObject("nemar", key, Buffer.from(JSON.stringify(m)));
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("manifest-mismatch");
    expect(w.row().status).toBe("released");
    expect(w.row().last_error).toStartWith("[lock:manifest-mismatch]");
    expect(w.s3.calls("PutObjectRetention")).toEqual([]);
    expect(lockOf(other)).toBeUndefined();
  });

  test("a merge commit whose trailers are not its last paragraph is refused at release: it stays merged", async () => {
    // A host that appends a paragraph of its own to the squash commit's message.
    w.setMergeMessageSuffix("\n\nCo-authored-by: enrichment-bot <bot@nemar.org>");
    await driveMerged();
    await tagged();
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("merge-trailers");
    expect(w.row()).toMatchObject({ status: "merged", tag_sha: null });
    expect(w.row().last_error).toStartWith("[release:merge-trailers]");
    expect(w.s3.calls("PutObjectRetention")).toEqual([]);
  });

  test("a record whose corrections count is not its plan's makes no N.0.1", async () => {
    await merged();
    // The plan has no correction; a record that says otherwise is not the same plan.
    w.db().run("UPDATE upstream_repulls SET counts = json_set(counts, '$.corrections', 2)");
    await w.tagMain("2.0.0");
    w.insertVersionRow("2.0.0");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("patch-plan-mismatch");
    expect(w.row().status).toBe("released");
    expect(JSON.parse(w.row().counts).locked).toBeGreaterThan(0);
    expect(w.row().last_error).toStartWith("[patch:patch-plan-mismatch]");
    expect(Object.values(w.gh.pulls).filter((p) => p.headRef === "release/v2.0.1")).toEqual([]);
  });

  test("a plan with no correction and no conflict opens no second pull request", async () => {
    await merged();
    await tagged();
    const run = await resume();
    expect(run.exitCode, run.all).toBe(0);
    expect(w.row().status).toBe("complete");
    expect(Object.values(w.gh.pulls).filter((p) => p.headRef === "release/v2.0.1")).toEqual([]);
    expect(
      (await gitIn(w.fx.originRepo, ["for-each-ref", "refs/heads/release/v2.0.1"])).trim(),
    ).toBe("");
  });
});
