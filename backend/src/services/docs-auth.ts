/**
 * SQL and helpers for the docs admin gate (epic #1336 phase 0, issue #1338).
 * Routes live in `routes/auth-docs.ts`; the shared literals are in
 * `shared/contract/docs-auth.ts`.
 *
 * TWO RULES THIS FILE EXISTS TO HOLD.
 *
 * **Every gate is re-checked at MINT time, in the statement that mints.** The
 * grant records who asked; it decides nothing. `DOCS_MINT_INSERT_SQL` re-reads
 * role, status and `deleted_at` from `users` in its own WHERE clause, so an
 * account demoted or revoked inside the grant's sixty seconds gets a zero-row
 * insert instead of a session. This is the same shape as
 * `DEVICE_MINT_INSERT_SQL`, for the same reason: state can change between the
 * two halves of a handoff, and only the half that creates the credential is in
 * a position to say no.
 *
 * **Every timestamp is SQL-side.** `datetime('now', ...)` throughout, never a
 * JS `toISOString()` value. The two compare unequally on the same day and
 * silently break expiry, which is the trap ADR 0047 records for the device
 * flow.
 */

import { ACTIVE_ACCOUNT_STATUS_SQL_LIST } from "./account-tier";
import { generateCookieId, hashCookieId } from "./web-session";

/** A one-time grant code: 256 random bits, URL-safe. Reuses the cookie-id
 *  generator rather than introducing a second random-token primitive, since
 *  the requirement is identical (unguessable, URL-safe, no padding). */
export function generateGrantCode(): string {
  return generateCookieId();
}

/** Unkeyed SHA-256 hex of a grant code, for storage. Unkeyed is right here for
 *  the same reason it is for cookie ids: the code has 256 bits of entropy, so
 *  there is no dictionary to defend against, unlike the six-digit email codes
 *  that do get a keyed HMAC. */
export function hashGrantCode(code: string): Promise<string> {
  return hashCookieId(code);
}

/**
 * Delete grants more than an hour past expiry. Run opportunistically by
 * `grant`, which is the same prune-instead-of-cron idea as `device_codes`
 * (migration 0081) and `orcid_link_intents` (0078).
 *
 * An hour rather than the 24 hours a device code keeps: nobody polls a grant,
 * so no expired row needs to survive in order to explain itself. The browser
 * simply asks for another.
 */
export const DOCS_GRANT_PRUNE_SQL = `DELETE FROM docs_grants
   WHERE expires_at < datetime('now', '-1 hour')`;

/**
 * Mint a grant from a live app session, or insert nothing.
 * Binds: codeHash, ttlSeconds, appSessionId.
 *
 * `INSERT ... SELECT` off `web_sessions` rather than binding the user id the
 * route already has, for two reasons. It re-proves the app session inside the
 * statement that writes -- the route resolved that session a few lines earlier,
 * and this closes the gap -- and it copies `auth_method` across, so the docs
 * session the exchange later mints records that the identity behind it was
 * proven by ORCID rather than resetting that history at the host boundary.
 *
 * `ws.scope = 'app'` is load-bearing: without it a docs session could be used
 * to mint another docs session, which would let one eight-hour grant renew
 * itself indefinitely without ever revisiting the app host.
 *
 * The TTL is applied SQL-side through a concatenated modifier, so the row's
 * expiry is measured by the database's clock, the only clock the consuming
 * statement compares against.
 */
export const DOCS_GRANT_INSERT_SQL = `INSERT INTO docs_grants (code_hash, user_id, auth_method, expires_at)
   SELECT ?, ws.user_id, ws.auth_method, datetime('now', '+' || ? || ' seconds')
     FROM web_sessions ws
    WHERE ws.id = ?
      AND ws.scope = 'app'
      AND ws.revoked_at IS NULL
      AND ws.expires_at > datetime('now')`;

