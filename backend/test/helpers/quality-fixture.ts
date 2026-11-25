/**
 * nemar-ica's real product (`test/fixtures/quality/ica-views`, copied from nemar-process P7 and held to its
 * SHA256SUMS.json by `test/quality-documents-contract.unit.test.ts`), and the rows a run of it leaves, for
 * the quality suites of epic #2324 phase B1.
 *
 * Nothing here stands in for NEMAR's code: the files are the recipe's own, and the rows are written with
 * SQL the tables accept (a stamp of a recipe the registry holds as a placeholder cannot be dispatched, so
 * its succeeded stamp is seeded, as the reconcile suites seed a job's state).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findRecipe } from "../../../shared/compute-recipes";

export const QUALITY_FIXTURE = join(import.meta.dir, "../../../test/fixtures/quality/ica-views");
export const QUALITY_PRODUCT = join(QUALITY_FIXTURE, "product");

export const ICA = findRecipe("nemar-ica") as NonNullable<ReturnType<typeof findRecipe>>;

/** Every file of the product, by its path under `product/`, as bytes. */
export function productFiles(): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const rel of readdirSync(QUALITY_PRODUCT, {
    recursive: true,
    encoding: "utf8",
  }) as string[]) {
    const file = join(QUALITY_PRODUCT, rel);
    if (statSync(file).isFile()) out.set(rel, new Uint8Array(readFileSync(file)));
  }
  return out;
}

/** The recipe's entry of the fixture's dataset `dataQuality` document. */
export function fixtureEntry(): Record<string, unknown> {
  const doc = JSON.parse(
    readFileSync(join(QUALITY_PRODUCT, "desc-nemarica_dataquality.json"), "utf8"),
  ) as { recipes: Record<string, Record<string, unknown>> };
  return doc.recipes["nemar-ica"] as Record<string, unknown>;
}

let jobSeq = 0;
/** A fresh job id of the shape the tables take. */
export const newJobId = (): string => `job_${(++jobSeq).toString(16).padStart(24, "0")}`;

/** A stamp of a nemar-ica run (or of another recipe), in the state given, with its job. Returns its id. */
export async function seedIcaStamp(
  db: D1Database,
  input: {
    datasetId: string;
    jobId: string;
    state?: "succeeded" | "failed";
    version?: string;
    attempt?: number;
    recipe?: string;
  },
): Promise<number> {
  const state = input.state ?? "succeeded";
  const row = await db
    .prepare(
      `INSERT INTO compute_pipeline_stamps
         (dataset_id, version, recipe, recipe_version, engine, attempt, state, job_id, refusal_code, input)
       VALUES (?1, ?2, ?9, ?3, ?4, ?5, ?6, ?7, ?8, 'bids') RETURNING id`,
    )
    .bind(
      input.datasetId,
      input.version ?? "v1.0.0",
      ICA.version,
      ICA.engine,
      input.attempt ?? 1,
      state,
      input.jobId,
      state === "failed" ? "runtime_error" : null,
      input.recipe ?? "nemar-ica",
    )
    .first<{ id: number }>();
  if (!row) throw new Error("no stamp");
  return row.id;
}

let keySeq = 0;

/**
 * A derivative row of a stamp, as the derivative store leaves one: `stored` at `storedAt` (or another
 * state), of the retention given. Returns its key.
 */
export async function seedDerivative(
  db: D1Database,
  input: {
    datasetId: string;
    stampId: number;
    jobId: string;
    recipe?: string;
    retention?: "canary" | "catalog" | "published";
    state?: "copying" | "stored" | "failed" | "expired";
    storedAt?: string;
    key?: string;
    /** When a later `catalog` row superseded it; null by default. */
    supersededAt?: string | null;
    /** Its date; by default a canary's far future and none for any other class. */
    expiresAt?: string | null;
  },
): Promise<string> {
  const key = input.key ?? (++keySeq).toString(16).padStart(64, "0");
  const state = input.state ?? "stored";
  const retention = input.retention ?? "canary";
  const storedAt =
    state === "stored" || state === "expired" ? (input.storedAt ?? "2026-11-20 10:00:00") : null;
  await db
    .prepare(
      `INSERT INTO compute_derivatives
         (key, dataset_id, version, recipe, recipe_version, engine, input, profile, input_digest,
          image_digest, job_id, stamp_id, state, retention, failure, copied, object_count, bytes,
          stored_at, expires_at, superseded_at)
       VALUES (?1, ?2, 'v1.0.0', ?3, ?4, ?5, 'bids', 'archive', ?6, ?7, ?8, ?9, ?10, ?11, ?12, 20, 20,
               1000, ?13, ?14, ?15)`,
    )
    .bind(
      key,
      input.datasetId,
      input.recipe ?? "nemar-ica",
      ICA.version,
      ICA.engine,
      `git:${"5".repeat(40)}`,
      `sha256:${"e".repeat(64)}`,
      input.jobId,
      input.stampId,
      state,
      retention,
      state === "failed" ? "copy_failed" : null,
      storedAt,
      input.expiresAt !== undefined
        ? input.expiresAt
        : retention === "canary"
          ? "2099-01-01 00:00:00"
          : null,
      input.supersededAt ?? null,
    )
    .run();
  return key;
}

/**
 * The review's construction of a summary that outgrows the column (#2375): the fixture's document with one
 * more distribution, of no value, whose histogram edges are written `1000e17, 1001e17, ...`. Each such edge
 * is 7 characters as written and 21 as `JSON.stringify` prints it (`100000000000000000000`), so a document of
 * `bytes` bytes, under the 65,536 a recipe writes, becomes an entry far over the 65,536 characters D1 keeps.
 * Every rule holds: no value (n 0, null summary and range), edges that rise, no integer literal.
 */
export function wideEdgesDocument(bytes = 62_641): Uint8Array {
  const doc = JSON.parse(
    readFileSync(join(QUALITY_PRODUCT, "desc-nemarica_dataquality.json"), "utf8"),
  ) as { recipes: Record<string, Record<string, Record<string, unknown>>> };
  const entry = doc.recipes["nemar-ica"] as Record<string, Record<string, unknown>>;
  const build = (edges: number, pad: number): string => {
    entry.distributions.wideEdges = {
      description: `Edges written short${".".repeat(pad + 1)}`,
      histogram: {
        counts: "__COUNTS__",
        edges: "__EDGES__",
        missing: 0,
        overflow: 0,
        underflow: 0,
      },
      max: null,
      median: null,
      min: null,
      n: 0,
      unit: "count",
    };
    entry.observed_range.wideEdges = { max: null, min: null };
    const written = Array.from({ length: edges }, (_, i) => `${1000 + i}e17`).join(",");
    return JSON.stringify(doc)
      .replace('"__EDGES__"', `[${written}]`)
      .replace(
        '"__COUNTS__"',
        `[${Array(edges - 1)
          .fill(0)
          .join(",")}]`,
      );
  };
  const base = build(2, 0).length;
  // Ten bytes an edge ("1000e17," and "0,"); the remainder pads the description.
  const edges = Math.floor((bytes - base) / 10) + 2;
  const text = build(edges, bytes - build(edges, 0).length);
  if (text.length !== bytes) throw new Error(`built ${text.length} bytes, not ${bytes}`);
  return new TextEncoder().encode(text);
}
