# ADR 0056: The admin docs are gated by NEMAR's own session, handed to the docs host by a one-time code

**Status:** accepted
**Date:** 2026-09-10
**Owner:** Seyed Yahya Shirazi

## Context

`docs.nemar.org/admin/*` was reachable by anyone. Every agent-facing document in this
repository said the section was protected by Cloudflare Access; the Access application on
that Pages project covers its **preview deployments only** and never covered the production
hostname, so all twelve operations pages answered 200 to an anonymous request and every one
of them was listed in the public sitemap. Nothing confidential leaked (procedures and
identifiers in a public repository, never credential values), so this was a false safety
claim rather than a breach, and the claim was about to be believed: epic #1336's later phase
moves `systems-inventory.md` there.

Two constraints shape the fix. `WEB_SESSION_COOKIE_DOMAIN` is `app.nemar.org`, scoped that
narrowly on purpose so the session never attaches to `data.nemar.org` byte-range fetches or
`api.nemar.org` search, which means a cookie scoped to one host cannot authenticate another.
And `docs.nemar.org` is a git-connected Cloudflare **Pages** project, so request-time logic
there means Pages Functions.

## Decision

The gate is NEMAR's own ORCID-backed session with an admin-role check, and the docs host
gets a credential of its own through a sixty-second one-time code rather than by widening
anyone's cookie. Six decisions inside that, each of which reopens a hole if reversed:

1. **`users.role` in D1 is the only source of truth for who is an admin.** No Access email
   allowlist, because a second copy of "who is an admin" is the thing that drifts, and
   removing that drift is what this epic exists for.
2. **A handoff, not a shared cookie.** The website's authorize page proves an admin session,
   `POST /auth/docs/grant` mints a code, and the docs Pages Function trades it at
   `POST /auth/docs/exchange` for a `__Host-`prefixed cookie of its own. Widening the app
   session to `.nemar.org` would undo the reason its scope exists.
3. **The docs session is minted by the EXCHANGE, never by the grant**, so no cookie value is
   ever at rest between the two steps. Same rule as the device flow (ADR 0047), same reason.
4. **One `web_sessions` table, one `scope` column, and every reader names the scope it
   wants.** Reuse means revocation, expiry and the `deleted_at` guard apply unchanged
   instead of being re-copied. Its cost is that the separation is only as good as the
   weakest reader: the first version of this change put the predicate on one of the two
   readers, and the docs credential authenticated the entire management API.
5. **A D1-backed session, not a signed token.** A signed token would need no subrequest and
   no migration, but revocation would wait out its TTL, and the core rule is that revocation
   cascades to every linked credential. Admin docs traffic is a handful of views, so the
   subrequest costs nothing real. Consequently **every path that ends or downgrades a
   credential must reach the docs session and its outstanding grants**: sign-out, admin
   revoke, role demotion, and the owner-only soft delete.
6. **Fail closed.** Only an exact `200` carrying `ok: true` is an admin verdict, so an
   unreachable API, a redirect, a 204, a non-JSON body and a 200 that says otherwise all
   refuse. This is the opposite of the sweeps' fail-open rule (ADR 0005), and deliberately:
   that rule is about reporting a verdict, this is about granting access.

**A signed-in non-admin gets 404 rather than 403**, matching `adminGate` on the website so
the two surfaces answer the same way. That is parity, **not** non-disclosure, and no comment
or document may upgrade it into one: `exchange` answers 400 to a malformed body and `verify`
401 to any caller, neither needing a session, so the route family is already public — as are
the pages themselves, in a public repository.

## Consequences

- The admin section is served only to admins, and an admin's access ends when their role,
  status, or session does, at the next page view rather than eight hours later.
- Admin docs are unreadable during an API outage. That is correct for an access control and
  is a real availability cost.
- Four repositories now participate in one flow (`nemar-cli`, `nemarOrg/website`,
  `nemarOrg/docs`, plus D1), and they deploy independently, so **order matters**: the
  backend must ship before either front end. Before it, the docs middleware maps an
  unrouted `verify` to 503 on every `/admin/*` page, and the website's authorize page maps
  the unrouted 404 to "not an admin" and sends a real admin to `/404`.
- The gate cannot be verified by a local `wrangler pages dev` run: locally an asset is
  served **without** invoking the Function, while deployed Pages invokes the Function first.
  So a deployed-host probe (`bun run probe:gate` in the docs repo) is part of the procedure,
  not a nicety.
- Excluding the admin pages from the search index is part of the gate, not a refinement.
  `/pagefind/*`, the sitemap and `llms.txt` all sit outside `/admin/`, so the middleware
  never sees them, and the index otherwise carries the full text of every gated page.
- The literals live in `shared/contract/docs-auth.ts`, but unlike `account-copy.ts` there is
  **no drift test on the other side yet**; epic #1336's drift-guard phase owns that.

## Alternatives considered

- **Cloudflare Access on the production hostname.** Would have worked and needs no code, but
  its policy is an email allowlist maintained separately from `users.role` — the second
  source of truth this epic exists to remove. It also cannot express "admin or owner in D1".
- **Widening the session cookie to `.nemar.org`.** One less moving part, at the cost of
  attaching a credential to `data.nemar.org` byte-range fetches and `api.nemar.org` search
  requests. The narrow scope is deliberate and documented in `website/src/lib/host.ts`.
- **A signed short-lived token as the docs credential.** No migration, no subrequest, but
  revocation waits out the TTL. Rejected on the revocation rule (decision 5).
- **Keeping the section private by moving it into this repository.** Considered and partly
  kept: genuinely internal material (webhook contracts, SSR contracts, the blast-radius
  fences) stays here regardless. But operations runbooks are what on-call people read, and a
  private repository is a worse reader than a gated site.
- **Making the section undiscoverable.** Rejected as unachievable: the sidebar links all
  thirteen pages by title from every public page, `robots.txt` names the prefix in order to
  ask crawlers off it, and both repositories are public. The gate controls who is *served*
  the pages.

## Receipts

- Issue #1338 (phase 0), epic #1336; PR #1345 (phase 0), #1355 (epic → dev), #1361 (the
  sign-out transaction).
- `backend/src/routes/auth-docs.ts`, `backend/src/services/docs-auth.ts`,
  `shared/contract/docs-auth.ts`, migrations `0083_docs_sessions.sql` and
  `0084_web_session_expiry_format.sql`.
- `nemarOrg/docs#32` (the Pages Function gate, the site-wide path normalization, and the
  search-index guard), `nemarOrg/website#328` (the authorize page).
- ADR 0047 (nothing secret at rest between two halves of a handoff), ADR 0022 (intent is
  never minted on a GET), ADR 0040 (the account-status rule), ADR 0005 (why fail-open is
  right for verdicts and wrong here).
- Three review rounds on #1355 found, in order: the docs credential authenticating the whole
  management API; sign-out skipping the cascade when the app session had lapsed, plus admin
  revoke never reaching the docs credential at all; and a revoked cookie retaining the power
  to revoke. Each is a consequence of decisions 4 and 5 being easy to implement halfway.
