/**
 * A run's quality record and files as an administrator reads them (`routes/admin/quality-views.ts`, epic
 * #2324 phase B3b, ADR 0137 decision 7), through the REAL admin router with its authentication, admin and
 * cookie-origin middleware, over a real bun:sqlite D1 carrying every production migration, real API keys
 * (hashed as production hashes them) and Miniflare's R2 as the derivatives bucket. The product is nemar-ica's
 * real one (`test/fixtures/quality/ica-views`), stored under the derivative's key as the derivative store
 * stores it; the dataset, stamp and derivative rows are written with SQL the tables accept.
 *
 * What is pinned, each case by the mutation it kills (the PR's mutation table names them):
 *  - who may: no key, a member's key, a revoked admin key and a demoted admin are refused at their next
 *    request; an admin and an owner are not;
 *  - only a stored, in-date derivative is read, of any retention (a canary included, a superseded row
 *    included); every other case is its word, with no store read;
 *  - the derivative is the stamp's own and of the stamp's dataset; the record is checked against its own
 *    dataset and recording, and against the row's plugins;
 *  - the path grammar: forged digests, traversal, encoded separators, a query string and HEAD are refused
 *    before anything is read;
 *  - B2's file checks: declared files only, the size and the digest checked again;
 *  - nothing public: no edge-cache read or write, `no-store` on every answer, no `Cache-Tag` or `ETag`, and
 *    a concealed deposit's views are served to an administrator only.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import {
  QUALITY_ADMIN_ROUTE_WORDS,
  QUALITY_RECORD_FORMAT,
  qualityAdminFilePath,
  qualityAdminRecordPath,
  qualityRecordPath,
} from "../../shared/contract/quality-route";
import { runViewRefusal } from "../src/routes/admin/quality-views";
import { dataRoutes } from "../src/routes/data";
import { viewFiles } from "../src/services/quality-views";
import type { Bindings, Variables } from "../src/types/bindings";
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
const OTHER = "on007824";
const RECORDING = "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_eeg.edf";
const RECORD_PATH = "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_desc-nemarica_signalJourney.json";
const PRODUCT = productFiles();
const RECORD: Loose = JSON.parse(new TextDecoder().decode(PRODUCT.get(RECORD_PATH)));
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Every file the record's views declare, by digest, with its location. */
const DECLARED = new Map<string, string>();
for (const view of RECORD.extensions.nemar.views) {
  for (const f of viewFiles(view)) DECLARED.set(f.sha256, f.location);
}
const SPECTRUM = [...DECLARED].find(([, l]) => l.endsWith("_spectrum.tsv")) as [string, string];
/** A file of the product no view declares. */
const UNDECLARED = [...PRODUCT].find(
  ([path, bytes]) => path.endsWith("_weights.tsv") && !DECLARED.has(sha256(bytes)),
) as [string, Uint8Array];

let db: Database;
let host: Miniflare;
let bucket: R2Bucket;
/** Store reads a request made (the calls go to Miniflare's R2; this only counts them). */
let reads: number;
const handle = makeComputeApp();

