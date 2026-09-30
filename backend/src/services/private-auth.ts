/**
 * SQL for the private site's session handoff (ADR 0079). The grant route is
 * `routes/auth-private.ts`; the shared literals are in
 * `shared/contract/private-site.ts`.
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
