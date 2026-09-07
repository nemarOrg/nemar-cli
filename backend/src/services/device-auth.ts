/**
 * Device authorization grant helpers (RFC 8628; epic #1272 phase 1, #1281;
 * ADR 0047).
 *
 * The SQL that drives `routes/auth-device.ts` and `routes/auth-keys.ts`
 * lives here as exported constants, not inline in the routes, so
 * `.rules/testing.md`'s "never hand-copy SQL into a test" rule has something
 * to import: `backend/test/device-codes-migration.test.ts` runs these exact
 * statements against a real bun:sqlite database.
 *
 * WHY EVERY TIMESTAMP IS SQL-SIDE (ADR 0047). A JS `toISOString()` value
 * (`2026-09-06T12:00:00.000Z`) compares greater than a same-day SQL
 * `datetime('now')` value (`2026-09-06 12:00:00`) at index 10 -- `'T' >
 * ' '` -- so mixing the two silently breaks any expiry comparison. Every
 * statement below writes and compares `expires_at` with SQLite's own
 * `datetime()`/`julianday()`, never with a value computed in JS.
 *
 * MINT AT COLLECT, NEVER AT CONFIRM (ADR 0047). `DEVICE_MINT_INSERT_SQL`
 * and `DEVICE_MINT_CONSUME_SQL` are meant to run together in one
 * `db.batch()` from the token route: the INSERT mints the `tokens` row, and
 * the UPDATE marks this row `consumed` gated on `EXISTS` against the
 * api_key_hash the INSERT just wrote -- never on `last_insert_rowid()`,
 * which is stale after a zero-row `INSERT ... SELECT` on both D1 and
 * bun:sqlite.
 */

import type { ApiKeySummary } from "../../../shared/contract/device-auth.js";
import {
  DEFAULT_MACHINE_NAME,
  DEVICE_AUTH_MESSAGES,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_CONFIRM_GRACE_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  type DeviceAuthRefusalCode,
  MACHINE_NAME_MAX_CHARS,
  MAX_LIVE_API_KEYS,
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
} from "../../../shared/contract/device-auth.js";
import { auditLogStatement } from "../db/audit-log";
import { flag } from "../db/flag";
import { ACTIVE_ACCOUNT_STATUS_SQL_LIST, isActiveAccountStatus } from "./account-tier";
import { hashApiKey } from "./token";

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

/** 256 bits of URL-safe randomness for the polling secret the CLI holds.
 *  Never stored: only its SHA-256 hash lives in `device_codes` (ADR 0047: the
 *  polling secret is stored hashed). */
export function generateDeviceCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Hash a device code for storage/lookup. Same function `tokens
 *  .api_key_hash` uses (SHA-256, unkeyed -- the code carries 256 bits of its
 *  own entropy, same reasoning as `hashCookieId`). */
export const hashDeviceCode = hashApiKey;

/** Reject a drawn byte at or above this ceiling so `% USER_CODE_ALPHABET
 *  .length` is uniform: `floor(256 / 28) * 28 = 252`. */
const USER_CODE_REJECT_CEILING =
  Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;

/** Generate an 8-character code from {@link USER_CODE_ALPHABET} by rejection
 *  sampling a single random byte per character. Expected draws per
 *  character is `256 / 252 ≈ 1.016`, so the loop is effectively
 *  single-pass, like `generateAuthCode`'s 32-bit rejection sampling. */
export function generateUserCode(): string {
  const buf = new Uint8Array(1);
  let out = "";
  while (out.length < USER_CODE_LENGTH) {
    crypto.getRandomValues(buf);
    if (buf[0] < USER_CODE_REJECT_CEILING) {
      out += USER_CODE_ALPHABET[buf[0] % USER_CODE_ALPHABET.length];
    }
  }
  return out;
}

/**
 * Canonical stored form of client-supplied `machine_name` (RFC 8628 section
 * 5.4): strip control characters (a machine name is displayed, never
 * executed, but a raw control byte has no business in a DB row or an audit
 * log line), trim, collapse internal whitespace runs to one space, and cap
 * at {@link MACHINE_NAME_MAX_CHARS}. An empty result (no name sent, or a
 * name that was ALL control characters/whitespace) falls back to
 * {@link DEFAULT_MACHINE_NAME} rather than storing an empty string a NOT
 * NULL column would reject anyway.
 */
