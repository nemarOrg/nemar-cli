/**
 * Anonymous deposit: the one place that says what "anonymous" means.
 *
 * A depositor submitting to a double-blind venue needs the data readable and
 * themselves concealed until the paper is accepted (epic #1406). Phase 1
 * (#1403) made the readable half possible by serving a dataset's metadata
 * from the data plane, so the repository can stay private without the dataset
 * becoming unreadable. This module is the concealed half.
 *
 * Three rules, and the reasoning behind each is what keeps them from drifting:
 *
 * **Only before first publication.** Retracting an attribution that has
 * already been public is theatre: DataCite is harvested, the landing page is
 * indexed, and the git history is in every clone that exists. So anonymity is
 * a property of a pre-publication deposit, and publication is the one-way
 * flip that ends it. The rule is enforced by the database (migration 0085's
 * two triggers), not only here, because a rule that lives in a service is one
 * a future route can forget.
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
 * searchable in the index while the API dutifully hid them. The only field
 * that cannot be handled this way is the owner, which is joined from `users`
 * at read time -- so that one gets an explicit projection rule below.
 */

import type { Bindings } from "../types/bindings.js";

/** The columns any anonymity decision reads. */
export interface AnonymityFields {
  anonymous?: number | null;
  first_published_at?: string | null;
}

/** Is this dataset currently concealing its depositor? */
export function isAnonymous(row: AnonymityFields | null | undefined): boolean {
  return row?.anonymous === 1;
}

/**
 * Has this dataset ever been public?
 *
 * Read the column, never re-derive it. The obvious substitutes are unsound:
 * `visibility` is current state with no history, and `concept_doi IS NULL`
 * fails because the publish orchestrator flips visibility three steps before
 * it mints the DOI, so a crashed run leaves a public dataset with no DOI.
 */
export function hasEverBeenPublished(row: AnonymityFields | null | undefined): boolean {
  return Boolean(row?.first_published_at);
}

/**
 * What the catalog says in place of an author list while a deposit is blind.
 *
 * Deliberately a string ADR 0026's `PLACEHOLDER_AUTHOR` matches. That gate
 * already refuses a publication request whose authors are placeholders, so
 * this label is what makes "you cannot publish while still blinded" an
 * existing, tested interlock rather than a new check: a depositor must commit
 * their real attribution before publication will proceed, which is exactly
 * the ordering de-anonymization needs (the commit has to land while the repo
 * is still private, because ADR 0001 makes `main` pull-request-only once it
 * is public).
 */
export const ANONYMOUS_AUTHORS_LABEL = "Anonymous (withheld until publication)";

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
 * "when is an owner disclosed". `backend/test/anonymity-projection.test.ts`
 * fails if any site spells the raw join out instead -- the same source-level
 * assertion `test/data-summary-route.test.ts` uses to keep the summary route
 * a passthrough.
 *
 * `d` is the required alias for the `datasets` table at every call site.
 */
export const OWNER_USERNAME_SQL =
  "CASE WHEN d.anonymous = 1 THEN NULL ELSE u.username END AS owner_username";
export const OWNER_GITHUB_SQL =
  "CASE WHEN d.anonymous = 1 THEN NULL ELSE u.github_username END AS owner_github";

/**
 * Strip the depositor-identifying parts of an enrichment document.
 *
 * `.nemar/metadata.json` is written by the BACKEND as `nemarAdmin`, not by
 * the depositor -- the CLI gitignores it -- so no depositor-side scrub can
 * suppress it, and the next enrichment run would rewrite whatever was
 * scrubbed. It is also, since #1403, publicly readable: it is a git-tracked
 * file, so it appears in the published manifest and the data plane serves it
 * (verified on nm000104, where it returns 200 and names three authors). That
 * makes this function the difference between a blind deposit and a blind
 * deposit with the author list one URL away.
 *
 * `title`, `description`, `methods_description` and the recording-level
 * fields are left alone: they describe the DATA, and blanking them would
 * conceal the thing a reviewer is meant to read. What goes is the structured
 * attribution -- authors, contributors, and the funding references that name
 * a lab through its grants.
 */
export function blindEnrichmentMetadata<T extends object>(metadata: T): T {
  const { authors, contributors, funding_references, ...rest } = metadata as T & {
    authors?: unknown;
    contributors?: unknown;
    funding_references?: unknown;
  };
  return rest as T;
}

/**
 * Turn anonymity on.
 *
 * The write can still be refused by the database when the dataset has been
 * published -- that refusal is the invariant, not a bug -- so callers must
 * surface the error rather than assuming success.
 */
export async function markAnonymous(env: Bindings, datasetId: string): Promise<void> {
  await env.DB.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = ?")
    .bind(datasetId)
    .run();
}

/** Turn anonymity off without publishing (a depositor changing their mind). */
export async function clearAnonymous(env: Bindings, datasetId: string): Promise<void> {
  await env.DB.prepare("UPDATE datasets SET anonymous = 0 WHERE dataset_id = ?")
    .bind(datasetId)
    .run();
}

/**
 * Record the first publication, and end anonymity in the same statement.
 *
 * ONE statement, deliberately. The triggers refuse a row that is
 * simultaneously anonymous and published, so clearing the flag and stamping
 * the date as two updates would abort on whichever ran first. Doing both at
 * once is also the honest description of what publication is.
 *
 * `first_published_at` is written only if it is not already set: it records
 * the FIRST publication, and a dataset that is withdrawn and republished has
 * still been public since the first time.
 */
export async function recordFirstPublication(env: Bindings, datasetId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE datasets
     SET anonymous = 0,
         first_published_at = COALESCE(first_published_at, datetime('now'))
     WHERE dataset_id = ?`,
  )
    .bind(datasetId)
    .run();
}
