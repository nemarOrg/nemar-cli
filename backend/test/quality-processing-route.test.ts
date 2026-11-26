/**
 * The processing endpoint of the public quality route (`GET /<id>/quality/v1/<recipe>/processing/<recording>`,
 * ADR 0134 decision 9 as amended 2026-11-26, epic #2324 phase B4), through the real `dataRoutes` router over a
 * real bun:sqlite D1 carrying every production migration and Miniflare's R2 as the derivatives bucket. The
 * product is nemar-ica's real one (copied from nemar-process P7, `test/fixtures/quality/ica-views`), stored
 * under the derivative's key as the derivative store stores it. The fixture's recordings table holds one
 * recording that succeeded; tables of recordings that failed or were skipped are the fixture's header and
 * columns with rows in the recipe's grammar (`readRecordingsRow` reads them as reconciliation does), and,
 * as nemar-process writes none, those recordings have no record.
 *
 * What is pinned, each case by the mutation it names:
 *  - a recording's `processing` entry (each declared checkpoint, then `stored`) and its `signalJourney` link,
 *    valid against the vendored neuroschema, the link naming the very record bytes the record endpoint's
 *    `dataQuality` names; a failed or skipped recording's outcomes and its `failed` link; over a run's rows the
 *    outcomes sum to the run's reconciled counts with `stored` kept;
 *  - the recording is found by its exact path, and a recording with no row is not found;
 *  - a table or record that cannot be read or does not check is `record_unreadable`, never a link to nothing;
 *  - the derivative row's checkpoint map is used when the registry has moved past its version;
 *  - the quality route's gate, derivative choice, path rule, headers and epoch-keyed edge cache.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import {
  type RecordingRow,
  countRecordings,
  readRecordingsHeader,
  readRecordingsRow,
  storedCounts,
} from "../../shared/compute-checkpoints";
import { declaredCheckpoints } from "../../shared/compute-recipes";
import {
  QUALITY_PROCESSING_FORMAT,
  QUALITY_TABLE_LINE_MAX,
  qualityProcessingPath,
  qualityRecordPath,
} from "../../shared/contract/quality-route";
import {
  compileNeuroschemaValidator,
  formatAjvErrors,
} from "../../test/contract/neuroschema-validator";
import { dataRoutes } from "../src/routes/data";
import { TABLE_PART_BYTES } from "../src/services/quality-processing";
import type { Bindings, Variables } from "../src/types/bindings";
import { InMemoryCache } from "./helpers/cache";
import { freshDb, realD1 } from "./helpers/d1";
import { logged } from "./helpers/logs";
import {
  ICA,
  newJobId,
  productFiles,
  seedDerivative,
  seedIcaStamp,
} from "./helpers/quality-fixture";

// biome-ignore lint/suspicious/noExplicitAny: documents are read field by field
type Loose = Record<string, any>;

const DATASET = "on007823";
const RECORDING = "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_eeg.edf";
const RECORD_PATH = "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_desc-nemarica_signalJourney.json";
const TABLE_PATH = "desc-nemarica_recordings.tsv";
const PRODUCT = productFiles();
const RECORD_BYTES = PRODUCT.get(RECORD_PATH) as Uint8Array;
const TABLE_TEXT = new TextDecoder().decode(PRODUCT.get(TABLE_PATH));
const [HEADER, SUCCEEDED] = TABLE_TEXT.trimEnd().split("\n") as [string, string];
const COLUMNS = HEADER.split("\t");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const validateProcessing = compileNeuroschemaValidator("nsc:/extensions/processing.schema.json");
const validateSignalJourney = compileNeuroschemaValidator(
  "nsc:/extensions/signalJourney.schema.json",
);

/** A row in the fixture table's columns: the cells given, `n/a` everywhere else. */
function line(cells: Record<string, string>): string {
  return COLUMNS.map((c) => cells[c] ?? "n/a").join("\t");
}