export function normalizeMachineName(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_MACHINE_NAME;
  const stripped = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping control bytes from client input
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return stripped.length > 0 ? stripped.slice(0, MACHINE_NAME_MAX_CHARS) : DEFAULT_MACHINE_NAME;
}

/** Convert a `datetime('now')`-shaped SQLite UTC string
 *  (`YYYY-MM-DD HH:MM:SS`) to an ISO-8601 string for the wire. One-way:
 *  nothing here is fed back into a SQL comparison (ADR 0047). */
export function sqliteUtcToIso(ts: string): string {
  return `${ts.replace(" ", "T")}Z`;
}

// ---------------------------------------------------------------------------
// Typed refusals
// ---------------------------------------------------------------------------

/** Build a `{ error, message }` body from the refusal vocabulary. `error`
 *  carries the CODE (matching the browser-facing convention `identity.ts`
 *  documents), unlike `identityRefusal`, whose `code` field the caller
 *  spreads under a separately-chosen key. */
export function deviceRefusal(code: DeviceAuthRefusalCode): {
  error: DeviceAuthRefusalCode;
  message: string;
} {
  return { error: code, message: DEVICE_AUTH_MESSAGES[code] };
}

/** HTTP status for each refusal code (ADR 0047): 404 for "no such row", 410
 *  for "it existed and is gone", 409 for "it exists but is already resolved
 *  OR the account is at capacity" (a key cap is a conflict, the same status
 *  `POST /auth/keys` already answers with), 403 for "the account cannot do
 *  this for an identity reason". Every route in this file and
 *  `routes/auth-keys.ts` reads this map rather than hardcoding a status, so
 *  the mapping cannot drift between the two files. */
export const HTTP_STATUS_FOR_REFUSAL: Record<DeviceAuthRefusalCode, 403 | 404 | 409 | 410> = {
  device_code_unknown: 404,
  device_code_expired: 410,
  device_code_used: 409,
  device_code_denied: 409,
  account_pending: 403,
  account_revoked: 403,
  identity_conflict: 403,
  service_account: 403,
  too_many_keys: 409,
  key_not_found: 404,
};

/**
 * Whether the ACCOUNT a device code names (or would be confirmed for) may
 * proceed, independent of the code's own status.
 *
 * Order is the point: `pending` is checked before the active-status test, so
 * an unverified account is told to verify its email rather than "revoked";
 * the identity-conflict flag is checked only once the status test has
 * already passed, so a flagged pending account still gets the more useful
 * `account_pending` (verifying email is unconditionally the next step for
 * it, whereas identity_conflict names a problem someone with a live session
 * has to go fix in Settings). `null` means the account may proceed. Phase 4
 * adds a `service_account` branch here once a `kind` column exists.
 *
 * `account_revoked` this function returns is UNREACHABLE at the session
 * routes (`lookup`/`confirm`/`deny`) for a reason that lives outside this
 * function: `findSessionByCookieId` (services/web-session.ts) filters
 * `status != 'revoked'` when it resolves a cookie, so a revoked account
 * carries no web session at all and never reaches a route that would call
 * `accountRefusal` in the first place -- it 401s instead. It IS reachable
 * at `/auth/device/token`, which has no session and reads `users.status`
 * directly. That literal `'revoked'` and this module's
 * {@link isActiveAccountStatus} (from `ACTIVE_ACCOUNT_STATUSES`) describe
 * the same boundary from two files; if one changes, the other must.
 */
export function accountRefusal(
  status: string,
  identityConflict: boolean,
): DeviceAuthRefusalCode | null {
  if (status === "pending") return "account_pending";
  if (!isActiveAccountStatus(status)) return "account_revoked";
  if (identityConflict) return "identity_conflict";
  return null;
}

/** Columns every `device_codes` row carries regardless of status, as read
 *  back by {@link DEVICE_ROW_BY_HASH_SQL} / {@link DEVICE_ROW_BY_USER_CODE_SQL}
 *  -- every table column except `status`/`user_id` (split out below to
 *  model the migration's own cross-field CHECK), plus the two computed
 *  fields every caller needs (`is_expired` as SQLite's 0/1, `expires_in` in
 *  whole seconds, possibly negative once past expiry). */