function counted(inner: R2Bucket): R2Bucket {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "get" || prop === "head" || prop === "list") {
        return (...args: unknown[]) => {
          reads += 1;
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

function seedDataset(id: string, anonymous = 0): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, anonymous, modalities,
                           first_published_at)
     VALUES (?, ?, -1, 'active', ?, 0, ?, 'eeg', ?)`,
    // A concealed deposit is never published (ADR 0065): private, and with no first publication.
    [id, id, anonymous ? "private" : "public", anonymous, anonymous ? null : "2026-01-01 00:00:00"],
  );
}

let userIds: Record<ComputeWho, number>;

beforeEach(async () => {
  db = freshDb();
  userIds = await seedComputeUsers(db);
  seedDataset(DATASET);
  await emptyBucket();
  reads = 0;
  (globalThis as { caches?: unknown }).caches = undefined;
});

let runs = 0;

/** A derivative of a fresh stamp, with the real product under its key (unless `files` is false). */
async function derivative(
  over: {
    retention?: "canary" | "catalog" | "published";
    state?: "copying" | "stored" | "failed" | "expired";
    supersededAt?: string | null;
    expiresAt?: string | null;
    qualityPlugins?: string | null;
    /** The derivative row's dataset (the stamp's by default). */
    rowDataset?: string;
    stampDataset?: string;
    files?: boolean;
  } = {},
): Promise<{ stampId: number; key: string }> {
  const jobId = newJobId();
  const stampId = await seedIcaStamp(realD1(db), {
    datasetId: over.stampDataset ?? DATASET,
    jobId,
    version: `v1.0.${runs++}`,
  });
  const key = await seedDerivative(realD1(db), {
    retention: over.retention ?? "canary",
    state: over.state,
    supersededAt: over.supersededAt,
    expiresAt: over.expiresAt,
    qualityPlugins: over.qualityPlugins,
    datasetId: over.rowDataset ?? over.stampDataset ?? DATASET,
    stampId,
    jobId,
  });
  if (over.files !== false) {
    for (const [path, bytes] of PRODUCT) await bucket.put(`d/${key}/${path}`, bytes);
  }
  return { stampId, key };
}

interface Answer {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  body: Loose;
}

async function call(
  path: string,
  who: ComputeWho | null = "admin",
  init: { method?: string; over?: Partial<Bindings> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  const res = await handle(
    new Request(`http://api.test${path}`, { headers, method: init.method ?? "GET" }),
    env(init.over),
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  let body: Loose = {};
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, bytes, body };
}

/** The answer is the admin mount's word, with its status, `no-store`, and no store read. */
function expectWord(answer: Answer, word: keyof typeof QUALITY_ADMIN_ROUTE_WORDS): void {
  expect([answer.status, answer.body.error]).toEqual([QUALITY_ADMIN_ROUTE_WORDS[word], word]);
  expect(answer.headers.get("Cache-Control")).toBe("no-store");
  expect(answer.headers.get("Cache-Tag")).toBeNull();
}

/** Nothing of the answer can make it public: no-store, no tag, no validator, no address. */
function expectPrivate(answer: Answer): void {
  expect(answer.headers.get("Cache-Control")).toBe("no-store");
  expect(answer.headers.get("Cache-Tag")).toBeNull();
  expect(answer.headers.get("ETag")).toBeNull();
  expect(answer.headers.get("Location")).toBeNull();
  expect(answer.headers.get("Link")).toBeNull();
  expect(answer.headers.get("X-Content-Type-Options")).toBe("nosniff");
}

const record = (stampId: number, who: ComputeWho | null = "admin") =>
  call(qualityAdminRecordPath(stampId, RECORDING), who);
const file = (stampId: number, sha: string, who: ComputeWho | null = "admin") =>
  call(qualityAdminFilePath(stampId, sha, RECORDING), who);

describe("who may read a run's views", () => {
  test("no key is 401 and a member's key 403, with no store read; an admin and an owner read it", async () => {
    const { stampId } = await derivative();
    expect((await record(stampId, null)).status).toBe(401);
    const member = await record(stampId, "member");
    expect(member.status).toBe(403);
    expect(new TextDecoder().decode(member.bytes)).not.toContain(RECORDING);
    expect(reads).toBe(0);
    expect((await record(stampId, "admin")).status).toBe(200);
    expect((await record(stampId, "owner")).status).toBe(200);
    expect((await file(stampId, SPECTRUM[0], "member")).status).toBe(403);
  });

  test("an admin key revoked between two requests is refused at the next one", async () => {
    const { stampId } = await derivative();
    expect((await record(stampId)).status).toBe(200);
    db.run(`UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ?`, [userIds.admin]);
    reads = 0;
    const revoked = await record(stampId);
    expect(revoked.status).toBe(401);
    expect(reads).toBe(0);
    expect((await file(stampId, SPECTRUM[0])).status).toBe(401);
  });

  test("an admin demoted between two requests is refused at the next one", async () => {
    const { stampId } = await derivative();
    expect((await file(stampId, SPECTRUM[0])).status).toBe(200);
    db.run(`UPDATE users SET role = 'member' WHERE id = ?`, [userIds.admin]);
    reads = 0;
    const demoted = await file(stampId, SPECTRUM[0]);
    expect(demoted.status).toBe(403);
    expect(reads).toBe(0);
    expect((await record(stampId)).status).toBe(403);
  });
});

