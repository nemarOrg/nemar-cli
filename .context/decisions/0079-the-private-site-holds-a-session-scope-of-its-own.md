# ADR 0079: The private site holds a session scope of its own, minted for any active account

**Status:** accepted
**Date:** 2026-09-30
**Owner:** Seyed Yahya Shirazi

## Context

The private site (`private.nemar.org`) needs a session on its own host.
The app session cookie is scoped to `app.nemar.org` on purpose (ADR 0056),
so it never reaches another host, and widening it would undo the reason for the scope.
ADR 0056 already solved this problem for `docs.nemar.org`:
the website's authorize page proves an app session, the API mints a sixty-second one-time grant,
and the other host trades the grant for a credential of its own,
stored as a `web_sessions` row with its own `scope`.

The private site's needs differ from the docs host's in three ways.
Its audience is every account that can use the API, not only admins.
Its Worker reaches this API through the `NemarApiRpc` service binding (ADR 0078), not over HTTP.
And what it grants access to is decided by the private site from the account it is told about,
not by a role this API checks.

## Decision

**A third `web_sessions.scope`, `private`, minted by the same handoff as the docs session,
with its grants in a table of their own (`private_grants`).**
Migration 0089 rebuilds `web_sessions` to widen the `CHECK` to `('app', 'docs', 'private')`,
because SQLite cannot alter a `CHECK`,
and copies every row, column and index across unchanged.
`services/private-auth.ts` holds the statements, modeled on `services/docs-auth.ts`.

Where it follows ADR 0056 unchanged:
the grant is minted from a live `app`-scope session only (so a docs or private session can never mint or renew one),
the session is minted by the exchange and never by the grant (nothing secret is at rest between the two steps),
single use is a `DELETE` gated on the minted row,
every gate is re-checked in the statement that mints,
and every timestamp is written and compared in SQL.

Where it deliberately differs:

1. **Every active account, not admins.**
   The mint gates on `ACTIVE_ACCOUNT_STATUSES` and `deleted_at IS NULL`, and on no role.
   `resolvePrincipal` re-applies the status rule on every call,
   because `findSessionByCookieId` admits `pending` (the same standing check `/auth/docs/verify` makes),
   and returns the account's live role, which the private site reads rather than trusts from the session.
2. **Exchange, verify and sign-out are RPC methods, never HTTP routes.**
   The public surface is one route, `POST /auth/private/grant`, behind the app session, the Origin allow-list
   and `Cache-Control: no-store`.
   A missing session is 401 `unauthenticated`; an inactive account is 403 with `inactiveAccountBody`;
   a missing or malformed `state` is 400 `invalid_request`.
3. **The handoff binds the browser that starts it to the browser that finishes it (a `state`).**
   The docs host is read-only, so ADR 0056 did not need this; the private site is a write surface.
   Without it, login CSRF works: an attacker starts a sign-in to their own account, stops at the callback,
   and lures a victim's browser there, which is then signed in as the attacker, and the victim's uploads land in the attacker's account.
   So the private site generates at least 256 bits of random `state` per sign-in and keeps it in a host-only `__Host-` cookie
   (HttpOnly, Secure, SameSite=Lax, a short Max-Age);
   it sends the value to the website's authorize page as `PRIVATE_AUTHORIZE_STATE_PARAM`, and the website forwards it to the grant.
   `private_grants.state_hash` holds only its SHA-256.
   The exchange takes the value from the private site's own cookie, and the mint requires it to match:
   a missing or different `state` is `invalid_grant` (one answer), and the grant is not consumed,
   so it stays spendable by the browser that asked for it.
