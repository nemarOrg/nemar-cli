# ADR 0078: The API exposes a service-binding entrypoint, and the Cloudflare account is its trust boundary

**Status:** accepted
**Date:** 2026-09-30
**Owner:** Seyed Yahya Shirazi

## Context

The private site (`private.nemar.org`) hosts NEMAR's access-controlled features.
It runs as its own Worker, but identity stays in this API:
`users`, `tokens` and `web_sessions` live in this Worker's D1,
and a second copy of any of the rules that read them is the kind of copy that drifts
(the scope predicate ADR 0056 records, missing from one of two readers, is the standing example).
So the private site needs to ask this API the question it cannot answer itself:
who is this caller.

It could ask over HTTP, as the docs gate does (`/auth/docs/exchange`, `/auth/docs/verify`).
Both Workers run in the same Cloudflare account (ADR 0008),
which offers a second channel: a service binding to a named `WorkerEntrypoint`,
called as typed methods, with no public URL and no HTTP middleware in between.

Two constraints shape how that entrypoint is wired.
`backend/src/index.ts` is imported by a number of bun tests that drive the real worker,
and bun cannot resolve the `cloudflare:workers` module a `WorkerEntrypoint` comes from,
so `index.ts` must never import it.
And the entrypoint bypasses everything `api.use("*", ...)` installs,
which is where CORS, the rate limiter and maintenance mode live.

## Decision

**This Worker exports `NemarApiRpc`, a `WorkerEntrypoint`, and the private site calls it through a service binding.**
`backend/src/worker.ts` is the Worker's `main`:
it re-exports the default `{ fetch, scheduled }` object from `index.ts` unchanged and adds the class from `rpc/entrypoint.ts`.
The class is a thin shim; each method calls an env-level function in `backend/src/rpc/`,
which is what the tests drive.
The contract (method names, request and result types, `Principal`,
and the literals other repositories read as text) is `shared/contract/private-site.ts`.