describe("only a stored, in-date derivative of the run is read", () => {
  test("a canary is served: the checked record and every declared file, byte for byte, private", async () => {
    const { stampId, key } = await derivative({ retention: "canary" });
    const answer = await record(stampId);
    expect(answer.status).toBe(200);
    expectPrivate(answer);
    expect(answer.headers.get("Content-Type")).toBe("application/json");
    expect(answer.body.format).toBe(QUALITY_RECORD_FORMAT);
    expect(answer.body.dataset_id).toBe(DATASET);
    expect(answer.body.recording).toBe(RECORDING);
    expect(answer.body.derivative).toMatchObject({ key, retention: "canary" });
    expect(answer.body.dataQuality.recipes["nemar-ica"].views).toEqual(
      RECORD.extensions.nemar.views,
    );
    expect(DECLARED.size).toBeGreaterThanOrEqual(8);
    for (const [sha, location] of DECLARED) {
      const served = await file(stampId, sha);
      expect([location, served.status]).toEqual([location, 200]);
      expectPrivate(served);
      expect(sha256(served.bytes)).toBe(sha);
      const name = location.slice(location.lastIndexOf("/") + 1);
      expect(served.headers.get("Content-Disposition")).toBe(`inline; filename*=UTF-8''${name}`);
    }
  });

  test("catalog, published and superseded rows are served too", async () => {
    for (const over of [
      { retention: "catalog" as const },
      { retention: "published" as const },
      { retention: "catalog" as const, supersededAt: "2026-11-21 00:00:00" },
    ]) {
      const { stampId, key } = await derivative(over);
      const answer = await record(stampId);
      expect([over, answer.status]).toEqual([over, 200]);
      expect(answer.body.derivative).toMatchObject({ key, retention: over.retention });
    }
  });

  test("every other case is its word, with no store read", async () => {
    const cases: [string, () => Promise<number>, keyof typeof QUALITY_ADMIN_ROUTE_WORDS][] = [
      ["no such stamp", async () => 987_654, "stamp_not_found"],
      [
        "a succeeded run with no derivative",
        () => seedIcaStamp(realD1(db), { datasetId: DATASET, jobId: newJobId(), version: "v9" }),
        "derivative_not_keyed",
      ],
      [
        "a run in progress",
        () =>
          seedIcaStamp(realD1(db), {
            datasetId: DATASET,
            jobId: newJobId(),
            state: "dispatched",
            version: "v8",
          }),
        "derivative_not_keyed",
      ],
      [
        "a failed run",
        () =>
          seedIcaStamp(realD1(db), {
            datasetId: DATASET,
            jobId: newJobId(),
            state: "failed",
            version: "v7",
          }),
        "derivative_not_keyed",
      ],
      [
        "copying",
        async () => (await derivative({ state: "copying" })).stampId,
        "derivative_copying",
      ],
      ["failed", async () => (await derivative({ state: "failed" })).stampId, "derivative_failed"],
      ["expired", async () => (await derivative({ state: "expired" })).stampId, "views_expired"],
      [
        "a canary past its date the sync has not marked",
        async () => (await derivative({ expiresAt: "2026-01-01 00:00:00" })).stampId,
        "views_expired",
      ],
      [
        "a catalog row past its date",
        async () =>
          (await derivative({ retention: "catalog", expiresAt: "2026-01-01 00:00:00" })).stampId,
        "views_expired",
      ],
    ];
    for (const [name, make, word] of cases) {
      const stampId = await make();
      reads = 0;
      const answer = await record(stampId);
      expectWord(answer, word);
      expect([name, reads]).toEqual([name, 0]);
      expectWord(await file(stampId, SPECTRUM[0]), word);
      expect([name, reads]).toEqual([name, 0]);
    }
    expectWord(
      await call(`/admin/compute/pipeline/runs/0/quality/record/${RECORDING}`),
      "stamp_not_found",
    );
    expectWord(
      await call(`/admin/compute/pipeline/runs/99999999999999999/quality/record/${RECORDING}`),
      "stamp_not_found",
    );
  });

  test("a state the table does not know yet is never read (the table's CHECK holds four today)", () => {
    const row = {
      stamp_id: 1,
      key: "a".repeat(64),
      dataset_id: DATASET,
      recipe: "nemar-ica",
      version: "v1.0.0",
      recipe_version: "1",
      input: "bids" as const,
      retention: "canary",
      stored_at: "2026-11-20 10:00:00",
      quality_plugins: "[]",
      past: 0,
    };
    expect(runViewRefusal({ ...row, state: "stored" })).toBeNull();
    expect(runViewRefusal({ ...row, state: "archived" })).toBe("derivative_not_keyed");
  });

  test("a derivative row of another dataset than its stamp's is never the run's", async () => {
    seedDataset(OTHER);
    const { stampId } = await derivative({ stampDataset: OTHER, rowDataset: DATASET });
    expectWord(await record(stampId), "derivative_not_keyed");
    expect(reads).toBe(0);
  });

  test("the record must be of the row's own dataset: one stored under another dataset's run is refused", async () => {
    seedDataset(OTHER);
    // The product is of on007823; this run and its row are of on007824.
    const { stampId } = await derivative({ stampDataset: OTHER });
    const lines = await logged(async () => {
      expectWord(await record(stampId), "record_unreadable");
      expectWord(await file(stampId, SPECTRUM[0]), "record_unreadable");
    });
    expect(lines.join("\n")).toContain("reason=record_elsewhere");
    expect(lines.join("\n")).not.toContain(RECORDING);
  });

  test("the row's plugins decide: none recorded serves nothing, one missing refuses the record", async () => {
    const none = await derivative({ qualityPlugins: null });
    expectWord(await record(none.stampId), "quality_not_found");
    const fewer = await derivative({ qualityPlugins: JSON.stringify(["nemar-quality"]) });
    expectWord(await record(fewer.stampId), "record_unreadable");
  });

  test("a recording with no record is quality_not_found; an unbound store is quality_unavailable", async () => {
    const { stampId } = await derivative({ files: false });
    expectWord(await record(stampId), "quality_not_found");
    const unbound = await call(qualityAdminRecordPath(stampId, RECORDING), "admin", {
      over: { COMPUTE_DERIVATIVES: undefined },
    });
    expectWord(unbound, "quality_unavailable");
  });
});

