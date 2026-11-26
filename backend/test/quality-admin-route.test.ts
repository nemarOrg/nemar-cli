/**
 * A run's quality as an administrator reads it (`GET /admin/compute/pipeline/runs/:stamp/quality`,
 * `services/quality-admin.ts`, epic #2324 phase B3), through the REAL admin router with its authentication,
 * admin and cookie-origin middleware, over a real bun:sqlite D1 carrying every production migration, real
 * API keys (hashed as production hashes them) and Miniflare's R2 as the derivatives bucket. The dataset,
 * stamp and derivative rows are written with SQL the tables accept (nemar-ica is a placeholder no path
 * dispatches); the recordings table is nemar-ica's real one, or one built in its columns.
 *
 * What is pinned, each case by the mutation it kills (the PR's mutation table names them):
 *  - who may: no key, a member's key and a revoked admin key are refused; an admin and an owner are not;
 *  - every state a derivative can stand in is answered with its word (never a 500): no succeeded run, not
 *    keyed, awaiting, copying, failed, expired (marked, and a canary past its date that the sync has not
 *    marked yet), canary, current, superseded and not current; only a stored row's table is read;
 *  - the recordings: succeeded only, sorted, 100 a page, with `next_after`; an empty table, an exact multiple
 *    of 100, a cursor past the end, a cursor the list does not hold, and forged cursors (refused, echoing
 *    nothing); a path the quality route would refuse is left out and counted;
 *  - the read is bounded: a table over the bound is never read, a page from the cache reads no store, and
 *    the cache entry is the derivative's key's;
 *  - every answer, a refusal included, is `no-store`.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  COMPUTE_RUN_QUALITY_PAGE_SIZE,
  COMPUTE_RUN_QUALITY_RECORDINGS_STATES,
  COMPUTE_RUN_QUALITY_STATES,
  ComputeRunQualityResponseSchema,
} from "../../shared/contract/compute-admin";
import { TABLE_READ_MAX_BYTES } from "../src/services/compute-derivatives";
import { RUN_QUALITY_SQL, runQualityCacheKey } from "../src/services/quality-admin";
import type { Bindings } from "../src/types/bindings";
import { InMemoryCache } from "./helpers/cache";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { freshDb, realD1 } from "./helpers/d1";
import { logged } from "./helpers/logs";
import { newJobId, productFiles, seedDerivative, seedIcaStamp } from "./helpers/quality-fixture";

// biome-ignore lint/suspicious/noExplicitAny: answers are read field by field
type Loose = Record<string, any>;

const DATASET = "on007823";
const TABLE_PATH = "desc-nemarica_recordings.tsv";
const REAL_TABLE = productFiles().get(TABLE_PATH) as Uint8Array;
const REAL_RECORDING = "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_eeg.edf";

let db: Database;
let host: Miniflare;
let bucket: R2Bucket;
/** Store reads the route made, by method (the bucket is Miniflare's; this only counts the calls). */
let reads: { get: number; head: number; body: number };
const handle = makeComputeApp();

