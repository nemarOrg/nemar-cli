# ADR 0022: ORCID relink intent is minted only by an authenticated same-origin POST

**Status:** accepted
**Date:** 2026-08-02
**Owner:** Seyed Yahya Shirazi

## Context

Settings needs a "change / re-link ORCID" flow (#913): a signed-in user who
linked the wrong iD completes a fresh ORCID OAuth flow and the account's
linked identity is replaced. The OAuth mode rides the `nemar_oauth_state`
cookie, which is base64url JSON — not signed — and `GET /auth/orcid/start`
sets it from a bare query parameter with no session or origin requirement.
A GET link can be delivered cross-site and rides the victim's ambient
cookies, so if a GET could mint `mode=relink`, a crafted link plus an active
ORCID session for some other iD in the victim's browser would silently swap
which iD backs their account — overwriting the citation-facing `users.orcid`
(the invariant migration 0050 protects from logins) and, if the other iD is
attacker-controlled, handing the attacker ORCID sign-in to the victim's
account afterward.

## Decision

`mode=relink` is honored only on `POST /auth/orcid/start`, which requires a
valid web session and an allow-listed `Origin` header (the same gate as
`POST /auth/orcid/unlink`). The GET route coerces `relink` to `login`, so a
forged link degrades to the historical `orcid_already_have` refusal. Two
subsidiary rules travel with this: the callback refuses a relink-mode
completion whose session expired mid-roundtrip (`orcid_relink_session`)
instead of falling through to sign-in/signup, and an explicit relink
overwrites `users.orcid` and sets `orcid_verified=1` — unlike first-link
reconciliation (`decideVerifiedFlag`), because a confirmed relink IS the
user correcting which iD is theirs. The swap itself is DELETE+INSERT of the
identity row in one D1 batch, so a concurrent unlink cannot strand it and
`UNIQUE(provider, provider_subject)` still refuses an iD another account
claimed.

## Consequences

- The website's Settings confirm step must submit a real form POST (a plain
  anchor can no longer trigger relink). Until that frontend change ships,
  the Settings button degrades to the pre-#913 behavior rather than
  breaking.
- The conflict check (new iD backs a different account) stays ahead of the
  mode check in the callback, in every mode; route-level tests
  (`backend/test/orcid-relink-route.test.ts`) pin that ordering, the POST
  minting rules, and the expired-session refusal.
- The state cookie remains unsigned. That is acceptable only because no
  privileged mode can now be minted without an authenticated, origin-checked
  request; if a future mode carries privilege, sign the state (the
  `signPending` pattern) rather than relying on this precedent.

## Alternatives considered

- **HMAC-sign the state cookie only:** insufficient alone — the victim's own
  ambient session would still mint a validly-signed relink state from a
  forged GET link.
- **Short-lived intent token minted by a separate POST endpoint, checked at
  /orcid/start:** equivalent security, one more endpoint, one more cookie,
  and a two-step frontend dance. The direct POST start achieves the same
  property with existing machinery.
- **Keep unlink-then-relink as the only correction path:** two steps and
  racy (the account briefly has no verified iD), which is what #913 was
  filed to fix.

## Receipts

- nemar-cli#913, PR #1051 and its security review finding
- Migration `0050_orcid_sso.sql` (citation-value invariant, UNIQUE backstop)
- `backend/test/orcid-relink-route.test.ts`, `test/orcid-relink.unit.test.ts`
