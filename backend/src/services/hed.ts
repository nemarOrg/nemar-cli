/**
 * HED (Hierarchical Event Descriptors) detection for the catalog (epic #869,
 * phase 2 / #871). Pure helpers: read `HEDVersion` from a parsed
 * `dataset_description.json` and decide whether a BIDS events sidecar carries a
 * real HED annotation. The enrichment path (`getBidsTreeStats` -> `probeHed`)
 * samples the root description + exemplar `*_events.json` / `*_events.tsv` and
 * feeds the content here; everything in this module is I/O-free and unit-tested
 * with real-shape BIDS inputs.
 *
 * Detection rule (migration 0056 header): a dataset "has HED" only when
 * `dataset_description.json` declares a `HEDVersion` AND at least one real HED
 * annotation exists -- an `*_events.json` column whose object has a `"HED"` key,
 * OR an `*_events.tsv` with a literal `HED` column. This module supplies the two
 * halves; `probeHed` ANDs them.
 */

/**
 * Extract the `HEDVersion` declaration from a parsed `dataset_description.json`.
 *
 * BIDS allows `HEDVersion` to be a scalar string ("8.4.0") or an array of schema
 * strings when multiple HED libraries are used (["8.3.0", "sc:score_1.0.0"]).
 * The array form is collapsed to a comma-joined string so it fits the single
 * `hed_version` TEXT column. Returns null when absent/blank/wrong-typed.
 */
export function parseHedVersion(desc: unknown): string | null {
  if (typeof desc !== "object" || desc === null) return null;
  const v = (desc as Record<string, unknown>).HEDVersion;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(v)) {
    const parts = v
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    return parts.length > 0 ? parts.join(",") : null;
  }
  return null;
}

/**
 * True when a BIDS `*_events.json` sidecar carries a HED annotation: any
 * top-level column definition whose value is an object containing a `"HED"` key.
 * That covers both value-level (`"HED": "Label/#"`) and categorical
 * (`"HED": { "go": "..." }`) annotations. Returns false on parse error or when
 * no column declares HED.
 */
export function eventsJsonHasHed(content: string): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof obj !== "object" || obj === null) return false;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null && "HED" in value) return true;
  }
  return false;
}

/**
 * True when a BIDS `*_events.tsv` has a literal `HED` column (assembled HED
 * strings annotated per row). Only the header row is inspected. Returns false
 * on an empty file or when no header cell is exactly `HED`.
 */
export function eventsTsvHasHed(content: string): boolean {
  const firstLine = content.split(/\r?\n/, 1)[0];
  if (!firstLine) return false;
  return firstLine.split("\t").some((cell) => cell.trim() === "HED");
}
