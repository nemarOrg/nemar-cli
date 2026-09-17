/**
 * Anonymous deposit: the one place that says what "anonymous" means.
 *
 * A depositor submitting to a double-blind venue needs the data readable and
 * themselves concealed until the paper is accepted (epic #1406). The
 * data-plane phase (#1403, PR #1410) made the readable half possible by
 * serving a dataset's git-tracked metadata from `data.nemar.org`, so the
 * repository can stay private without the dataset becoming unreadable. This
 * module is the concealed half.
 *
 * **`markAnonymous` is called by exactly one path**, and that is the point:
 * `stepRepoPublic` in the publication orchestrator, at the moment an
 * admin-approved anonymous release makes the data readable (#1408). Anonymity
 * is asked for at publication rather than at upload, because the moment a
 * depositor wants concealment is the moment they want their data read; those
 * are not two decisions. The leak closures below were written before that path
 * existed, deliberately: a closure written after the route exists is written
 * against a live leak.
 *
 * Three rules, and the reasoning behind each is what keeps them from drifting:
 *
 * **Only before the identity has been public.** Retracting an attribution
 * that has already been published is theater: DataCite is harvested, the
 * landing page is indexed, and the git history is in every clone that exists.
 * So anonymity is a property of a deposit whose depositor has never been
 * named in public, and the flip that names them is one-way. The rule is
 * enforced by the database (migration 0085's two triggers), not only here,
 * because a rule that lives in a service is one a future route can forget.
 *
 * **Anonymity is toward the public, never toward NEMAR** (requirement R5).
 * `owner_user_id` keeps pointing at the real account throughout. Nothing here
 * anonymizes the archive's own records, which is also what makes
 * de-anonymization possible and what separates this from a drop box.
 *
 * **Withhold by construction, not by filtering.** Wherever NEMAR writes the
 * depositor's identity, the WRITER checks anonymity, so the public columns
 * never hold the real values. That matters more than it sounds:
 * `datasets.authors` reaches the full-text index through a trigger, with no
 * visibility predicate, so a query-time filter would leave the real names
 * searchable in the index while the API dutifully hid them. Two things cannot
 * be handled that way and so get explicit rules below: the owner, which is
 * joined from `users` at read time, and `?owner=`, which matches on the real
 * username in a `WHERE` clause that no projection can reach.
 */

import type { Bindings } from "../types/bindings.js";

/**
 * The column `isAnonymous` reads.
 *
 * REQUIRED, not optional, and that is the whole point of the type: an
 * optional field is assignable from a row whose `SELECT` never asked for the
 * column, so the predicate would quietly answer "no" and TypeScript would
 * raise nothing. Every anonymity decision here fails in the direction the
 * feature exists to prevent, so the compiler is the only reviewer that sees
 * every call site.
 */
export interface AnonymityFields {
  anonymous: number | null;
}

/**
 * The column `hasEverBeenPublished` reads, required for the same reason.
 *
 * Split from `AnonymityFields` rather than added to it because the two
 * predicates are asked at different places: most callers know only whether a
 * dataset is currently anonymous, and requiring a column they have no use for
 * would push them toward `SELECT *` or a cast. A caller that asks THIS
 * question must carry THIS column.
 */
export interface PublicationStampFields {
  first_published_at: string | null;
}

/** What a write to `datasets` actually did, so a caller can tell a no-op apart. */
export interface AnonymityWriteResult {
  /** False when the id matched no row: the caller's dataset is gone or misspelled. */
  changed: boolean;
}

/** `markAnonymous`, plus the one thing D1 cannot fix on its own. */
export interface MarkAnonymousResult extends AnonymityWriteResult {
  /**
   * True when an enrichment had already run, so `.nemar/metadata.json` in the
   * dataset repository still carries the real attribution and only a fresh
   * enrichment commit can replace it. D1 is scrubbed by `markAnonymous`
   * itself; the repository is not reachable from here without a circular
   * import, so the caller must run `runEnrichmentForDataset` when this is set.
   */
  repoMetadataStale: boolean;
}

/** Is this dataset currently concealing its depositor? */
export function isAnonymous(row: AnonymityFields | null | undefined): boolean {
  return row?.anonymous === 1;
}

/**
 * Has this dataset's depositor ever been named in public?
 *
 * Precisely that, and not "has the row ever been public": an anonymous
 * deposit IS `visibility = 'public'` (listed, browsable, downloadable) while
 * concealing its depositor, so a transition to public stamps this column only
 * when the row is not anonymous at that moment. `FIRST_PUBLICATION_STAMP_SQL`
 * is that rule, and it is what every path to public must use.
 *
 * Read the column, never re-derive it. The obvious substitutes are unsound:
 * `visibility` is current state with no history, and `concept_doi IS NULL`
 * fails because the publish orchestrator flips visibility before it mints the
 * DOI, so a crashed run leaves a public dataset with no DOI.
 */