/** An object's body, counting each time it is read. */
function countedBody(object: R2ObjectBody): R2ObjectBody {
  return new Proxy(object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "arrayBuffer" || prop === "text" || prop === "json" || prop === "body") {
        reads.body += 1;
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The derivatives bucket, counting the reads a request makes of it (the calls go to Miniflare's R2). */
function counted(inner: R2Bucket): R2Bucket {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "get") {
        return async (...args: unknown[]) => {
          reads.get += 1;
          const object = (await (value as (...a: unknown[]) => Promise<R2ObjectBody | null>).apply(
            target,
            args,
          )) as R2ObjectBody | null;
          return object === null ? null : countedBody(object);
        };
      }
      if (prop === "head") {
        return (...args: unknown[]) => {
          reads.head += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const env = (over: Partial<Bindings> = {}): Bindings =>
  ({
    DB: realD1(db),
    ENVIRONMENT: "production",
    COMPUTE_DERIVATIVES: counted(bucket),
    COMPUTE_DERIVATIVES_BUCKET_NAME: "nemar-compute-derivatives",
    ...over,
  }) as Bindings;

beforeAll(async () => {
  host = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2024-12-01",
    r2Buckets: ["COMPUTE_DERIVATIVES"],
  });
  bucket = (await host.getR2Bucket("COMPUTE_DERIVATIVES")) as unknown as R2Bucket;
}, 120_000);

afterAll(async () => {
  await host?.dispose();
}, 30_000);

async function emptyBucket(): Promise<void> {
  for (;;) {
    const listed = await bucket.list({ limit: 1000 });
    if (listed.objects.length === 0) return;
    await bucket.delete(listed.objects.map((o) => o.key));
  }
}

beforeEach(async () => {
  db = freshDb();
  await seedComputeUsers(db);
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, anonymous, modalities,
                           first_published_at)
     VALUES (?, ?, -1, 'active', 'public', 0, 0, 'eeg', '2026-01-01 00:00:00')`,
    [DATASET, DATASET],
  );
  await emptyBucket();
  reads = { get: 0, head: 0, body: 0 };
  (globalThis as { caches?: unknown }).caches = undefined;
});

async function get(path: string, who: ComputeWho | null = "admin", over: Partial<Bindings> = {}) {
  const headers: Record<string, string> = {};
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  const res = await handle(new Request(`http://api.test/admin${path}`, { headers }), env(over));
  const text = await res.text();
  let body: Loose = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, body, cacheControl: res.headers.get("Cache-Control") };
}

const quality = (stamp: number | string, query = "", who: ComputeWho | null = "admin") =>
  get(`/compute/pipeline/runs/${stamp}/quality${query}`, who);

let runs = 0;
/** A stamp of a nemar-ica run in the state given; its id. */
async function stamp(state: "succeeded" | "failed" = "succeeded"): Promise<number> {
  return seedIcaStamp(realD1(db), {
    datasetId: DATASET,
    jobId: newJobId(),
    state,
    version: `v1.0.${runs++}`,
  });
}

/** A derivative of a fresh succeeded stamp, with `table` (or none) stored under its key. */
async function derivative(
  over: {
    retention?: "canary" | "catalog" | "published";
    state?: "copying" | "stored" | "failed" | "expired";
    storedAt?: string;
    supersededAt?: string | null;
    expiresAt?: string | null;
  } = {},
  table: Uint8Array | string | null = REAL_TABLE,
): Promise<{ stampId: number; key: string }> {
  const jobId = newJobId();
  const stampId = await seedIcaStamp(realD1(db), {
    datasetId: DATASET,
    jobId,
    version: `v1.0.${runs++}`,
  });
  const key = await seedDerivative(realD1(db), {
    retention: "canary",
    ...over,
    datasetId: DATASET,
    stampId,
    jobId,
  });
  if (table !== null) await bucket.put(`d/${key}/${TABLE_PATH}`, table);
  return { stampId, key };
}

/** A recordings table in nemar-ica's columns: `n` succeeded recordings, and the rows given after them. */
function table(n: number, extra: string[] = []): string {
  const rows = ["path\tstatus\tcode\tstep"];
  for (let i = 0; i < n; i++) {
    const sub = `sub-${String(i).padStart(4, "0")}`;
    rows.push(`${sub}/eeg/${sub}_task-rest_eeg.edf\tsucceeded\tn/a\tn/a`);
  }
  return `${[...rows, ...extra].join("\n")}\n`;
}

/** Every path of every page, following `next_after`. */
async function allPages(stampId: number): Promise<{ paths: string[]; pages: number }> {
  const paths: string[] = [];
  let after: string | null = null;
  let pages = 0;
  for (;;) {
    const q = after === null ? "" : `?after=${encodeURIComponent(after)}`;
    const r = await quality(stampId, q);
    expect(r.status).toBe(200);
    pages++;
    for (const item of r.body.recordings.items) paths.push(item.path);
    after = r.body.recordings.next_after;
    if (after === null) return { paths, pages };
    if (pages > 50) throw new Error("the pages never ended");
  }
}

describe("who may read a run's quality", () => {
  test("no key is 401, a member's key 403, a revoked admin key 401; an admin and an owner read it", async () => {
    const { stampId } = await derivative();
    expect((await quality(stampId, "", null)).status).toBe(401);
    const member = await quality(stampId, "", "member");
    expect(member.status).toBe(403);
    expect(member.text).not.toContain(DATASET);
    expect((await quality(stampId, "", "owner")).status).toBe(200);
    expect((await quality(stampId, "", "admin")).status).toBe(200);

    // The admin's own key, revoked: the same request is refused, and says nothing of the run.
    db.run(
      `UPDATE tokens SET revoked_at = datetime('now')
        WHERE user_id = (SELECT id FROM users WHERE username = 'cmp-admin')`,
    );
    const revoked = await quality(stampId, "", "admin");
    expect(revoked.status).toBe(401);
    expect(revoked.text).not.toContain(DATASET);
    expect((await quality(stampId, "", "admin2")).status).toBe(200);
  });

  test("every answer of the route is no-store, a refusal included", async () => {
    const { stampId } = await derivative();
    expect((await quality(stampId)).cacheControl).toBe("no-store");
    expect((await quality(999_999)).cacheControl).toBe("no-store");
    expect((await quality("abc")).cacheControl).toBe("no-store");
    expect((await quality(stampId, "?after=..%2Fx")).cacheControl).toBe("no-store");
  });
});

describe("where a run's derivative stands, one word each", () => {
  test("the answer parses as the contract's and every word is one the contract lists", async () => {
    const { stampId, key } = await derivative();
    const r = await quality(stampId);
    expect(r.status).toBe(200);
    expect(ComputeRunQualityResponseSchema.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({
      stamp_id: stampId,
      dataset_id: DATASET,
      recipe: "nemar-ica",
      input: "bids",
      stamp_state: "succeeded",
      quality: "canary",
      skip: null,
      derivative: {
        key,
        state: "stored",
        retention: "canary",
        failure: null,
        stored_at: "2026-11-20 10:00:00",
        expires_at: "2099-01-01 00:00:00",
        superseded_at: null,
      },
    });
    expect(COMPUTE_RUN_QUALITY_STATES).toContain(r.body.quality);
    expect(COMPUTE_RUN_QUALITY_RECORDINGS_STATES).toContain(r.body.recordings.state);
  });

  test("a stamp that did not succeed is run_not_succeeded, with no derivative and no read", async () => {
    const id = await stamp("failed");
    const r = await quality(id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ quality: "run_not_succeeded", derivative: null, skip: null });
    expect(r.body.recordings).toEqual({
      state: "not_stored",
      succeeded: null,
      unlisted: 0,
      items: [],
      next_after: null,
    });
    expect(reads).toEqual({ get: 0, head: 0, body: 0 });
  });

  test("a succeeded stamp the store decided not to key is not_keyed with the skip word; one undecided is awaiting_derivative", async () => {
    const undecided = await stamp();
    expect((await quality(undecided)).body.quality).toBe("awaiting_derivative");
    const skipped = await stamp();
    db.run(
      "INSERT INTO compute_derivative_skips (stamp_id, word) VALUES (?, 'transient_failure')",
      [skipped],
    );
    const r = await quality(skipped);
    expect(r.body).toMatchObject({
      quality: "not_keyed",
      skip: "transient_failure",
      derivative: null,
    });
    expect(r.body.recordings.state).toBe("not_stored");
    expect(reads).toEqual({ get: 0, head: 0, body: 0 });
  });

  test("copying, failed and expired rows are answered with their words and their tables are not read", async () => {
    const copying = await derivative({ state: "copying" });
    const failed = await derivative({ state: "failed" });
    const expired = await derivative({ state: "expired", retention: "catalog" });
    for (const [d, word] of [
      [copying, "copying"],
      [failed, "failed"],
      [expired, "expired"],
    ] as const) {
      const r = await quality(d.stampId);
      expect([word, r.status]).toEqual([word, 200]);
      expect([word, r.body.quality]).toEqual([word, word]);
      expect([word, r.body.recordings.state]).toEqual([word, "not_stored"]);
    }
    expect((await quality(failed.stampId)).body.derivative.failure).toBe("copy_failed");
    expect(reads).toEqual({ get: 0, head: 0, body: 0 });
  });

  test("the missing canary: a canary past its date that the sync has not marked is expired, its table never read", async () => {
    const d = await derivative({ retention: "canary", expiresAt: "2026-01-01 00:00:00" });
    const r = await quality(d.stampId);
    expect(r.status).toBe(200);
    expect(r.body.quality).toBe("expired");
    expect(r.body.derivative).toMatchObject({ state: "stored", expires_at: "2026-01-01 00:00:00" });
    expect(r.body.recordings.state).toBe("not_stored");
    expect(reads.get).toBe(0);
    // Its files already gone (what the sync does next) is the same answer, never a 500.
    await bucket.delete(`d/${d.key}/${TABLE_PATH}`);
    expect((await quality(d.stampId)).body.quality).toBe("expired");
  });

  test("a failed row whose date also passed is failed: the failure is the row's last word", async () => {
    const d = await derivative({ state: "failed", expiresAt: "2026-01-01 00:00:00" });
    expect((await quality(d.stampId)).body.quality).toBe("failed");
  });

  test("current, superseded and not_current: the public rule, with each row's table listed", async () => {
    const older = await derivative({ retention: "catalog", storedAt: "2026-11-01 00:00:00" });
    const newer = await derivative({ retention: "catalog", storedAt: "2026-11-10 00:00:00" });
    const superseded = await derivative({
      retention: "catalog",
      storedAt: "2026-10-01 00:00:00",
      supersededAt: "2026-11-01 00:00:00",
      expiresAt: "2099-01-01 00:00:00",
    });
    const words = async (id: number) => {
      const r = await quality(id);
      return [r.body.quality, r.body.recordings.state];
    };
    expect(await words(newer.stampId)).toEqual(["current", "listed"]);
    expect(await words(older.stampId)).toEqual(["not_current", "listed"]);
    expect(await words(superseded.stampId)).toEqual(["superseded", "listed"]);
    // A published row that was superseded is public: it is current when it is the newest.
    const published = await derivative({
      retention: "published",
      storedAt: "2026-11-20 00:00:00",
      supersededAt: "2026-11-21 00:00:00",
    });
    expect(await words(published.stampId)).toEqual(["current", "listed"]);
    expect(await words(newer.stampId)).toEqual(["not_current", "listed"]);
  });

  test("a stamp that does not exist is 404 stamp_not_found; a stamp id that is not one is invalid_query naming stamp", async () => {
    const missing = await quality(999_999);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("stamp_not_found");
    for (const bad of ["abc", "0", "01", "99999999999999999"]) {
      const r = await quality(bad);
      expect([bad, r.status, r.body.code]).toEqual([bad, 400, "invalid_query"]);
      expect(r.body.error).toContain("stamp");
    }
  });

  test("the statement reads the stamp and its derivative by index", () => {
    const plan = db
      .query(`EXPLAIN QUERY PLAN ${RUN_QUALITY_SQL}`)
      .all(1)
      .map((r) => (r as { detail: string }).detail)
      .join("\n");
    expect(plan).not.toMatch(/SCAN (s|cd|k)\b/);
  });
});

describe("the recordings that succeeded", () => {
  test("nemar-ica's real table: its one succeeded recording", async () => {
    const d = await derivative();
    const r = await quality(d.stampId);
    expect(r.body.recordings).toEqual({
      state: "listed",
      succeeded: 1,
      unlisted: 0,
      items: [{ path: REAL_RECORDING }],
      next_after: null,
    });
  });

  test("only succeeded rows, sorted by path; a path the quality route would refuse is left out and counted", async () => {
    const d = await derivative(
      { retention: "canary" },
      [
        "path\tstatus\tcode\tstep",
        "sub-b/eeg/sub-b_task-x_eeg.set\tsucceeded\tn/a\tn/a",
        "sub-a/eeg/sub-a_task-x_eeg.edf\tsucceeded\tn/a\tn/a",
        "sub-c/eeg/sub-c_task-x_eeg.edf\tfailed\tload_failed\tload",
        "sub-d/eeg/sub-d_task-x_eeg.edf\tskipped\tno_data\tn/a",
        "../sub-e/eeg/sub-e_task-x_eeg.edf\tsucceeded\tn/a\tn/a",
        "sub-f/eeg/sub-f_task-x_events.tsv\tsucceeded\tn/a\tn/a",
        "sub-a/eeg/sub-a_task-x_eeg.edf\tsucceeded\tn/a\tn/a",
        "",
      ].join("\n"),
    );
    const r = await quality(d.stampId);
    expect(r.body.recordings).toEqual({
      state: "listed",
      succeeded: 2,
      unlisted: 3,
      items: [
        { path: "sub-a/eeg/sub-a_task-x_eeg.edf" },
        { path: "sub-b/eeg/sub-b_task-x_eeg.set" },
      ],
      next_after: null,
    });
  });

  test("an empty page: a table with no succeeded row lists none, and is not an error", async () => {
    const header = await derivative({}, "path\tstatus\tcode\tstep\n");
    const r = await quality(header.stampId);
    expect(r.status).toBe(200);
    expect(r.body.recordings).toEqual({
      state: "listed",
      succeeded: 0,
      unlisted: 0,
      items: [],
      next_after: null,
    });
    const allFailed = await derivative(
      {},
      table(0, ["sub-x/eeg/sub-x_eeg.edf\tfailed\tload_failed\tload"]),
    );
    expect((await quality(allFailed.stampId)).body.recordings).toMatchObject({
      succeeded: 0,
      items: [],
    });
  });

  test(`pages of ${COMPUTE_RUN_QUALITY_PAGE_SIZE}: 250 recordings are three pages, each path once, in order`, async () => {
    const d = await derivative({}, table(250));
    const first = await quality(d.stampId);
    expect(first.body.recordings.items).toHaveLength(COMPUTE_RUN_QUALITY_PAGE_SIZE);
    expect(first.body.recordings.succeeded).toBe(250);
    expect(first.body.recordings.next_after).toBe(first.body.recordings.items[99].path);
    const { paths, pages } = await allPages(d.stampId);
    expect(pages).toBe(3);
    expect(paths).toHaveLength(250);
    expect(new Set(paths).size).toBe(250);
    expect(paths).toEqual([...paths].sort());
  });

  test("an exact multiple of 100: 200 recordings are two pages, and the second says there is no third", async () => {
    const d = await derivative({}, table(200));
    const { paths, pages } = await allPages(d.stampId);
    expect(pages).toBe(2);
    expect(paths).toHaveLength(200);
    const exactly = await derivative({}, table(100));
    const one = await quality(exactly.stampId);
    expect(one.body.recordings.items).toHaveLength(100);
    expect(one.body.recordings.next_after).toBeNull();
    // 101 is two pages, the second of one.
    const over = await derivative({}, table(101));
    const p = await allPages(over.stampId);
    expect([p.pages, p.paths.length]).toEqual([2, 101]);
  });

  test("a cursor past the last path is an empty page; one the list does not hold pages from where it sorts", async () => {
    const d = await derivative({}, table(150));
    const past = await quality(
      d.stampId,
      `?after=${encodeURIComponent("sub-9999/eeg/sub-9999_task-rest_eeg.edf")}`,
    );
    expect(past.status).toBe(200);
    expect(past.body.recordings).toMatchObject({ succeeded: 150, items: [], next_after: null });
    // `sub-0049x...` sorts after sub-0049's own path and before sub-0050's.
    const between = await quality(
      d.stampId,
      `?after=${encodeURIComponent("sub-0049/eeg/sub-0049x_eeg.edf")}`,
    );
    expect(between.body.recordings.items[0].path).toBe("sub-0050/eeg/sub-0050_task-rest_eeg.edf");
    expect(between.body.recordings.items).toHaveLength(100);
    expect(between.body.recordings.next_after).toBeNull();
  });

  test("a forged cursor is refused as invalid_query naming after, echoing nothing, before anything is read", async () => {
    const d = await derivative({}, table(5));
    const forged = [
      "../../d/secret_eeg.edf",
      "/sub-01/eeg/sub-01_eeg.edf",
      "sub-01//sub-01_eeg.edf",
      "sub-01/eeg/sub-01_events.tsv",
      "",
      `sub-01/${"x".repeat(1100)}_eeg.edf`,
      "sub-01/eeg/sub-01_eeg.edf\nsub-02",
    ];
    for (const cursor of forged) {
      const r = await quality(d.stampId, `?after=${encodeURIComponent(cursor)}`);
      expect([cursor.slice(0, 40), r.status, r.body.code]).toEqual([
        cursor.slice(0, 40),
        400,
        "invalid_query",
      ]);
      expect(r.body.error).toContain("after");
      if (cursor.length > 0) expect(r.text).not.toContain(cursor.slice(0, 20));
    }
    // Two cursors, or a key the route does not take, are refused too.
    expect((await quality(d.stampId, "?after=a_eeg.edf&after=b_eeg.edf")).status).toBe(400);
    expect((await quality(d.stampId, "?limit=500")).status).toBe(400);
    expect(reads).toEqual({ get: 0, head: 0, body: 0 });
  });
});

describe("the read is bounded and cached by key", () => {
  test("a table over the read bound is table_too_large and its body is never read", async () => {
    const d = await derivative({}, null);
    // A sparse body of one byte over the bound: Miniflare stores it, the route sees its size first.
    await bucket.put(`d/${d.key}/${TABLE_PATH}`, new Uint8Array(TABLE_READ_MAX_BYTES + 1));
    const r = await quality(d.stampId);
    expect(r.status).toBe(200);
    expect(r.body.quality).toBe("canary");
    expect(r.body.recordings).toMatchObject({
      state: "table_too_large",
      succeeded: null,
      items: [],
    });
    // One store call, and its body is never read: the stated size decides first.
    expect(reads).toEqual({ get: 1, head: 0, body: 0 });
  }, 60_000);

  test("a stored derivative with no table is table_missing; a table that does not parse is table_unreadable, logged", async () => {
    const none = await derivative({}, null);
    expect((await quality(none.stampId)).body.recordings.state).toBe("table_missing");
    const bad = await derivative({}, "path\tstatus\n");
    const lines = await logged(async () => {
      expect((await quality(bad.stampId)).body.recordings.state).toBe("table_unreadable");
    });
    expect(lines.join("\n")).toContain(`table_unreadable stamp=${bad.stampId}`);
    expect(lines.join("\n")).toContain("reason=missing_column");
    const notUtf8 = await derivative({}, new Uint8Array([0x70, 0xff, 0xfe, 0x0a]));
    expect((await quality(notUtf8.stampId)).body.recordings.state).toBe("table_unreadable");
  });

  test("an unbound store is store_unavailable, never a 500; so is a store that throws", async () => {
    const d = await derivative();
    const unbound = await get(`/compute/pipeline/runs/${d.stampId}/quality`, "admin", {
      COMPUTE_DERIVATIVES: undefined,
    });
    expect(unbound.status).toBe(200);
    expect(unbound.body).toMatchObject({
      quality: "canary",
      recordings: { state: "store_unavailable" },
    });
    const throwing = {
      get: () => Promise.reject(new Error("store down")),
    } as unknown as R2Bucket;
    const lines = await logged(async () => {
      const down = await get(`/compute/pipeline/runs/${d.stampId}/quality`, "admin", {
        COMPUTE_DERIVATIVES: throwing,
      });
      expect(down.status).toBe(200);
      expect(down.body.recordings.state).toBe("store_unavailable");
    });
    expect(lines.join("\n")).toContain(`store_unavailable stamp=${d.stampId}`);
  });

  test("with an edge cache, the table is read once per key: every later page reads no store", async () => {
    const cache = new InMemoryCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
    const d = await derivative({}, table(250));
    await quality(d.stampId);
    expect(reads.get).toBe(1);
    const { paths } = await allPages(d.stampId);
    expect(paths).toHaveLength(250);
    expect(reads.get).toBe(1);
    // The entry is the key's: a second derivative is read once of its own.
    const other = await derivative({}, table(3));
    expect((await quality(other.stampId)).body.recordings.succeeded).toBe(3);
    expect(reads.get).toBe(2);
    expect(await cache.match(runQualityCacheKey("http://api.test", d.key))).toBeDefined();
    expect(await cache.match(runQualityCacheKey("http://api.test", other.key))).toBeDefined();
  });

  test("the cache is consulted only after D1 says the files stand: an expired derivative is not listed from it", async () => {
    const cache = new InMemoryCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
    const d = await derivative({}, table(3));
    expect((await quality(d.stampId)).body.recordings.succeeded).toBe(3);
    db.run("UPDATE compute_derivatives SET expires_at = '2026-01-01 00:00:00' WHERE key = ?", [
      d.key,
    ]);
    const r = await quality(d.stampId);
    expect(r.body.quality).toBe("expired");
    expect(r.body.recordings).toMatchObject({ state: "not_stored", items: [] });
  });

  test("a refused table is not cached: once it is fixed, the next page reads it", async () => {
    const cache = new InMemoryCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
    const d = await derivative({}, "path\tstatus\n");
    expect((await quality(d.stampId)).body.recordings.state).toBe("table_unreadable");
    await bucket.put(`d/${d.key}/${TABLE_PATH}`, table(2));
    expect((await quality(d.stampId)).body.recordings).toMatchObject({
      state: "listed",
      succeeded: 2,
    });
  });
});
