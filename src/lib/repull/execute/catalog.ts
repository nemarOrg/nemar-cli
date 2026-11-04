/**
 * The two NEMAR API reads a re-pull plan starts from (ADR 0111, epic #1046): the dataset row and
 * its version rows. `nemar admin repull plan` makes them before it plans, and execution makes them
 * again before it re-plans, because the plan's preflight is recomputed from live sources and never
 * read from a file.
 *
 * Both are GETs through the API client, outside the planner's read-only guard. A 404 on the
 * versions route (a backend without it) leaves the rows unknown (`null`); it is never read as "no
 * rows", because no rows would let a version check pass that has nothing to check.
 */

import { getDataset, getVersionHistory } from "../../api/datasets.js";
import { ApiError } from "../../api/errors.js";
import type { CatalogFacts } from "../plan.js";

/** The dataset row (null when it does not exist) and its version rows (null when unreadable). */
export async function readCatalogFacts(datasetId: string): Promise<CatalogFacts> {
  let dataset: CatalogFacts["dataset"] = null;
  try {
    dataset = await getDataset(datasetId);
  } catch (err) {
    if (!(err instanceof ApiError && err.statusCode === 404)) throw err;
  }
  let versions: CatalogFacts["versions"] = null;
  if (dataset) {
    try {
      const history = await getVersionHistory(datasetId);
      versions = history.versions.map((v) => ({
        version: v.version,
        source_version: v.source_version ?? null,
        source_version_basis: v.source_version_basis ?? null,
      }));
    } catch (err) {
      if (!(err instanceof ApiError && err.statusCode === 404)) throw err;
    }
  }
  return { dataset, versions };
}
