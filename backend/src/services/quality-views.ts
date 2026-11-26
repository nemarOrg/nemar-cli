/**
 * One recording's quality views, checked whole before anything of them is served (ADR 0137 decisions 6 and
 * 7, epic #2324 phase B2).
 *
 * `recordQualityEntry` (B1) projects a recording's `dataQuality` entry from the bytes of its signalJourney
 * record and checks what the entry states: its identity, its metrics and their producers, the head of each
 * view, the views skipped, the copy each store input names, the record's integers, each plugin view's
 * plugin against the recipe version's `quality` checkpoint, and `nemar.record-checks.v1`. This file adds
 * the rest:
 *
 *  - THE WHOLE DECLARATION. The entry, as `{ level: "record", recipes: { <recipe>: entry } }`, is checked
 *    against the vendored neuroschema 0.6.0 `dataQuality` schema, which reaches `view.schema.json` and the
 *    schema of every known kind, content and transform. The Worker cannot run Ajv, so the check is
 *    `shared/contract/schema-check.ts`, which interprets the vendored text itself and is held to
 *    python-jsonschema's verdicts and to Ajv by `test/schema-check-contract.unit.test.ts`.
 *  - RECORDING SCOPE. `subject`, `dataset` and `collection` are reserved and nothing reads them yet, so a
 *    view of another scope is refused here rather than served under a recording.
 *  - THE DECLARED FILES. The only files the route serves are the `data[]` files and the file `inputs[]` of
 *    a validated view (`declaredFiles`), each with its location, size and format. A digest declared twice
 *    with different sizes or formats cannot be one file and refuses the entry.
 *
 * Pure apart from Web Crypto; nothing here reads a database or a bucket.
 */

import bundle from "../../../shared/contract/neuroschema/dataset.bundle.json" with { type: "json" };
import { SchemaSet, schemasReachableFrom } from "../../../shared/contract/schema-check.js";
import { viewDigest } from "../../../shared/contract/view-digest.js";
import { type RecordEntryRefusal, recordQualityEntry } from "./quality-documents.js";

/** The schema every recording's document is checked against. */
export const DATA_QUALITY_SCHEMA_ID = "nsc:/extensions/dataQuality.schema.json";

let schemas: SchemaSet | null = null;

/** The vendored schemas `dataQuality` reaches, built once per isolate. */
export function qualitySchemas(): SchemaSet {
  if (schemas === null) {
    const all = (bundle as { schemas: Record<string, unknown>[] }).schemas;
    schemas = new SchemaSet(schemasReachableFrom(all, DATA_QUALITY_SCHEMA_ID));
  }
  return schemas;
}

/** One file a validated view declares: where it is in the product, its size, its format if it is data. */
export interface DeclaredFile {
  location: string;
  size: number;
  /**
   * The `format` of a `data[]` entry; for a file input, which declares none, the format its extension
   * names (`tsv` or `json`), else null.
   */
  format: string | null;
}

/**
 * Why a recording's views are not served, a fixed word: any of `recordQualityEntry`'s, the record says it is
 * of another dataset or recording than the one it was read for (`record_elsewhere`), or the entry breaks
 * the vendored schema (`declaration_invalid`), a view's scope is not `recording` (`view_scope_reserved`), or
 * one digest is declared as two different files (`view_files_inconsistent`).
 */
export type RecordingViewsRefusal =
  | RecordEntryRefusal
  | "record_elsewhere"
  | "declaration_invalid"
  | "view_scope_reserved"
  | "view_files_inconsistent";

export type RecordingViews =
  | {
      ok: true;
      /** The recording's `dataQuality` document: `{ level: "record", recipes: { <recipe>: entry } }`. */
      document: { level: "record"; recipes: Record<string, Record<string, unknown>> };
      /** The files the views declare, by SHA-256. */
      files: Map<string, DeclaredFile>;
      /** Each view's `nemar.view-digest.v1`, by view key. */
      digests: Record<string, string>;
    }
  | { ok: false; reason: RecordingViewsRefusal; at?: string };

// biome-ignore lint/suspicious/noExplicitAny: a declaration validated against the schema is read field by field
type Loose = Record<string, any>;

/**
 * The format a file input's location names: neuroschema's rule that a location ending in `.tsv` or `.json`,
 * in any case, is a file of that format (the extension and the format name each other); null otherwise.
 */
function formatOf(location: string): string | null {
  const lower = location.toLowerCase();
  if (lower.endsWith(".tsv")) return "tsv";
  if (lower.endsWith(".json")) return "json";
  return null;
}

/** The files a view declares, each with its digest: its `data[]` entries and its file inputs. */
export function viewFiles(view: Loose): (DeclaredFile & { sha256: string })[] {
  const out: (DeclaredFile & { sha256: string })[] = [];
  for (const d of (view.data ?? []) as Loose[]) {
    out.push({ location: d.location, size: d.size, format: d.format, sha256: d.sha256 });
  }
  for (const input of (view.inputs ?? []) as Loose[]) {
    const f = input.file as Loose | undefined;
    if (f !== undefined) {
      out.push({
        location: f.location,
        size: f.size,
        format: formatOf(f.location),
        sha256: f.sha256,
      });
    }
  }
  return out;
}

/**
 * A recording's views from the bytes of its record, checked whole (see the header), with the files they
 * declare and each view's digest. `stamp` is the derivative's recipe, recipe version, input and the
 * plugins that recipe version runs at `quality`; `expected` is what the record must say it is of.
 */
export async function recordingViews(
  bytes: Uint8Array,
  stamp: {
    recipe: string;
    recipeVersion: string;
    input: "bids" | "zarr";
    plugins: readonly string[];
  },
  /** The dataset (the derivative row's) and the recording the record was read for. */
  expected: { datasetId: string; recording: string },
): Promise<RecordingViews> {
  const projected = await recordQualityEntry(bytes, stamp);
  if (!projected.ok) return { ok: false, reason: projected.reason };
  if (
    projected.of.dataset !== expected.datasetId ||
    projected.of.recording !== expected.recording
  ) {
    return { ok: false, reason: "record_elsewhere" };
  }
  const entry = projected.entry;
  const document = { level: "record" as const, recipes: { [stamp.recipe]: entry } };
  const verdict = qualitySchemas().check(DATA_QUALITY_SCHEMA_ID, document);
  if (!verdict.valid) {
    return { ok: false, reason: "declaration_invalid", at: verdict.failure.at };
  }
  const files = new Map<string, DeclaredFile>();
  const digests: Record<string, string> = {};
  for (const view of entry.views as Loose[]) {
    if (view.scope !== undefined && view.scope !== "recording") {
      return { ok: false, reason: "view_scope_reserved" };
    }
    for (const file of viewFiles(view)) {
      const seen = files.get(file.sha256);
      if (seen === undefined) {
        files.set(file.sha256, { location: file.location, size: file.size, format: file.format });
        continue;
      }
      if (seen.size !== file.size) return { ok: false, reason: "view_files_inconsistent" };
      // Two entries of one digest name one format; a file input with no format of its own takes one.
      if (file.format !== null) {
        if (seen.format !== null && seen.format !== file.format) {
          return { ok: false, reason: "view_files_inconsistent" };
        }
        seen.format = file.format;
      }
    }
    digests[view.key as string] = await viewDigest(view);
  }
  return { ok: true, document, files, digests };
}
