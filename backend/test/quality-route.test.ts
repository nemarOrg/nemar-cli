/**
 * The public quality view route (`routes/quality.ts`, ADR 0137 decisions 6 and 7, epic #2324 phase B2),
 * through the real `dataRoutes` router over a real bun:sqlite D1 carrying every production migration and
 * Miniflare's R2 as the derivatives bucket. The product is nemar-ica's real one (copied from nemar-process
 * P7, `test/fixtures/quality/ica-views`), stored under the derivative's key as the derivative store stores
 * it; the dataset, stamp and derivative rows are written with SQL the tables accept (nemar-ica is a
 * placeholder no path dispatches).
 *
 * The access matrix, each case by the mutation it kills (the mutation table of the PR names them):
 *  - every term of the dataset gate (active, public, not concealed, first published, not withdrawn, not
 *    tombstoned) refuses a dataset that otherwise serves, with the answer an unknown dataset gets;
 *  - only the current public derivative serves: canary, copying, failed, expired and superseded `catalog`
 *    rows never do, a superseded `published` row does, the newest by `stored_at` wins, the larger key a tie;
 *    a public key that expired answers `views_expired`; one dataset's key never serves under another's id;
 *  - the record is checked whole (schema, unsafe integers, plugin sources, scope, its own identity);
 *  - only a file a validated view declares is served, after its size and digest are checked again;
 *  - a path that is not a recording's (traversal included) is refused before anything is read;
 *  - the gate runs before the edge cache, the cache key carries the dataset's epoch, and no refusal is cached.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import {
  QUALITY_RECORD_FORMAT,
  qualityFilePath,
  qualityRecordPath,
} from "../../shared/contract/quality-route";
import { viewDigest } from "../../shared/contract/view-digest";
import {
  compileNeuroschemaValidator,
  formatAjvErrors,
} from "../../test/contract/neuroschema-validator";
import { dataRoutes } from "../src/routes/data";
import { viewFiles } from "../src/services/quality-views";
import type { Bindings, Variables } from "../src/types/bindings";
import { InMemoryCache } from "./helpers/cache";
import { freshDb, realD1 } from "./helpers/d1";
import { logged } from "./helpers/logs";
import { newJobId, productFiles, seedDerivative, seedIcaStamp } from "./helpers/quality-fixture";

// biome-ignore lint/suspicious/noExplicitAny: documents are read field by field
type Loose = Record<string, any>;

const DATASET = "on007823";
const RECORDING = "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_eeg.edf";
const RECORD_PATH = "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_desc-nemarica_signalJourney.json";
const PRODUCT = productFiles();
const RECORD_TEXT = new TextDecoder().decode(PRODUCT.get(RECORD_PATH));
const RECORD: Loose = JSON.parse(RECORD_TEXT);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Every file the record's views declare, by digest, with its location. */
const DECLARED = new Map<string, string>();
for (const view of RECORD.extensions.nemar.views) {
  for (const f of viewFiles(view)) DECLARED.set(f.sha256, f.location);
}
const SPECTRUM = [...DECLARED].find(([, l]) => l.endsWith("_spectrum.tsv")) as [string, string];
const ICCLASSES = [...DECLARED].find(([, l]) => l.endsWith("_icclasses.json")) as [string, string];

const validateDataQuality = compileNeuroschemaValidator("nsc:/extensions/dataQuality.schema.json");

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let host: Miniflare;
let bucket: R2Bucket;

