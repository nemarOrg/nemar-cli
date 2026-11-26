/**
 * A recording's checkpoint outcomes and signalJourney link (ADR 0134 decision 9 as amended 2026-11-26, epic
 * #2324 phase B4): the neuroschema `processing` entry at `level: record` and the `signalJourney` link of one
 * recording, built on request from a derivative a route has decided may be read, and never stored.
 *
 *  1. The checkpoint map of the derivative's recipe version: the one its row recorded when it was made
 *     (`compute_derivatives.checkpoint_map`, migration 0154), else the registry's while the registry holds
 *     that very version; with neither, nothing is shown (`checkpoint_map_unknown`).
 *  2. The recording's row of the run's recordings table (`<key>/desc-<label>_recordings.tsv`), found by a
 *     scan of ranged reads that holds one part and a line, at most `QUALITY_TABLE_MAX_BYTES` and lines of at
 *     most `QUALITY_TABLE_LINE_MAX`, and stops at the first line whose `path` cell is the recording, exactly
 *     (no normalization). The header and the row are read by the counting rules' own readers
 *     (`readRecordingsHeader`, `readRecordingsRow`), so a row reads here as reconciliation read it.
 *  3. The outcomes (`processingRecordEntry`): each declared checkpoint's, then `stored`, which a promoted
 *     derivative has kept, checked by `processingRecordProblem`.
 *  4. The link: a succeeded recording's record (at most `QUALITY_RECORD_MAX_BYTES`) must be UTF-8 I-JSON that
 *     names the derivative ROW's dataset, this recording and the derivative's recipe and version; the link
 *     carries its location, the SHA-256 of its bytes and its `sj_version`. A recording that failed or was
 *     skipped has no record (nemar-process writes none), so its link is `failed`.
 *  5. Both entries checked against the vendored neuroschema `processing` and `signalJourney` schemas.
 *
 * A step that cannot be read or does not check refuses the answer with `record_unreadable`, logged with a
 * fixed word; a recording with no row is `quality_not_found`. A log line carries the caller's tag, the
 * dataset id, the first twelve digits of the key and a fixed word, never a path.
 */

import {
  type RecordingRow,
  type RecordingsHeader,
  processingRecordEntry,
  processingRecordProblem,
  readRecordingsHeader,
  readRecordingsRow,
  signalJourneyLink,
} from "../../../shared/compute-checkpoints.js";
import { label, productPath } from "../../../shared/compute-naming.js";
import {
  type DeclarableCheckpoint,
  RECIPE_PRODUCT_OUTPUT_PREFIX,
  type RecipeCheckpoint,
  STANDARD_CHECKPOINTS,
  STORED_CHECKPOINT,
  findRecipe,
  recipeCheckpointMap,
  recipeRequiredOutputs,
} from "../../../shared/compute-recipes.js";
import bundle from "../../../shared/contract/neuroschema/dataset.bundle.json" with { type: "json" };
import {
  QUALITY_PROCESSING_FORMAT,
  QUALITY_RECORD_MAX_BYTES,
  QUALITY_TABLE_LINE_MAX,
  QUALITY_TABLE_MAX_BYTES,
} from "../../../shared/contract/quality-route.js";
import { SchemaSet, schemasReachableFrom } from "../../../shared/contract/schema-check.js";
import { readIJson, sha256HexOfBytes } from "../../../shared/contract/view-digest.js";
import { DERIVATIVE_OBJECT_PREFIX } from "./compute-derivatives.js";
import { type Served, type ServedDerivative, readBounded } from "./quality-serve.js";

/** The derivative row the processing endpoint reads: the served fields and the map the row recorded. */
export interface ProcessingDerivative extends ServedDerivative {
  checkpoint_map: string | null;
}

const PROCESSING_SCHEMA_ID = "nsc:/extensions/processing.schema.json";
const SIGNAL_JOURNEY_SCHEMA_ID = "nsc:/extensions/signalJourney.schema.json";

let schemas: SchemaSet | null = null;

/** The vendored schemas the two entries reach, built once per isolate. */
function processingSchemas(): SchemaSet {
  if (schemas === null) {
    const all = (bundle as { schemas: Record<string, unknown>[] }).schemas;
    const ids = new Set<string>();
    const reached: Record<string, unknown>[] = [];
    for (const root of [PROCESSING_SCHEMA_ID, SIGNAL_JOURNEY_SCHEMA_ID]) {
      for (const schema of schemasReachableFrom(all, root)) {
        const id = (schema as { $id?: string }).$id;
        if (id !== undefined && !ids.has(id)) {
          ids.add(id);
          reached.push(schema);
        }
      }
    }
    schemas = new SchemaSet(reached);
  }
  return schemas;
}

/** The checkpoints a recipe may declare: the standard ones but `stored`, which only the backend sets. */
const DECLARABLE: readonly string[] = STANDARD_CHECKPOINTS.filter((c) => c !== STORED_CHECKPOINT);