The first surface is three methods:
`resolvePrincipal` (a private-site session value or an API key, to the account behind it),
`exchangePrivateGrant` (a one-time grant code and the browser's `state`, to a private-site session; ADR 0079),
and `revokePrivateSession`.

A method answering "what is this dataset" was drafted and deliberately left out.
Dataset facts wait until a caller needs them,
so that the disclosure rule for anonymous deposits (ADR 0065) and the handling of archived and deleted rows
are settled with that caller rather than guessed at here.
The contract is additive only (rule 5), so a method whose meaning is not settled must not ship.

Seven rules bind every method, now and later:

1. **No method acts for a user without that user's credential or a one-time grant.**
   None takes a bare user id as authority.
   `resolvePrincipal` takes a credential and returns whose it is;
   it never takes an id and returns what that account may do.
   A method that did would let any caller act as anyone, and the binding is not a user-facing boundary (rule 4).
2. **Expected refusals are result unions; unexpected faults throw.**
   A dead credential, an inactive account, an account whose record cannot be expressed (`unresolved_account`),
   and a spent grant are `{ ok: false, error }` values.
   A D1 failure throws, and so does the one fault a refusal can no longer describe:
   `exchangePrivateGrant` has already consumed the grant when a freshly minted session fails to resolve,
   so it throws rather than answer.
   The caller fails closed on anything that is not `ok: true`, a throw included.
3. **The HTTP middleware does not apply, so each method carries what it needs of it.**
   There is no CORS (no browser is involved), and no rate limit:
   the caller is one Worker, and a per-IP bucket would count that Worker, not its visitors.
   Maintenance mode is mirrored exactly, through `maintenanceRefuses`, which is the HTTP middleware's own rule:
   the two writing methods, `exchangePrivateGrant` and `revokePrivateSession`, answer `unavailable` and write nothing
   in `read-only` and in `full`;
   the reading method, `resolvePrincipal`, answers `unavailable` in `full` only,
   because the HTTP API refuses every read in `full` and keeps serving a `GET` in `read-only`.
   A caller fails closed on `unavailable` like any other refusal (rule 2).
4. **The Cloudflare account is the trust boundary.**
   Any Worker deployed in the account can declare a binding to `NemarApiRpc`;
   nothing in the entrypoint can tell one caller from another.
   So deploy access to the account is access to this surface,
   and rule 1 is what keeps that from meaning access to every user.
5. **The contract changes additively only:** new optional fields, new methods, and new `error` literals.
   The private site deploys independently of this API,
   so removing or renaming a field breaks a caller nobody here redeploys.
   A changed meaning is a new method.
   Because an `error` literal may be added, a caller must handle an error it does not recognise by failing closed,
   and must never switch over the errors exhaustively without a default.
6. **A caller must not cache or persist a `Principal`, or anything derived from it, across requests.**
   A demotion, a status change or a revocation reaches the private site only through the next `resolvePrincipal`;
   that is why ADR 0079 can leave private sessions alone on a demotion.
   A cached copy would keep acting on a role or status the account no longer has.
7. **API keys reaching the private site are an accepted trade, bounded in writing.**
   The private site is operated by NEMAR, in the same Cloudflare account (rule 4).
   It must not log, persist or forward an API key a visitor presents to it; `resolvePrincipal` is the only thing it does with one.
   No key is traded for a private-site session today.
   If a trade like `POST /auth/docs/cli-session` is ever added, the routes that revoke keys must reach the private scope too
   (ADR 0079 says the same beside its cascade).

## Consequences

- The private site's session checks cost a binding call rather than a public HTTP round trip,
  and exchange, verify and sign-out for its sessions exist only as methods.
  The public API gains one route, `POST /auth/private/grant` (ADR 0079).
- `index.ts` stays importable under bun.
  `backend/test/private-site-rpc-entry.test.ts` bundles the Worker with the production bundler
  (`wrangler deploy --dry-run --outdir`, about half a second) and runs it in workerd through Miniflare,
  next to a caller Worker holding the binding.
  That is the only way to see the class exported and each method reached: no bun test can load it.
  It cannot see the class hand `this.ctx` to the session read (local workerd finishes the floating write either way);
  the bun test of the function proves the hand-off, and the class passing `this.ctx` is guarded by reading it.
- The entry module now exports only the default handler and a class.
  The non-handler constants `index.ts` exports are no longer exports of the Worker's entry,
  so the local workerd restriction ADR 0050 records (issue #1324) does not apply to it:
  the entry test starts the real bundle in local workerd.
- Rule 3 has a cost:
  a new cross-cutting concern added as HTTP middleware does not reach these methods.
  Anyone adding such a concern has to decide whether the entrypoint needs it too.
- Rule 4 means the account's deploy permissions are part of this API's security.
  A Worker added to the account for any other reason could call these methods.
- `resolveApiKeyUser` in `middleware/auth.ts` is now the one API-key lookup;
  `resolveBearerUser` and `optionalAuthMiddleware` both call it,
  so the entrypoint and the HTTP API cannot disagree about which keys are live.
  `optionalAuthMiddleware`'s old copy lacked the `expires_at` predicate, so an expired key identified its account
  on every route behind it; that is fixed in the same change.
  It also means a live key presented to one of those routes now has its `last_used_at` touched, as every other key read does.

## Alternatives considered

- **HTTP routes, as the docs gate uses.**
  Works, and needs no new wiring.
  Rejected because every method would be a public URL that the whole internet can probe,
  each needing its own rate-limit and caching decisions,
  for a caller that sits in the same account.
- **A shared secret header on those HTTP routes.**
  Narrows who can call them, but adds a secret to rotate in two Workers,
  and a leaked value works from anywhere.
  The binding needs no secret because it has no URL.
- **Giving the private site's Worker a binding to this API's D1 database.**
  The smallest change, and the worst:
  it makes a second reader of `web_sessions` and `tokens`,
  which is exactly the copy ADR 0056's review found missing a predicate.
- **Exporting the class from `index.ts`.**
  Rejected because bun cannot resolve `cloudflare:workers`,
  and the tests that drive the real worker import `index.ts`.

## Receipts

- `backend/src/worker.ts`, `backend/src/rpc/`, `shared/contract/private-site.ts`.
- ADR 0008 (one Cloudflare account), ADR 0056 (the docs gate this copies, and the reader that lacked a predicate),
  ADR 0065 (the disclosure rule a future dataset method must settle with its caller), ADR 0079 (the session scope).
- Cloudflare, "RPC (WorkerEntrypoint)", <https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/>,
  read 2026-09-30: an entrypoint's public methods "can then be directly called by other Workers on your Cloudflare account
  that declare a binding to this Worker", which is rule 4.
