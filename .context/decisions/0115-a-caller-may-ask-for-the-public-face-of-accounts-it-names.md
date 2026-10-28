# ADR 0115: A caller may ask for the public face of accounts it names, and nothing more

**Status:** proposed
**Date:** 2026-10-28
**Owner:** Seyed Yahya Shirazi

## Context

The `NemarApiRpc` entrypoint (ADR 0078) answers one question about people: whose is this credential.
A page on the private site that shows a list of people, the members of a list the visitor may read for example,
holds user ids and has no way to turn one into a name.
`resolvePrincipal` describes the visitor behind the credential it is given, never anyone else,
and the caller has no read access to `users` (ADR 0078 rejected giving it a D1 binding).

Three of ADR 0078's rules bear on a method that takes ids.
Rule 1 says no method takes a bare user id as authority.
Rule 6 says a caller must not cache or persist a `Principal`, or anything derived from it.
Rule 7 says the key a visitor presents is used for `resolvePrincipal` and nothing else.

## Decision

**`NemarApiRpc` gains `describeAccounts`: given the visitor's credential and the user ids a caller names, it answers the public face of each, and nothing more.**
The contract is `shared/contract/private-site.ts` (additive, ADR 0078 rule 5); the rules are these.

1. **The ids are the subject of the read and never its authority.**
   The authority is the credential, which `describeAccounts` resolves with `resolvePrincipal` itself, never a second copy of its SELECTs.
   Only a live, active account can ask, a credential refusal is passed through unchanged,
   and a caller with no live credential gets the same answer whether an id exists or not,
   so the method does not turn the binding into an account directory for a caller that has none.
2. **One entry for each id asked, in the order asked, in one of three states.**
   `active` (the account may authenticate): `username`, `givenName`, `familyName` and `orcid`, each `null` where none is stored.
   `inactive` (a `pending` account, whose email is not verified yet) and `gone` (revoked, deleted, or never there, one answer for all three) carry the id and the state alone.
   The entry is built field by field, so no email, role, status, account kind or later column can reach a caller.
3. **The ORCID iD is shown only when it is verified and canonical.**
   `orcid` is the stored iD when `orcid_verified` is 1 and `identity_conflict` is 0, and `null` otherwise.
   A flagged row is the non-canonical duplicate of an identifier another live account holds (ADR 0043), and it keeps the iD in its column on purpose;
   showing it would put one person's iD on another person's account.
   The flag is one column for the iD, the email and the GitHub handle, so a row flagged for an email collision hides its iD too, which is the safe direction.
4. **The request is bounded, and refused as a value.**
   `userIds` is 1 to `DESCRIBE_ACCOUNTS_MAX` (100) positive safe integers, none twice; anything else, and a request that is not an object, is `invalid_request`.
   The bound is D1's limit on bound values, so a call is always one SELECT.
   The shape is judged before the credential: its rules are in the contract, they say nothing about any account, and a malformed request costs no credential lookup.
5. **The other rules of ADR 0078 apply as for `resolvePrincipal`.**
   Maintenance mode is mirrored as a read (`full` answers `unavailable`, `read-only` keeps answering), faults throw, and nothing logged names an account or a credential.

**This clarifies ADR 0078 rule 6.**
A caller may keep a user id as a key, of a membership or a grant for example, because an id is not derived from an account's state.
It must not cache or persist what `describeAccounts` answers (a name, a username, an iD, a state), for the reason the rule gives:
a rename, a revocation or an iD that stops being canonical reaches the caller only through the next call.

**This amends the sentence of ADR 0078 rule 7 that names the one use of a key:**
the private site uses a key a visitor presents for `resolvePrincipal` and `describeAccounts`, and for nothing else.
`describeAccounts` takes the visitor's own credential, resolves it as `resolvePrincipal` does, and does nothing else with it; the rest of the rule stands.

## Consequences

- A page can show people instead of numbers, and every render costs a call, because nothing is cached (rule 6).
  A list longer than 100 is asked for in pages.
- The method is a directory of active accounts for anyone who holds a live credential:
  ids are sequential, so a caller, or a visitor through a careless caller, can walk them 100 at a time.
  The contract tells a caller to name only accounts it has a reason of its own to show and never an id a visitor typed.
  What comes back is a profile's public fields, never the email, and `inactive` against `gone` says only that an id names an account that is not active yet, which is little beyond what a sequential id already says.
  There is no rate limit here (rule 3); a bound on how fast a visitor can ask is the caller's.
- A duplicate account flagged under ADR 0043 shows no iD until the flag clears, and a legitimate account flagged for an email collision loses its iD in this answer until an administrator clears it.
- `active` means a status in `ACTIVE_ACCOUNT_STATUSES`, the one definition ADR 0040 gave, so this method and the credential check cannot disagree about who may authenticate.
  The one SELECT is of other accounts and shares no code with the readers behind a credential, so a column added to `users` later reaches no caller until `accounts.ts` is changed to say so.
- `resolvePrincipal` already logs a line that names the account (`parseRole`) when a stored role cannot be read, and `describeAccounts` inherits it when the caller's own role is the unreadable one.
  The method adds no line of its own.

## Alternatives considered

- **Put the names in `Principal`.**
  It describes the credential's own account, so describing others would make `resolvePrincipal` take ids, which is what rule 1 forbids.
- **The caller keeps its own copy of names.**
  A copy drifts, and it goes on showing a name after an account is revoked, which is why rule 6 exists.
- **A read of `users` through a D1 binding.**
  Rejected in ADR 0078 as a second reader of the identity tables, and it would hand over every column.
- **A public HTTP route for a profile.**
  A public URL for the whole internet to probe, with its own rate-limit and caching decisions, for a caller in the same account (ADR 0078's argument against routes).
- **A method that takes ids and no credential.**
  Any Worker in the account could list every account, and rule 4 makes the account the trust boundary, not a user-facing one.
- **Return the email to the account itself, or the role to an operator.**
  Neither is a public face, and each is a different question with a different authority; `resolvePrincipal` already answers both for the visitor.
- **Show a flagged duplicate's iD anyway.**
  The iD would be another account's.

## Receipts

- ADR 0078 (the entrypoint, rules 1, 4, 5, 6 and 7), ADR 0043 (identity uniqueness and the `identity_conflict` flag of migration 0077), ADR 0040 (the active statuses).
- `shared/contract/private-site.ts`, `backend/src/rpc/accounts.ts`, `backend/src/rpc/entrypoint.ts`.
- `backend/test/private-site-rpc.test.ts` (each state, the iD rules, the bounds, the credential refusals, maintenance, a database fault and the logs), `backend/test/private-site-rpc-entry.test.ts` (the method through the binding in workerd, with D1's own flags and 100 ids), `backend/test/private-site-contract.test.ts` and `backend/test/private-site-entrypoint-shim.test.ts`.