/**
 * A checkpoint map as a derivative row keeps it (`[{checkpoint, steps}]`), or null when it is not one: every
 * entry a checkpoint a recipe may declare and a list of step words, no checkpoint twice, at least one.
 */
function checkpointMapOfRow(text: string): RecipeCheckpoint[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<string>();
  const map: RecipeCheckpoint[] = [];
  for (const item of value) {
    const c = item as { checkpoint?: unknown; steps?: unknown } | null;
    if (
      typeof c !== "object" ||
      c === null ||
      typeof c.checkpoint !== "string" ||
      !DECLARABLE.includes(c.checkpoint) ||
      seen.has(c.checkpoint) ||
      !Array.isArray(c.steps) ||
      !c.steps.every((s) => typeof s === "string")
    ) {
      return null;
    }
    seen.add(c.checkpoint);
    map.push({
      checkpoint: c.checkpoint as DeclarableCheckpoint,
      steps: [...(c.steps as string[])],
    });
  }
  return map;
}

/** What the scan of a recordings table found. */
type RowScan =
  | { kind: "row"; row: RecordingRow }
  | { kind: "absent" }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

/**
 * The bytes one ranged read of a recordings table takes: a table of a few thousand recordings is one read,
 * and the largest the scan takes (`QUALITY_TABLE_MAX_BYTES`) is eight, so memory holds one part and a line.
 */
export const TABLE_PART_BYTES = 4 * 1024 * 1024;

/**
 * The recording's row of a recordings table, by a scan of ranged reads (see the header, step 2). Text is
 * decoded as reconciliation decodes a table (UTF-8, a byte order mark dropped, CRLF tolerated); the scan
 * stops at the first line whose `path` cell is `recording`. A derivative's objects never change, and a part
 * whose etag is not the object's refuses the scan (`table_changed`).
 */
async function scanRecordingRow(
  bucket: R2Bucket,
  key: string,
  recording: string,
): Promise<RowScan> {
  const head = await bucket.head(key);
  if (head === null) return { kind: "missing" };
  if (head.size > QUALITY_TABLE_MAX_BYTES) return { kind: "unreadable", reason: "table_too_large" };
  const decoder = new TextDecoder();
  let header: RecordingsHeader | null = null;
  let pending = "";
  /** One line: the header, or a row that may be the recording's. A result ends the scan. */
  const take = (raw: string): RowScan | null => {
    if (raw.length > QUALITY_TABLE_LINE_MAX) return { kind: "unreadable", reason: "line_too_long" };
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (header === null) {
      const read = readRecordingsHeader(line);
      if (!read.ok) return { kind: "unreadable", reason: read.reason };
      header = read.header;
      return null;
    }
    if (!line.includes(recording)) return null;
    if (line.split("\t")[header.path] !== recording) return null;
    const row = readRecordingsRow(line, header);
    return row.ok ? { kind: "row", row: row.row } : { kind: "unreadable", reason: row.reason };
  };
  /** Every whole line of `pending`, leaving the last, partial one. */
  const drain = (): RowScan | null => {
    let at = pending.indexOf("\n");
    while (at >= 0) {
      const found = take(pending.slice(0, at));
      if (found !== null) return found;
      pending = pending.slice(at + 1);
      at = pending.indexOf("\n");
    }
    return pending.length > QUALITY_TABLE_LINE_MAX
      ? { kind: "unreadable", reason: "line_too_long" }
      : null;
  };
  for (let offset = 0; offset < head.size; ) {
    const part = await bucket.get(key, {
      range: { offset, length: Math.min(TABLE_PART_BYTES, head.size - offset) },
    });
    if (part === null) return { kind: "missing" };
    if (part.etag !== head.etag) return { kind: "unreadable", reason: "table_changed" };
    const bytes = new Uint8Array(await part.arrayBuffer());
    if (bytes.byteLength === 0) return { kind: "unreadable", reason: "table_changed" };
    offset += bytes.byteLength;
    pending += decoder.decode(bytes, { stream: true });
    const found = drain();
    if (found !== null) return found;
  }
  pending += decoder.decode();
  const found = drain();
  if (found !== null) return found;
  if (pending !== "") {
    const last = take(pending);
    if (last !== null) return last;
  }
  return header === null ? { kind: "unreadable", reason: "empty_table" } : { kind: "absent" };
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const SJ_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const objectOf = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * The `sj_version` of a recording's record whose identity is the one asked for, or the word it is refused
 * with: not UTF-8 I-JSON (`record_unreadable`), naming another dataset, recording, recipe or version
 * (`record_elsewhere`), or with no signalJourney version (`no_sj_version`).
 */
function recordVersion(
  bytes: Uint8Array,
  expected: { datasetId: string; recording: string; recipe: string; recipeVersion: string },
): { ok: true; sjVersion: string } | { ok: false; reason: string } {
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    return { ok: false, reason: "record_unreadable" };
  }
  const read = readIJson(text);
  if (!read.ok) return { ok: false, reason: "record_unreadable" };
  const record = objectOf(read.value);
  const nemar = objectOf(objectOf(record?.extensions)?.nemar);
  if (
    objectOf(nemar?.dataset)?.id !== expected.datasetId ||
    objectOf(nemar?.recording)?.path !== expected.recording ||
    objectOf(nemar?.recipe)?.id !== expected.recipe ||
    objectOf(nemar?.recipe)?.version !== expected.recipeVersion
  ) {
    return { ok: false, reason: "record_elsewhere" };
  }
  const sjVersion = record?.sj_version;
  if (typeof sjVersion !== "string" || !SJ_VERSION_RE.test(sjVersion)) {
    return { ok: false, reason: "no_sj_version" };
  }
  return { ok: true, sjVersion };
}