interface DeviceCodeRowBase {
  device_code_hash: string;
  user_code: string;
  machine_name: string;
  token_id: number | null;
  created_at: string;
  expires_at: string;
  last_polled_at: string | null;
  poll_count: number;
  confirmed_at: string | null;
  consumed_at: string | null;
  is_expired: number;
  expires_in: number;
}

/** A row whose status carries no account -- `user_id` is nullable, matching
 *  every status the migration's CHECK does not constrain. */
export interface UnclaimedDeviceCodeRow extends DeviceCodeRowBase {
  status: "pending" | "denied" | "expired";
  user_id: number | null;
}

/** A row the migration's CHECK requires to name an account: `confirmed` and
 *  `consumed` cannot exist with `user_id IS NULL` (migration 0081,
 *  `CHECK (status NOT IN ('confirmed', 'consumed') OR user_id IS NOT NULL)`). */
export interface ClaimedDeviceCodeRow extends DeviceCodeRowBase {
  status: "confirmed" | "consumed";
  user_id: number;
}

/** A `device_codes` row as read back by {@link DEVICE_ROW_BY_HASH_SQL} /
 *  {@link DEVICE_ROW_BY_USER_CODE_SQL}, typed to match the migration's own
 *  cross-field CHECK rather than widening `user_id` to `number | null`
 *  everywhere a caller only ever reaches for a confirmed/consumed row. TS
 *  narrows this union on `status` like any other discriminated union, so a
 *  handler that has already excluded `pending`/`denied`/`expired` via
 *  early returns reads `row.user_id` as a plain `number`, no `?? null`
 *  filler needed. */
export type DeviceCodeRow = UnclaimedDeviceCodeRow | ClaimedDeviceCodeRow;

/**
 * Map a row (or its absence) to the refusal a caller should answer with, or
 * `null` when the code is still live and pending.
 *
 * Checked in this order because a row can carry a status that has not yet
 * been observed to be expired -- `stampExpiredOnce` is what flips `status`
 * to `'expired'`, and nothing requires it to have run before this read, so
 * `pending`/`confirmed` rows are ALSO checked against `is_expired` directly.
 * `denied` is checked before `consumed`/`confirmed` only because both are
 * terminal and mutually exclusive by construction; the order between them
 * does not matter.
 */
export function refusalForRow(row: DeviceCodeRow | null): DeviceAuthRefusalCode | null {
  if (!row) return "device_code_unknown";
  if (row.status === "expired") return "device_code_expired";
  if ((row.status === "pending" || row.status === "confirmed") && flag(row.is_expired)) {
    return "device_code_expired";
  }
  if (row.status === "denied") return "device_code_denied";
  if (row.status === "consumed" || row.status === "confirmed") return "device_code_used";
  return null;
}

/**
 * Type guard for the one case {@link refusalForRow} answers `null`: a row
 * that exists, is `pending`, and is not past `expires_at`. Lets a route that
 * has already called `refusalForRow` and seen `null` read the row's fields
 * without an `as DeviceCodeRow` cast -- `lookup` and `confirm` both narrow
 * on this rather than asserting the type by hand.
 */
export function isLivePending(
  row: DeviceCodeRow | null,
): row is UnclaimedDeviceCodeRow & { status: "pending" } {
  return refusalForRow(row) === null;
}

/**
 * Stamp a row `expired` the first time anything observes it past
 * `expires_at` (ADR 0047: expiry is observed, not scheduled -- no cron).
 * `changes === 1` is the mutual-exclusion gate: only the caller that wins
 * the race writes the audit row, so a code is never logged as "expired"
 * twice. A no-op (silently) when the row is not actually past expiry or is
 * already terminal -- callers only reach this after `refusalForRow` (or an
 * equivalent inline check) has already decided the row IS expired.
 */
export async function stampExpiredOnce(
  db: D1Database,
  row: Pick<DeviceCodeRow, "device_code_hash" | "user_id" | "user_code">,
): Promise<void> {
  const result = await db.prepare(DEVICE_STAMP_EXPIRED_SQL).bind(row.device_code_hash).run();
  if ((result.meta?.changes ?? 0) === 1) {
    await auditLogStatement(db, {
      userId: row.user_id,
      action: "device_auth_expired",
      resourceType: "device_code",
      resourceId: row.user_code,
    })
      .run()
      .catch((err) =>
        console.error("[device-auth] failed to write device_auth_expired audit row", err),
      );
  }
}

