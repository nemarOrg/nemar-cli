/**
 * SQL for the private site's session handoff (ADR 0079). The grant route is
 * `routes/auth-private.ts`; the exchange and sign-out are methods on the
 * `NemarApiRpc` service-binding entrypoint (`rpc/private-session.ts`, ADR
 * 0078); the shared literals are in `shared/contract/private-site.ts`.
 *
 * MODELED ON `services/docs-auth.ts`, AND ITS TWO RULES HOLD HERE. Every gate
 * is re-checked at mint time, in the statement that mints, because state can
 * change between the two halves of a handoff. And every timestamp is
 * SQL-side, never a JS `toISOString()` value, for the reason ADR 0047 records.
 * The grant code reuses `generateGrantCode` / `hashGrantCode` from that file
 * rather than a second random-token primitive.
 *
 * WHERE THIS DIFFERS FROM THE DOCS GATE, deliberately:
 *   - No role gate. The private site serves every account that can use the
 *     API, so nothing here reads `users.role`.
 *   - Its own grants table, `private_grants` (migration 0089), so the live docs
 *     statements stay untouched and a code minted for one host can never be
 *     spent at the other.
 */

import { ACTIVE_ACCOUNT_STATUS_SQL_LIST } from "./account-tier";

/**
 * Delete grants more than an hour past expiry. Run opportunistically by the
 * grant route in the same batch as the insert, to save a round trip; the two
 * share one transaction, so a failed prune fails that grant too. Same idea,
 * and the same hour, as `DOCS_GRANT_PRUNE_SQL`.
 */
export const PRIVATE_GRANT_PRUNE_SQL = `DELETE FROM private_grants
   WHERE expires_at < datetime('now', '-1 hour')`;

/**
 * Mint a grant from a live APP session, or insert nothing.
 * Binds: codeHash, ttlSeconds, appSessionId.
 *
 * `INSERT ... SELECT` off `web_sessions` rather than binding the user id the
 * route already has: it re-proves the app session inside the statement that
 * writes, closing the gap since the middleware's lookup, and it copies
 * `auth_method` so the private session later records how the identity behind
 * it was proven instead of resetting that history at the host boundary.
 *
 * `ws.scope = 'app'` is load-bearing even though the route cannot reach this
 * statement without an app session (`webSessionMiddleware` reads that scope
 * only). The statement holds its own contract regardless of its caller:
 * without the predicate a docs or private session id would mint a grant, and a
 * private session could renew itself every eight hours without ever revisiting
 * the app host, which is where sign-out, revocation and the status checks live.
 */
export const PRIVATE_GRANT_INSERT_SQL = `INSERT INTO private_grants (code_hash, user_id, auth_method, expires_at)
   SELECT ?, ws.user_id, ws.auth_method, datetime('now', '+' || ? || ' seconds')
     FROM web_sessions ws
    WHERE ws.id = ?
      AND ws.scope = 'app'
      AND ws.revoked_at IS NULL
      AND ws.expires_at > datetime('now')`;

/**
 * Mint the private session from a live grant, or insert nothing.
 * Binds: cookieIdHash, ttlSeconds, userAgent, ipHash, codeHash.
 *
 * `INSERT ... SELECT`, so the gates and the write are one statement with no
 * window between checking and creating; zero rows inserted IS the refusal.
 * The gates:
 *   - `pg.expires_at > datetime('now')` - the grant is still claimable.
 *   - `u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}` and `deleted_at IS NULL`
 *     - re-read from `users` at mint, not trusted from the grant, and the SAME
 *     status rule the API's credential checks apply (`isActiveAccountStatus`).
 *     An account revoked, left pending or deleted inside the grant's sixty
 *     seconds gets nothing.
 *
 * THERE IS NO ROLE GATE, and that is the difference from
 * `DOCS_MINT_INSERT_SQL` rather than an omission: the private site serves every
 * active account, and reads the live role from `resolvePrincipal` on each
 * request instead of trusting one stamped at mint.
 *
 * `remember` is the literal 0 and `scope` the literal 'private', so a bindings
 * mistake cannot turn this into a remember-me or an app session.
 */
export const PRIVATE_MINT_INSERT_SQL = `INSERT INTO web_sessions
     (user_id, cookie_id_hash, remember, expires_at, user_agent, ip_hash, auth_method, scope)
   SELECT pg.user_id,
          ?,
          0,
          datetime('now', '+' || ? || ' seconds'),
          ?,
          ?,
          pg.auth_method,
          'private'
     FROM private_grants pg
     JOIN users u ON u.id = pg.user_id
    WHERE pg.code_hash = ?
      AND pg.expires_at > datetime('now')
      AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}
      AND u.deleted_at IS NULL`;

/**
 * Consume the grant, in the same `db.batch()` as
 * {@link PRIVATE_MINT_INSERT_SQL}. Binds: codeHash, cookieIdHash.
 *
 * Gated on `EXISTS` against the cookie hash the INSERT just wrote, and NEVER
 * on `last_insert_rowid()`, which is stale after a zero-row `INSERT ... SELECT`
 * on both D1 and bun:sqlite (the lesson `DOCS_MINT_CONSUME_SQL` and
 * `DEVICE_MINT_CONSUME_SQL` carry). A refused mint leaves the grant to expire
 * on its own, harmless because it can never mint anything, and a successful
 * one removes it before a second exchange can see it.
 */
export const PRIVATE_MINT_CONSUME_SQL = `DELETE FROM private_grants
   WHERE code_hash = ?
     AND EXISTS (SELECT 1 FROM web_sessions WHERE cookie_id_hash = ? AND scope = 'private')`;

/**
 * Revoke ONE private session by the hash of its value. Binds: cookieIdHash.
 *
 * `scope = 'private'` is the point of this statement: the private site's
 * sign-out must never be able to end an app or docs session, whatever value it
 * is handed. Idempotent: a revoked, unknown or non-private value changes
 * nothing.
 */
export const PRIVATE_REVOKE_ONE_SQL = `UPDATE web_sessions
      SET revoked_at = datetime('now')
    WHERE cookie_id_hash = ?
      AND scope = 'private'
      AND revoked_at IS NULL`;