const env = (over: Partial<Bindings> = {}): Bindings =>
  ({
    DB: realD1(db),
    ENVIRONMENT: "test",
    COMPUTE_DERIVATIVES: bucket,
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

function seedDataset(id: string): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, anonymous, modalities,
                           first_published_at)
     VALUES (?, ?, -1, 'active', 'public', 0, 0, 'eeg', '2026-01-01 00:00:00')`,
    [id, id],
  );
}

/** A stored derivative of the dataset's nemar-ica run, with the real product under its key. Returns the key. */
async function derivative(
  over: {
    datasetId?: string;
    retention?: "canary" | "catalog" | "published";
    state?: "copying" | "stored" | "failed" | "expired";
    storedAt?: string;
    key?: string;
    supersededAt?: string | null;
    expiresAt?: string | null;
    recipeVersion?: string;
    qualityPlugins?: string | null;
    /** Store the product under the key (default true). */
    files?: boolean;
  } = {},
): Promise<string> {
  const d1 = realD1(db);
  const datasetId = over.datasetId ?? DATASET;
  const jobId = newJobId();
  const runs = (
    db
      .query("SELECT COUNT(*) AS n FROM compute_pipeline_stamps WHERE dataset_id = ?")
      .get(datasetId) as { n: number }
  ).n;
  const stampId = await seedIcaStamp(d1, { datasetId, jobId, version: `v1.0.${runs}` });
  const key = await seedDerivative(d1, {
    retention: "catalog",
    ...over,
    datasetId,
    stampId,
    jobId,
  });
  if (over.files !== false) {
    for (const [path, bytes] of PRODUCT) await bucket.put(`d/${key}/${path}`, bytes);
  }
  return key;
}

const get = (path: string, over: Partial<Bindings> = {}) => app.request(path, {}, env(over));
const recordUrl = (id = DATASET, recording = RECORDING) =>
  qualityRecordPath(id, "nemar-ica", recording);
const fileUrl = (key: string, sha: string, id = DATASET, recording = RECORDING) =>
  qualityFilePath(id, "nemar-ica", key, sha, recording);

async function word(res: Response): Promise<string> {
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return ((await res.json()) as { error: string }).error;
}

/** Replace the stored record of a derivative with text of the caller's. */
const putRecord = (key: string, text: string) => bucket.put(`d/${key}/${RECORD_PATH}`, text);

beforeEach(async () => {
  db = freshDb();
  app = new Hono();
  app.route("/", dataRoutes);
  await emptyBucket();
  seedDataset(DATASET);
  (globalThis as { caches?: unknown }).caches = undefined;
});

describe("a recording's views and files, from the current public derivative", () => {
  test("the record endpoint: the checked dataQuality document, the derivative, each view's digest, public headers", async () => {
    const key = await derivative();
    const res = await get(recordUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("Cache-Tag")).toBe(`nemar-dq-${DATASET}`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = await res.text();
    // A strong ETag: the SHA-256 of the body's own bytes (MUTATION: the record's digest).
    expect(res.headers.get("ETag")).toBe(`"${sha256(text)}"`);
    const body = JSON.parse(text) as Loose;
    expect(body.format).toBe(QUALITY_RECORD_FORMAT);
    expect(body.dataset_id).toBe(DATASET);
    expect(body.recording).toBe(RECORDING);
    expect(body.derivative).toMatchObject({ key, version: "v1.0.0", retention: "catalog" });
    if (!validateDataQuality(body.dataQuality))
      throw new Error(formatAjvErrors(validateDataQuality));
    const entry = body.dataQuality.recipes["nemar-ica"];
    expect(entry.views).toEqual(RECORD.extensions.nemar.views);
    expect(Object.keys(entry.metrics)).toContain("nemar-quality:percentBrainComponents");
    for (const view of entry.views) {
      expect(body.view_digests[view.key]).toBe(await viewDigest(view));
    }
  });

  test("every declared file is served byte for byte, with its media type, nosniff and its digest as ETag", async () => {
    const key = await derivative();
    expect(DECLARED.size).toBeGreaterThanOrEqual(8);
    for (const [sha, location] of DECLARED) {
      const res = await get(fileUrl(key, sha));
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(sha256(bytes)).toBe(sha);
      expect(bytes).toEqual(PRODUCT.get(location) as Uint8Array);
      expect(res.headers.get("ETag")).toBe(`"${sha}"`);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(res.headers.get("Cache-Tag")).toBe(`nemar-dq-${DATASET}`);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      const name = location.slice(location.lastIndexOf("/") + 1);
      expect(res.headers.get("Content-Disposition")).toBe(`inline; filename*=UTF-8''${name}`);
      expect(res.headers.get("Content-Type")).toBe(
        location.endsWith(".tsv") ? "text/tab-separated-values; charset=utf-8" : "application/json",
      );
    }
  });

  test("`quality` is never read as a version, and an unknown recipe or route version answers quality_not_found", async () => {
    await derivative();
    for (const path of [
      `/${DATASET}/quality`,
      `/${DATASET}/quality/`,
      `/${DATASET}/quality/v2/nemar-ica/record/${RECORDING}`,
      `/${DATASET}/quality/v1/nemar-floorx/record/${RECORDING}`,
      `/${DATASET}/quality/v1/nemar-ica/other/${RECORDING}`,
    ]) {
      const res = await get(path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(await word(res)).toBe("quality_not_found");
    }
  });

  test("an unbound derivatives store serves nothing", async () => {
    await derivative();
    const res = await get(recordUrl(), { COMPUTE_DERIVATIVES: undefined });
    expect(res.status).toBe(404);
    expect(await word(res)).toBe("quality_not_found");
  });
});

describe("the dataset gate (MUTATION: drop each term)", () => {
  const unknown = async () => {
    const res = await get(recordUrl("nm000777"));
    return { status: res.status, body: await res.text() };
  };

  const cases: Array<[string, string]> = [
    ["private", "UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?"],
    ["archived", "UPDATE datasets SET status = 'archived' WHERE dataset_id = ?"],
    ["deleted", "UPDATE datasets SET status = 'deleted' WHERE dataset_id = ?"],
    ["withdrawn", "UPDATE datasets SET withdrawn_at = '2026-11-01 00:00:00' WHERE dataset_id = ?"],
    ["tombstoned", "UPDATE datasets SET ezid_status = 'unavailable' WHERE dataset_id = ?"],
    ["never published", "UPDATE datasets SET first_published_at = NULL WHERE dataset_id = ?"],
    [
      "an anonymous deposit (the shape of nm099998: concealed, never published)",
      "UPDATE datasets SET first_published_at = NULL, anonymous = 1 WHERE dataset_id = ?",
    ],
  ];

  for (const [name, statement] of cases) {
    test(`${name}: both endpoints answer exactly as an unknown dataset`, async () => {
      const key = await derivative();
      expect((await get(recordUrl())).status).toBe(200);
      db.run(statement, [DATASET]);
      const record = await get(recordUrl());
      expect({ status: record.status, body: await record.text() }).toEqual(await unknown());
      const file = await get(fileUrl(key, SPECTRUM[0]));
      expect(file.status).toBe(404);
      expect(await word(file)).toBe("quality_not_found");
    });
  }

  test("concealment alone refuses, even where the database's own invariant were broken (anonymous and first published)", async () => {
    // A published dataset cannot become anonymous (migration 0085's trigger), so the gate's first-publication
    // term also refuses every anonymous deposit. The trigger is dropped here to show the anonymity term
    // refuses on its own: neither guard leans on the other (ADR 0065).
    await derivative();
    db.run("DROP TRIGGER datasets_anonymous_unpublished_au");
    db.run("UPDATE datasets SET anonymous = 1 WHERE dataset_id = ?", [DATASET]);
    const res = await get(recordUrl());
    expect(res.status).toBe(404);
    expect(await word(res)).toBe("quality_not_found");
  });

  test("one dataset's key never serves under another dataset's id (MUTATION: trust the URL's dataset)", async () => {
    const key = await derivative();
    seedDataset("nm000901");
    const res = await get(fileUrl(key, SPECTRUM[0], "nm000901"));
    expect(res.status).toBe(404);
    expect(await word(res)).toBe("quality_not_found");
    const record = await get(recordUrl("nm000901"));
    expect(record.status).toBe(404);
  });

  test("a derivative of another dataset holding this dataset's record bytes is refused as record_elsewhere", async () => {
    seedDataset("nm000901");
    await derivative({ datasetId: "nm000901" });
    const res = await get(recordUrl("nm000901"));
    expect(res.status).toBe(502);
    expect(await word(res)).toBe("record_unreadable");
  });
});

describe("which derivative serves", () => {
  test("a canary, a copying and a failed row never serve; a public key that is not current answers quality_not_found", async () => {
    const canary = await derivative({ retention: "canary" });
    const copying = await derivative({ state: "copying" });
    const failed = await derivative({ state: "failed" });
    expect(await word(await get(recordUrl()))).toBe("quality_not_found");
    for (const key of [canary, copying, failed]) {
      const res = await get(fileUrl(key, SPECTRUM[0]));
      expect(res.status).toBe(404);
      expect(await word(res)).toBe("quality_not_found");
    }
  });

  test("an expired public derivative: the record is not found, and its files answer views_expired (410)", async () => {
    const dated = await derivative({ expiresAt: "2026-01-01 00:00:00" });
    const marked = await derivative({ state: "expired", retention: "published" });
    expect(await word(await get(recordUrl()))).toBe("quality_not_found");
    for (const key of [dated, marked]) {
      const res = await get(fileUrl(key, SPECTRUM[0]));
      expect(res.status).toBe(410);
      expect(await word(res)).toBe("views_expired");
    }
  });

  test("an expired canary answers quality_not_found, never views_expired", async () => {
    const key = await derivative({ retention: "canary", expiresAt: "2026-01-01 00:00:00" });
    const res = await get(fileUrl(key, SPECTRUM[0]));
    expect(res.status).toBe(404);
    expect(await word(res)).toBe("quality_not_found");
  });

  test("a superseded catalog row never serves; a superseded published row does", async () => {
    const catalog = await derivative({ supersededAt: "2026-11-21 00:00:00" });
    expect(await word(await get(recordUrl()))).toBe("quality_not_found");
    expect((await get(fileUrl(catalog, SPECTRUM[0]))).status).toBe(404);
    const published = await derivative({
      retention: "published",
      supersededAt: "2026-11-21 00:00:00",
      storedAt: "2026-11-19 10:00:00",
    });
    const res = await get(recordUrl());
    expect(res.status).toBe(200);
    expect(((await res.json()) as Loose).derivative.key).toBe(published);
  });

  test("the newest by stored_at serves, the larger key on a tie, and an older key's files are not found", async () => {
    const older = await derivative({ storedAt: "2026-11-19 10:00:00", key: "f".repeat(64) });
    const newer = await derivative({ storedAt: "2026-11-20 10:00:00", key: "1".repeat(64) });
    let res = await get(recordUrl());
    expect(((await res.json()) as Loose).derivative.key).toBe(newer);
    expect(await word(await get(fileUrl(older, SPECTRUM[0])))).toBe("quality_not_found");
    const tie = await derivative({ storedAt: "2026-11-20 10:00:00", key: "2".repeat(64) });
    res = await get(recordUrl());
    expect(((await res.json()) as Loose).derivative.key).toBe(tie);
  });

  for (const retention of ["catalog", "published"] as const) {
    test(`a ${retention} derivative of a recipe version the registry has moved past is served, checked against the plugins its row recorded (MUTATION: check against the registry's current version)`, async () => {
      const key = await derivative({ retention, recipeVersion: "0.9.0" });
      // The run of that version wrote its version into its record.
      const record = JSON.parse(RECORD_TEXT);
      record.extensions.nemar.recipe.version = "0.9.0";
      await putRecord(key, JSON.stringify(record));
      const res = await get(recordUrl());
      expect(res.status).toBe(200);
      const body = (await res.json()) as Loose;
      expect(body.derivative).toMatchObject({ key, recipe_version: "0.9.0", retention });
      expect((await get(fileUrl(key, SPECTRUM[0]))).status).toBe(200);
    });
  }

  test("the recorded plugin list decides: a plugin view of a plugin the row does not list is refused (MUTATION: ignore the stored list)", async () => {
    const key = await derivative({ qualityPlugins: JSON.stringify(["nemar-quality"]) });
    const res = await get(recordUrl());
    expect(res.status).toBe(502);
    expect(await word(res)).toBe("record_unreadable");
    expect((await get(fileUrl(key, SPECTRUM[0]))).status).toBe(502);
  });

  test("a row with no recorded plugins (made before migration 0153) serves nothing (MUTATION: fall back to the registry)", async () => {
    const key = await derivative({ qualityPlugins: null });
    let res: Response | undefined;
    const lines = await logged(async () => {
      res = await get(recordUrl());
    });
    expect(res?.status).toBe(404);
    expect(await word(res as Response)).toBe("quality_not_found");
    expect(lines).toEqual([
      `[quality] quality_plugins_unknown dataset=${DATASET} key=${key.slice(0, 12)}`,
    ]);
  });

  test("a recording the run did not record answers quality_not_found", async () => {
    await derivative();
    const res = await get(recordUrl(DATASET, "sub-CUCOV999/eeg/sub-CUCOV999_task-COVID_eeg.edf"));
    expect(res.status).toBe(404);
    expect(await word(res)).toBe("quality_not_found");
  });
});

