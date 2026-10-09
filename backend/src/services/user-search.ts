/**
 * Admin account search and the columns an admin may read (ADR 0093).
 *
 * `GET /admin/users?q=` has to look at "all fields" of an account without
 * becoming an oracle for the fields that must never be read, and it has to stay
 * true as the table grows. Both come from ONE classification of every `users`
 * column, {@link USER_COLUMN_ROLES}; the search SQL, the detail SELECT and the
 * test that fails on an unclassified column are all derived from it. A column
 * added by a migration with no entry here fails
 * `backend/test/admin-user-search.test.ts` until someone decides what it is.
 *
 * WHY ONE HAYSTACK AND NOT A LIKE PER COLUMN. D1 allows 100 bound parameters
 * per statement. A `LIKE ?` on each of ~25 columns costs 25 per search word, so
 * a four-word query is already over the limit. Concatenating the searchable
 * columns into one lower-cased string costs one parameter per word, and a word
 * is looked for with `instr()` rather than `LIKE`, so `%` and `_` in what the
 * admin types are ordinary characters and need no escaping.
 *
 * MATCHING. Every word must be found somewhere in the account (AND), in any
 * column, so `ada lovelace` finds given name Ada with family name Lovelace and
 * `ucsd 2026-09` finds an affiliation plus a creation month. Case-insensitive
 * for ASCII only, exactly like SQLite's `LIKE`: both the stored text and the
 * word are folded by the same `lower()`, so `Ekström` is found by `ekström` but
 * not by `EKSTRÖM`.
 */

import {
  ADMIN_USER_SEARCH_MAX_TERMS,
  ADMIN_USER_SEARCH_MAX_TERM_CHARS,
} from "../../../shared/contract/admin-user.js";

/**
 * What a `users` column is to the admin lookup.
 *
 *   id      the primary key. Matched exactly, and only by a purely numeric word.
 *   text    searched (as a substring) and returned. Everything an admin would
 *           read off an account.
 *   flag    returned, NOT searched. A 0/1 column searched as text makes the word
 *           `1` match every account; the tier and status filters
 *           (`--verified`, `--no-upload-access`, ...) are how flags are asked for.
 *   ref     returned, NOT searched. A numeric pointer to another user, which as
 *           text would match unrelated rows.
 *   secret  NEVER searched and NEVER returned. A credential, a hash, a token, or
 *           the expiry that belongs to one. Searching a secret is an oracle: an
 *           admin could recover a hash prefix by prefix from the match count.
 *   omit    neither searched nor returned. Not a secret; just not account
 *           detail (the notification preferences have their own route).
 */
export type UserColumnRole = "id" | "text" | "flag" | "ref" | "secret" | "omit";

/**
 * Every column of `users`, classified. Keep in step with the migrations; the
 * test compares this table's keys with `PRAGMA table_info(users)` on a fully
 * migrated database, in both directions.
 */
export const USER_COLUMN_ROLES: Readonly<Record<string, UserColumnRole>> = {
  id: "id",

  username: "text",
  email: "text",
  github_username: "text",
  orcid: "text",
  given_name: "text",
  family_name: "text",
  affiliation: "text",
  city: "text",
  country: "text",
  description: "text",
  status: "text",
  role: "text",
  account_kind: "text",
  signup_source: "text",
  aws_iam_username: "text",
  sandbox_dataset_id: "text",
  created_at: "text",
  updated_at: "text",
  approved_at: "text",
  revoked_at: "text",
  deleted_at: "text",
  sandbox_completed_at: "text",
  service_access_granted_at: "text",
  upload_access_requested_at: "text",
  upload_access_notified_at: "text",

  email_verified: "flag",
  orcid_verified: "flag",
  service_access: "flag",
  sandbox_completed: "flag",
  identity_conflict: "flag",
  username_auto_assigned: "flag",

  service_access_granted_by: "ref",

  password_hash: "secret",
  verification_token: "secret",
  verification_expires_at: "secret",
  aws_access_key_id_encrypted: "secret",
  aws_secret_access_key_encrypted: "secret",

  email_preferences: "omit",
};

function columnsWithRole(...roles: UserColumnRole[]): string[] {
  return Object.entries(USER_COLUMN_ROLES)
    .filter(([, role]) => roles.includes(role))
    .map(([column]) => column);
}

/** Columns searched as text, in the order they are checked and reported. */
export const USER_SEARCH_TEXT_COLUMNS: readonly string[] = columnsWithRole("text");

/** Columns that must never be searched or returned. */
export const USER_SECRET_COLUMNS: readonly string[] = columnsWithRole("secret");

/**
 * The `SELECT` list for one account's details, prefixed with the table alias
 * `u`. An explicit list, never `u.*`: `SELECT *` is how a credential column
 * added next year, or the ones added years ago, ends up in an admin's terminal.
 */
export const ADMIN_USER_DETAIL_SELECT: string = columnsWithRole("id", "text", "flag", "ref")
  .map((column) => `u.${column}`)
  .join(", ");

/**
 * Every column that is NOT a secret, prefixed `u.`: {@link ADMIN_USER_DETAIL_SELECT}
 * plus the `omit` columns (today the notification preferences).
 *
 * For the older username-keyed `GET /admin/users/:username`, which has always
 * returned the whole row. The fix for it removes the credentials and nothing
 * else, so a caller reading a non-secret column from it keeps working; new
 * routes use the narrower list above.
 */
export const ADMIN_USER_NON_SECRET_SELECT: string = columnsWithRole(
  "id",
  "text",
  "flag",
  "ref",
  "omit",
)
  .map((column) => `u.${column}`)
  .join(", ");

