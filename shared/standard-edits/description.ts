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
 * both load it.
 */

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
    const alreadyPresent = sources.some((s) => typeof s.DOI === "string" && s.DOI === existingDoi);
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
