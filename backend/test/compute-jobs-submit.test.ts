/**
 * `POST /compute/jobs` (epic #2021 phase D3, #2024; ADR 0118, the amendment of this phase), through the
 * REAL compute router with its real authentication, over real migrated SQLite, Miniflare's R2 through the
 * Worker's own bindings and the real local S3 interface. The Tapis stand-in was built from Tapis's
 * published specifications and no response of it was recorded from a real tenant.
 *
 * What is pinned: the ORDER of refusal (one failing request per code; a request that fails two checks
 * reports the first), that a refusal writes nothing and returns no address, compute access read in the
 * hold's own statement and not only from the pools, the dataset gate the pipelines use, the upload
 * address (one fixed key, short expiry, the owner only), image mode, the Idempotency-Key, and that the
 * routes work with the compute switch off.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { COMPUTE_REFUSAL_STATUS } from "../../shared/compute-state";
import { BUNDLE_MAX_FILES } from "../../shared/contract/compute-bundle";
import {
  ComputeSubmitErrorSchema,
  ComputeSubmitRequestSchema,
  ComputeSubmitResponseSchema,
} from "../../shared/contract/compute-submit";
import { createJob } from "../src/services/compute-jobs";
import { submitComputeJob } from "../src/services/compute-lifecycle";
import { COMPUTE_ACCESS_READ_SQL } from "../src/services/compute-submit";
import { seedEegDataset } from "./helpers/compute-pipeline-fixture";
import { fundAccount, setPolicy, trace } from "./helpers/compute-seed";
import {
  type Person,
  type World,
  allowRegistry,
  bundleRequest,
  call,
  cookieFor,
  imageRequest,
  jobRow,
  makeBundle,
  newPerson,
  parsedSpec,
  putArchive,
  resetWorld,
  startWorld,
} from "./helpers/compute-submit-world";
import { logged } from "./helpers/logs";

let w: World;

beforeAll(async () => {
  w = await startWorld();
}, 120_000);

beforeEach(async () => {
  await resetWorld(w);
});

afterAll(async () => {
  await w?.fx.dispose();
}, 30_000);

const submit = (p: Person, json: unknown, headers: Record<string, string> = {}) =>
  call(w, "POST", "/compute/jobs", { key: p.key, json, headers });

describe("a script job with a code bundle", () => {
  test("201: uploading, the hold taken, ONE address for the fixed key, and nothing in the records but the job's own", async () => {
    const p = await newPerson(w);
    const bundle = makeBundle();
    const before = Date.now();
    const request = bundleRequest(bundle);
    // The request is the contract's, and the answer parses against the contract's open response.
    expect(ComputeSubmitRequestSchema.safeParse(request).success).toBe(true);
    const r = await submit(p, request);
    expect(r.status).toBe(201);
    expect(ComputeSubmitResponseSchema.safeParse(r.body).success).toBe(true);
    const id = r.body.job_id as string;
    expect(id).toMatch(/^job_[0-9a-f]{24}$/);
    expect(r.body).toMatchObject({
      state: "uploading",
      tag: `nemar_job:${id}`,
      name: "a script job",
    });
    expect(r.body.replayed).toBeUndefined();
    expect(r.headers.get("cache-control")).toBe("no-store");
    const up = r.body.upload;
    expect(up.method).toBe("PUT");
    expect(up.size).toBe(bundle.size);
    // The key is fixed by the Worker, in the path of the address, and no other.
    expect(new URL(up.url).pathname.endsWith(`/incoming/${id}/bundle.tar.gz`)).toBe(true);
    expect(Object.keys(up.headers)).toEqual(["x-amz-checksum-sha256"]);
    // Valid for an hour: short, from now.
    const lives = Date.parse(up.expires_at) - before;
    expect(lives).toBeGreaterThan(55 * 60_000);
    expect(lives).toBeLessThanOrEqual(61 * 60_000);
    expect(new URL(up.url).searchParams.get("X-Amz-Expires")).toBe("3600");
    // The job and its hold are one thing: 1 SU for two cores for half an hour.
    const row = jobRow(w, id);
    expect(row).toMatchObject({ state: "uploading", account_id: p.id, held_milli: 1000 });
    expect(row.records_written_at).toBeNull();
    // Nothing is in `incoming/` yet and nothing is in `records/<id>/submitted/`.
    const keys = await w.fx.harness.keys(w.fx.harness.records);
    expect(keys.filter((k) => k.startsWith("incoming/"))).toEqual([]);
    expect(keys).toEqual([`records/${id}/identity.json`, `records/${id}/spec.json`]);
    // The name is in the recorded specification, not a column.
    const spec = JSON.parse(
      await (await w.fx.harness.records.get(`records/${id}/spec.json`))!.text(),
    );
    expect(spec.name).toBe("a script job");
    expect(Object.keys(row)).not.toContain("name");
  });

  test("the address takes the archive, at that key, and a signature for one key is no signature for another", async () => {
    const p = await newPerson(w);
    const bundle = makeBundle();
    const r = await submit(p, bundleRequest(bundle));
    const up = r.body.upload;
    const other = up.url.replace("bundle.tar.gz", "other.bin");
    expect((await putArchive({ ...up, url: other }, bundle.archive)).status).toBe(403);
    expect((await putArchive(up, bundle.archive)).status).toBeLessThan(300);
    const stored = await w.fx.harness.records.head(`incoming/${r.body.job_id}/bundle.tar.gz`);
    expect(stored?.size).toBe(bundle.size);
    expect(await w.fx.harness.keys(w.fx.harness.records)).not.toContain(
      `incoming/${r.body.job_id}/other.bin`,
    );
  });

  test("the checksum is signed: a body that is not the declared archive is refused by the store", async () => {
    const p = await newPerson(w);
    const bundle = makeBundle();
    const r = await submit(p, bundleRequest(bundle));
    const other = new TextEncoder().encode("not the archive at all, and of another length");
    expect((await putArchive(r.body.upload, other)).status).toBe(400);
  });
});

describe("an image job", () => {
  test("is submitted at once: state submitted, no address, the Tapis job exists", async () => {
    await allowRegistry(w);
    const p = await newPerson(w);
    const r = await submit(p, imageRequest());
    expect(r.status).toBe(201);
    expect(r.body.state).toBe("submitted");
    expect(r.body.upload).toBeUndefined();
    expect(jobRow(w, r.body.job_id).tapis_uuid).not.toBeNull();
    expect(w.fx.tapis.jobs.size).toBe(1);
  });
});

describe("compute off", () => {
  test("the routes work with the switch off; the job waits, then fails submit_timeout with its hold released", async () => {
    await allowRegistry(w);
    const p = await newPerson(w);
    const off = w.env({ COMPUTE_ENABLED: undefined });
    const image = await call(w, "POST", "/compute/jobs", {
      key: p.key,
      json: imageRequest(),
      env: off,
    });
    expect(image.status).toBe(201);
    expect(image.body.state).toBe("created");
    expect(w.fx.tapis.jobs.size).toBe(0);
    const bundle = makeBundle();
    const script = await call(w, "POST", "/compute/jobs", {
      key: p.key,
      json: bundleRequest(bundle),
      env: off,
    });
    expect(script.status).toBe(201);
    expect(script.body.state).toBe("uploading");
    // Past the reservation wait the image job fails and its hold is released.
    const later = Date.now() + 31 * 60_000;
    await submitComputeJob(off, image.body.job_id, later);
    const row = jobRow(w, image.body.job_id);
    expect(row).toMatchObject({ state: "failed", failure_code: "submit_timeout" });
    const released = w.fx.harness.db
      .query("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ? AND kind = 'release'")
      .get(image.body.job_id) as { n: number };
    expect(released.n).toBe(1);
  });
});

describe("the order of refusal: one failing request per code", () => {
  /** Each case: how to arrange the world, the request, and the word and status expected. */
  type Case = {
    name: string;
    code: string;
    field?: string;
    arrange?: (p: Person) => Promise<void> | void;
    access?: string;
    request?: (b: ReturnType<typeof makeBundle>) => unknown;
    headers?: Record<string, string>;
    env?: Parameters<World["env"]>[0];
  };
  const valid = (b: ReturnType<typeof makeBundle>) => bundleRequest(b);
  const mutate = (b: ReturnType<typeof makeBundle>, spec: Record<string, unknown>) =>
    bundleRequest(b, spec);

  const cases: Case[] = [
    { name: "never asked", code: "no_compute_access", access: "none" },
    { name: "asked", code: "no_compute_access", access: "requested" },
    { name: "denied", code: "no_compute_access", access: "denied" },
    { name: "revoked", code: "no_compute_access", access: "revoked" },
    { name: "suspended", code: "suspended", access: "suspended" },
    {
      name: "a bad Idempotency-Key header",
      code: "invalid_spec",
      field: "Idempotency-Key",
      headers: { "Idempotency-Key": "short" },
    },
    {
      name: "a spec with an unknown key",
      code: "invalid_spec",
      field: "spec",
      request: (b) => mutate(b, { surprise: 1 }),
    },
    {
      name: "a spec with a bad name",
      code: "invalid_spec",
      field: "spec.name",
      request: (b) => mutate(b, { name: "" }),
    },
    {
      name: "an unknown top-level key",
      code: "invalid_spec",
      field: "body",
      request: (b) => ({ ...(valid(b) as object), extra: 1 }),
    },
    {
      name: "a bundle with no manifest",
      code: "invalid_spec",
      field: "manifest",
      request: (b) => ({ spec: (valid(b) as { spec: unknown }).spec }),
    },
    {
      name: "a manifest with no bundle",
      code: "invalid_spec",
      field: "manifest",
      request: (b) => ({
        ...(imageRequest() as object),
        manifest: b.manifest,
      }),
    },
    {
      name: "a dataset version that has no tag",
      code: "invalid_spec",
      field: "spec.datasets.0.version",
      request: (b) => mutate(b, { datasets: [{ id: "nm000104", version: "abc" }] }),
    },
    {
      name: "a recipe, which is NEMAR's own",
      code: "invalid_spec",
      field: "spec.recipe",
      request: () => ({
        spec: {
          name: "x",
          runtime: "python",
          recipe: "nemar-floor",
          partition: "shared",
          cores: 1,
          minutes: 5,
        },
      }),
    },
    {
      name: "the MATLAB runtime",
      code: "runtime_unavailable",
      request: (b) => mutate(b, { runtime: "matlab" }),
    },
    {
      name: "a python job while NEMAR's runtime image is not set",
      code: "runtime_unavailable",
      env: { COMPUTE_RUNTIME_IMAGE: undefined },
    },
    {
      name: "an image from a registry that is not listed",
      code: "registry_not_allowed",
      request: () =>
        imageRequest({ image: `docker://quay.example/team/tool@sha256:${"d".repeat(64)}` }),
    },
    {
      name: "a partition people are not offered",
      code: "partition_not_offered",
      request: (b) => mutate(b, { partition: "large-shared" }),
    },
    {
      name: "a job over the partition's ceiling",
      code: "over_job_limit",
      request: (b) => mutate(b, { minutes: 2881 }),
    },
    {
      name: "too many files in the manifest",
      code: "bundle_too_many_files",
      request: (b) => ({
        ...(valid(b) as object),
        manifest: {
          files: Array.from({ length: BUNDLE_MAX_FILES + 1 }, (_, i) => ({
            path: `f${i}.py`,
            size: 1,
            sha256: "a".repeat(64),
          })),
        },
      }),
    },
    {
      name: "a file over the per-file cap",
      code: "bundle_too_large",
      request: (b) => ({
        ...(valid(b) as object),
        manifest: { files: [{ path: "run.py", size: 26 * 1024 * 1024, sha256: "a".repeat(64) }] },
      }),
    },
    {
      name: "an archive over the total cap",
      code: "bundle_too_large",
      request: (b) => mutate(b, { bundle: { size: 101 * 1024 * 1024, sha256: b.sha256 } }),
    },
    {
      name: "an entry that is not in the bundle",
      code: "entry_not_in_bundle",
      request: (b) => mutate(b, { entry: "elsewhere.py" }),
    },
    {
      name: "a path that is a traversal in disguise",
      code: "invalid_spec",
      field: "manifest.files.0.path",
      request: (b) => ({
        ...(valid(b) as object),
        manifest: { files: [{ path: "%2e%2e/run.py", size: 1, sha256: "a".repeat(64) }] },
      }),
      // The entry is named so that only the path rule can be the first to fail.
    },
    {
      name: "a dataset that does not exist",
      code: "dataset_not_eligible",
      field: "spec.datasets.0.id",
      request: (b) => mutate(b, { datasets: [{ id: "nm000199", version: "1.0.0" }] }),
    },
    {
      name: "a dataset version that does not exist",
      code: "version_not_found",
      field: "spec.datasets.0.version",
      request: (b) => mutate(b, { datasets: [{ id: "nm000104", version: "9.9.9" }] }),
    },
    {
      name: "a balance that cannot cover the hold",
      code: "insufficient_balance",
      arrange: async (p) => {
        const row = w.fx.harness.db
          .query("SELECT id FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ?")
          .get(String(p.id)) as { id: number };
        w.fx.harness.db
          .query(
            `INSERT INTO compute_ledger (kind, pool_id, charged_delta_milli, idempotency_key, actor_user_id)
             VALUES ('adjust', ?, 99500, 'test-drain-' || ?, 1)`,
          )
          .run(row.id, p.id);
      },
    },
  ];

  for (const c of cases) {
    test(`${c.name}: ${c.code}`, async () => {
      await allowRegistry(w);
      const p = await newPerson(w, { access: c.access ?? "active" });
      await c.arrange?.(p);
      const bundle = makeBundle();
      const request = c.request ? c.request(bundle) : bundleRequest(bundle);
      const before = await trace(w.env().DB);
      const keysBefore = await w.fx.harness.keys(w.fx.harness.records);
      const r = await call(w, "POST", "/compute/jobs", {
        key: p.key,
        json: request,
        headers: c.headers,
        env: c.env ? w.env(c.env) : undefined,
      });
      expect([c.code, r.status, r.body.code]).toEqual([
        c.code,
        COMPUTE_REFUSAL_STATUS[c.code as keyof typeof COMPUTE_REFUSAL_STATUS],
        c.code,
      ]);
      expect(ComputeSubmitErrorSchema.safeParse(r.body).success).toBe(true);
      if (c.field !== undefined) expect(r.body.field).toBe(c.field);
      // A refusal writes nothing and carries no address, in either bucket.
      expect(await trace(w.env().DB)).toEqual(before);
      expect(await w.fx.harness.keys(w.fx.harness.records)).toEqual(keysBefore);
      expect(await w.fx.harness.keys(w.fx.harness.results)).toEqual([]);
      expect(r.text).not.toContain("X-Amz");
      expect(r.body.upload).toBeUndefined();
    });
  }

  test("over_concurrency: the person's live jobs against the owner's limit", async () => {
    await setPolicy(w.env().DB, w.fx.ownerId, { maxLiveJobsPerPerson: 1 });
    const p = await newPerson(w);
    expect((await submit(p, bundleRequest(makeBundle()))).status).toBe(201);
    const before = await trace(w.env().DB);
    const r = await submit(p, bundleRequest(makeBundle()));
    expect([r.status, r.body.code]).toEqual([409, "over_concurrency"]);
    expect(await trace(w.env().DB)).toEqual(before);
  });

  test("a request that fails two checks reports the first, for each adjacent pair", async () => {
    await allowRegistry(w);
    const bundle = makeBundle();
    const failing = (spec: Record<string, unknown>, manifest?: unknown) => {
      const r = bundleRequest(bundle, spec) as { spec: unknown; manifest: unknown };
      return manifest === undefined ? r : { ...r, manifest };
    };
    const order: Array<[string, string, (p: Person) => Promise<Reply2>]> = [];
    type Reply2 = Awaited<ReturnType<typeof submit>>;
    const run = async (access: string, req: unknown, headers: Record<string, string> = {}) => {
      const p = await newPerson(w, { access });
      return submit(p, req, headers);
    };
    // access before a bad body, for a paused grant as for one never asked
    expect((await run("none", { nonsense: 1 })).body.code).toBe("no_compute_access");
    expect((await run("suspended", { nonsense: 1 })).body.code).toBe("suspended");
    // a bad key header before a bad body
    expect((await run("active", { nonsense: 1 }, { "Idempotency-Key": "x" })).body.field).toBe(
      "Idempotency-Key",
    );
    // a bad body before the runtime
    expect((await run("active", failing({ runtime: "matlab", surprise: 1 }))).body.code).toBe(
      "invalid_spec",
    );
    // the runtime before the partition
    expect(
      (await run("active", failing({ runtime: "matlab", partition: "large-shared" }))).body.code,
    ).toBe("runtime_unavailable");
    // the partition before the ceiling
    expect(
      (await run("active", failing({ partition: "large-shared", minutes: 99999 }))).body.code,
    ).toBe("invalid_spec"); // 99999 is over the schema's own bound: the body is judged first
    expect(
      (await run("active", failing({ partition: "large-shared", minutes: 2881 }))).body.code,
    ).toBe("partition_not_offered");
    // the ceiling before the bundle
    expect((await run("active", failing({ minutes: 2881, entry: "nope.py" }))).body.code).toBe(
      "over_job_limit",
    );
    // the bundle before the datasets
    expect(
      (
        await run(
          "active",
          failing({ entry: "nope.py", datasets: [{ id: "nm000199", version: "1.0.0" }] }),
        )
      ).body.code,
    ).toBe("entry_not_in_bundle");
    // the person's live-job limit before the bundle and the datasets
    await setPolicy(w.env().DB, w.fx.ownerId, { maxLiveJobsPerPerson: 1 });
    const full = await newPerson(w);
    expect((await submit(full, bundleRequest(makeBundle([{ path: "run.py", content: "1" }])))).status).toBe(201);
    expect(
      (
        await submit(
          full,
          failing({ entry: "nope.py", datasets: [{ id: "nm000199", version: "1.0.0" }] }),
        )
      ).body.code,
    ).toBe("over_concurrency");
    await setPolicy(w.env().DB, w.fx.ownerId, {});
    // the datasets before the hold
    const poor = await newPerson(w, { grant: 1 });
    expect(
      (await submit(poor, failing({ datasets: [{ id: "nm000199", version: "1.0.0" }] }))).body.code,
    ).toBe("dataset_not_eligible");
    void order;
  });
});

