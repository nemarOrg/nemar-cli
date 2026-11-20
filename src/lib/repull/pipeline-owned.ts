/**
 * The paths NEMAR's iEEG geometry pipeline owns on a mirror (ADR 0111, the amendment of 2026-11-19;
 * iEEG geometry plan, ruling 28).
 *
 * The pipeline commits computed `space-<label>` electrode and coordinate-system files, and lists
 * each in `.nemar/ieeg-geometry.json` with the inputs it was computed from. A re-pull does not
 * replay such a path as a correction: it is classified `pipeline-owned` (`overlay.ts`), N.0.0
 * follows upstream for it, and N.0.1 regenerates it by running the pipeline on the new snapshot
 * (`pipeline-run.ts`).
 *
 * The ownership file is NEMAR's own, so what it lists is not trusted to name anything: a listed
 * path that is not shaped like one of the pipeline's outputs is ignored (and counted), so an
 * ownership file can never take a privacy-relevant or upstream path out of the corrections.
 */

import { stripBom } from "./edits.js";

/** The ownership record, in NEMAR's mirror (never compared by the overlay: `.nemar/**`). */
export const OWNERSHIP_PATH = ".nemar/ieeg-geometry.json";

/**
 * The version of the Python package `scripts/ieeg_geometry` this release of the CLI runs. The
 * pipeline's outputs are a function of the snapshot and this version, so a re-pull asserts the
 * report names it (`test/repull-pipeline-owned.unit.test.ts` keeps it equal to the package's
 * `pyproject.toml`). A release that moves the package moves this value in the same change.
 */
export const IEEG_GEOMETRY_PIPELINE_VERSION = "0.1.0";

const OUTPUT_NAME = /_(?:electrodes\.tsv|coordsystem\.json)$/;

/**
 * A path the pipeline may own, write or remove: a subject's electrodes table or coordinate-system
 * sidecar, as a relative path of plain segments. The ownership file itself is handled apart.
 */
export function isPipelineOutputPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || /[\\\0]/.test(path)) return false;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  return (segments[0] as string).startsWith("sub-") && OUTPUT_NAME.test(segments.at(-1) as string);
}

export interface PipelineOwned {
  /** `absent`: no ownership file; `unreadable`: it does not parse (unknown is never none). */
  status: "absent" | "ok" | "unreadable";
  /** The listed paths that are shaped like the pipeline's outputs, sorted. */
  paths: string[];
  /** The listed paths that are not, left to the ordinary rules. */
  ignored: number;
}

/** The ownership record's listed paths, from its bytes (null when the file is absent). */
export function readPipelineOwned(bytes: Buffer | null): PipelineOwned {
  if (bytes === null) return { status: "absent", paths: [], ignored: 0 };
  let doc: unknown;
  try {
    doc = JSON.parse(stripBom(bytes.toString("utf8")));
  } catch {
    return { status: "unreadable", paths: [], ignored: 0 };
  }
  const record = doc as { schema?: unknown; paths?: unknown } | null;
  const listed = record?.paths;
  if (
    !record ||
    typeof record !== "object" ||
    record.schema !== 1 ||
    !listed ||
    typeof listed !== "object" ||
    Array.isArray(listed)
  ) {
    return { status: "unreadable", paths: [], ignored: 0 };
  }
  const all = Object.keys(listed);
  const paths = all.filter(isPipelineOutputPath).sort();
  return { status: "ok", paths, ignored: all.length - paths.length };
}

/**
 * The ownership record's bytes without the entries of `drop`: the file the pipeline is handed when
 * upstream added a file at an owned path (upstream wins; the path leaves the ownership list and is
 * never regenerated again). The bytes are the same as the input when nothing is dropped. Keys are
 * written sorted with two-space indentation and a final newline, as the pipeline writes them.
 */
export function withoutOwnedPaths(bytes: Buffer, drop: ReadonlySet<string>): Buffer {
  if (drop.size === 0) return bytes;
  const doc = JSON.parse(stripBom(bytes.toString("utf8"))) as { paths: Record<string, unknown> };
  const paths: Record<string, unknown> = {};
  for (const key of Object.keys(doc.paths).sort()) {
    if (!drop.has(key)) paths[key] = doc.paths[key];
  }
  return Buffer.from(`${JSON.stringify(sortKeys({ ...doc, paths }), null, 2)}\n`, "utf8");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