/**
 * A recording's processing answer over a derivative a route has decided may be read (see the header).
 * `log` is the log line's tag and the context it leads with.
 */
export async function serveRecordingProcessing(
  bucket: R2Bucket,
  row: ProcessingDerivative,
  recording: string,
  log: { tag: string; context?: string },
): Promise<Served> {
  const lead = log.context === undefined ? `[${log.tag}]` : `[${log.tag}] ${log.context}`;
  const refused = (word: "quality_not_found" | "record_unreadable", reason: string): Served => {
    console.warn(
      `${lead} ${word} dataset=${row.dataset_id} key=${row.key.slice(0, 12)} reason=${reason}`,
    );
    return { ok: false, word };
  };
  const recipe = findRecipe(row.recipe);
  if (recipe === null) return refused("quality_not_found", "recipe_unknown");

  // 1. The checkpoint map.
  let map: readonly RecipeCheckpoint[] | null;
  if (row.checkpoint_map !== null) {
    map = checkpointMapOfRow(row.checkpoint_map);
    if (map === null) return refused("record_unreadable", "checkpoint_map_invalid");
  } else {
    map = recipeCheckpointMap(recipe.name, row.recipe_version);
    if (map === null) return refused("quality_not_found", "checkpoint_map_unknown");
  }

  // 2. The recording's row.
  const tableKey = `${DERIVATIVE_OBJECT_PREFIX}${row.key}/${recipeRequiredOutputs(recipe).table.slice(RECIPE_PRODUCT_OUTPUT_PREFIX.length)}`;
  const scan = await scanRecordingRow(bucket, tableKey, recording);
  if (scan.kind === "absent") return { ok: false, word: "quality_not_found" };
  if (scan.kind === "missing") return refused("record_unreadable", "table_missing");
  if (scan.kind === "unreadable") return refused("record_unreadable", scan.reason);

  // 3. The outcomes, stored kept.
  const entry = processingRecordEntry({
    recipeVersion: row.recipe_version,
    checkpoints: map,
    row: scan.row,
  });
  const declared = [...map.map((c) => c.checkpoint), STORED_CHECKPOINT];
  const problem = processingRecordProblem(entry, declared);
  if (problem !== null) return refused("record_unreadable", problem);

  // 4. The link.
  const location = productPath(recording, label(recipe.name), "signalJourney", "json");
  let link: ReturnType<typeof signalJourneyLink>;
  if (scan.row.status === "succeeded") {
    const record = await readBounded(
      bucket,
      `${DERIVATIVE_OBJECT_PREFIX}${row.key}/${location}`,
      QUALITY_RECORD_MAX_BYTES,
    );
    if (record.kind === "missing") return refused("record_unreadable", "record_missing");
    if (record.kind === "too_large") return refused("record_unreadable", "record_too_large");
    const version = recordVersion(record.bytes, {
      datasetId: row.dataset_id,
      recording,
      recipe: recipe.name,
      recipeVersion: row.recipe_version,
    });
    if (!version.ok) return refused("record_unreadable", version.reason);
    link = signalJourneyLink({
      recipeVersion: row.recipe_version,
      status: "completed",
      location,
      sha256: await sha256HexOfBytes(record.bytes),
      sjVersion: version.sjVersion,
    });
  } else {
    link = signalJourneyLink({ recipeVersion: row.recipe_version, status: "failed" });
  }
  if (link === null) return refused("record_unreadable", "link_invalid");

  // 5. Both entries against the vendored schemas.
  const processing = {
    level: "record" as const,
    recipes: { [recipe.name]: entry as { recipe_version: string; checkpoints: object } },
  };
  const signalJourney = { recipes: { [recipe.name]: link } };
  if (!processingSchemas().check(PROCESSING_SCHEMA_ID, processing).valid) {
    return refused("record_unreadable", "processing_invalid");
  }
  if (!processingSchemas().check(SIGNAL_JOURNEY_SCHEMA_ID, signalJourney).valid) {
    return refused("record_unreadable", "link_invalid");
  }

  const body = {
    format: QUALITY_PROCESSING_FORMAT,
    dataset_id: row.dataset_id,
    recipe: recipe.name,
    recording,
    derivative: {
      key: row.key,
      version: row.version,
      recipe_version: row.recipe_version,
      retention: row.retention,
      stored_at: row.stored_at,
    },
    processing,
    signalJourney,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    ok: true,
    bytes,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
    sha256: await sha256HexOfBytes(bytes),
  };
}