describe("compute access is read in the hold's own statement, not only from the pools", () => {
  test("pools funded and UNFROZEN, access not active: refused for every state but active", async () => {
    for (const access of ["revoked", "suspended", "denied", "none"]) {
      const p = await newPerson(w);
      // The window the D1 amendment names: access has ended, the pools were not frozen.
      await w
        .env()
        .DB.prepare("UPDATE users SET compute_access = ?1 WHERE id = ?2")
        .bind(access, p.id)
        .run();
      const frozen = w.fx.harness.db
        .query("SELECT COUNT(*) AS n FROM compute_pools WHERE holder_ref = ? AND frozen <> 0")
        .get(String(p.id)) as { n: number };
      expect(frozen.n).toBe(0);
      const r = await submit(p, bundleRequest(makeBundle()));
      expect([access, r.status]).toEqual([access, 403]);
      expect(r.body.code).toBe(access === "suspended" ? "suspended" : "no_compute_access");
    }
  });

  test("through the route: access ends AFTER the route read it and BEFORE the hold, and the hold's own statement refuses", async () => {
    const p = await newPerson(w);
    const real = w.env().DB;
    // A database whose read of the access state is answered truthfully (`active`) and is followed at once
    // by the end of the grant: the interleaving the D1 amendment names. Every other statement, a batch
    // included, is the real one.
    const flipping = {
      prepare(sql: string) {
        const statement = real.prepare(sql);
        if (sql !== COMPUTE_ACCESS_READ_SQL) return statement;
        return {
          bind(...args: unknown[]) {
            const bound = statement.bind(...args);
            return {
              async first() {
                const row = await bound.first();
                await real
                  .prepare("UPDATE users SET compute_access = 'revoked' WHERE id = ?1")
                  .bind(p.id)
                  .run();
                return row;
              },
            };
          },
        };
      },
      batch: (statements: D1PreparedStatement[]) => real.batch(statements),
    } as unknown as D1Database;
    const before = await trace(real);
    const r = await call(w, "POST", "/compute/jobs", {
      key: p.key,
      json: bundleRequest(makeBundle()),
      env: { ...w.env(), DB: flipping },
    });
    expect([r.status, r.body.code]).toEqual([403, "no_compute_access"]);
    expect(await trace(real)).toEqual(before);
    expect(r.body.upload).toBeUndefined();
  });

  test("the hold's own statement refuses when the route's read was stale (createJob, called as the route calls it)", async () => {
    const p = await newPerson(w);
    // The route read `active`; the grant then ended before the hold. Calling createJob with the guard on
    // is that interleaving exactly.
    await w
      .env()
      .DB.prepare("UPDATE users SET compute_access = 'revoked' WHERE id = ?1")
      .bind(p.id)
      .run();
    const before = await trace(w.env().DB);
    const bundle = makeBundle();
    const spec = parsedSpec(bundleRequest(bundle) as { spec: Record<string, unknown> });
    const made = await createJob(w.env(), {
      source: "cli",
      accountId: p.id,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec,
      requireActiveAccess: true,
    });
    expect(made).toEqual({ ok: false, code: "no_compute_access" });
    expect(await trace(w.env().DB)).toEqual(before);
    // The same call without the guard takes the hold: it is the guard that refused, not the pools.
    const unguarded = await createJob(w.env(), {
      source: "cli",
      accountId: p.id,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec,
    });
    expect(unguarded.ok).toBe(true);
  });
});

