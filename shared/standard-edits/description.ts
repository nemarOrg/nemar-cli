/**
 * NEMAR's standard edit to a dataset's `dataset_description.json`: the concept DOI.
 *
 * It lives in `shared/` because three places have to make or recognize exactly this edit: the
 * publication orchestrator's `update_metadata` step (which reaches it through
 * `backend/src/services/doi.ts`), the #1386 repair (`scripts/repair-doi-metadata.ts`), and the
 * upstream re-pull's planner (ADR 0111), which runs in the CLI and must tell this edit apart from
 * a contributor's change. A copy in any one of them would drift from the others.
 *
 * Pure: no I/O, and no import from Node or the Worker runtime, so the Worker bundle and the CLI
 * both load it. Its two imports are shared modules held to the same rule.
 */

import { normalizeDoiKey } from "../never-data-paper.js";
import { openNeuroDatasetOfDoi, openNeuroUrlParts } from "../openneuro-tag.js";

/**
 * Put NEMAR's concept DOI into a dataset_description.json, keeping whatever DOI was
 * there before as a source.
 *
 * An imported dataset arrives carrying OpenNeuro's DOI. Overwriting it outright would
 * erase the provenance link, so the previous value moves into `SourceDatasets` -- the
 * BIDS field for exactly that -- and only then does `DatasetDOI` become ours. Both
 * the publication orchestrator and the #1386 repair go through here, because they are
 * the same edit made at different times and must not drift.
 *
 * Pure, and idempotent: re-running on a description that already carries the concept
 * DOI adds nothing and duplicates no source.
 */
export function applyConceptDoiToDescription(
  description: Record<string, unknown>,
  conceptDoi: string,
): { description: Record<string, unknown>; changed: boolean; preservedSourceDoi?: string } {
  const next = { ...description };
  let changed = false;
  let preservedSourceDoi: string | undefined;

  const existingDoi = next.DatasetDOI;
  if (typeof existingDoi === "string" && existingDoi && existingDoi !== conceptDoi) {
    // A `SourceDatasets` that is not an array is not ours to discard. BIDS says
    // array, but an imported description can carry an object or a string, and
    // replacing it wholesale would erase provenance on published metadata during a
    // bulk repair. Keep it as the first entry instead.
    const existing = next.SourceDatasets;
    const sources: Array<Record<string, unknown>> = Array.isArray(existing)
      ? [...(existing as Array<Record<string, unknown>>)]
      : existing === undefined || existing === null
        ? []
        : [existing as Record<string, unknown>];
    // Compared as DOIs, not as strings: `doi:` and resolver prefixes and letter case do not make
    // a different DOI. And an entry for the same OpenNeuro dataset already present -- the one an
    // import records for the snapshot it mirrors (ADR 0111 decision 10) -- is not joined by a
    // second, from upstream's own DatasetDOI: NEMAR owns one entry per mirrored `ds`, and two that
    // named different versions would leave the recorded upstream tag unknown. So upstream's own
    // DatasetDOI is dropped when an entry for the same `ds` exists at another tag, older or newer;
    // moving the entry to a new tag is a re-pull's edit, never publication's. Entries of any
    // shape, `null` included, are tolerated: only an object can match.
    const ds = openNeuroDatasetOfDoi(existingDoi);
    const alreadyPresent = sources.some((s) => {
      if (typeof s !== "object" || s === null) return false;
      const doi = typeof s.DOI === "string" ? s.DOI : null;
      const url = typeof s.URL === "string" ? s.URL : null;
      if (doi !== null && normalizeDoiKey(doi) === normalizeDoiKey(existingDoi)) return true;
      if (ds === null) return false;
      return (
        (doi !== null && openNeuroDatasetOfDoi(doi) === ds) ||
        (url !== null && openNeuroUrlParts(url)?.ds === ds)
      );
    });
    if (!alreadyPresent) {
      sources.push({ DOI: existingDoi });
      next.SourceDatasets = sources;
      preservedSourceDoi = existingDoi;
      changed = true;
    }
  }

  if (next.DatasetDOI !== conceptDoi) {
    next.DatasetDOI = conceptDoi;
    changed = true;
  }

  // A published dataset needs a Version; the orchestrator defaults it here so
  // create_tag does not have to write a separate [skip ci] commit.
  if (!next.Version) {
    next.Version = "1.0.0";
    changed = true;
  }

  return { description: next, changed, preservedSourceDoi };
}