describe("the record is checked whole before anything of it is served", () => {
  const refused = async (key: string) => {
    for (const url of [recordUrl(), fileUrl(key, SPECTRUM[0])]) {
      const res = await get(url);
      expect([url, res.status]).toEqual([url, 502]);
      expect(await word(res)).toBe("record_unreadable");
    }
  };
  const edited = (edit: (r: Loose) => void): string => {
    const copy = JSON.parse(RECORD_TEXT);
    edit(copy);
    return JSON.stringify(copy);
  };

  test("a view the heads check passes but the full schema refuses (an empty caption) (MUTATION: skip the full check)", async () => {
    const key = await derivative();
    await putRecord(
      key,
      edited((r) => {
        r.extensions.nemar.views[4].caption = "";
      }),
    );
    await refused(key);
  });

  test("a spectrum whose parameters break its kind schema", async () => {
    const key = await derivative();
    await putRecord(
      key,
      edited((r) => {
        r.extensions.nemar.views[4].parameters.overlap = 1;
      }),
    );
    await refused(key);
  });

  test("an integer literal beyond 2^53 - 1 anywhere in the record (MUTATION: ignore the reader's flag)", async () => {
    const key = await derivative();
    expect(RECORD_TEXT).toContain('"clean_channels.ransac": 5489');
    await putRecord(
      key,
      RECORD_TEXT.replace(
        '"clean_channels.ransac": 5489',
        '"clean_channels.ransac": 9007199254740993',
      ),
    );
    await refused(key);
  });

  test("a plugin view whose plugin the recipe version does not run at quality (MUTATION: drop the plugin source check)", async () => {
    const key = await derivative();
    await putRecord(
      key,
      edited((r) => {
        r.extensions.nemar.views[4].source.plugin.name = "nemar-other";
      }),
    );
    await refused(key);
  });

  test("a view of a reserved scope, valid by the schema (MUTATION: drop the scope rule)", async () => {
    const key = await derivative();
    await putRecord(
      key,
      edited((r) => {
        r.extensions.nemar.views[3].scope = "subject";
        r.extensions.nemar.views[3].sources = [{ record_sha256: "a".repeat(64) }];
      }),
    );
    await refused(key);
  });

  test("a record that says it is another recording's (MUTATION: drop the identity check)", async () => {
    const key = await derivative();
    await putRecord(
      key,
      edited((r) => {
        r.extensions.nemar.recording.path = "sub-CUCOV077/eeg/sub-CUCOV077_task-COVID_eeg.edf";
      }),
    );
    await refused(key);
  });

  test("a record over 512 KiB is refused unread", async () => {
    const key = await derivative();
    await putRecord(
      key,
      edited((r) => {
        r.extensions.nemar.padding = "x".repeat(600 * 1024);
      }),
    );
    await refused(key);
  });

  test("one digest declared as two files of one format and different sizes (MUTATION: drop the one-digest-one-size rule)", async () => {
    const key = await derivative();
    await putRecord(
      key,
      edited((r) => {
        const spectrum = r.extensions.nemar.views[4];
        expect(spectrum.data[0].format).toBe(spectrum.data[1].format);
        spectrum.data[1].sha256 = spectrum.data[0].sha256;
        spectrum.data[1].size = spectrum.data[0].size + 1;
      }),
    );
    await refused(key);
  });

  test("one digest declared as files of two formats", async () => {
    const key = await derivative();
    await putRecord(
      key,
      edited((r) => {
        r.extensions.nemar.views[3].data[0].size = r.extensions.nemar.views[4].data[0].size;
        r.extensions.nemar.views[3].data[0].sha256 = r.extensions.nemar.views[4].data[0].sha256;
      }),
    );
    await refused(key);
  });
});