/** Recordings that did not succeed, in the recipe's grammar: a recording of the same task per subject. */
const rec = (subject: string) => `sub-${subject}/eeg/sub-${subject}_task-COVID_eeg.edf`;
const FAILED_PREPROCESS = line({
  path: rec("CUCOV101"),
  datatype: "eeg",
  status: "failed",
  code: "all_channels_flagged",
  step: "bad_channels",
});
const FAILED_ICA = line({
  path: rec("CUCOV102"),
  datatype: "eeg",
  status: "failed",
  code: "ica_degenerate",
  step: "ica",
});
const SKIPPED = line({
  path: rec("CUCOV103"),
  datatype: "eeg",
  status: "skipped",
  code: "unsupported_format",
});
const FAILED_NO_STEP = line({
  path: rec("CUCOV104"),
  datatype: "eeg",
  status: "failed",
  code: "disk_error",
});
const MIXED_TABLE = `${[HEADER, SUCCEEDED, FAILED_PREPROCESS, FAILED_ICA, SKIPPED, FAILED_NO_STEP].join("\n")}\n`;

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

/** A stored derivative of the dataset's nemar-ica run, with the real product (and `table`) under its key. */
async function derivative(
  over: {
    retention?: "canary" | "catalog" | "published";
    storedAt?: string;
    recipeVersion?: string;
    table?: string | null;
  } = {},
): Promise<string> {
  const d1 = realD1(db);
  const jobId = newJobId();
  const runs = (
    db
      .query("SELECT COUNT(*) AS n FROM compute_pipeline_stamps WHERE dataset_id = ?")
      .get(DATASET) as { n: number }
  ).n;
  const stampId = await seedIcaStamp(d1, { datasetId: DATASET, jobId, version: `v1.0.${runs}` });
  const key = await seedDerivative(d1, {
    datasetId: DATASET,
    stampId,
    jobId,
    retention: over.retention ?? "catalog",
    storedAt: over.storedAt,
    recipeVersion: over.recipeVersion,
  });
  for (const [path, bytes] of PRODUCT) await bucket.put(`d/${key}/${path}`, bytes);
  if (over.table === null) await bucket.delete(`d/${key}/${TABLE_PATH}`);
  else if (over.table !== undefined) await bucket.put(`d/${key}/${TABLE_PATH}`, over.table);
  return key;
}

const get = (path: string, over: Partial<Bindings> = {}) => app.request(path, {}, env(over));
const url = (recording = RECORDING, id = DATASET) =>
  qualityProcessingPath(id, "nemar-ica", recording);

async function word(res: Response): Promise<string> {
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return ((await res.json()) as { error: string }).error;
}

const PASSED = { status: "passed", code: null, step: null };

beforeEach(async () => {
  db = freshDb();
  app = new Hono();
  app.route("/", dataRoutes);
  await emptyBucket();
  seedDataset(DATASET);
  (globalThis as { caches?: unknown }).caches = undefined;
});