export function hasEverBeenPublished(row: PublicationStampFields | null | undefined): boolean {
  return Boolean(row?.first_published_at);
}

/**
 * What the catalog says in place of an author list while a deposit is blind.
 *
 * It is a label, and it is ALSO read as one interlock, which is a distinction
 * worth keeping straight. What orders de-anonymization before publication is
 * the submission-minimums gate in `routes/datasets/publication.ts`, which
 * reads the depositor's own `dataset_description.json` from the repository and
 * refuses a publication whose `Authors` still names nobody. This column is not
 * that gate. What it IS read by is `blockedByUnrestoredAttribution` in the
 * publication orchestrator, which refuses to mint or publish a DOI while the
 * catalog still carries this string -- the same ordering stated as an
 * invariant, so a retry or a reordered step set cannot slip past it.
 *
 * An earlier draft of this module claimed ADR 0026's `PLACEHOLDER_AUTHOR`
 * matched this label and that the minimums gate therefore enforced the
 * ordering for free. Both halves were wrong at the time: the regex was
 * anchored (`^anonymous$`), and the gate reads the repository file, never this
 * column. The regex has since been widened to match `anonymous` as a leading
 * word, precisely so a depositor who copies this label into their own file is
 * not told it "names" someone; the second half is still true and is why the
 * interlock above reads the column directly.
 *
 * The ordering it protects is real: the depositor has to commit their
 * attribution while the repository is still private, since ADR 0001 makes
 * `main` pull-request-only once it is public.
 */
export const ANONYMOUS_AUTHORS_LABEL = "Anonymous (withheld until publication)";

/**
 * Why a DOI sync was skipped for a blinded deposit (`DoiSyncOutcome.reason`).
 *
 * It was ALSO a `publication_requests.block_reason` in phase 2, when an
 * anonymous dataset could not be published at all. #1408 replaced that flat
 * refusal with a conditional gate -- a normal request is exactly how a blinded
 * deposit gets published for real -- so the value left the contract enum and
 * migration 0086 clears the rows that carried it. It survives here because the
 * enrichment pass still has a real reason to skip: minting or refreshing a
 * DataCite record for a concealed depositor is the one write that cannot be
 * taken back (ADR 0041).
 */
export const ANONYMOUS_DEPOSIT_REASON = "anonymous_deposit";

/**
 * The identifiers a concealed deposit must not advertise to the public.
 *
 * None of them NAMES the depositor, which is why they are handled here rather
 * than by a writer: `github_repo` points at a repository that is private (so
 * the URL 404s while still disclosing that a repo exists under a predictable
 * name), and `concept_doi` and `latest_version_doi` are registered `reserved`
 * at EZID, so they do not resolve and must not be cited. `data-router.ts`
 * already withholds the first two from `external_links`; this is the same rule
 * for the catalog projections, which serve the raw columns.
 *
 * `latest_version_doi` joined the list with #1447. Before that, an anonymous
 * release skipped `version_doi` entirely, so the column was always NULL on a
 * concealed row and the gap was invisible; the release now mints the version
 * identifier RESERVED (it is also the only thing that dispatches the manifest
 * job), so the column is populated and non-resolving, which is exactly the
 * shape this rule exists for. The detail route reaches it through `SELECT d.*`
 * without naming it anywhere, which is why the rule is applied over the
 * assembled payload rather than written into each projection.
 *
 * Conditional on the VIEWER, unlike every other rule in this module, and that
 * is deliberate: anonymity is toward the public, never toward NEMAR or toward
 * the depositor themselves (requirement R5). `nemar dataset clone`, `commit`,
 * `push` and `ci` all read `github_repo` from these routes, and the depositor
 * needs exactly those commands to restore their attribution and end the
 * anonymity. Withholding from the owner would break the documented way out.
 */
export function withheldWhileAnonymous<T extends Record<string, unknown>>(
  row: T,
  viewerMayKnow: boolean,
): T {
  if (viewerMayKnow || row.anonymous !== 1) return row;
  return {
    ...row,
    ...("github_repo" in row ? { github_repo: null } : {}),
    ...("concept_doi" in row ? { concept_doi: null } : {}),
    ...("doi" in row ? { doi: null } : {}),
    ...("latest_version_doi" in row ? { latest_version_doi: null } : {}),
  };
}

