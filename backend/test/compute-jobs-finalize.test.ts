/**
 * `POST /compute/jobs/:id/finalize` and the release of abandoned uploads (epic #2021 phase D3, #2024;
 * ADR 0118, the amendment of this phase), through the REAL compute router over real migrated SQLite,
 * Miniflare's R2 through the Worker's own bindings and the real local S3 interface (whose request log
 * counts the copies). The Tapis stand-in was built from Tapis's published specifications; no response of
 * it was recorded from a real tenant.
 *
 * What is pinned: a finalize with a missing or a short archive is 409 `bundle_incomplete` and copies
 * nothing; a good one copies the archive ONCE, only after the job and its hold exist, writes the manifest
 * beside it and submits; a second is the job unchanged and copies nothing; the manifest is judged before
 * anything is read; an upload nobody finishes is failed `upload_expired` after the hour and its hold is
 * released, in pages, in production only, and neither the 30-minute backstop nor the reservation wait
 * ever turns an unfinished upload into a platform failure.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ComputeFinalizeResponseSchema } from "../../shared/contract/compute-submit";
import { runComputeAdvanceCron } from "../src/services/compute-advance";
import { getJob } from "../src/services/compute-jobs";
import { advanceComputeJob, endUploadExpired, submitComputeJob } from "../src/services/compute-lifecycle";
import {
  ABANDONED_UPLOADS_SQL,
  UPLOAD_EXPIRY_ROWS_PER_TICK,
  runUploadExpiryCron,
} from "../src/services/compute-uploads";
import { roundTripD1, setPolicy, trace } from "./helpers/compute-seed";
import {
  type Bundle,
  type Person,
  type World,
  bundleRequest,
  call,
  cookieFor,
  jobRow,
  makeBundle,
  newPerson,
  putArchive,
  resetWorld,
  startWorld,
} from "./helpers/compute-submit-world";

let w: World;

beforeAll(async () => {
  w = await startWorld();
}, 120_000);

beforeEach(async () => {
  await resetWorld(w);
  w.fx.harness.standin.log.length = 0;
});

afterAll(async () => {
  await w?.fx.dispose();
}, 30_000);

interface Started {
  p: Person;
  bundle: Bundle;
  id: string;
  upload: { url: string; headers: Record<string, string>; size: number };
}

async function start(over: Record<string, unknown> = {}, who?: Person): Promise<Started> {
  const p = who ?? (await newPerson(w));
  const bundle = makeBundle([{ path: "run.py", content: `print(${Math.random()})` }]);
  const r = await call(w, "POST", "/compute/jobs", {
    key: p.key,
    json: bundleRequest(bundle, over),
  });
  expect(r.status).toBe(201);
  return { p, bundle, id: r.body.job_id, upload: r.body.upload };
}

const finalize = (s: Started, json?: unknown, key: string | null = s.p.key, env = w.env()) =>
  call(w, "POST", `/compute/jobs/${s.id}/finalize`, { key, json, env });

const copies = () => w.fx.harness.standin.log.filter((e) => e.op === "CopyObject");
const incomingKey = (id: string) => `incoming/${id}/bundle.tar.gz`;
const submittedKey = (id: string) => `records/${id}/submitted/bundle.tar.gz`;

describe("a finalize that is not ready", () => {
  test("a missing archive is 409 bundle_incomplete, and nothing is copied or recorded", async () => {
    const s = await start();
    const r = await finalize(s, s.bundle.manifest);
    expect([r.status, r.body.code]).toEqual([409, "bundle_incomplete"]);
    expect(copies()).toEqual([]);
    expect(await w.fx.harness.records.head(submittedKey(s.id))).toBeNull();
    expect(await w.fx.harness.records.head(`records/${s.id}/bundle-manifest.json`)).toBeNull();
    expect(jobRow(w, s.id)).toMatchObject({ state: "uploading", records_written_at: null });
    expect(w.fx.tapis.jobs.size).toBe(0);
  });

  test("a short archive is 409 bundle_incomplete, nothing is copied, and what was uploaded is left alone", async () => {
    const s = await start();
    await w.fx.harness.records.put(incomingKey(s.id), s.bundle.archive.slice(0, s.bundle.size - 1));
    const r = await finalize(s, s.bundle.manifest);
    expect([r.status, r.body.code]).toEqual([409, "bundle_incomplete"]);
    expect(copies()).toEqual([]);
    expect((await w.fx.harness.records.head(incomingKey(s.id)))?.size).toBe(s.bundle.size - 1);
    expect(await w.fx.harness.records.head(submittedKey(s.id))).toBeNull();
    // The person finishes the upload and asks again: now it goes.
    expect((await putArchive(s.upload, s.bundle.archive)).status).toBeLessThan(300);
    expect((await finalize(s, s.bundle.manifest)).status).toBe(200);
  });

  test("a long archive is just as incomplete: the size must be exactly the declared one", async () => {
    const s = await start();
    await w.fx.harness.records.put(incomingKey(s.id), new Uint8Array(s.bundle.size + 1));
    expect((await finalize(s, s.bundle.manifest)).body.code).toBe("bundle_incomplete");
    expect(copies()).toEqual([]);
  });

  test("the manifest is judged before the object is read: entry, path, caps and shape, each a refusal that copies nothing", async () => {
    const s = await start();
    await putArchive(s.upload, s.bundle.archive);
    const sha = "a".repeat(64);
    const bad: Array<[string, unknown, string, string | undefined]> = [
      ["no body", undefined, "invalid_spec", "files"],
      ["not a manifest", { nope: 1 }, "invalid_spec", "body"],
      ["an empty list", { files: [] }, "invalid_spec", "files"],
      [
        "an entry that is not in it",
        { files: [{ path: "other.py", size: 1, sha256: sha }] },
        "entry_not_in_bundle",
        undefined,
      ],
      [
        "a disguised traversal",
        { files: [{ path: "%2e%2e/run.py", size: 1, sha256: sha }] },
        "invalid_spec",
        "files.0.path",
      ],
      [
        "a file over the cap",
        { files: [{ path: "run.py", size: 26 * 1024 * 1024, sha256: sha }] },
        "bundle_too_large",
        undefined,
      ],
      [
        "an unknown key in a file",
        { files: [{ path: "run.py", size: 1, sha256: sha, mode: 1 }] },
        "invalid_spec",
        "files.0",
      ],
    ];
    for (const [name, json, code, field] of bad) {
      const r = await finalize(s, json);
      expect([name, r.body.code]).toEqual([name, code]);
      if (field !== undefined) expect([name, r.body.field]).toEqual([name, field]);
    }
    expect(copies()).toEqual([]);
    expect(await w.fx.harness.records.head(submittedKey(s.id))).toBeNull();
  });
});

describe("a finalize that goes", () => {
  test("copies the archive once, writes the manifest beside it, marks the records and submits", async () => {
    const s = await start();
    // Before the finalize there is no copy in the records: only the job's own two records.
    expect(await w.fx.harness.keys(w.fx.harness.records)).toEqual([
      `records/${s.id}/identity.json`,
      `records/${s.id}/spec.json`,
    ]);
    expect((await putArchive(s.upload, s.bundle.archive)).status).toBeLessThan(300);
    const r = await finalize(s, s.bundle.manifest);
    expect(r.status).toBe(200);
    expect(ComputeFinalizeResponseSchema.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({
      job_id: s.id,
      state: "submitted",
      name: "a script job",
      submitted: true,
      replayed: false,
    });
    expect(copies()).toHaveLength(1);
    expect(copies()[0]).toMatchObject({
      key: submittedKey(s.id),
      copySource: `/nemar-compute-records/${incomingKey(s.id)}`,
    });
    const copied = new Uint8Array(
      await (await w.fx.harness.records.get(submittedKey(s.id)))!.arrayBuffer(),
    );
    expect(copied).toEqual(s.bundle.archive);
    const manifest = JSON.parse(
      await (await w.fx.harness.records.get(`records/${s.id}/bundle-manifest.json`))!.text(),
    );
    expect(manifest).toEqual({
      job_id: s.id,
      archive: { sha256: s.bundle.sha256, size: s.bundle.size },
      files: s.bundle.manifest.files,
    });
    expect(jobRow(w, s.id).records_written_at).not.toBeNull();
    expect(w.fx.tapis.jobs.size).toBe(1);
  });

  test("twice: the second is the job unchanged, copies nothing and submits nothing", async () => {
    const s = await start();
    await putArchive(s.upload, s.bundle.archive);
    await finalize(s, s.bundle.manifest);
    const second = await finalize(s, s.bundle.manifest);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ job_id: s.id, state: "submitted", replayed: true });
    // No body is asked of a job that is past the upload.
    const third = await finalize(s);
    expect([third.status, third.body.replayed]).toEqual([200, true]);
    expect(copies()).toHaveLength(1);
    expect(w.fx.tapis.jobs.size).toBe(1);
  });

  test("with compute off the records are written and the job waits; the backstop submits it once compute is on", async () => {
    const s = await start();
    await putArchive(s.upload, s.bundle.archive);
    const off = w.env({ COMPUTE_ENABLED: undefined });
    const r = await finalize(s, s.bundle.manifest, s.p.key, off);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "uploading", submitted: false });
    expect(jobRow(w, s.id).records_written_at).not.toBeNull();
    expect(w.fx.tapis.jobs.size).toBe(0);
    await advanceComputeJob(w.env(), s.id);
    expect(jobRow(w, s.id).state).toBe("submitted");
  });

  test("the cookie path needs a NEMAR Origin, a key does not", async () => {
    const s = await start();
    await putArchive(s.upload, s.bundle.archive);
    const cookie = await cookieFor(w, s.p);
    for (const origin of ["https://evil.example", "null", undefined]) {
      const r = await call(w, "POST", `/compute/jobs/${s.id}/finalize`, {
        cookie,
        origin,
        json: s.bundle.manifest,
      });
      expect([origin, r.status]).toEqual([origin, 403]);
    }
    expect(copies()).toEqual([]);
    const ok = await call(w, "POST", `/compute/jobs/${s.id}/finalize`, {
      cookie,
      origin: "https://app.nemar.org",
      json: s.bundle.manifest,
    });
    expect(ok.status).toBe(200);
  });
});

describe("the release of abandoned uploads", () => {
  const age = (id: string, modifier: string) =>
    w.fx.harness.db
      .query("UPDATE compute_jobs SET created_at = datetime('now', ?) WHERE id = ?")
      .run(modifier, id);

  test("an upload over an hour old is failed upload_expired with its hold released; a younger one is left", async () => {
    const p = await newPerson(w, { grant: 5000 });
    const stale = await start({}, p);
    const fresh = await start({}, p);
    age(stale.id, "-61 minutes");
    age(fresh.id, "-59 minutes");
    const r = await runUploadExpiryCron(w.env());
    expect(r).toMatchObject({ examined: 1, expired: 1, errors: [] });
    expect(jobRow(w, stale.id)).toMatchObject({
      state: "failed",
      failure_code: "upload_expired",
      platform_failure: 0,
      charged_milli: 0,
    });
    expect(jobRow(w, fresh.id).state).toBe("uploading");
    // The hold of the stale job is released, the fresh one is still held, and nothing was charged.
    const pool = w.fx.harness.db
      .query(
        "SELECT held_milli, charged_milli FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ?",
      )
      .get(String(p.id)) as { held_milli: number; charged_milli: number };
    expect(pool).toEqual({ held_milli: 1000, charged_milli: 0 });
    const releases = w.fx.harness.db
      .query("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ? AND kind = 'release'")
      .get(stale.id) as { n: number };
    expect(releases.n).toBe(1);
  });

  test("it frees the person's live-job slot", async () => {
    await setPolicy(w.env().DB, w.fx.ownerId, { maxLiveJobsPerPerson: 1 });
    const p = await newPerson(w);
    const s = await start({}, p);
    const blocked = await call(w, "POST", "/compute/jobs", {
      key: p.key,
      json: bundleRequest(makeBundle([{ path: "run.py", content: "n" }])),
    });
    expect(blocked.body.code).toBe("over_concurrency");
    age(s.id, "-2 hours");
    await runUploadExpiryCron(w.env());
    const after = await call(w, "POST", "/compute/jobs", {
      key: p.key,
      json: bundleRequest(makeBundle([{ path: "run.py", content: "m" }])),
    });
    expect(after.status).toBe(201);
  });

  test("a finalize after the release is 409 upload_expired and copies nothing", async () => {
    const s = await start();
    await putArchive(s.upload, s.bundle.archive);
    age(s.id, "-2 hours");
    await runUploadExpiryCron(w.env());
    const r = await finalize(s, s.bundle.manifest);
    expect([r.status, r.body.code]).toEqual([409, "upload_expired"]);
    expect(copies()).toEqual([]);
    expect(await w.fx.harness.records.head(submittedKey(s.id))).toBeNull();
  });

  test("it leaves alone a finalized job waiting to be submitted, a job with a cancel recorded, and a job with a Tapis job", async () => {
    const waiting = await start();
    await putArchive(waiting.upload, waiting.bundle.archive);
    await finalize(
      waiting,
      waiting.bundle.manifest,
      waiting.p.key,
      w.env({ COMPUTE_ENABLED: undefined }),
    );
    const cancelled = await start();
    w.fx.harness.db
      .query("UPDATE compute_jobs SET cancel_requested_at = datetime('now') WHERE id = ?")
      .run(cancelled.id);
    const submitted = await start();
    w.fx.harness.db
      .query("UPDATE compute_jobs SET tapis_uuid = 'abc' WHERE id = ?")
      .run(submitted.id);
    for (const s of [waiting, cancelled, submitted]) age(s.id, "-3 hours");
    expect(await runUploadExpiryCron(w.env())).toMatchObject({ examined: 0, expired: 0 });
    expect(jobRow(w, waiting.id).state).toBe("uploading");
    expect(jobRow(w, cancelled.id).state).toBe("uploading");
  });

  test("it takes a page a tick, then the rest on the next", async () => {
    const p = await newPerson(w, { grant: 100_000 });
    await setPolicy(w.env().DB, w.fx.ownerId, { maxLiveJobsPerPerson: 20 });
    const made: Started[] = [];
    for (let i = 0; i < UPLOAD_EXPIRY_ROWS_PER_TICK + 2; i++) made.push(await start({}, p));
    for (const s of made) age(s.id, "-2 hours");
    const first = await runUploadExpiryCron(w.env());
    expect(first).toMatchObject({
      examined: UPLOAD_EXPIRY_ROWS_PER_TICK,
      expired: UPLOAD_EXPIRY_ROWS_PER_TICK,
    });
    const second = await runUploadExpiryCron(w.env());
    expect(second).toMatchObject({ examined: 2, expired: 2 });
    expect(await runUploadExpiryCron(w.env())).toMatchObject({ examined: 0 });
  });

  test("outside exact production it does nothing at all", async () => {
    const s = await start();
    age(s.id, "-3 hours");
    expect(await runUploadExpiryCron(w.env({ ENVIRONMENT: "development" }))).toBeNull();
    expect(jobRow(w, s.id).state).toBe("uploading");
  });

  test("the selection is served by an index: no scan of the jobs table", () => {
    const plan = w.fx.harness.db
      .query(`EXPLAIN QUERY PLAN ${ABANDONED_UPLOADS_SQL.replace("?1", "10")}`)
      .all() as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join("\n");
    expect(text).toContain("USING INDEX compute_jobs_examined");
    expect(text).not.toMatch(/SCAN compute_jobs(?! USING)/);
  });
});

describe("an unfinished upload is never a platform failure", () => {
  test("past the reservation wait, neither the reservation check nor the 30-minute backstop ends it", async () => {
    const s = await start();
    w.fx.harness.db
      .query("UPDATE compute_jobs SET created_at = datetime('now', '-40 minutes') WHERE id = ?")
      .run(s.id);
    const later = Date.now() + 40 * 60_000;
    const direct = await submitComputeJob(w.env(), s.id, later);
    expect(direct).toEqual({ ok: false, outcome: "records_not_written" });
    const tick = await runComputeAdvanceCron(w.env());
    expect(tick).toMatchObject({ examined: 0 });
    expect(jobRow(w, s.id)).toMatchObject({ state: "uploading", failure_code: null });
    // Once it is finalized the wait applies as it does to any job.
    await putArchive(s.upload, s.bundle.archive);
    await finalize(s, s.bundle.manifest, s.p.key, w.env({ COMPUTE_ENABLED: undefined }));
    const t = await trace(w.env().DB);
    expect(t.holds).toBe(1);
  });
});

describe("whose job it is", () => {
  test("another person, an administrator, an absent job and a malformed id are one 404 for finalize", async () => {
    const mine = await start();
    const other = await newPerson(w);
    const none = await call(w, "POST", "/compute/jobs/job_000000000000000000000000/finalize", {
      key: mine.p.key,
      json: mine.bundle.manifest,
    });
    const attempts = [
      await finalize(mine, mine.bundle.manifest, other.key),
      await call(w, "POST", "/compute/jobs/nope/finalize", {
        key: mine.p.key,
        json: mine.bundle.manifest,
      }),
      none,
    ];
    for (const a of attempts) expect([a.status, a.text]).toEqual([404, none.text]);
    expect(none.body.code).toBe("job_not_found");
    expect(copies()).toEqual([]);
  });
});

describe("the upload window is the only clock before a finalize (the reservation wait runs from the finalize)", () => {
  const ageCreated = (id: string, minutes: number) =>
    w.fx.harness.db
      .query("UPDATE compute_jobs SET created_at = datetime('now', ?) WHERE id = ?")
      .run(`-${minutes} minutes`, id);

  test("a finalize at minute 45 after a real upload succeeds and submits; it is not a platform failure", async () => {
    const s = await start();
    await putArchive(s.upload, s.bundle.archive);
    ageCreated(s.id, 45);
    const r = await finalize(s, s.bundle.manifest);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "submitted", submitted: true });
    expect(jobRow(w, s.id)).toMatchObject({ failure_code: null, platform_failure: 0 });
  });

  test("with compute off the wait runs from the finalize: 45 minutes after creation is not overdue, and it is sent once compute is on", async () => {
    const s = await start();
    await putArchive(s.upload, s.bundle.archive);
    ageCreated(s.id, 45);
    const off = w.env({ COMPUTE_ENABLED: undefined });
    const r = await finalize(s, s.bundle.manifest, s.p.key, off);
    expect(r.body).toMatchObject({ state: "uploading", submitted: false });
    // 29 minutes after the finalize it is still inside the reservation wait (30 by default).
    const inside = await submitComputeJob(off, s.id, Date.now() + 29 * 60_000);
    expect(inside.outcome).toBe("compute_disabled");
    expect(jobRow(w, s.id)).toMatchObject({ state: "uploading", failure_code: null });
    await advanceComputeJob(w.env(), s.id);
    expect(jobRow(w, s.id).state).toBe("submitted");
  });

  test("a finalize at minute 61 is 409 upload_expired: the job is ended on the spot, the submitter's code, the hold released, nothing copied", async () => {
    const s = await start();
    await putArchive(s.upload, s.bundle.archive);
    ageCreated(s.id, 61);
    const r = await finalize(s, s.bundle.manifest);
    expect([r.status, r.body.code]).toEqual([409, "upload_expired"]);
    expect(jobRow(w, s.id)).toMatchObject({
      state: "failed",
      failure_code: "upload_expired",
      platform_failure: 0,
    });
    const held = w.fx.harness.db
      .query("SELECT held_milli FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ?")
      .get(String(s.p.id)) as { held_milli: number };
    expect(held.held_milli).toBe(0);
    expect(copies()).toEqual([]);
    expect(w.fx.tapis.jobs.size).toBe(0);
  });

  test("a job is born uploading, so no bundle job can wait as `created` with a hold and no owner for its release", async () => {
    const s = await start();
    expect(jobRow(w, s.id).state).toBe("uploading");
  });
});

describe("the release against a finalize (the statement binds records unwritten)", () => {
  test("a release working from a stale row does not end a job whose finalize has since written its records", async () => {
    const s = await start();
    await putArchive(s.upload, s.bundle.archive);
    w.fx.harness.db
      .query("UPDATE compute_jobs SET created_at = datetime('now', '-3 hours') WHERE id = ?")
      .run(s.id);
    // The release read the row before the finalize (the stale row: records unwritten, old).
    const stale = (await getJob(w.env().DB, s.id))!;
    expect(stale.records_written_at).toBeNull();
    // The finalize runs now, with compute off, so the job stays `uploading` with its records written.
    w.fx.harness.db
      .query("UPDATE compute_jobs SET created_at = datetime('now', '-10 minutes') WHERE id = ?")
      .run(s.id);
    const done = await finalize(s, s.bundle.manifest, s.p.key, w.env({ COMPUTE_ENABLED: undefined }));
    expect(done.body).toMatchObject({ state: "uploading", submitted: false });
    // The release now acts on the stale row: the statement refuses, the job is untouched, the hold stands.
    expect(await endUploadExpired(w.env(), stale)).toBe(false);
    expect(jobRow(w, s.id)).toMatchObject({ state: "uploading", failure_code: null });
    const held = w.fx.harness.db
      .query("SELECT held_milli FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ?")
      .get(String(s.p.id)) as { held_milli: number };
    expect(held.held_milli).toBe(1000);
  });
});

describe("a larger object than declared", () => {
  test("is deleted and never copied; a shorter one is left", async () => {
    const s = await start();
    await w.fx.harness.records.put(incomingKey(s.id), new Uint8Array(s.bundle.size + 5));
    const r = await finalize(s, s.bundle.manifest);
    expect([r.status, r.body.code]).toEqual([409, "bundle_incomplete"]);
    expect(await w.fx.harness.records.head(incomingKey(s.id))).toBeNull();
    expect(copies()).toEqual([]);
    // The person uploads it properly and goes on.
    expect((await putArchive(s.upload, s.bundle.archive)).status).toBeLessThan(300);
    expect((await finalize(s, s.bundle.manifest)).status).toBe(200);
  });
});

describe("two finalizes at once", () => {
  const slowEnv = () => ({ ...w.env(), DB: roundTripD1(w.env().DB) });

  test("the same manifest: one submit, one manifest record, the loser gets a clean 200", async () => {
    const s = await start();
    await putArchive(s.upload, s.bundle.archive);
    const env = slowEnv();
    const [a, b] = await Promise.all([
      finalize(s, s.bundle.manifest, s.p.key, env),
      finalize(s, s.bundle.manifest, s.p.key, env),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(w.fx.tapis.jobs.size).toBe(1);
    const manifest = JSON.parse(
      await (await w.fx.harness.records.get(`records/${s.id}/bundle-manifest.json`))!.text(),
    );
    expect(manifest.files).toEqual(s.bundle.manifest.files);
    // The copy is idempotent (the same bytes to the same key), so under concurrency it may be asked for
    // more than once; the record that results is one archive.
    expect(copies().length).toBeGreaterThanOrEqual(1);
    const copied = new Uint8Array(await (await w.fx.harness.records.get(submittedKey(s.id)))!.arrayBuffer());
    expect(copied).toEqual(s.bundle.archive);
    expect(jobRow(w, s.id).state).toBe("submitted");
  });

  test("different manifests: exactly one is recorded and the job is submitted once; the other is refused cleanly", async () => {
    const s = await start();
    await putArchive(s.upload, s.bundle.archive);
    const one = s.bundle.manifest;
    const two = { files: [{ ...one.files[0], size: one.files[0].size + 1 }] };
    const env = slowEnv();
    const [a, b] = await Promise.all([
      finalize(s, one, s.p.key, env),
      finalize(s, two, s.p.key, env),
    ]);
    // Exactly one wins; the other is told, cleanly, that the job is not in a state that takes its manifest.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lost = a.status === 409 ? a : b;
    expect(lost.body.code).toBe("bad_state");
    expect(w.fx.tapis.jobs.size).toBe(1);
    const manifest = JSON.parse(
      await (await w.fx.harness.records.get(`records/${s.id}/bundle-manifest.json`))!.text(),
    );
    expect([one.files, two.files]).toContainEqual(manifest.files);
  });
});