describe("only declared files, read again and hashed", () => {
  test("a digest no view declares answers view_not_declared, even the digest of a product file or of the record (MUTATION: serve any product file)", async () => {
    const key = await derivative();
    const undeclared = [
      "0".repeat(64),
      sha256(PRODUCT.get(RECORD_PATH) as Uint8Array),
      sha256(
        PRODUCT.get(
          "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_desc-nemarica_ica.json",
        ) as Uint8Array,
      ),
    ];
    for (const sha of undeclared) {
      expect(DECLARED.has(sha)).toBe(false);
      const res = await get(fileUrl(key, sha));
      expect(res.status).toBe(404);
      expect(await word(res)).toBe("view_not_declared");
    }
  });

  test("a stored file whose bytes differ, at the declared size, is view_data_corrupt (MUTATION: drop the re-hash)", async () => {
    const key = await derivative();
    const good = PRODUCT.get(SPECTRUM[1]) as Uint8Array;
    const bad = new Uint8Array(good);
    bad[10] = bad[10] === 0x31 ? 0x32 : 0x31;
    await bucket.put(`d/${key}/${SPECTRUM[1]}`, bad);
    const res = await get(fileUrl(key, SPECTRUM[0]));
    expect(res.status).toBe(502);
    expect(await word(res)).toBe("view_data_corrupt");
  });

  test("a stored file of another size is view_data_corrupt, refused for its size before it is hashed (MUTATION: drop the size check)", async () => {
    const key = await derivative();
    const good = PRODUCT.get(ICCLASSES[1]) as Uint8Array;
    await bucket.put(`d/${key}/${ICCLASSES[1]}`, new Uint8Array([...good, 0x0a]));
    let res: Response | undefined;
    const lines = await logged(async () => {
      res = await get(fileUrl(key, ICCLASSES[0]));
    });
    expect(res?.status).toBe(502);
    expect(await word(res as Response)).toBe("view_data_corrupt");
    expect(lines).toEqual([
      `[quality] view_data_corrupt dataset=${DATASET} key=${key.slice(0, 12)} reason=size`,
    ]);
  });

  test("a declared file missing from the store is view_data_missing (404), never a server error", async () => {
    const key = await derivative();
    await bucket.delete(`d/${key}/${SPECTRUM[1]}`);
    const res = await get(fileUrl(key, SPECTRUM[0]));
    expect(res.status).toBe(404);
    expect(await word(res)).toBe("view_data_missing");
  });
});