describe("the path grammar, before anything is read", () => {
  const base = (stampId: number) => `/admin/compute/pipeline/runs/${stampId}/quality`;

  test("forged digests, kinds and recordings are recording_path_invalid", async () => {
    const { stampId } = await derivative();
    const sha = SPECTRUM[0];
    for (const rest of [
      `file/${sha.toUpperCase()}/${RECORDING}`,
      `file/${sha.slice(1)}/${RECORDING}`,
      `file/${sha}0/${RECORDING}`,
      `file/${"g".repeat(64)}/${RECORDING}`,
      `file/${RECORDING}`,
      `file/${sha}`,
      "record",
      "record/",
      `other/${RECORDING}`,
      `views/${RECORDING}`,
      "record/sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_channels.tsv",
      "record/participants.tsv",
      `record/${RECORDING}/`,
      `record//${RECORDING}`,
      `record/sub-CUCOV076/eeg/${"a".repeat(1100)}_eeg.edf`,
    ]) {
      reads = 0;
      const answer = await call(`${base(stampId)}/${rest}`);
      expectWord(answer, "recording_path_invalid");
      expect([rest, reads]).toEqual([rest, 0]);
    }
  });

  test("traversal and encoded separators are refused, and a resolved `..` never reaches the file", async () => {
    const { stampId } = await derivative();
    const sha = SPECTRUM[0];
    for (const rest of [
      "record/sub-CUCOV076%2Feeg%2Fsub-CUCOV076_task-COVID_eeg.edf",
      "record/sub-CUCOV076%2feeg/sub-CUCOV076_task-COVID_eeg.edf",
      "record/sub-CUCOV076%5Ceeg/sub-CUCOV076_task-COVID_eeg.edf",
      "record/sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_eeg.edf%00",
      `file/${sha}/sub-CUCOV076%2Feeg%2Fsub-CUCOV076_task-COVID_eeg.edf`,
      "record/sub-CUCOV076/eeg/sub-CUCOV076_task-COVID%ZZ_eeg.edf",
    ]) {
      reads = 0;
      const answer = await call(`${base(stampId)}/${rest}`);
      expect([rest, answer.status]).toEqual([rest, 400]);
      expect(answer.headers.get("Cache-Control")).toBe("no-store");
      expect([rest, reads]).toEqual([rest, 0]);
    }
    // A `..`, plain or encoded, is resolved by the URL parser before routing: one that climbs out of the
    // mount is never this route's, and one that stays in names the path it resolves to, which the grammar
    // then checks (`qualityAdminRest` refuses the raw forms; the contract suite pins that).
    for (const rest of [
      `file/${sha}/../../../../users`,
      `file/${sha}/%2E%2E/%2e%2e/.%2E/%2E./users`,
    ]) {
      reads = 0;
      const resolved = await call(`${base(stampId)}/${rest}`);
      expect([rest, resolved.status === 200]).toEqual([rest, false]);
      expect([rest, reads]).toEqual([rest, 0]);
    }
  });

  test("a query string is refused, and only GET is answered", async () => {
    const { stampId } = await derivative();
    reads = 0;
    expectWord(
      await call(`${qualityAdminRecordPath(stampId, RECORDING)}?after=x`),
      "recording_path_invalid",
    );
    const head = await call(qualityAdminRecordPath(stampId, RECORDING), "admin", {
      method: "HEAD",
    });
    expect(head.status).toBe(405);
    expect(head.headers.get("Cache-Control")).toBe("no-store");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const answer = await call(qualityAdminRecordPath(stampId, RECORDING), "admin", { method });
      expect([method, answer.status === 200]).toEqual([method, false]);
    }
    expect(reads).toBe(0);
  });
});