describe("the dataset gate is the pipelines' own", () => {
  const request = (id: string, version = "1.0.0") =>
    bundleRequest(makeBundle(), { datasets: [{ id, version }] });

  test("every reason a dataset is not eligible is one answer, and it is refused before any hold is written", async () => {
    const reasons: Array<[string, Parameters<typeof seedEegDataset>[2]]> = [
      ["nm000110", { visibility: "private" }],
      // An anonymous dataset has never been published (a trigger holds that), so it fails two terms.
      ["nm000111", { anonymous: 1, firstPublishedAt: null }],
      ["nm000112", { firstPublishedAt: null }],
      ["nm000113", { withdrawnAt: "2026-02-01 00:00:00" }],
      ["nm000114", { ezidStatus: "unavailable" }],
      ["nm000115", { status: "archived" }],
      ["nm000116", { versions: [] }],
    ];
    for (const [id, over] of reasons) await seedEegDataset(w.env(), id, over);
    const p = await newPerson(w);
    const before = await trace(w.env().DB);
    const bodies = new Set<string>();
    for (const id of [...reasons.map(([i]) => i), "nm000199"]) {
      const r = await submit(p, request(id));
      expect([id, r.status, r.body.code]).toEqual([id, 422, "dataset_not_eligible"]);
      bodies.add(JSON.stringify({ ...r.body, field: undefined }));
    }
    // Anonymous, private, withdrawn and absent are told apart by nobody.
    expect(bodies.size).toBe(1);
    expect(await trace(w.env().DB)).toEqual(before);
  });

  test("a sandbox dataset and a fixture id are not real datasets", async () => {
    await seedEegDataset(w.env(), "xx000001");
    await seedEegDataset(w.env(), "nm099999");
    const p = await newPerson(w);
    for (const id of ["xx000001", "nm099999"]) {
      expect((await submit(p, request(id))).body.code).toBe("dataset_not_eligible");
    }
  });

  test("a dataset of another modality is fine for a person: only the pipelines are EEG-only", async () => {
    await seedEegDataset(w.env(), "nm000120", { modalities: "meg" });
    const p = await newPerson(w);
    expect((await submit(p, request("nm000120"))).status).toBe(201);
  });

  test("version_untagged and too_many_files, from the stored version rows", async () => {
    await seedEegDataset(w.env(), "nm000121", { versions: [["1.0", "2026-01-02 03:04:05"]] });
    await seedEegDataset(w.env(), "nm000122", {
      versions: [["1.0.0", "2026-01-02 03:04:05", 38_001]],
    });
    const p = await newPerson(w);
    const untagged = await submit(p, request("nm000121", "latest"));
    expect([untagged.status, untagged.body.code]).toEqual([422, "version_untagged"]);
    const big = await submit(p, request("nm000122", "latest"));
    expect([big.status, big.body.code]).toEqual([422, "too_many_files"]);
    const edge = await seedEegDataset(w.env(), "nm000123", {
      versions: [["1.0.0", "2026-01-02 03:04:05", 38_000]],
    });
    void edge;
    expect((await submit(p, request("nm000123", "latest"))).status).toBe(201);
  });
});

