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

/**
 * What the caller is asking to do, for the one case where the gate's answer
 * depends on it.
 *
 * Defaulted to `{}` rather than required: every existing caller is asking the
 * destructive question (mint a DOI, publish a DOI, publish for real), and the
 * safe default for a gate is to refuse. Only the publication-request route,
 * which knows whether the depositor asked for `--anonymous`, passes it.
 */
export interface ExemplarPublishIntent {
  /**
   * The caller is an ANONYMOUS release: row public, repository private,
   * attribution withheld, `first_published_at` left NULL. Never set this from
   * anything but the request's own flag -- inferring it from the row's current
   * `anonymous` value would make every plain publish of an anonymous deposit
   * look like an anonymous release, which is the exact confusion this
   * parameter exists to prevent.
   */
  anonymousRelease?: boolean;
}

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
 * is_exemplar=1 AND that this is not an attribution-ending publish of the
 * fleet's anonymous deposit. Callers keep their existing xx / is_sandbox block
 * and skip it only when this returns true
 * (`... && !isExemplarPublishAllowed(env, row)`).
 *
 * **The anonymity term is not belt-and-braces; it is the whole guard for one
 * dataset.** `xx099907` is the fleet's standing anonymous deposit, and
 * publishing it is not a mess to clean up: the approve path stamps
 * `first_published_at`, after which migration 0085's triggers refuse
 * `anonymous = 1` on that row FOREVER. The fixture is destroyed rather than
 * dirtied, which is what `scripts/exemplar-fleet.json` and AGENTS.md both warn
 * about, and the normal publication-request refusal does not cover it: a plain
 * (non-anonymous) publish request on an anonymous deposit is deliberately
 * allowed, because that is exactly how a blinded deposit is published for real.
 *
 * **`anonymousRelease` narrows that term to the direction it meant (#1423).**
 * The reasoning above is about an attribution-ending publish. An ANONYMOUS
 * release cannot do any of it: the orchestrator picks
 * `FIRST_PUBLICATION_STAMP_SQL` for that path, and that rule is
 * `CASE WHEN anonymous = 1 THEN first_published_at ELSE COALESCE(...) END` --
 * it deliberately does not stamp an anonymous row, so the triggers keep
 * permitting `anonymous = 1` and the fixture survives intact.
 *
 * Refusing it anyway had a cost that was not noticed until someone tried to
 * BUILD the fixture: an anonymous release is the only path that runs
 * `repo_public` (catalog row public, GitHub repo private) and `create_tag`
 * (version row + manifest), so without it `xx099907` can only ever be a
 * private row that the data plane will not serve. Every public-facing
 * anonymity surface -- the git-file broker, the catalog owner projection, the
 * search blind -- was therefore unreachable by the one fixture that exists to
 * exercise them, while AGENTS.md described it as "public row, private repo".
 * The gate was refusing the safe direction and allowing the destructive one.
 */
export function isExemplarPublishAllowed(
  env: Pick<Bindings, "ENVIRONMENT">,
  row: ExemplarGateRow,
  intent: ExemplarPublishIntent = {},
): boolean {
  return (
    isNonProductionEnv(env) &&
    row.dataset_id.startsWith("xx") &&
    row.is_exemplar === 1 &&
    (row.anonymous !== 1 || intent.anonymousRelease === true)
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