describe("the file checks of the public route", () => {
  test("a file of the product no view declares is view_not_declared, and is never read", async () => {
    const { stampId } = await derivative();
    expect(UNDECLARED).toBeDefined();
    expectWord(await file(stampId, sha256(UNDECLARED[1])), "view_not_declared");
    expectWord(await file(stampId, "f".repeat(64)), "view_not_declared");
  });

  test("a declared file whose bytes changed is view_data_corrupt: same size, other size, missing", async () => {
    const { stampId, key } = await derivative();
    const [sha, location] = SPECTRUM;
    const original = PRODUCT.get(location) as Uint8Array;
    const flipped = new Uint8Array(original);
    flipped[0] = (flipped[0] as number) ^ 1;
    await bucket.put(`d/${key}/${location}`, flipped);
    const lines = await logged(async () => {
      expectWord(await file(stampId, sha), "view_data_corrupt");
    });
    expect(lines.join("\n")).toContain("[quality-admin] view_data_corrupt");
    expect(lines.join("\n")).toContain("reason=digest");
    // One byte longer: refused by its size, before it is hashed.
    await bucket.put(`d/${key}/${location}`, new Uint8Array([...original, 10]));
    const longer = await logged(async () => {
      expectWord(await file(stampId, sha), "view_data_corrupt");
    });
    expect(longer.join("\n")).toContain("reason=size");
    await bucket.delete(`d/${key}/${location}`);
    expectWord(await file(stampId, sha), "view_data_missing");
  });

  test("a record over the bound is never read whole and is record_unreadable", async () => {
    const { stampId, key } = await derivative();
    // Valid JSON one byte over the bound, so only the bound refuses it.
    const padded = JSON.stringify({ ...RECORD, pad: "" });
    const over = 512 * 1024 + 1 - new TextEncoder().encode(padded).byteLength;
    await bucket.put(
      `d/${key}/${RECORD_PATH}`,
      JSON.stringify({ ...RECORD, pad: "x".repeat(over) }),
    );
    const lines = await logged(async () => {
      expectWord(await record(stampId), "record_unreadable");
    });
    expect(lines.join("\n")).toContain("reason=record_too_large");
  });

  const edited = (edit: (r: Loose) => void): string => {
    const copy = structuredClone(RECORD);
    edit(copy);
    return JSON.stringify(copy);
  };

  test("the record is checked whole: the schema, plugin sources, scope and its own recording", async () => {
    const cases: [string, (r: Loose) => void, string][] = [
      ["schema", (r) => void (r.extensions.nemar.views[4].caption = ""), "declaration_invalid"],
      [
        "plugin source",
        (r) => void (r.extensions.nemar.views[4].source.plugin.name = "nemar-other"),
        "",
      ],
      [
        "scope",
        (r) => {
          r.extensions.nemar.views[3].scope = "subject";
          r.extensions.nemar.views[3].sources = [{ record_sha256: "a".repeat(64) }];
        },
        "view_scope_reserved",
      ],
      [
        "identity",
        (r) => {
          const text = JSON.stringify(r).replaceAll(
            "sub-CUCOV076_task-COVID",
            "sub-CUCOV077_task-COVID",
          );
          Object.assign(r, JSON.parse(text));
        },
        "record_elsewhere",
      ],
    ];
    for (const [name, edit, reason] of cases) {
      const { stampId, key } = await derivative();
      await bucket.put(`d/${key}/${RECORD_PATH}`, edited(edit));
      const lines = await logged(async () => {
        const answer = await record(stampId);
        expect([name, answer.body.error]).toEqual([name, "record_unreadable"]);
        expectWord(await file(stampId, SPECTRUM[0]), "record_unreadable");
      });
      if (reason !== "")
        expect([name, lines.join("\n")]).toEqual([
          name,
          expect.stringContaining(`reason=${reason}`),
        ]);
    }
  });
});