/**
 * Columns whose SEARCHABLE value is not the stored one. A member's `role` is
 * stored as NULL (migration 0009 defaults it, older rows predate that), and
 * every surface calls that account a member, so the word `member` must find it.
 */
const SEARCH_VALUE_SQL: Readonly<Record<string, string>> = {
  role: "COALESCE(role, 'member')",
};

function valueSql(column: string): string {
  return SEARCH_VALUE_SQL[column] ?? column;
}

/** One lower-cased string of every searchable column, with an unprintable
 *  separator (U+001F) so a word can never match across two fields. */
const HAYSTACK_SQL = `lower(${USER_SEARCH_TEXT_COLUMNS.map(
  (column) => `COALESCE(${valueSql(column)}, '')`,
).join(" || char(31) || ")})`;

export type SearchTermsResult = { ok: true; terms: string[] } | { ok: false; message: string };

/**
 * Split what the admin typed into search words. Whitespace separates words; no
 * quoting is supported because AND-ing the words already finds a phrase.
 *
 * Folds ASCII case only (see the file header) so the word and the haystack are
 * lower-cased by the same rule. `String.prototype.toLowerCase()` would also fold
 * `É`, which SQLite's `lower()` leaves alone, and the word would then never
 * match the stored text it was typed from.
 */
export function parseSearchTerms(q: string): SearchTermsResult {
  const terms = q
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.replace(/[A-Z]/g, (ch) => ch.toLowerCase()));
  if (terms.length === 0) {
    return { ok: false, message: "Enter at least one word to search for" };
  }
  if (terms.length > ADMIN_USER_SEARCH_MAX_TERMS) {
    return {
      ok: false,
      message: `Search takes at most ${ADMIN_USER_SEARCH_MAX_TERMS} words; narrow it with a filter such as --role or --kind instead`,
    };
  }
  const tooLong = terms.find((word) => word.length > ADMIN_USER_SEARCH_MAX_TERM_CHARS);
  if (tooLong !== undefined) {
    return {
      ok: false,
      message: `Each search word must be at most ${ADMIN_USER_SEARCH_MAX_TERM_CHARS} characters`,
    };
  }
  return { ok: true, terms };
}

/** A purely numeric word may also be an account id. */
const NUMERIC_TERM_RE = /^\d{1,15}$/;

export interface UserSearchSql {
  /** A boolean SQL expression: true when every word is found in the account. */
  where: string;
  /** A SQL expression yielding the matching column names, space separated. */
  matchedIn: string;
}

/**
 * Build the WHERE condition and the "found in" expression for a set of words.
 *
 * `bind` registers one word and returns its numbered placeholder (`?3`). The
 * placeholder is reused wherever the word appears, so a search costs one bound
 * parameter per word however many columns it covers. The caller must use
 * numbered placeholders for every other parameter of the same statement too:
 * SQLite does not allow bare `?` and `?N` to be mixed safely.
 */
export function buildUserSearchSql(
  terms: readonly string[],
  bind: (term: string) => string,
): UserSearchSql {
  const placeholders = terms.map((term) => ({ term, p: bind(term) }));
  const numeric = placeholders.filter(({ term }) => NUMERIC_TERM_RE.test(term));

  const where = placeholders
    .map(({ term, p }) =>
      NUMERIC_TERM_RE.test(term)
        ? `(instr(${HAYSTACK_SQL}, ${p}) > 0 OR id = CAST(${p} AS INTEGER))`
        : `instr(${HAYSTACK_SQL}, ${p}) > 0`,
    )
    .join(" AND ");

  const parts: string[] = [];
  if (numeric.length > 0) {
    const cond = numeric.map(({ p }) => `id = CAST(${p} AS INTEGER)`).join(" OR ");
    parts.push(`CASE WHEN ${cond} THEN 'id ' ELSE '' END`);
  }
  for (const column of USER_SEARCH_TEXT_COLUMNS) {
    const cond = placeholders
      .map(({ p }) => `instr(lower(COALESCE(${valueSql(column)}, '')), ${p}) > 0`)
      .join(" OR ");
    parts.push(`CASE WHEN ${cond} THEN '${column} ' ELSE '' END`);
  }

  return { where, matchedIn: `TRIM(${parts.join(" || ")})` };
}

/**
 * A condition that is true for the account(s) whose id, username, email, GitHub
 * handle or ORCID iD equals one of `keys` (already normalised and lower-cased by
 * `identityKeys`), or null when there are no keys.
 *
 * This is OR-ed with the substring search rather than left to it, because an
 * identifier written the way people paste it (`@name`, an ORCID URL) is not a
 * substring of anything stored and the substring search alone would miss the
 * one account that query names outright. Each key costs one bound parameter.
 */
export function buildExactIdentifierSql(
  keys: readonly string[],
  bind: (term: string) => string,
): string | null {
  if (keys.length === 0) return null;
  const list = keys.map(bind).join(", ");
  return `(lower(COALESCE(username, '')) IN (${list})
    OR lower(email) IN (${list})
    OR lower(COALESCE(github_username, '')) IN (${list})
    OR lower(COALESCE(orcid, '')) IN (${list})
    OR CAST(id AS TEXT) IN (${list}))`;
}

/** `matched_in` as it comes back from SQL (space separated) to the wire array. */
export function splitMatchedIn(value: unknown): string[] {
  return typeof value === "string" ? value.split(" ").filter((name) => name.length > 0) : [];
}