/**
 * Build one {@link ApiKeySummary} from a `tokens` row and whether it is the
 * key presenting the current request. Used by every route that returns a
 * key -- `POST /auth/device/token`, `GET /auth/keys`, `POST /auth/keys` --
 * so the shape is defined once. The row's fields are never optional here:
 * every caller reads it from a read-back INSIDE the same transaction (or
 * batch) as the mint/list that produced it, so there is nothing to fall
 * back on -- a missing field is a canary the caller logs and throws on, not
 * a `?? 0` / `?? ""` filler this function would otherwise have to invent.
 */
export function buildApiKeySummary(
  row: {
    id: number;
    name: string | null;
    prefix: string;
    created_at: string;
    last_used_at: string | null;
  },
  current: boolean,
): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    current,
  };
}

// ---------------------------------------------------------------------------
// SQL (binds noted per statement; all timestamps SQL-side per ADR 0047)
// ---------------------------------------------------------------------------

/** Opportunistic prune, run best-effort at `start` (no cron, same pattern as
 *  `orcid_link_intents`). 24h past expiry rather than immediately: a row
 *  that just expired is still useful for one more `token` poll to answer
 *  `expired_token` with a sentence, rather than `device_code_unknown`. */
export const DEVICE_PRUNE_SQL = `DELETE FROM device_codes WHERE expires_at < datetime('now', '-24 hours')`;

/** Binds: hash, userCode, machineName. */
export const DEVICE_INSERT_SQL = `INSERT INTO device_codes (device_code_hash, user_code, machine_name, expires_at)
   VALUES (?, ?, ?, datetime('now', '+${DEVICE_CODE_TTL_SECONDS} seconds'))`;

/** Shared column list (plus two computed columns) for both row reads below. */
export const DEVICE_ROW_COLUMNS = `device_code_hash, user_code, machine_name, status, user_id, token_id, created_at, expires_at,
  last_polled_at, poll_count, confirmed_at, consumed_at,
  (expires_at <= datetime('now')) AS is_expired,
  CAST((julianday(expires_at) - julianday('now')) * 86400 AS INTEGER) AS expires_in`;

/** Binds: hash. */
export const DEVICE_ROW_BY_HASH_SQL = `SELECT ${DEVICE_ROW_COLUMNS} FROM device_codes WHERE device_code_hash = ?`;

/** Binds: userCode. */
export const DEVICE_ROW_BY_USER_CODE_SQL = `SELECT ${DEVICE_ROW_COLUMNS} FROM device_codes WHERE user_code = ?`;

/** Binds: hash. `changes === 1` means THIS call is the one that observed the
 *  expiry (ADR 0047: expiry is observed, not scheduled). `changes === 0`
 *  covers every other shape: the hash does not exist, the row is not
 *  actually past `expires_at` yet, it is `denied`/`consumed` (terminal
 *  statuses this statement's `status IN (...)` deliberately excludes --
 *  a resolved code is not "expired", it is already used), or somebody
 *  else already stamped it `expired` first. */
export const DEVICE_STAMP_EXPIRED_SQL = `UPDATE device_codes SET status = 'expired'
   WHERE device_code_hash = ? AND status IN ('pending', 'confirmed') AND expires_at <= datetime('now')`;

/** Binds: hash. `changes === 1` -> a live poll, answer `authorization_pending`.
 *  `changes === 0` on an otherwise-pending, non-expired row -> a poll inside
 *  the {@link DEVICE_POLL_INTERVAL_SECONDS}-second floor, answer `slow_down`
 *  WITHOUT resetting `last_polled_at` (ADR 0047: the poll floor does not
 *  reset on a `slow_down` answer, so a jittery client is not
 *  starved -- the floor is measured from the last STAMPED poll, not from
 *  every attempt). */
export const DEVICE_POLL_SQL = `UPDATE device_codes SET last_polled_at = datetime('now'), poll_count = poll_count + 1
   WHERE device_code_hash = ? AND status = 'pending' AND expires_at > datetime('now')
     AND (last_polled_at IS NULL OR last_polled_at <= datetime('now', '-${DEVICE_POLL_INTERVAL_SECONDS} seconds'))`;