/**
 * Owner identity, as SQL.
 *
 * `owner_username` and `owner_github` come from a join on `users`, so unlike
 * every other identifying field they cannot be kept out of the row by the
 * writer -- they are assembled at read time from a table that is not, and
 * must not be, anonymized. The catalog's list, detail and fallback queries
 * return their rows more or less straight to the client, so the withholding
 * has to happen in the projection itself rather than in a mapper that some
 * paths would bypass.
 *
 * Declared once here and interpolated at each site, so there is one answer to
 * when an owner is PROJECTED. It is not the only way the owner can leak:
 * `?owner=<username>` matches on the real username in a `WHERE` clause
 * (`services/dataset-filters.ts`) and the detail route serves the raw
 * `owner_user_id`, both handled at those sites.
 * `backend/test/anonymity-projection.test.ts` fails if any site spells the raw
 * join out instead -- the same source-level assertion
 * `test/data-summary-route.test.ts` uses to keep the summary route a
 * passthrough.
 *
 * `d` is the required alias for the `datasets` table at every call site.
 */
export const OWNER_USERNAME_SQL =
  "CASE WHEN d.anonymous = 1 THEN NULL ELSE u.username END AS owner_username";
export const OWNER_GITHUB_SQL =
  "CASE WHEN d.anonymous = 1 THEN NULL ELSE u.github_username END AS owner_github";

/**
 * The concept DOI, withheld for a concealed deposit, as a SQL projection.
 *
 * The same rule `withheldWhileAnonymous` applies in TypeScript, for the
 * projections that never build a row object to hand it -- the search tiers and
 * the MCP catalog row, which SELECT straight into a response shape.
 *
 * It exists because the rule had been written by hand three times
 * (`withheldWhileAnonymous`, `page-bundle.ts`, `data-router.ts`) and,
 * predictably, was missing from the fourth and fifth surfaces. A reserved
 * identifier does not resolve and must not be cited; handing one to a search
 * result or an MCP `citation` string gives a reader a ready-made dead DOI,
 * which is the harm ADR 0065 names.
 *
 * `d` must be the `datasets` alias, as with the owner projections above.
 */
export const CONCEPT_DOI_SQL = "CASE WHEN d.anonymous = 1 THEN NULL ELSE d.concept_doi END";

/**
 * What a dataset's GitHub repository SHOULD be, which is not always what its
 * catalog row says.
 *
 * An anonymous deposit is public in the catalog and private on GitHub: that
 * is the state, not drift. Every caller that reports on or MUTATES repository
 * visibility goes through this, so the two cannot disagree -- the drift
 * report (`routes/admin/fleet.ts`) would otherwise flag every anonymous
 * deposit as `PUBLIC_UNPROTECTED`, and the visibility service
 * (`services/visibility.ts`) would otherwise take a request for a public
 * catalog row as a request to publish the repository, disclosing the
 * depositor's entire git history while the catalog kept saying they were
 * concealed.
 *
 * `anonymous` is required rather than optional: every caller reads it from a
 * `SELECT`, and making it optional is what would let a future edit drop the
 * column from that `SELECT` and silently get the old answer back.
 */
export function expectedRepoVisibility(row: {
  visibility?: string | null;
  anonymous: number | null;
}): "public" | "private" {
  if (row.anonymous === 1) return "private";
  return row.visibility === "public" ? "public" : "private";
}

/**
 * The stamp every transition to `visibility = 'public'` must carry.
 *
 * Interpolated into the `SET` clause rather than expressed as a second
 * statement, because the triggers refuse a row that is both anonymous and
 * stamped, so a separate `UPDATE` would abort on whichever ran first.
 *
 * The `CASE` is the whole point: an anonymous deposit is deliberately made
 * public (listed, browsable, downloadable) while its depositor stays
 * concealed, and stamping there would both trip the trigger and record a
 * publication of an identity that has not been published. So the stamp is
 * taken only when the row is not anonymous, which makes the column mean "the
 * depositor has been named in public" -- exactly the fact the triggers need.
 *
 * `COALESCE` keeps the FIRST publication: a dataset withdrawn and republished
 * has still been public since the first time, and that is what the one-way
 * door turns on. `backend/test/anonymity-publication-paths.test.ts` fails if
 * any `visibility = 'public'` update omits this.
 */
export const FIRST_PUBLICATION_STAMP_SQL =
  "first_published_at = CASE WHEN anonymous = 1 THEN first_published_at ELSE COALESCE(first_published_at, datetime('now')) END";