describe("the Idempotency-Key", () => {
  test("a repeat returns the ORIGINAL job: one job, one hold, replayed, a fresh address for the same key", async () => {
    const p = await newPerson(w);
    const bundle = makeBundle();
    const headers = { "Idempotency-Key": "key-0001-abcdef" };
    const first = await submit(p, bundleRequest(bundle), headers);
    expect(first.status).toBe(201);
    const again = await submit(p, bundleRequest(bundle), headers);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.body).toMatchObject({
      job_id: first.body.job_id,
      state: "uploading",
      tag: first.body.tag,
      name: first.body.name,
      replayed: true,
    });
    expect(new URL(again.body.upload.url).pathname).toBe(new URL(first.body.upload.url).pathname);
    // The address a repeat gets works.
    expect((await putArchive(again.body.upload, bundle.archive)).status).toBeLessThan(300);
    expect((await trace(w.env().DB)).jobs).toBe(1);
    expect((await trace(w.env().DB)).holds).toBe(1);
  });

  test("an address that has expired is refused by the store; a repeat of the key (inside the job's hour) gives one that works", async () => {
    const p = await newPerson(w);
    const bundle = makeBundle();
    const headers = { "Idempotency-Key": "key-0007-abcdef" };
    const first = await submit(p, bundleRequest(bundle), headers);
    const clock = w.fx.harness.standin.clock;
    const real = clock.now;
    clock.now = () => Date.now() + 2 * 3600 * 1000;
    try {
      expect((await putArchive(first.body.upload, bundle.archive)).status).toBe(403);
    } finally {
      clock.now = real;
    }
    expect(await w.fx.harness.records.head(`incoming/${first.body.job_id}/bundle.tar.gz`)).toBeNull();
    const again = await submit(p, bundleRequest(bundle), headers);
    expect(again.body.job_id).toBe(first.body.job_id);
    expect((await putArchive(again.body.upload, bundle.archive)).status).toBeLessThan(300);
  });

  test("a repeat does not depend on the world staying as it was: the dataset has since been withdrawn", async () => {
    const p = await newPerson(w);
    const bundle = makeBundle();
    const headers = { "Idempotency-Key": "key-0002-abcdef" };
    const first = await submit(p, bundleRequest(bundle), headers);
    await w
      .env()
      .DB.prepare(
        "UPDATE datasets SET withdrawn_at = datetime('now') WHERE dataset_id = 'nm000104'",
      )
      .run();
    const again = await submit(p, bundleRequest(bundle), headers);
    expect([again.status, again.body.job_id]).toEqual([201, first.body.job_id]);
  });

  test("the same key with a different request is 422 idempotency_conflict and writes nothing", async () => {
    const p = await newPerson(w);
    const bundle = makeBundle();
    const headers = { "Idempotency-Key": "key-0003-abcdef" };
    await submit(p, bundleRequest(bundle), headers);
    const before = await trace(w.env().DB);
    for (const spec of [{ name: "another name" }, { partition: "compute" }, { minutes: 31 }]) {
      const r = await submit(p, bundleRequest(bundle, spec), headers);
      expect([r.status, r.body.code]).toEqual([422, "idempotency_conflict"]);
    }
    expect(await trace(w.env().DB)).toEqual(before);
  });

  test("the key is the person's: another person with the same key makes their own job", async () => {
    const a = await newPerson(w);
    const b = await newPerson(w);
    const headers = { "Idempotency-Key": "key-0004-abcdef" };
    const first = await submit(a, bundleRequest(makeBundle()), headers);
    const second = await submit(
      b,
      bundleRequest(makeBundle([{ path: "run.py", content: "2" }])),
      headers,
    );
    expect(second.status).toBe(201);
    expect(second.body.job_id).not.toBe(first.body.job_id);
    expect(second.body.replayed).toBeUndefined();
  });

  test("a repeat of an image job returns it in its current state, with no address", async () => {
    await allowRegistry(w);
    const p = await newPerson(w);
    const headers = { "Idempotency-Key": "key-0005-abcdef" };
    const first = await submit(p, imageRequest(), headers);
    const again = await submit(p, imageRequest(), headers);
    expect(again.body).toMatchObject({
      job_id: first.body.job_id,
      state: "submitted",
      replayed: true,
    });
    expect(again.body.upload).toBeUndefined();
    expect(w.fx.tapis.jobs.size).toBe(1);
  });

  test("a repeat of a job whose hour has passed is the failed job, not a new address", async () => {
    const p = await newPerson(w);
    const bundle = makeBundle();
    const headers = { "Idempotency-Key": "key-0006-abcdef" };
    const first = await submit(p, bundleRequest(bundle), headers);
    w.fx.harness.db
      .query("UPDATE compute_jobs SET created_at = datetime('now', '-2 hours') WHERE id = ?")
      .run(first.body.job_id);
    const { runUploadExpiryCron } = await import("../src/services/compute-uploads");
    await runUploadExpiryCron(w.env());
    const again = await submit(p, bundleRequest(bundle), headers);
    expect(again.body).toMatchObject({
      job_id: first.body.job_id,
      state: "failed",
      replayed: true,
    });
    expect(again.body.upload).toBeUndefined();
  });
});