describe("a recording's outcomes and link, from the current public derivative", () => {
  test("a recording that succeeded: every checkpoint passed, stored kept, a completed link to its record, public headers (MUTATION: hash the location, not the bytes)", async () => {
    const key = await derivative();
    const res = await get(url());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("Cache-Tag")).toBe(`nemar-dq-${DATASET}`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = await res.text();
    expect(res.headers.get("ETag")).toBe(`"${sha256(text)}"`);
    const body = JSON.parse(text) as Loose;
    expect(body.format).toBe(QUALITY_PROCESSING_FORMAT);
    expect(body).toMatchObject({ dataset_id: DATASET, recipe: "nemar-ica", recording: RECORDING });
    expect(body.derivative).toMatchObject({
      key,
      recipe_version: ICA.version,
      retention: "catalog",
    });
    const declared = declaredCheckpoints(ICA);
    expect(body.processing).toEqual({
      level: "record",
      recipes: {
        "nemar-ica": {
          recipe_version: ICA.version,
          checkpoints: Object.fromEntries(declared.map((c) => [c, PASSED])),
        },
      },
    });
    expect(Object.keys(body.processing.recipes["nemar-ica"].checkpoints)).toEqual(declared);
    if (!validateProcessing(body.processing)) throw new Error(formatAjvErrors(validateProcessing));
    expect(body.signalJourney).toEqual({
      recipes: {
        "nemar-ica": {
          recipe_version: ICA.version,
          processing_status: "completed",
          location: RECORD_PATH,
          sha256: sha256(RECORD_BYTES),
          sj_version: "0.1.0",
        },
      },
    });
    if (!validateSignalJourney(body.signalJourney)) {
      throw new Error(formatAjvErrors(validateSignalJourney));
    }
    // The link names the very record the record endpoint's dataQuality entry came from.
    const record = (await (
      await get(qualityRecordPath(DATASET, "nemar-ica", RECORDING))
    ).json()) as Loose;
    expect(record.dataQuality.recipes["nemar-ica"].record_sha256).toBe(
      body.signalJourney.recipes["nemar-ica"].sha256,
    );
  });

  test("recordings that failed or were skipped: first outcome carried to stored, a failed link, nothing read of a record (MUTATION: stored passed for every row)", async () => {
    await derivative({ table: MIXED_TABLE });
    const cases: Array<[string, Record<string, Loose>]> = [
      [
        rec("CUCOV101"),
        {
          import: PASSED,
          preprocess: { status: "failed", code: "all_channels_flagged", step: "bad_channels" },
          ica: { status: "skipped", code: "all_channels_flagged", step: "bad_channels" },
          stored: { status: "skipped", code: "all_channels_flagged", step: "bad_channels" },
        },
      ],
      [
        rec("CUCOV102"),
        {
          preprocess: PASSED,
          ica: { status: "failed", code: "ica_degenerate", step: "ica" },
          quality: { status: "skipped", code: "ica_degenerate", step: "ica" },
          stored: { status: "skipped", code: "ica_degenerate", step: "ica" },
        },
      ],
      [
        rec("CUCOV103"),
        {
          import: { status: "skipped", code: "unsupported_format", step: null },
          stored: { status: "skipped", code: "unsupported_format", step: null },
        },
      ],
      [
        rec("CUCOV104"),
        {
          import: { status: "failed", code: "disk_error", step: null },
          stored: { status: "skipped", code: "disk_error", step: null },
        },
      ],
    ];
    for (const [recording, expected] of cases) {
      const res = await get(url(recording));
      expect([recording, res.status]).toEqual([recording, 200]);
      const body = (await res.json()) as Loose;
      expect(body.processing.recipes["nemar-ica"].checkpoints).toMatchObject(expected);
      if (!validateProcessing(body.processing))
        throw new Error(formatAjvErrors(validateProcessing));
      expect(body.signalJourney.recipes["nemar-ica"]).toEqual({
        recipe_version: ICA.version,
        processing_status: "failed",
        location: null,
        sha256: null,
        sj_version: null,
      });
      if (!validateSignalJourney(body.signalJourney)) {
        throw new Error(formatAjvErrors(validateSignalJourney));
      }
    }
  });

  test("over every row of the run, the recordings' outcomes sum to the run's reconciled counts with stored kept", async () => {
    await derivative({ table: MIXED_TABLE });
    const lines = MIXED_TABLE.trimEnd().split("\n");
    const head = readRecordingsHeader(lines[0] as string);
    if (!head.ok) throw new Error(head.reason);
    const rows = lines.slice(1).map((l) => {
      const r = readRecordingsRow(l, head.header);
      if (!r.ok) throw new Error(r.reason);
      return r.row;
    }) as RecordingRow[];
    const declared = declaredCheckpoints(ICA);
    const sums: Loose = Object.fromEntries(
      declared.map((c) => [c, { passed: 0, failed: 0, skipped: 0, total: 0 }]),
    );
    for (const r of rows) {
      const body = (await (await get(url(r.path))).json()) as Loose;
      for (const c of declared) {
        sums[c][body.processing.recipes["nemar-ica"].checkpoints[c].status] += 1;
        sums[c].total += 1;
      }
    }
    const counts = countRecordings(rows, ICA.checkpoints);
    const last = counts.quality;
    expect(sums).toEqual({ ...counts, stored: storedCounts("kept", last.passed, last.total) });
  });

  test("the recording is its exact path: another case, a longer path or a recording the run did not list is not found (MUTATION: match by substring)", async () => {
    await derivative({ table: MIXED_TABLE });
    for (const recording of [
      "sub-CUCOV076/eeg/sub-cucov076_task-COVID_eeg.edf",
      "x/sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_eeg.edf",
      // A tail of the listed path: found only by a match that is not exact.
      "CUCOV076/eeg/sub-CUCOV076_task-COVID_eeg.edf",
      "sub-CUCOV076/eeg/sub-CUCOV076_task-COV_eeg.edf",
      rec("CUCOV999"),
    ]) {
      const res = await get(url(recording));
      expect([recording, res.status]).toEqual([recording, 404]);
      expect(await word(res)).toBe("quality_not_found");
    }
  });

  test("an unknown dataset, a canary run and no derivative are not found; the newest public run serves", async () => {
    expect(await word(await get(url()))).toBe("quality_not_found");
    await derivative({ retention: "canary" });
    expect(await word(await get(url()))).toBe("quality_not_found");
    const older = await derivative({ storedAt: "2026-11-20 10:00:00" });
    const newer = await derivative({ storedAt: "2026-11-21 10:00:00", table: MIXED_TABLE });
    const body = (await (await get(url(rec("CUCOV101")))).json()) as Loose;
    expect(body.derivative.key).toBe(newer);
    expect(body.derivative.key).not.toBe(older);
    expect(await word(await get(url(RECORDING, "nm000777")))).toBe("quality_not_found");
  });
});

