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
 * #1168, and by the catalog-fact sweeps in routes/admin/datasets-lifecycle.ts,
 * issue #1496; the inline catalog/search/data predicates write the literal for
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
  /**
   * Required, not optional: the gate must not be callable without deciding it.
   * A caller that stops selecting the column is then a compile error rather
   * than a silent "not anonymous".
   */
  anonymous: number | null;
}

/**
 * True when a normally-blocked xx dataset is an exemplar that may proceed through
 * publish / DOI / reindex. Requires a non-production env AND an xx-prefix id AND
 * is_exemplar=1 AND that the row is not anonymous. Callers keep their existing
 * xx / is_sandbox block and skip it only when this returns true
 * (`... && !isExemplarPublishAllowed(env, row)`).
 *
 * **The anonymity term is defense in depth, not dead weight.** Both known
 * producers of such a row are now closed: `scripts/exemplar-fleet.json` declares
 * no anonymous entry and the loader refuses the key outright (#1433), and
 * `POST /admin/datasets/exemplar` refuses `anonymous: true` before anything is
 * created, writing the column as a literal 0 (#1434). Neither closure is a
 * reason to drop this term, because what it refuses is a row that reached the
 * table by some other route: a manual insert, a restored backup predating
 * #1434, or a later writer that forgets. It costs one boolean; being wrong
 * costs what the next paragraph describes.
 *
 * What it prevents: publishing an anonymous row does not dirty it but destroys
 * it, because the approve path stamps `first_published_at`, after which
 * migration 0085's triggers refuse `anonymous = 1` on that row forever.
 *
 * **What this function no longer does, and why (#1433).** It briefly took an
 * `ExemplarPublishIntent` so that an explicit `anonymousRelease` could pass the
 * anonymity term (#1423). That existed for one reason: the standing anonymous
 * deposit had been placed in the `xx` band, where publication is itself an
 * exception, so the one path the fixture needed was the one path the gate
 * refused. The right repair was not to widen the gate but to move the fixture
 * to a reserved `nm` id (ADR 0068, epic #1430), where an anonymous release is
 * an ordinary publication and no exception is involved. The parameter is gone
 * with the fixture it served.
 */
export function isExemplarPublishAllowed(
  env: Pick<Bindings, "ENVIRONMENT">,
  row: ExemplarGateRow,
): boolean {
  return (
    isNonProductionEnv(env) &&
    row.dataset_id.startsWith("xx") &&
    row.is_exemplar === 1 &&
    row.anonymous !== 1
  );
}

/**
 * True when a normally-blocked xx dataset is an exemplar that may be REINDEXED.
 *
 * Deliberately WITHOUT the anonymity term that `isExemplarPublishAllowed`
 * carries, because the two ask different questions. Publishing an anonymous
 * deposit destroys it; reindexing one is how it stays concealed. `markAnonymous`
 * returns `repoMetadataStale`, and only a fresh enrichment commit replaces the
 * `.nemar/metadata.json` that still names the depositor -- so blocking reindex
 * here would leave the repository's committed metadata un-blinded, which is the
 * opposite of what the anonymity term is for.
 */
export function isExemplarReindexAllowed(
  env: Pick<Bindings, "ENVIRONMENT">,
  row: Pick<ExemplarGateRow, "dataset_id" | "is_exemplar">,
): boolean {
  return isNonProductionEnv(env) && row.dataset_id.startsWith("xx") && row.is_exemplar === 1;
}

/**
 * SQL predicate fragment admitting exemplar rows through a visibility filter, e.g.
 * `(d.is_sandbox = 0 OR d.is_sandbox IS NULL OR ${exemplarOrFragment("d")})`.
 * Returns `<alias>.is_exemplar = 1` (or bare `is_exemplar = 1` when alias is "").
 * Safe on production because no is_exemplar=1 rows exist there. Canonical form used
 * by the programmatically-built reindex-filter SQL (buildReindexFilterQuery), by
 * the signal-defaults-sweep / availability-report candidate+remaining queries
 * (both unaliased, so called with alias=""), and by the archive, zarr,
 * channel-montage, hed and data-integrity sweeps and vectorize/reindex-all in
 * routes/admin/datasets-lifecycle.ts (#1496); the inline visibility predicates
 * in the catalog/search/data routes mirror `<alias>.is_exemplar = 1` literally
 * for SQL readability.
 */
export function exemplarOrFragment(alias = "d"): string {
  const col = alias ? `${alias}.is_exemplar` : "is_exemplar";
  return `${col} = 1`;
}
