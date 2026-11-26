/**
 * The record and file steps of the quality views (ADR 0137 decisions 6 and 7, epic #2324 phases B2 and
 * B3b): what is read from a derivative once a route has decided which derivative may be read. Both mounts
 * call `serveRecordingViews` and nothing else reads a derivative's views:
 *  - the public route (`routes/quality.ts`), after its dataset gate, for the recipe's current public
 *    derivative, behind its edge cache;
 *  - the admin route (`routes/admin/quality-views.ts`), after the admin role, for a run's stored, in-date
 *    derivative of any retention, with no cache at all.
 *
 * The steps (B2's 4 and 5):
 *  4. The recording's record (at most `QUALITY_RECORD_MAX_BYTES`), projected and checked whole
 *     (`recordingViews`): the record's integers, its identity (the derivative ROW's dataset and the
 *     recording asked for), every plugin view's plugin against the `quality` plugins the row recorded for
 *     its recipe version when it was made (`compute_derivatives.quality_plugins`; a row without them serves
 *     nothing), the vendored schema, recording scope and `nemar.record-checks.v1`.
 *  5. For a file: the digest must be one a validated view declares; the object (at most
 *     `QUALITY_FILE_MAX_BYTES`) must be its declared size and is hashed again before a byte is served, with
 *     `nosniff`, and as an attachment unless its format is one the registry lists.
 *
 * What a caller adds is caching: the answer carries only its content headers, so the public route adds its
 * cache headers and the admin route `no-store`. A log line carries the dataset id, the first twelve digits
 * of a key and a fixed word, never a path.
 */

import { label, productPath } from "../../../shared/compute-naming.js";
import { findRecipe } from "../../../shared/compute-recipes.js";
import {
  QUALITY_FILE_MAX_BYTES,
  QUALITY_RECORD_FORMAT,
  QUALITY_RECORD_MAX_BYTES,
  type QualityRouteWord,
  qualityFileHeaders,
} from "../../../shared/contract/quality-route.js";
import { sha256HexOfBytes } from "../../../shared/contract/view-digest.js";
import { DERIVATIVE_OBJECT_PREFIX } from "./compute-derivatives.js";
import { recordingViews } from "./quality-views.js";

/** The derivative row a route has decided may be read: the fields the steps read. */
export interface ServedDerivative {
  key: string;
  /** The ROW's dataset: the record must say it is of this dataset. */
  dataset_id: string;
  recipe: string;
  version: string;
  recipe_version: string;
  input: "bids" | "zarr";
  retention: string;
  stored_at: string;
  quality_plugins: string | null;
}

/** What is asked of the derivative: a recording's record, or one file its views declare. */
export type ViewAsk =
  | { kind: "record"; recording: string }
  | { kind: "file"; sha256: string; recording: string };

/** The answer's bytes and content headers, or the word it is refused with. */
export type Served =
  | { ok: true; bytes: Uint8Array; headers: Record<string, string>; sha256: string }
  | { ok: false; word: QualityRouteWord };

/** The plugin names a row's `quality_plugins` holds, or null when it holds none that can be read. */
export function pluginsOf(text: string | null): string[] | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : null;
}

/** Read an object of at most `max` bytes, or say why not; a larger one is never read into memory. */
export async function readBounded(
  bucket: R2Bucket,
  key: string,
  max: number,
): Promise<
  { kind: "ok"; bytes: Uint8Array } | { kind: "missing" } | { kind: "too_large"; size: number }
> {
  const object = await bucket.get(key);
  if (object === null) return { kind: "missing" };
  // A larger object's body is never read: it is left unconsumed, and the runtime releases it.
  if (object.size > max) return { kind: "too_large", size: object.size };
  const bytes = new Uint8Array(await object.arrayBuffer());
  // The size the store stated is the size read, or the object changed under the read.
  if (bytes.byteLength > max) return { kind: "too_large", size: bytes.byteLength };
  return { kind: "ok", bytes };
}

const refused = (word: QualityRouteWord): Served => ({ ok: false, word });

/**
 * Steps 4 and 5 over a derivative a route has decided may be read. `log` is the log line's tag
 * (`quality` or `quality-admin`).
 */
export async function serveRecordingViews(
  bucket: R2Bucket,
  row: ServedDerivative,
  asked: ViewAsk,
  log: string,
): Promise<Served> {
  // 4. The record, checked whole.
  const short = row.key.slice(0, 12);
  const datasetId = row.dataset_id;
  const recipe = findRecipe(row.recipe);
  // The recipe version's quality plugins as the row recorded them when it was made, so a derivative of a
  // version the registry has moved past is checked against its own version's plugins.
  const plugins = pluginsOf(row.quality_plugins);
  if (recipe === null || plugins === null) {
    console.warn(`[${log}] quality_plugins_unknown dataset=${datasetId} key=${short}`);
    return refused("quality_not_found");
  }
  const recordPath = productPath(asked.recording, label(recipe.name), "signalJourney", "json");
  const record = await readBounded(
    bucket,
    `${DERIVATIVE_OBJECT_PREFIX}${row.key}/${recordPath}`,
    QUALITY_RECORD_MAX_BYTES,
  );
  if (record.kind === "missing") return refused("quality_not_found");
  if (record.kind === "too_large") {
    console.warn(
      `[${log}] record_unreadable dataset=${datasetId} key=${short} reason=record_too_large`,
    );
    return refused("record_unreadable");
  }
  const views = await recordingViews(
    record.bytes,
    {
      recipe: recipe.name,
      recipeVersion: row.recipe_version,
      input: row.input,
      plugins,
    },
    { datasetId, recording: asked.recording },
  );
  if (!views.ok) {
    console.warn(
      `[${log}] record_unreadable dataset=${datasetId} key=${short} reason=${views.reason}`,
    );
    return refused("record_unreadable");
  }

  if (asked.kind === "record") {
    const body = {
      format: QUALITY_RECORD_FORMAT,
      dataset_id: datasetId,
      recipe: recipe.name,
      recording: asked.recording,
      derivative: {
        key: row.key,
        version: row.version,
        recipe_version: row.recipe_version,
        retention: row.retention,
        stored_at: row.stored_at,
      },
      dataQuality: views.document,
      view_digests: views.digests,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    return {
      ok: true,
      bytes,
      headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
      sha256: await sha256HexOfBytes(bytes),
    };
  }

  // 5. A declared file, read again and hashed.
  const declared = views.files.get(asked.sha256);
  if (declared === undefined) return refused("view_not_declared");
  const file = await readBounded(
    bucket,
    `${DERIVATIVE_OBJECT_PREFIX}${row.key}/${declared.location}`,
    QUALITY_FILE_MAX_BYTES,
  );
  if (file.kind === "missing") return refused("view_data_missing");
  if (file.kind === "too_large" || file.bytes.byteLength !== declared.size) {
    console.error(`[${log}] view_data_corrupt dataset=${datasetId} key=${short} reason=size`);
    return refused("view_data_corrupt");
  }
  if ((await sha256HexOfBytes(file.bytes)) !== asked.sha256) {
    console.error(`[${log}] view_data_corrupt dataset=${datasetId} key=${short} reason=digest`);
    return refused("view_data_corrupt");
  }
  return {
    ok: true,
    bytes: file.bytes,
    headers: qualityFileHeaders(declared.location, declared.format),
    sha256: asked.sha256,
  };
}