describe("paths that are not a recording's are refused before anything is read", () => {
  const bad = [
    [
      "a traversal in one encoded segment",
      "sub-CUCOV076%2F..%2F..%2Fsub-CUCOV076_task-COVID_eeg.edf",
    ],
    ["an encoded absolute path", "%2Fetc%2Fsub-01_task-x_eeg.edf"],
    ["a backslash", "sub-CUCOV076%5Ceeg%5Csub-CUCOV076_task-COVID_eeg.edf"],
    [
      "a product file, not a recording",
      "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_desc-nemarica_channels.tsv",
    ],
    ["an empty segment", "sub-CUCOV076//eeg/sub-CUCOV076_task-COVID_eeg.edf"],
    ["a broken escape", "sub-CUCOV076/eeg/%E0%A4%A_eeg.edf"],
    ["a scheme", "https%3A%2F%2Fx_eeg.edf"],
  ] as const;

  for (const [name, raw] of bad) {
    test(`${name}: recording_path_invalid on both endpoints`, async () => {
      const key = await derivative();
      for (const url of [
        `/${DATASET}/quality/v1/nemar-ica/record/${raw}`,
        `/${DATASET}/quality/v1/nemar-ica/file/${key}/${SPECTRUM[0]}/${raw}`,
      ]) {
        const res = await get(url);
        expect([url, res.status]).toEqual([url, 400]);
        expect(await word(res)).toBe("recording_path_invalid");
      }
    });
  }

  test("a key or digest that is not 64 lowercase hexadecimal digits", async () => {
    const key = await derivative();
    for (const url of [
      `/${DATASET}/quality/v1/nemar-ica/file/${"A".repeat(64)}/${SPECTRUM[0]}/${RECORDING}`,
      `/${DATASET}/quality/v1/nemar-ica/file/${key}/${SPECTRUM[0].slice(1)}/${RECORDING}`,
      `/${DATASET}/quality/v1/nemar-ica/file/${key}/${RECORDING}`,
    ]) {
      const res = await get(url);
      expect([url, res.status]).toEqual([url, 400]);
      expect(await word(res)).toBe("recording_path_invalid");
    }
  });
});