/**
 * Mint the docs session from a live grant, or insert nothing.
 * Binds: cookieIdHash, ttlSeconds, userAgent, ipHash, codeHash.
 *
 * `INSERT ... SELECT` rather than a read followed by an insert: the gates and
 * the write are then one statement, so there is no window between checking and
 * creating. Zero rows inserted IS the refusal, and the caller reads
 * `meta.changes` to see it.
 *
 * The gates, and why each is here rather than in the route:
 *   - `dg.expires_at > datetime('now')` - the grant is still claimable.
 *   - `u.role IN ('admin','owner')`     - re-read at mint, not trusted from
 *                                         the grant.
 *   - `u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}` plus `deleted_at IS NULL`
 *     - the SAME status rule the API's own cookie path applies
 *     (`isActiveAccountStatus` in `middleware/auth.ts`), not a hand-rolled
 *     `!= 'revoked'`. The looser spelling admitted `pending`, which the API
 *     refuses, and an admin-only surface must never be easier to enter than the
 *     API it documents.
 *
 * `remember` is hard-coded 0: a docs session is never a remember-me session.
 * `scope` is hard-coded 'docs' so this statement cannot mint an app session
 * even if someone edits the bindings.
 */
export const DOCS_MINT_INSERT_SQL = `INSERT INTO web_sessions
     (user_id, cookie_id_hash, remember, expires_at, user_agent, ip_hash, auth_method, scope)
   SELECT dg.user_id,
          ?,
          0,
          datetime('now', '+' || ? || ' seconds'),
          ?,
          ?,
          dg.auth_method,
          'docs'
     FROM docs_grants dg
     JOIN users u ON u.id = dg.user_id
    WHERE dg.code_hash = ?
      AND dg.expires_at > datetime('now')
      AND u.role IN ('admin', 'owner')
      AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}
      AND u.deleted_at IS NULL`;

/**
 * Consume the grant, in the same `db.batch()` as {@link DOCS_MINT_INSERT_SQL}.
 * Binds: codeHash, cookieIdHash.
 *
 * Gated on `EXISTS` against the cookie hash the INSERT just wrote, and NEVER
 * on `last_insert_rowid()`, which is stale after a zero-row `INSERT ... SELECT`
 * on both D1 and bun:sqlite -- the lesson `DEVICE_MINT_CONSUME_SQL` already
 * carries. So a refused mint leaves the grant in place to expire on its own,
 * which is harmless because it can never mint anything, and a successful mint
 * removes it before any second exchange can see it.
 */
export const DOCS_MINT_CONSUME_SQL = `DELETE FROM docs_grants
   WHERE code_hash = ?
     AND EXISTS (SELECT 1 FROM web_sessions WHERE cookie_id_hash = ? AND scope = 'docs')`;

/**
 * Revoke every docs session belonging to one account. Binds: userId.
 *
 * Called by `/auth/logout`. Without it, signing out of nemar.org would leave
 * docs access live for up to eight hours, which is not what anyone means by
 * signing out, and it is the specific failure the core principle about
 * revocation cascading to linked credentials is meant to prevent.
 */
export const DOCS_REVOKE_ALL_SQL = `UPDATE web_sessions
      SET revoked_at = datetime('now')
    WHERE user_id = ?
      AND scope = 'docs'
      AND revoked_at IS NULL`;

/**
 * Delete every outstanding grant for one account. Binds: userId.
 *
 * Called by `/auth/logout` alongside {@link DOCS_REVOKE_ALL_SQL}. Revoking live
 * sessions is not enough on its own: a grant is a 60-second licence to create a
 * new eight-hour session, held by whoever has the code, and the mint checks the
 * ACCOUNT rather than the app session that authorized it. So a code captured from
 * the callback URL survived sign-out and could still be spent. Signing out must
 * end what can still create access, not only the access that exists.
 */
export const DOCS_GRANTS_PURGE_SQL = "DELETE FROM docs_grants WHERE user_id = ?";