describe("what cannot be read or does not check is record_unreadable, logged, never a link to nothing", () => {
  const refused = async (recording = RECORDING) => {
    const res = await get(url(recording));
    expect(res.status).toBe(502);
    return word(res);
  };

  test("the run's table is missing (MUTATION: answer not found)", async () => {
    const key = await derivative({ table: null });
    let answer = "";
    const lines = await logged(async () => {
      answer = await refused();
    });
    expect(answer).toBe("record_unreadable");
    expect(lines).toEqual([
      `[quality] record_unreadable dataset=${DATASET} key=${key.slice(0, 12)} reason=table_missing`,
    ]);
  });

  test("a table with no step column, an empty table, and the recording's row of the wrong width", async () => {
    for (const table of [
      TABLE_TEXT.replace("\tstep\t", "\tstage\t"),
      "",
      `${HEADER}\n${RECORDING}\tsucceeded\n`,
    ]) {
      await emptyBucket();
      db.run("DELETE FROM compute_derivatives");
      await derivative({ table });
      expect(
        await logged(async () => expect(await refused()).toBe("record_unreadable")),
      ).toHaveLength(1);
    }
  });

  test("a line longer than the scan takes, before the recording's (MUTATION: drop the line bound)", async () => {
    const long = line({ path: rec("CUCOV200"), status: "failed", code: "x".repeat(10), step: "a" });
    const padded = `${long}${"\t".repeat(0)}`.replace(
      "n/a\tn/a",
      `${"y".repeat(QUALITY_TABLE_LINE_MAX + 1)}\tn/a`,
    );
    await derivative({ table: `${HEADER}\n${padded}\n${SUCCEEDED}\n` });
    const lines = await logged(async () => expect(await refused()).toBe("record_unreadable"));
    expect(lines.join("\n")).toContain("reason=line_too_long");
  });

  test("a table of several ranged parts: the recording's row across a part boundary is read whole (MUTATION: drop the partial line between parts)", async () => {
    // Rows of another recording, enough that the recording's line starts within 40 bytes before the first
    // part ends and finishes in the second (all ASCII, so characters are bytes).
    const filler = `${FAILED_PREPROCESS.replace("CUCOV101", "CUCOV1XX")}\n`;
    const before = `${HEADER}\n`;
    const count = Math.floor((TABLE_PART_BYTES - 40 - before.length) / filler.length);
    const table = `${before}${filler.repeat(count)}${SUCCEEDED}\n${FAILED_ICA}\n`;
    expect(table.length).toBeGreaterThan(TABLE_PART_BYTES);
    const at = table.indexOf(SUCCEEDED);
    expect(at).toBeLessThan(TABLE_PART_BYTES);
    expect(at + SUCCEEDED.length).toBeGreaterThan(TABLE_PART_BYTES);
    await derivative({ table });
    const res = await get(url());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Loose;
    expect(body.processing.recipes["nemar-ica"].checkpoints.stored).toEqual(PASSED);
    // A row in the second part is found too.
    const second = (await (await get(url(rec("CUCOV102")))).json()) as Loose;
    expect(second.processing.recipes["nemar-ica"].checkpoints.ica.status).toBe("failed");
  }, 60_000);

  test("the scan stops at the recording's row: a later line is never read", async () => {
    await derivative({ table: `${HEADER}\n${SUCCEEDED}\nnot a row at all\n` });
    expect((await get(url())).status).toBe(200);
  });

  test("a succeeded recording whose record is missing, names another recording, or has no signalJourney version (MUTATION: drop the identity check)", async () => {
    const edits: Array<[string, (doc: Loose) => void, string]> = [
      [
        "another recording",
        (doc) => {
          doc.extensions.nemar.recording.path = rec("CUCOV101");
        },
        "record_elsewhere",
      ],
      [
        "another dataset",
        (doc) => {
          doc.extensions.nemar.dataset.id = "nm000001";
        },
        "record_elsewhere",
      ],
      [
        "no version",
        (doc) => {
          doc.sj_version = undefined;
        },
        "no_sj_version",
      ],
    ];
    for (const [name, edit, reason] of edits) {
      await emptyBucket();
      db.run("DELETE FROM compute_derivatives");
      const key = await derivative();
      const doc = JSON.parse(new TextDecoder().decode(RECORD_BYTES)) as Loose;
      edit(doc);
      await bucket.put(`d/${key}/${RECORD_PATH}`, JSON.stringify(doc));
      const lines = await logged(async () => expect(await refused()).toBe("record_unreadable"));
      expect([name, lines.join("\n")]).toEqual([name, expect.stringContaining(`reason=${reason}`)]);
    }
    await emptyBucket();
    db.run("DELETE FROM compute_derivatives");
    const key = await derivative();
    await bucket.delete(`d/${key}/${RECORD_PATH}`);
    const lines = await logged(async () => expect(await refused()).toBe("record_unreadable"));
    expect(lines.join("\n")).toContain("reason=record_missing");
  });
});