describe("nothing from this mount is public", () => {
  /** A real in-memory edge cache that counts every read and write made of it. */
  function countingCache(): { cache: InMemoryCache; calls: { match: number; put: number } } {
    const cache = new InMemoryCache();
    const calls = { match: 0, put: 0 };
    const match = cache.match.bind(cache);
    const put = cache.put.bind(cache);
    cache.match = (req) => {
      calls.match += 1;
      return match(req);
    };
    cache.put = (req, res) => {
      calls.put += 1;
      return put(req, res);
    };
    return { cache, calls };
  }

  test("the edge cache is never read or written, on answers and refusals alike", async () => {
    const { cache, calls } = countingCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
    const { stampId } = await derivative({ retention: "catalog" });
    expect((await record(stampId)).status).toBe(200);
    expect((await file(stampId, SPECTRUM[0])).status).toBe(200);
    expectWord(await file(stampId, "f".repeat(64)), "view_not_declared");
    expect(calls).toEqual({ match: 0, put: 0 });

    // The same derivative through the public route does use the cache: the counter sees it.
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/", dataRoutes);
    const pub = await app.request(qualityRecordPath(DATASET, "nemar-ica", RECORDING), {}, env());
    expect(pub.status).toBe(200);
    expect(calls.put).toBeGreaterThan(0);
  });

  test("a concealed deposit's views are an administrator's only: private headers, no public address", async () => {
    db.run("DELETE FROM datasets WHERE dataset_id = ?", [DATASET]);
    seedDataset(DATASET, 1);
    const { cache, calls } = countingCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
    const { stampId } = await derivative({ retention: "catalog" });

    const answer = await record(stampId);
    expect(answer.status).toBe(200);
    expectPrivate(answer);
    expect(Object.keys(answer.body).sort()).toEqual(
      [
        "dataQuality",
        "dataset_id",
        "derivative",
        "format",
        "recipe",
        "recording",
        "view_digests",
      ].sort(),
    );
    const text = new TextDecoder().decode(answer.bytes);
    expect(text).not.toContain("nemar-dq-");
    expect(text).not.toContain(`/${DATASET}/quality/`);
    const served = await file(stampId, SPECTRUM[0]);
    expect(served.status).toBe(200);
    expectPrivate(served);
    expect(calls).toEqual({ match: 0, put: 0 });

    // The public route refuses the same deposit, as it refuses any concealed dataset (ADR 0065).
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/", dataRoutes);
    const pub = await app.request(qualityRecordPath(DATASET, "nemar-ica", RECORDING), {}, env());
    expect(pub.status).toBe(404);
    expect(calls.put).toBe(0);

    // A member is refused it as any other run.
    expect((await record(stampId, "member")).status).toBe(403);
  });
});
