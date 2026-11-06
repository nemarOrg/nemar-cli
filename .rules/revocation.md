# Revocation Cascades

The detail behind the "Revocation cascades, always" hard rule in `AGENTS.md`.
The decisions are ADR 0056 (the docs session), ADR 0078 (the `NemarApiRpc` service-binding entrypoint) and ADR 0079 (the private site).
Where this file and an ADR disagree, the ADR wins.

## [STRICT] Ending a credential has to end everything minted from it

API tokens are tied to a GitHub personal access token and per-user S3 credentials, and an API key can also mint a docs session (`POST /auth/docs/cli-session`).
So every route that revokes keys without ending every session calls `revokeDocsCredentials`.
The three that revoke keys and end the docs credential in their own batch (a role demotion, `finalizeRevocation`, the owner-only soft delete) do not need it.

Two host-scoped session kinds hang off the app session:

- `docs` (ADR 0056).
- `private`, held by the private site (`private.nemar.org`, ADR 0079) and reached only through the `NemarApiRpc` service-binding entrypoint (ADR 0078).

## The caller counts are load-bearing

`services/docs-auth.ts` and `services/private-auth.ts` each name the callers of their revoke and grants-purge statements, and say that a new path that ends a credential needs the lines too.
Those counts are load-bearing: add yourself to them rather than assuming someone else did.
The tests that drive these paths through their real routes are `backend/test/admin-credential-cascade.test.ts`, `backend/test/private-site-cascade.test.ts` and, for the support-ticket release that rides the same paths, `backend/test/mail-ticket-cascades.test.ts`.

## What deliberately does not cascade

A role demotion and an API key revocation deliberately leave `private` sessions alone; `PRIVATE_REVOKE_ALL_SQL` says why.

## OpenID Connect grants hang off the account

A third set hangs off the account itself: the grants, tokens and codes of NEMAR's OpenID Connect provider (ADR 0119).
`oidcEndStatements` in `services/oidc-cascade.ts` is added to the batch of every path that ends a credential for good, `OIDC_END_CALLERS` lists them, and a test holds that list to the code.
A role demotion, an API key revocation and the app session's sign-out leave those grants alone on purpose (rule 12).
A back-channel logout is queued in that batch and sent afterwards, never inside it: a request to a partner's server must not be able to fail a revocation, and no dev or staging Worker may reach a real partner host (rule 15).