describe("the edge cache", () => {
  let cache: InMemoryCache;
  beforeEach(() => {
    cache = new InMemoryCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
  });
  afterAll(() => {
    (globalThis as { caches?: unknown }).caches = undefined;
  });

  test("an unpublish refuses at the next request although the answer is cached (MUTATION: read the cache before the gate)", async () => {
    const key = await derivative();
    expect((await get(recordUrl())).status).toBe(200);
    expect((await get(fileUrl(key, SPECTRUM[0]))).status).toBe(200);
    db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?", [DATASET]);
    expect(await word(await get(recordUrl()))).toBe("quality_not_found");
    expect(await word(await get(fileUrl(key, SPECTRUM[0])))).toBe("quality_not_found");
  });

  test("an answer is cached, and a change of the dataset's gate columns moves it to a new epoch (MUTATION: leave the epoch out of the key)", async () => {
    const key = await derivative();
    expect((await get(fileUrl(key, SPECTRUM[0]))).status).toBe(200);
    // The store's copy goes bad: the cached answer still serves the bytes that were checked.
    const good = PRODUCT.get(SPECTRUM[1]) as Uint8Array;
    const bad = new Uint8Array(good);
    bad[10] = bad[10] === 0x31 ? 0x32 : 0x31;
    await bucket.put(`d/${key}/${SPECTRUM[1]}`, bad);
    const hit = await get(fileUrl(key, SPECTRUM[0]));
    expect(hit.status).toBe(200);
    expect(sha256(new Uint8Array(await hit.arrayBuffer()))).toBe(SPECTRUM[0]);
    // Unpublished and published again: the epoch advanced twice, so the old entry is never read again.
    db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?", [DATASET]);
    db.run("UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?", [DATASET]);
    const res = await get(fileUrl(key, SPECTRUM[0]));
    expect(res.status).toBe(502);
    expect(await word(res)).toBe("view_data_corrupt");
  });

  test("no refusal is cached: a corrupt answer is followed by the good one once the store is right", async () => {
    const key = await derivative();
    const good = PRODUCT.get(SPECTRUM[1]) as Uint8Array;
    const bad = new Uint8Array(good);
    bad[10] = bad[10] === 0x31 ? 0x32 : 0x31;
    await bucket.put(`d/${key}/${SPECTRUM[1]}`, bad);
    expect((await get(fileUrl(key, SPECTRUM[0]))).status).toBe(502);
    await bucket.put(`d/${key}/${SPECTRUM[1]}`, good);
    expect((await get(fileUrl(key, SPECTRUM[0]))).status).toBe(200);
  });

  test("a newer promoted derivative is served at once: the derivative key is part of the cache key", async () => {
    await derivative({ storedAt: "2026-11-19 10:00:00" });
    expect((await get(recordUrl())).status).toBe(200);
    const newer = await derivative({ storedAt: "2026-11-20 10:00:00" });
    const res = await get(recordUrl());
    expect(((await res.json()) as Loose).derivative.key).toBe(newer);
  });
});