/**
 * Strip the depositor-identifying parts of an enrichment document.
 *
 * `.nemar/metadata.json` is written by the BACKEND as `nemarAdmin`, not by
 * the depositor -- the CLI gitignores it -- so no depositor-side scrub can
 * suppress it, and the next enrichment run would rewrite whatever was
 * scrubbed. It is also, since #1403, publicly readable: it is a git-tracked
 * file, so it appears in the published manifest and the data plane serves it.
 * That makes this function the difference between a blind deposit and a blind
 * deposit with the author list one URL away.
 *
 * `title`, `description`, `methods_description` and the recording-level
 * fields are left alone: they describe the DATA, and blanking them would
 * conceal the thing a reviewer is meant to read. What goes is everything that
 * names a person or the group they work in: authors and contributors, the
 * funding references that name a lab through its grants, the geo-locations
 * that name its institution or city, and the related identifiers that
 * typically point straight at the submitting group's own preprint.
 */
export function blindEnrichmentMetadata<T extends object>(metadata: T): T {
  const { authors, contributors, funding_references, geo_locations, related_identifiers, ...rest } =
    metadata as T & {
      authors?: unknown;
      contributors?: unknown;
      funding_references?: unknown;
      geo_locations?: unknown;
      related_identifiers?: unknown;
    };
  return rest as T;
}

/**
 * The top-level enrichment keys `blindEnrichmentMetadata` removes.
 *
 * Exported because the anonymity sweep (#1409) re-checks them: the blind is a
 * claim about what the cache and the committed document hold, and a claim
 * nothing re-reads is a claim that stops being true quietly.
 */
export const BLINDED_METADATA_KEYS = [
  "authors",
  "contributors",
  "funding_references",
  "geo_locations",
  "related_identifiers",
] as const;

/** The same keys as JSON paths, for the D1-side scrub below. */
const BLINDED_METADATA_PATHS = BLINDED_METADATA_KEYS.map((key) => `$.${key}`);

/**
 * Turn anonymity on, and scrub what a previous enrichment already published.
 *
 * The flag alone would be a promise NEMAR had already broken: enrichment runs
 * automatically on upload, so by the time a depositor asks for anonymity the
 * real names are usually in `datasets.authors` (hence in `datasets_fts`, fed
 * by a trigger with no visibility predicate), in the `enrichment_json` cache
 * that `GET /datasets/:id` serves raw, and committed to `.nemar/metadata.json`.
 * The writer-side blind only governs the NEXT run. So this statement does the
 * D1 half atomically, and the result names the half it cannot reach.
 *
 * `json_valid` guards the scrub: a malformed cached document is dropped
 * entirely rather than left in place, because `json_remove` on invalid JSON
 * would abort the whole statement and leave the dataset un-anonymized.
 *
 * The write can still be refused by the database when the depositor has
 * already been named in public -- that refusal is the invariant, not a bug --
 * so callers must let the error propagate rather than assuming success.
 */
export async function markAnonymous(
  env: Bindings,
  datasetId: string,
): Promise<MarkAnonymousResult> {
  const before = await env.DB.prepare(
    "SELECT enrichment_json IS NOT NULL AS enriched, first_published_at FROM datasets WHERE dataset_id = ?",
  )
    .bind(datasetId)
    .first<{ enriched: number; first_published_at: string | null }>();

  // The database is the guard -- the triggers refuse this write regardless of
  // what happens here. This check exists to turn their ABORT, which names no
  // dataset, into a sentence a route can hand to a person.
  if (hasEverBeenPublished(before)) {
    throw new Error(
      `${datasetId} has been published (first_published_at=${before?.first_published_at}), so it cannot become anonymous. Retracting an attribution that is already public is not something NEMAR can deliver.`,
    );
  }

  const result = await env.DB.prepare(
    `UPDATE datasets
     SET anonymous = 1,
         authors = ?,
         enrichment_json = CASE
           WHEN enrichment_json IS NULL THEN NULL
           WHEN json_valid(enrichment_json) THEN json_remove(enrichment_json, ${BLINDED_METADATA_PATHS.map(
             (p) => `'${p}'`,
           ).join(", ")})
           ELSE NULL
         END
     WHERE dataset_id = ?`,
  )
    .bind(ANONYMOUS_AUTHORS_LABEL, datasetId)
    .run();

  const changed = result.success && result.meta.changes > 0;
  return { changed, repoMetadataStale: changed && before?.enriched === 1 };
}

/**
 * Ending anonymity, as SQL: the two columns that must move together.
 *
 * ONE fragment, interpolated into the `UPDATE` that makes the repository
 * public, rather than a second statement. Migration 0085's triggers refuse a
 * row that is simultaneously anonymous and published, so clearing the flag
 * and stamping the date separately would abort on whichever ran first -- and
 * a crash between two statements would leave a dataset public in the world
 * and anonymous in D1, with nothing to retry it.
 *
 * `COALESCE` keeps the FIRST publication: a dataset withdrawn and republished
 * has still been public since the first time.
 */
export const END_ANONYMITY_AT_PUBLICATION_SQL =
  "anonymous = 0, first_published_at = COALESCE(first_published_at, datetime('now'))";
