/**
 * Live production dataset repos that hold REAL data. Automated governance and
 * admin sweeps must never mutate these without an explicit override. This
 * mirrors the LIVE datasets called out in AGENTS.md ("nm000103-nm000107 are
 * LIVE datasets. Do NOT modify ...").
 *
 * Usage:
 *  - Bulk mutators (`enforce/bulk`) exclude these outright, alongside the
 *    test dataset `nm099999`.
 *  - Single-dataset mutators (`ci/sync`, `enforce` with `dry_run:false`)
 *    refuse them unless the caller passes `?force=true` for a deliberate,
 *    one-off override.
 */
export const LIVE_DATASETS: ReadonlySet<string> = new Set([
  "nm000103",
  "nm000104",
  "nm000105",
  "nm000106",
  "nm000107",
]);

export function isLiveDataset(datasetId: string): boolean {
  return LIVE_DATASETS.has(datasetId);
}