describe("migration 0152: the dataset's quality cache epoch", () => {
  const epoch = () =>
    (
      db.query("SELECT epoch FROM dataset_quality_epochs WHERE dataset_id = ?").get(DATASET) as {
        epoch: number;
      } | null
    )?.epoch ?? 0;

  test("starts at 0, advances on every change of a gate column, and not on a write of the same value", () => {
    expect(epoch()).toBe(0);
    const steps: Array<[string, number]> = [
      ["UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?", 0],
      ["UPDATE datasets SET name = 'renamed' WHERE dataset_id = ?", 0],
      ["UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?", 1],
      ["UPDATE datasets SET status = 'archived' WHERE dataset_id = ?", 2],
      ["UPDATE datasets SET withdrawn_at = '2026-11-01 00:00:00' WHERE dataset_id = ?", 3],
      ["UPDATE datasets SET ezid_status = 'unavailable' WHERE dataset_id = ?", 4],
      ["UPDATE datasets SET first_published_at = NULL WHERE dataset_id = ?", 5],
      ["UPDATE datasets SET anonymous = 1 WHERE dataset_id = ?", 6],
    ];
    for (const [statement, expected] of steps) {
      db.run(statement, [DATASET]);
      expect([statement, epoch()]).toEqual([statement, expected]);
    }
  });

  test("the table refuses nothing the trigger writes: a dataset id of any shape still advances (review of #2383)", () => {
    db.run("PRAGMA ignore_check_constraints = 1");
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, anonymous)
       VALUES ('legacy-id-1', 'legacy', -1, 'active', 'public', 0, 0)`,
    );
    db.run("PRAGMA ignore_check_constraints = 0");
    db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'legacy-id-1'");
    expect(
      db.query("SELECT epoch FROM dataset_quality_epochs WHERE dataset_id = 'legacy-id-1'").get(),
    ).toEqual({ epoch: 1 });
  });
});