describe("the checkpoint map of the derivative's own version", () => {
  test("a derivative of a version the registry moved past is read with the map its row recorded (MUTATION: read the registry's map only)", async () => {
    const key = await derivative({ recipeVersion: "0.9.0", table: MIXED_TABLE });
    // Without a recorded map, nothing says which steps were which checkpoint's.
    const lines = await logged(async () => {
      expect(await word(await get(url(rec("CUCOV101"))))).toBe("quality_not_found");
    });
    expect(lines.join("\n")).toContain("reason=checkpoint_map_unknown");
    // That version's map: bad channels counted at import.
    const map = [
      { checkpoint: "import", steps: ["load", "bad_channels"] },
      { checkpoint: "ica", steps: ["ica"] },
    ];
    db.run("UPDATE compute_derivatives SET checkpoint_map = ? WHERE key = ?", [
      JSON.stringify(map),
      key,
    ]);
    const body = (await (await get(url(rec("CUCOV101")))).json()) as Loose;
    expect(body.processing.recipes["nemar-ica"]).toEqual({
      recipe_version: "0.9.0",
      checkpoints: {
        import: { status: "failed", code: "all_channels_flagged", step: "bad_channels" },
        ica: { status: "skipped", code: "all_channels_flagged", step: "bad_channels" },
        stored: { status: "skipped", code: "all_channels_flagged", step: "bad_channels" },
      },
    });
  });

  test("a recorded map that is not one is record_unreadable", async () => {
    const key = await derivative();
    db.run("UPDATE compute_derivatives SET checkpoint_map = ? WHERE key = ?", [
      JSON.stringify([{ checkpoint: "stored", steps: [] }]),
      key,
    ]);
    const lines = await logged(async () => {
      const res = await get(url());
      expect(res.status).toBe(502);
      expect(await word(res)).toBe("record_unreadable");
    });
    expect(lines.join("\n")).toContain("reason=checkpoint_map_invalid");
  });
});

