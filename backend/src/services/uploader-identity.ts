/**
 * The uploader's citable identity (#1255, epic #1250).
 *
 * DOIs attribute the person who deposited the dataset. That attribution used
 * to be `users.username` — a NEMAR login handle like `jdoe23`, emitted into
 * DataCite as a `<contributorName>` and into Zenodo as a creator. A username
 * is not a name: it is not what the person is cited as anywhere else, it does
 * not decompose into given/family parts, and it cannot be reconciled with an
 * ORCID record. Migration 0051 added `users.given_name`/`users.family_name`
 * for exactly this, with ORCID as the canonical source.
 *
 * This module is the single place that turns those two nullable columns into
 * something citable, so every DOI path agrees on the answer AND on when there
 * is no answer. `null` is the whole point of the return type: a half-filled
 * name (given but no family) is NOT citable, and the correct response is to
 * block the mint (see the publish-block reason below), never to fall back to
 * the username.
 */

/** The owner columns every DOI-minting query must select. */
export interface OwnerNameColumns {
  given_name?: string | null;
  family_name?: string | null;
  orcid?: string | null;
}

/**
 * A complete, citable uploader identity. Constructed only by
 * {@link resolveUploaderIdentity}, so `name` is always derived from the two
 * parts rather than being a third, independently-settable string that could
 * disagree with them.
 */
export interface UploaderIdentity {
  /** DataCite name form: "Family, Given". */
  readonly name: string;
  readonly givenName: string;
  readonly familyName: string;
  /** Present only when the account carries an ORCID iD. */
  readonly orcid?: string;
}

/**
 * Build the uploader identity from an owner row, or `null` when the account
 * has no usable real name. Whitespace-only columns count as missing: they
 * would render as `<contributorName/>`, which EZID rejects outright (the
 * issue #459 failure mode).
 */
export function resolveUploaderIdentity(owner: OwnerNameColumns): UploaderIdentity | null {
  const givenName = owner.given_name?.trim();
  const familyName = owner.family_name?.trim();
  if (!givenName || !familyName) return null;
  const orcid = owner.orcid?.trim();
  return {
    name: `${familyName}, ${givenName}`,
    givenName,
    familyName,
    ...(orcid ? { orcid } : {}),
  };
}

/**
 * The same row shape as {@link OwnerNameColumns}, spelled the way every
 * dataset-owner JOIN aliases it (`u.given_name as owner_given_name`, ...).
 */
export interface OwnerNameAliases {
  owner_given_name?: string | null;
  owner_family_name?: string | null;
  owner_orcid?: string | null;
}

/** {@link resolveUploaderIdentity} over a dataset row's aliased owner columns. */
export function resolveOwnerIdentity(row: OwnerNameAliases): UploaderIdentity | null {
  return resolveUploaderIdentity({
    given_name: row.owner_given_name,
    family_name: row.owner_family_name,
    orcid: row.owner_orcid,
  });
}

/**
 * Must this dataset carry an uploader name before its DOI is minted?
 *
 * No for the two deposit kinds whose owner row is a NEMAR service or admin
 * account rather than the researcher being cited: OpenNeuro imports (the
 * attribution belongs to the BIDS Authors, and the import was reviewed
 * upstream) and the staging exemplar fleet (copies of public datasets, minted
 * on the EZID sandbox shoulder). This is the same exemption pair the
 * submission-minimums check already applies, and it exists to avoid a
 * deadlock: those accounts have no ORCID to backfill from, so a hard block
 * would strand imports with no in-product way to clear it.
 */
export function requiresUploaderName(dataset: {
  source?: string | null;
  is_exemplar?: number | null;
}): boolean {
  return dataset.source !== "openneuro" && !dataset.is_exemplar;
}

/**
 * `publication_requests.block_reason` value for an owner with no real name.
 *
 * A new block reason needs no migration: `block_reason` is a free TEXT column
 * (migration 0015) and only `status` carries a CHECK constraint. What a new
 * reason DOES need is an entry in the BLOCK_MESSAGES vocabulary in
 * routes/datasets/publication.ts, which is what renders it to the user both
 * in the 422 and later in GET /publish/status.
 */
export const OWNER_NAME_MISSING_REASON = "owner_name_missing";

/**
 * User-facing explanation for {@link OWNER_NAME_MISSING_REASON}.
 *
 * Names the two ways a user can actually fix it. ORCID is listed first
 * because it is canonical: a public name on the ORCID record flows in through
 * the signup lookup, the OAuth link refresh, and `nemar admin backfill-names`.
 */
export const OWNER_NAME_MISSING_MESSAGE =
  "DOIs cite the person who deposited the dataset by name, and this account has no " +
  "researcher name on file. Add a given name and family name in Settings on nemar.org, " +
  "or make your name public on your ORCID record and re-link ORCID, then re-request " +
  "publication. NEMAR will not cite you by your username.";
