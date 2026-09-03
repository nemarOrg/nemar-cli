/**
 * Exemplar gating (epic #923, Phase 4).
 *
 * A small fleet of xx-prefixed "exemplar" datasets (is_exemplar=1) are curated
 * copies of real datasets that must pass through the full publish / DOI / reindex
 * pipeline on the staging environment (test.nemar.org). Each xx gate in the
 * publish / DOI / reindex / visibility paths is relaxed to "block unless
 * exemplar-allowed" via isExemplarPublishAllowed(); the visibility predicates
 * admit exemplars with an `is_exemplar = 1` SQL fragment — canonicalized as
 * exemplarOrFragment() (used by the programmatic reindex-filter query and by
 * the signal-defaults-sweep / availability-report backfill sweeps, issue
 * #1168; the inline catalog/search/data predicates write the literal for
 * readability). Note the `nemar admin summary` coverage query
 * (manifest-coverage.ts) is the one xx filter deliberately left broad; it is
 * an internal report, not a gate.
 *
 * Safety invariant (migration 0057): is_exemplar=1 rows never exist in
 * production. Today that holds because nothing writes the column; once Phase 5's
 * creation endpoint ships it will 403 in production. So the SQL fragment is safe
 * to append unconditionally and the gate stays a single env-independent
 * predicate. The runtime publish gate ALSO requires a non-production ENVIRONMENT
 * as defense in depth.
 */

import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";

/** Minimal row shape the publish gate needs. */
export interface ExemplarGateRow {
  dataset_id: string;
  is_exemplar?: number | null;
}

/**
 * True when a normally-blocked xx dataset is an exemplar that may proceed through
 * publish / DOI / reindex. Requires a non-production env AND an xx-prefix id AND
 * is_exemplar=1. Callers keep their existing xx / is_sandbox block and skip it
 * only when this returns true (`... && !isExemplarPublishAllowed(env, row)`).
 */
export function isExemplarPublishAllowed(
  env: Pick<Bindings, "ENVIRONMENT">,
  row: ExemplarGateRow,
): boolean {
  return isNonProductionEnv(env) && row.dataset_id.startsWith("xx") && row.is_exemplar === 1;
}

/**
 * SQL predicate fragment admitting exemplar rows through a visibility filter, e.g.
 * `(d.is_sandbox = 0 OR d.is_sandbox IS NULL OR ${exemplarOrFragment("d")})`.
 * Returns `<alias>.is_exemplar = 1` (or bare `is_exemplar = 1` when alias is "").
 * Safe on production because no is_exemplar=1 rows exist there. Canonical form used
 * by the programmatically-built reindex-filter SQL (buildReindexFilterQuery) and by
 * the signal-defaults-sweep / availability-report candidate+remaining queries
 * (both unaliased, so called with alias=""); the inline visibility predicates
 * in the catalog/search/data routes mirror `<alias>.is_exemplar = 1` literally
 * for SQL readability.
 */
export function exemplarOrFragment(alias = "d"): string {
  const col = alias ? `${alias}.is_exemplar` : "is_exemplar";
  return `${col} = 1`;
}
