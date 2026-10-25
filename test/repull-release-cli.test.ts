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
 * stand-in through the test endpoint override. No mocks.
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
import { type RepullWorld, startRepullWorld } from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

let w: RepullWorld;

beforeAll(async () => {
  if (awsInstalled) w = await startRepullWorld({ fixture: { noContributorEdits: true } });
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
async function merged(): Promise<void> {
  const head = w.row().head_sha as string;
  expect((await resume()).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  expect((await resume()).exitCode).toBe(0);
  const run = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
  expect(run.exitCode, run.all).toBe(0);
  expect(w.row().status).toBe("merged");
  w.db().run("UPDATE datasets SET sweep_stamps = ?", [JSON.stringify(STAMPS)]);
}

const objectsOf = () => w.s3.keys("nemar", `${w.fx.datasetId}/objects/`);

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
    // Every object under the dataset's prefix is under the governance lock, through the real route.
    expect(w.apiWrites).toContain(`POST /admin/datasets/${w.fx.datasetId}/s3-lock`);
    const keys = objectsOf();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect([key, w.s3.current("nemar", key)?.lock?.mode]).toEqual([key, "GOVERNANCE"]);
    }
    expect(JSON.parse(row.counts).locked).toBe(keys.length);
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
    await w.tagMain("2.0.0");
    w.insertVersionRow("2.0.0");
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
    for (const key of objectsOf())
      expect(w.s3.current("nemar", key)?.lock?.mode).toBe("GOVERNANCE");
  });

  test("a record with corrections stays released: N.0.1 is not built", async () => {
    await merged();
    w.db().run("UPDATE upstream_repulls SET counts = json_set(counts, '$.corrections', 2)");
    await w.tagMain("2.0.0");
    w.insertVersionRow("2.0.0");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("not built yet");
    expect(w.row().status).toBe("released");
    expect(JSON.parse(w.row().counts).locked).toBeGreaterThan(0);
  });
});