4. **Limited per account, not per address.**
   The website calls the grant server-side, so every sign-in arrives from a few Cloudflare egress addresses (issue #1354),
   and the strict per-IP bucket would make strangers share ten sign-ins a minute.
   The route is outside `AUTH_PATHS` and limited to ten a minute per account, keyed by the user id its app session names.
5. **A separate grants table rather than a scope column on `docs_grants`.**
   The live docs statements stay untouched,
   and a docs code can never be spent at the private site or the reverse,
   by construction rather than by a predicate someone could drop.
6. **The session lasts eight hours and is never remember-me.**

**The revocation cascade, and what is deliberately outside it.**
Ending a credential has to end what was minted from it (ADR 0021), and ADR 0056 decision 5 applies:

- `/auth/logout` revokes the account's private sessions and purges its private grants,
  in the same `db.batch` as the app-session revoke and the docs cascade.
- Admin revoke (`finalizeRevocation`, by username and by id) and the owner-only soft delete
  already revoke every session of every scope;
  each now also purges `private_grants`.
- **A role demotion leaves private sessions alone.**
  Nothing about a private session depends on the role:
  it was not minted because of one, and `resolvePrincipal` reports the live role on every call,
  so a demoted account is seen as demoted at its next request.
  The docs session is revoked on demotion because it exists only for admins; this one does not.
- **Revoking an API key leaves private sessions alone.**
  A private session is never minted from a key (there is no counterpart to `POST /auth/docs/cli-session`),
  so a key's end has nothing of this scope to reach.
  If a key-based path to a private session is ever added, this bullet stops being true and the key-revoke paths need the cascade.
- **Both rest on the caller holding no copy of the principal.**
  ADR 0078 rule 6 forbids the private site to cache or persist a `Principal` across requests,
  which is what makes "seen at its next request" true.

## Consequences

- Every reader of `web_sessions` has to name the scope it wants, as ADR 0056 decision 4 already requires:
  `findSessionByCookieId` takes it as an argument, and `resolveCookieUser` spells `'app'`.
  A private session value is therefore refused by `authMiddleware`, is no session to `webSessionMiddleware`,
  and fails `/auth/docs/verify`; `backend/test/private-site-rpc.test.ts` asserts all three.
- The rebuild copies ids verbatim, so `sqlite_sequence` is reseeded at the highest surviving id.
  Nothing stores a session id beyond the request that read it, so a reused id refers to nothing.
- Nothing prunes expired `web_sessions` rows (true before this change),
  and this scope adds a row per private-site sign-in, so the table grows with sign-ins until a prune exists.
- The rebuild is not guaranteed to land as one transaction on the remote database.
  `wrangler d1 migrations apply --remote` sends the file as one multi-statement request to D1's `/query` endpoint,
  whose documentation says the statements run "as a batch" and says nothing about rollback;
  the migration's header gives the sources, checked 2026-09-30.
  So the file does not rely on atomicity, and it names the assumption it does make:
  its guard stops the `DROP` only if the runner stops at the first failed statement.
  That holds for wrangler `--local` (reproduced in review: `CHECK constraint failed: ok = 1`, then a full rollback)
  and for the Miniflare D1 the migration test drives, is documented for the Worker binding's `exec()`,
  is unverified for REST `/query`, and is false for bun:sqlite's multi-statement `exec()`,
  which is why the test also applies the file one statement at a time and proves the guard stops the `DROP` there.
  The guard is exact: equal counts and an empty `EXCEPT` in both directions over every column.
  The window it cannot close is `DROP`, then `RENAME`, then the index rebuild:
  stopping inside it leaves sign-in down with every row intact in `web_sessions_new`,
  which is then the only copy (rename it, never drop it),
  or the table whole without its secondary indexes.
  Recovery: redeploy the previous Worker version before or together with any restore,
  then either D1 Time Travel to the START of the deploy workflow's migration-apply step (read from the Actions log, not the merge time),
  which also undoes every other write since then, or finish the remaining statements by hand and record the file in `d1_migrations`.
- Existing sessions are preserved as asserted by `private-sessions-migration.test.ts`,
  which seeds every row shape at 0088 and replays the file on bun:sqlite and on Miniflare's D1;
  `bun run migrations:d1-check` proves only that the schema replays, not the rows.
- `services/docs-auth.ts` and `services/private-auth.ts` each name the callers of their purge statements.
  That count is how a new path that ends a credential finds out it needs the line.
- Sign-out stays `200` when its batch fails, as ADR 0056 designed (the person asked to sign out, and the cookie is cleared);
  the log line now names the account, which is what an operator needs to finish the revoke by hand.
- The website authorize page and the private site deploy separately from this API,
  so the order ADR 0056 records holds here too: this API ships first.
  The deploy workflow now probes it: after the `/health` check, an anonymous `POST /auth/private/grant` must answer 401.
- The consumers own the drift tests for this contract, as ADR 0056 records for the docs contract:
  the website's lands with its authorize page, and the private site's with its Worker.
  `backend/test/private-site-contract.test.ts` pins, from this side, the constants a text reader sees.

## Alternatives considered

- **Reuse the docs scope and gate on role in the caller.**
  One scope for two hosts means a docs cookie is a private-site cookie and the reverse,
  and the docs verify re-reads role on every page view precisely so that a docs session means "admin".
  Rejected.
- **A signed token instead of a D1 row.**
  Rejected for the reason ADR 0056 decision 5 gives: revocation would wait out the TTL.
- **An HTTP exchange and verify, as the docs host has.**
  Rejected by ADR 0078: the private site sits behind a service binding, so public routes would add surface and no capability.
- **A `scope` column on `docs_grants`.**
  Smaller, but it edits the statements the live docs gate runs, and it makes the separation a predicate.

## Receipts

- Migration `0089_private_site_sessions.sql`, `backend/src/services/private-auth.ts`,
  `backend/src/routes/auth-private.ts`, `backend/src/rpc/`.
- Tests: `backend/test/private-sessions-migration.test.ts` (the rebuild changes no existing row, and the guard aborts),
  `private-grant-route.test.ts` (including the state and the per-account limit), `private-site-rpc.test.ts`,
  `private-site-contract.test.ts`, and `private-site-cascade.test.ts`
  (the cascade and the deliberate non-membership, for both host-scoped sessions).
- ADR 0021 (revocation cascades), ADR 0047 (nothing secret at rest between two halves of a handoff),
  ADR 0056 (the docs gate this copies), ADR 0078 (the entrypoint).
