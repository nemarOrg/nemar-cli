/**
 * Fleet revalidation helpers (epic #713, Phase 6 / #733).
 *
 * Pure target-selection for `nemar admin fleet revalidate --all/--prefix`.
 * The backend `POST /admin/datasets/:id/revalidate` endpoint is the real
 * live-dataset guard (returns 403); this CLI-side exclusion just avoids wasting
 * calls on datasets that would be skipped or refused anyway.
 */

/** Live production datasets — mirror of backend `LIVE_DATASETS` (constants.ts). */
export const CLI_LIVE_DATASETS: ReadonlySet<string> = new Set([
  "nm000103",
  "nm000104",
  "nm000105",
  "nm000106",
  "nm000107",
]);

export interface RevalidateTargetInput {
  dataset_id: string;
  visibility?: string;
}

/**
 * Select datasets eligible for a bulk revalidate: public nm/on repos, excluding
 * the test dataset (nm099999) and the live datasets. Honors an optional id
 * prefix. Returns sorted ids.
 */
export function selectRevalidateTargets(
  datasets: RevalidateTargetInput[],
  opts: { prefix?: string },
): string[] {
  return datasets
    .filter((d) => d.visibility === "public")
    .map((d) => d.dataset_id)
    .filter((id) => id.startsWith("nm") || id.startsWith("on"))
    .filter((id) => id !== "nm099999" && !CLI_LIVE_DATASETS.has(id))
    .filter((id) => (opts.prefix ? id.startsWith(opts.prefix) : true))
    .sort();
}