/** Binds: userId, userCode. The `MAX(expires_at, ...)` grants ADR 0047's
 *  collection grace: confirming in the closing seconds of the 10-minute
 *  window extends expiry by {@link DEVICE_CONFIRM_GRACE_SECONDS} rather than
 *  leaving the very next poll to find it already expired. Safe because the
 *  code is already bound to one account and the CLI still has to hold the
 *  device secret to collect it. */
export const DEVICE_CONFIRM_SQL = `UPDATE device_codes SET status = 'confirmed', user_id = ?, confirmed_at = datetime('now'),
     expires_at = MAX(expires_at, datetime('now', '+${DEVICE_CONFIRM_GRACE_SECONDS} seconds'))
   WHERE user_code = ? AND status = 'pending' AND expires_at > datetime('now')`;

/** Binds: userCode. Records no `user_id` on the row (ADR 0047: deny names no
 *  account on the row itself); the
 *  denier is on the audit row the route writes. */
export const DEVICE_DENY_SQL = `UPDATE device_codes SET status = 'denied'
   WHERE user_code = ? AND status = 'pending' AND expires_at > datetime('now')`;

/**
 * Mint the `tokens` row for a confirmed device code, in the SAME
 * `db.batch()` as {@link DEVICE_MINT_CONSUME_SQL}. Binds: apiKeyHash,
 * apiKeyPrefix, deviceHash.
 *
 * Every gate that decides whether an account may hold a new key lives in
 * this one statement's WHERE clause, re-checked at MINT time rather than at
 * confirm time, because the account can change state between the two
 * (revoked, flagged, or already at the key cap): the row must still be
 * `confirmed` and unexpired, the user must be live and active
 * ({@link ACTIVE_ACCOUNT_STATUS_SQL_LIST}) and unflagged, and the account's
 * live key count must be under {@link MAX_LIVE_API_KEYS}. A zero-row
 * `INSERT ... SELECT` here is exactly the shape `last_insert_rowid()` cannot
 * be trusted after (ADR 0047: mint at collect) -- the caller resolves success from
 * {@link DEVICE_MINT_CONSUME_SQL}'s `changes`, never from this statement's
 * `meta.last_row_id`.
 */
export const DEVICE_MINT_INSERT_SQL = `INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name)
   SELECT d.user_id, ?, ?, d.machine_name
     FROM device_codes d JOIN users u ON u.id = d.user_id
    WHERE d.device_code_hash = ? AND d.status = 'confirmed' AND d.expires_at > datetime('now')
      AND u.deleted_at IS NULL AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST} AND u.identity_conflict = 0
      AND (SELECT COUNT(*) FROM tokens t WHERE t.user_id = d.user_id AND t.revoked_at IS NULL
             AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))) < ${MAX_LIVE_API_KEYS}`;

/**
 * Consume the device code once the mint above actually landed a row. Binds:
 * apiKeyHash, deviceHash, apiKeyHash. The `EXISTS` gate (ADR 0047: mint at
 * collect, never at confirm) is what
 * makes this safe to run unconditionally in the same batch as a mint that
 * might have inserted zero rows: `changes === 1` here is the ONLY signal a
 * caller may trust for "a key was minted".
 */
export const DEVICE_MINT_CONSUME_SQL = `UPDATE device_codes
     SET status = 'consumed', consumed_at = datetime('now'),
         token_id = (SELECT id FROM tokens WHERE api_key_hash = ?)
   WHERE device_code_hash = ? AND status = 'confirmed'
     AND EXISTS (SELECT 1 FROM tokens WHERE api_key_hash = ?)`;

/** How many live keys an account holds right now, for the token route's
 *  mint-failure diagnosis (`too_many_keys` vs. some other reason -- the mint
 *  statement's own cap only says THAT it refused, not WHY). Binds: userId.
 *  Same predicate as the cap inside {@link DEVICE_MINT_INSERT_SQL} and
 *  {@link KEY_MINT_SQL}, kept as one statement so the three cannot drift. */
export const LIVE_KEY_COUNT_SQL = `SELECT COUNT(*) AS n FROM tokens
   WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))`;

/** The account fields a mint-failure diagnosis needs to run
 *  {@link accountRefusal} outside of the mint statement's own WHERE clause.
 *  Binds: userId. A NULL row (no such user) is handled by the caller the
 *  same way as a deleted one. */
export const USER_STATUS_FOR_DEVICE_AUTH_SQL =
  "SELECT status, deleted_at, identity_conflict FROM users WHERE id = ?";