describe("who may submit, and how", () => {
  test("no credential is 401; a session cookie needs a NEMAR Origin; a key does not", async () => {
    const p = await newPerson(w);
    const request = bundleRequest(makeBundle());
    expect((await call(w, "POST", "/compute/jobs", { json: request })).status).toBe(401);
    const cookie = await cookieFor(w, p);
    const before = await trace(w.env().DB);
    for (const origin of ["https://evil.example", "null", undefined]) {
      const r = await call(w, "POST", "/compute/jobs", { cookie, origin, json: request });
      expect([origin, r.status, r.body.code]).toEqual([origin, 403, "origin_not_allowed"]);
    }
    expect(await trace(w.env().DB)).toEqual(before);
    const ok = await call(w, "POST", "/compute/jobs", {
      cookie,
      origin: "https://app.nemar.org",
      json: request,
    });
    expect(ok.status).toBe(201);
    const keyed = await call(w, "POST", "/compute/jobs", {
      key: p.key,
      origin: "https://evil.example",
      json: bundleRequest(makeBundle([{ path: "run.py", content: "z" }])),
    });
    expect(keyed.status).toBe(201);
  });

  test("a body that is not JSON, not an object, or too large is invalid_spec and writes nothing", async () => {
    const p = await newPerson(w);
    const before = await trace(w.env().DB);
    for (const raw of ["{nope", "[]", "42"]) {
      const r = await call(w, "POST", "/compute/jobs", { key: p.key, raw });
      expect([raw, r.status, r.body.code]).toEqual([raw, 400, "invalid_spec"]);
    }
    const huge = await call(w, "POST", "/compute/jobs", {
      key: p.key,
      raw: JSON.stringify({ pad: "x".repeat(3 * 1024 * 1024) }),
    });
    expect([huge.status, huge.body.code]).toEqual([413, "invalid_spec"]);
    expect(await trace(w.env().DB)).toEqual(before);
  });

  test("insufficient_balance says the balance is used up and to ask an administrator, and promises no refund", async () => {
    const p = await newPerson(w, { grant: 1 });
    const r = await submit(p, bundleRequest(makeBundle()));
    expect(r.body.code).toBe("insufficient_balance");
    expect(r.body.error).toContain("used up");
    expect(r.body.error).toContain("administrator");
    expect(r.body.error.toLowerCase()).not.toContain("refund");
  });

  test("nothing a person chose reaches a Worker log: not the name, a path, an argument or the key", async () => {
    await allowRegistry(w);
    const p = await newPerson(w);
    const marker = "zq7-distinct-marker";
    const bundle = makeBundle([{ path: `dir-${marker}/run.py`, content: "x" }]);
    const lines = await logged(async () => {
      const r = await submit(
        p,
        bundleRequest(bundle, {
          name: `job ${marker}`,
          entry: `dir-${marker}/run.py`,
          args: [marker],
        }),
        { "Idempotency-Key": `key-${marker}` },
      );
      expect(r.status).toBe(201);
      await submit(p, bundleRequest(bundle, { name: `job ${marker}`, entry: "missing.py" }));
      await submit(
        p,
        imageRequest({ name: marker, image: `quay.example/${marker}/x@sha256:${"d".repeat(64)}` }),
      );
    });
    expect(lines.join("\n")).not.toContain(marker);
  });
});