describe("the quality route's gate, paths and cache", () => {
  const unknown = async () => {
    const res = await get(url(RECORDING, "nm000777"));
    return { status: res.status, body: await res.text() };
  };

  for (const [name, statement] of [
    ["private", "UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?"],
    ["withdrawn", "UPDATE datasets SET withdrawn_at = '2026-11-01 00:00:00' WHERE dataset_id = ?"],
    [
      "an anonymous deposit",
      "UPDATE datasets SET first_published_at = NULL, anonymous = 1 WHERE dataset_id = ?",
    ],
  ] as const) {
    test(`${name}: answers exactly as an unknown dataset`, async () => {
      await derivative();
      expect((await get(url())).status).toBe(200);
      db.run(statement, [DATASET]);
      const res = await get(url());
      expect({ status: res.status, body: await res.text() }).toEqual(await unknown());
    });
  }

  test("a path that is not a recording's is refused before anything is read", async () => {
    await derivative();
    for (const raw of [
      "sub-CUCOV076%2F..%2F..%2Fsub-CUCOV076_task-COVID_eeg.edf",
      "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_desc-nemarica_channels.tsv",
      "sub-CUCOV076//eeg/sub-CUCOV076_task-COVID_eeg.edf",
    ]) {
      const res = await get(`/${DATASET}/quality/v1/nemar-ica/processing/${raw}`);
      expect([raw, res.status]).toEqual([raw, 400]);
      expect(await word(res)).toBe("recording_path_invalid");
    }
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

    test("an answer is cached under the dataset's epoch, and an unpublish refuses at the next request (MUTATION: leave the epoch out of the key)", async () => {
      const key = await derivative();
      const first = await get(url());
      expect(first.status).toBe(200);
      const body = await first.text();
      // The table goes missing: the cached answer still serves.
      await bucket.delete(`d/${key}/${TABLE_PATH}`);
      const hit = await get(url());
      expect(hit.status).toBe(200);
      expect(await hit.text()).toBe(body);
      expect(hit.headers.get("Cache-Tag")).toBe(`nemar-dq-${DATASET}`);
      // Unpublished: refused before the cache.
      db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?", [DATASET]);
      expect(await word(await get(url()))).toBe("quality_not_found");
      // Published again: a new epoch, so the old entry is never read and the missing table shows.
      db.run("UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?", [DATASET]);
      const res = await logged(async () => {
        const again = await get(url());
        expect(again.status).toBe(502);
        expect(await word(again)).toBe("record_unreadable");
      });
      expect(res.join("\n")).toContain("reason=table_missing");
    });

    test("no refusal is cached, and the processing and record answers never share an entry", async () => {
      const key = await derivative();
      await bucket.delete(`d/${key}/${TABLE_PATH}`);
      await logged(async () => {
        expect((await get(url())).status).toBe(502);
      });
      await bucket.put(`d/${key}/${TABLE_PATH}`, TABLE_TEXT);
      const processing = await get(url());
      expect(processing.status).toBe(200);
      expect(((await processing.json()) as Loose).format).toBe(QUALITY_PROCESSING_FORMAT);
      const record = await get(qualityRecordPath(DATASET, "nemar-ica", RECORDING));
      expect(((await record.json()) as Loose).format).not.toBe(QUALITY_PROCESSING_FORMAT);
    });
  });
});

test("the fixture is what the cases assume: one recording, succeeded, in a table with a step column", () => {
  expect(COLUMNS).toContain("step");
  expect(SUCCEEDED.split("\t")[COLUMNS.indexOf("path")]).toBe(RECORDING);
  expect(SUCCEEDED.split("\t")[COLUMNS.indexOf("status")]).toBe("succeeded");
});