/** The user block for `POST /auth/device/token`'s success response,
 *  matching `POST /auth/login`'s shape (routes/auth.ts). Binds: userId. */
export const USER_BLOCK_FOR_DEVICE_TOKEN_SQL = `SELECT username, email, github_username, role, sandbox_completed, sandbox_dataset_id
   FROM users WHERE id = ?`;

/**
 * Named-key mint for `POST /auth/keys` (the paste-key fallback). Binds:
 * userId, hash, prefix, name, userId (the first four populate the INSERT's
 * SELECT values in column order; the fifth matches `u.id` in the WHERE).
 *
 * Carries the SAME account gates as {@link DEVICE_MINT_INSERT_SQL} --
 * `deleted_at IS NULL`, `status IN` {@link ACTIVE_ACCOUNT_STATUS_SQL_LIST},
 * `identity_conflict = 0` -- plus the shared {@link MAX_LIVE_API_KEYS} cap.
 * A route mounted on `resolveActingAccount` already knows the account is
 * live at the time of the CALL, but "live at call time" is not "live at
 * mint time" for the same reason it is not for the device flow: nothing
 * stops an admin from revoking or flagging the account in between, and this
 * statement's WHERE clause is what makes that unreachable rather than
 * merely unlikely.
 */
export const KEY_MINT_SQL = `INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name)
   SELECT ?, ?, ?, ? FROM users u
    WHERE u.id = ? AND u.deleted_at IS NULL AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}
      AND u.identity_conflict = 0
      AND (SELECT COUNT(*) FROM tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL
             AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))) < ${MAX_LIVE_API_KEYS}`;

/** Read back one key by its hash (after either mint above). Binds: hash.
 *  Never selects `api_key_hash` -- nothing downstream of this statement
 *  needs it, unlike {@link KEY_LIST_SQL}. */
export const KEY_BY_HASH_SQL = `SELECT id, name, api_key_prefix AS prefix, created_at, last_used_at
   FROM tokens WHERE api_key_hash = ?`;

/** `GET /auth/keys`: every live key for the account, newest first. Binds:
 *  userId. Carries `api_key_hash` ONLY so the route can compare it against
 *  the presenting bearer's hash to mark `current`; the route must never
 *  serialize this column into the response. */
export const KEY_LIST_SQL = `SELECT id, name, api_key_prefix AS prefix, created_at, last_used_at, api_key_hash
   FROM tokens
  WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))
  ORDER BY created_at DESC`;

/** Revoke one key by row id, scoped to the acting account. Binds: id,
 *  userId. `changes === 0` means the id does not exist, belongs to someone
 *  else, or is already revoked -- all three answer `key_not_found`. */
export const KEY_REVOKE_BY_ID_SQL = `UPDATE tokens SET revoked_at = datetime('now')
   WHERE id = ? AND user_id = ? AND revoked_at IS NULL`;

/** Revoke the presenting bearer's own key (`DELETE /auth/keys/current` on
 *  the token path). Binds: hash, userId. */
export const KEY_REVOKE_BY_HASH_SQL = `UPDATE tokens SET revoked_at = datetime('now')
   WHERE api_key_hash = ? AND user_id = ? AND revoked_at IS NULL`;

/**
 * Pre-read for `DELETE /auth/keys/:id`, run BEFORE the revoke UPDATE rather
 * than after -- so the route never has to read the mutated row back to
 * build its 404/audit response, and a decorative post-write read can never
 * turn an already-committed revoke into a 500. Binds: id, userId. Carries
 * `api_key_hash` ONLY so the route can compute `self` (does the id being
 * revoked equal the presenting bearer's own key) without a second query;
 * the route must never serialize this column into the response.
 */
export const KEY_ROW_BY_ID_FOR_USER_SQL = `SELECT id, name, api_key_prefix AS prefix, api_key_hash
   FROM tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL`;

/** Pre-read for `DELETE /auth/keys/current`, same reasoning as
 *  {@link KEY_ROW_BY_ID_FOR_USER_SQL}. Binds: hash, userId. `self` is
 *  always true on this path by construction, so `api_key_hash` is not
 *  selected here. */
export const KEY_ROW_BY_HASH_FOR_USER_SQL = `SELECT id, name, api_key_prefix AS prefix
   FROM tokens WHERE api_key_hash = ? AND user_id = ? AND revoked_at IS NULL`;
