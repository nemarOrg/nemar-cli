# ADR 0119: NEMAR is an OpenID Connect provider, and ORCID stays the upstream identity

**Status:** proposed
**Date:** 2026-11-03
**Owner:** Seyed Yahya Shirazi

Epic #2014, phase #2015.
Follows [ADR 0056](0056-the-admin-docs-are-gated-by-nemars-own-session.md) and [ADR 0079](0079-the-private-site-holds-a-session-scope-of-its-own.md) (a host-scoped credential is handed over, never a widened cookie), [ADR 0043](0043-one-person-one-account.md) (one person, one account), [ADR 0048](0048-account-kinds-are-explicit.md) (account kinds) and [ADR 0106](0106-an-owner-attests-an-orcid-id-that-the-person-has-not-proven.md) (an attestation is not a proof).
The design is the gated page `admin/design/compute-gateway`, section 3; where it and this ADR disagree, this ADR wins.

## Context

A partner-run site, `compute.nemar.org`, has to sign people in with their NEMAR account, and other services may follow.
NEMAR has no way to say who someone is to another host.
The app session cookie is scoped to `app.nemar.org` on purpose (ADR 0056), so it never reaches another host, and widening it would undo the reason for the scope.
ORCID (Open Researcher and Contributor ID) is the identity underneath every person's account (ADR 0047, ADR 0048), and NEMAR adds what it knows about the account.

Three things about the platform as it stands make a partner subdomain dangerous.
The application programming interface (API) trusts any `*.nemar.org` origin in its cross-origin allow-list, and in `isAllowedOrigin`, which is the origin check of the admin router's cookie-authenticated writes and of the authentication, profile, documentation and private-site routes.
Other cookie-authenticated writes (datasets, the upload-access request, sandbox) are not covered by that function: today they are covered by the website's own origin check and by the absence of a cross-origin preflight allowance for the app host.
The partner site serves pages whose JavaScript people write themselves, so a page on it could call the API with a visitor's cookie, or set a cookie for the whole `nemar.org` zone.
And the session cookie has no `__Host-` prefix, so nothing stops a sibling host from setting a cookie of that name for the zone.

A provider's issuer and subject format can never change once a client trusts them, so they are fixed here, before the first client registers and before any `/oauth` route exists.
The token prefixes are fixed here too, for secret scanning and so that the two token kinds cannot be confused, but tokens are opaque to clients: a prefix is a convention inside this Worker, and changing one is a coordinated change here and not a break for a client.
This phase builds none of the provider: it records the decisions and lands the three changes that must precede any client (the partner-host exclusion, the `__Host-` cookie and the subject).

## Decision

**NEMAR is a general OpenID Connect (OIDC) provider whose first client is `compute.nemar.org`; ORCID stays the identity underneath, and an account is the only thing a token ever names.**
Twelve rules inside that, each of which reopens a hole if reversed.

1. **Authorization code with Proof Key for Code Exchange (PKCE), method S256 only, for every client.**
   No implicit grant, no password grant, no `plain` challenge.
   A confidential client authenticates at the token endpoint with a client secret (`client_secret_basic`).
   A confidential client may also use the client credentials grant, for machine-only scopes such as `compute.stats`, and for nothing a person's consent covers.
2. **The issuer is `https://api.nemar.org` in production, and every identity (ID) token carries exactly that `iss`.**
   Discovery is `https://api.nemar.org/.well-known/openid-configuration` and the signing keys are `https://api.nemar.org/oauth/jwks`.
   The token, userinfo, revocation and introspection endpoints are under `https://api.nemar.org/oauth/`, following Request for Comments (RFC) 7009 for revocation and RFC 7662 for introspection.
   The authorization endpoint is `https://app.nemar.org/oauth/authorize`, because the sign-in cookie lives only on the app host: the page that proves the session and asks for consent is there, it cannot be framed (`frame-ancestors 'none'`) and its consent form is protected against cross-site request forgery.
   Introspection tells a caller only about tokens issued to itself or to a resource server registered for that token's audience.
   NEMAR tells a client about a revoked, deleted or suspended account at the client's registered back-channel logout address.
3. **Request handling.**
   `state` is returned unchanged and `nonce` is copied into the ID token.
   The authorization response carries `iss` (RFC 9207), so a client can tell which provider answered.
   `prompt=none` without a NEMAR session answers `login_required` and shows no page; `max_age` older than the session forces a fresh sign-in.
   A refresh token is issued only when the client asks for `offline_access` and is allowed it.
   Redeeming an authorization code twice revokes every token already issued from it (RFC 6749, section 4.1.2).
4. **Tokens.**

   | Token | Form | Lifetime |
   |---|---|---|
   | Authorization code | random, stored hashed, single use | 60 seconds |
   | ID token | JSON Web Token, ES256, with a key id; the next key is published before it signs | 5 minutes |
   | Access token | opaque, prefix `nmo_at_`, bound to one client, its scopes and its audience | 15 minutes |
   | Refresh token | opaque, prefix `nmo_rt_`, rotated on every use with a 30-second grace for a retried request; reusing a spent one after the grace revokes the whole family | 30 days idle, 90 days absolute |

   API keys are `nm_`, and the OIDC prefixes are chosen so that neither can be read as the other: a prefix test for `nm_` does not match `nmo_at_`.
   **An OIDC access token is accepted only by the routes that serve its scopes.**
   Every existing API route, `/users/me` included, refuses it, just as the OIDC routes refuse a command-line interface (CLI) key.
   A NEMAR API key has no scopes and carries its user's full authority, so the two token kinds must never be interchangeable.
5. **`sub` is `nmu_` plus 32 lowercase hexadecimal characters, 128 random bits, stored in `users.oidc_subject` (migration 0120).**
   It is assigned when the row is created and never changes, never reused, and is neither the row number nor the email address.
   The database enforces it: a format `CHECK`, a unique index, a trigger that fills a missing one on insert and a trigger that aborts any change to a value that is set.
   The tombstone mask keeps it, so a deleted account's subject is never handed to a different person.
   `nmu_` is a reserved username prefix (`validateUsernameFormat` refuses it with `username_reserved`), so no person, service or pipeline name can collide with a subject.
   The subject is on no existing response: not `/users/me`, not `/auth/me`, not an admin user detail or list.
   The only way to resolve one is the owner-only `GET /admin/users/by-oidc-subject/:sub`.
6. **Scopes and claims.**

   | Scope | Claims or access |
   |---|---|
   | `openid` | `sub` |
   | `profile` | `name`, `given_name`, `family_name` |
   | `email` | `email`, `email_verified` |
   | `orcid` | `orcid` (the iD as a URL), `orcid_verified`, true only when the iD was proven by an ORCID sign-in |
   | `nemar.account` | account kind, status and tier |
   | `compute.read` | the person's compute access, balances, usage and jobs, through the API |
   | `compute.reserve` | reserve time, report a job, release a reservation |
   | `compute.submit` | submit a job that NEMAR itself sends to Tapis; not granted to compute.nemar.org |
   | `compute.stats` | platform-wide aggregate usage; client credentials only |

   **The provider is general: compute facts are never put in the ID token.**
   They are read from the API with the access token, so they are current, and the provider stays usable by a client that has nothing to do with compute.
7. **Who may sign in is a rule on each client, and there are two.**
   `active_account`: the account is active (status `verified` or `approved`, ADR 0040), not revoked and not deleted.
   `person_proven_orcid`: `active_account`, account kind `person` (ADR 0048), and an ORCID iD the person proved by signing in with ORCID.
   "Proven" means an `oauth_identities` row for the ORCID provider whose iD matches `users.orcid`.
   An iD an owner attested (ADR 0106), or one filled in from a publication record, does not count: `orcid_verified = 1` no longer implies a sign-in record, and this rule is why the difference matters.
   `compute.nemar.org` uses `person_proven_orcid`, and does not require compute access to sign in, so a person can see why they cannot launch and follow a link to request access.
8. **Clients are registered by the owner, and by no one else.**
   A client carries a name, exact redirect addresses (no wildcards), allowed scopes and grants, its sign-in rule, its consent mode, its back-channel logout address, and caps on open reservations and on service units reserved per day.
   A client the owner marks first-party skips the consent screen; any other client asks once per set of scopes.
   **First-party is refused for a client with a partner-host redirect address**, at registration and again at every authorization, so a partner can never skip consent.
   `compute.nemar.org` is not first-party: its consent screen says it can reserve and spend the person's compute time.
9. **A partner subdomain is not trusted as a NEMAR origin.**
   `shared/partner-hosts.ts` lists the partner hosts (today `compute.nemar.org`) and `isPartnerHost` matches a host or any subdomain of one.
   `isNemarWebOrigin` (which the API's cross-origin rule, the zarr host and the Model Context Protocol (MCP) host all use) and `isAllowedOrigin` (the origin check of the admin router's cookie-authenticated writes and of the authentication, profile, documentation and private-site routes; other cookie-authenticated writes rely on the website's own origin check and the absence of a cross-origin preflight allowance for the app host, as the Context says) return false for a partner host before they test anything else.
   A partner reaches NEMAR only through OIDC and bearer tokens.
   A client is registered by an owner command, so a partner host is added to the list and released before the owner registers that partner's client.
   The exclusion is not enough on its own, because a partner host's page can still set a cookie for the parent domain: rule 10 is the other half.
10. **Every cookie the API or the website trusts to authenticate or link a session is host-only and `__Host-` prefixed.**
    The principle is that a page on a sibling host can set a cookie for the parent domain, and the partner-host rule (rule 9) does not stop that; a `__Host-` cookie (`Secure`, `Path=/`, no `Domain`) is the one kind a browser accepts from no other host.
    Three cookies are in scope.
    The session cookie moves from `nemar_session` to `__Host-nemar_session`, behind a flag and with a dual-read window, as below.
    The ORCID flow's state cookie (`nemar_oauth_state`) and pending-signup cookie (`nemar_orcid_pending`) move to `__Host-nemar_oauth_state` and `__Host-nemar_orcid_pending` at once, NOT behind the flag: nothing on the website reads the state cookie, and the website checks the pending cookie only for presence, under either name.
    The state cookie is read only under the new name, with no fallback, so a flow in flight at the deploy fails once with `orcid_state`; the old names are only cleared, with and without `Domain`.
    On a plain-http request to a loopback host (local development) the old unprefixed names are kept, because a `__Host-` cookie must be `Secure` and a browser on plain http may refuse it; the website's development login keeps the legacy session cookie name for the same reason.
    The session cookie's rules:
    - The reader tries the new name first and the legacy `nemar_session` second, and returns the name it read.
      A legacy cookie therefore never outranks a `__Host-` one, and an invalid, empty or revoked `__Host-` cookie is **not** rescued by a valid legacy one.
      A header that carries more than one `__Host-nemar_session` is no session.
    - A `__Host-` session cookie is minted only by a sign-in, never by a slide or by any read of a legacy value: with the flag on, the expiry slide re-issues the cookie only for a session read under the `__Host-` name.
    - The authorization and consent page of phase B3 treats a session read under the legacy name as no session, so a delegation is never granted on the cookie a sibling host can set.
    - The legacy name stops being read no earlier than 31 days after the production flag is turned on, because every legacy cookie issued before the flag has then passed its 30-day maximum age.
      The date is a later decision (see the not-decided list).
    - Until then the window keeps an exposure open, and it is named here.
      A legacy cookie is still read for any browser that holds no `__Host-` cookie: signed-out visitors, sessions not yet moved to the new name, and every session until the flag is on in production.
      A page on a sibling host can set a legacy cookie for the parent domain, so for those visitors the legacy cookie is not a trustworthy credential.
      A sibling host can also fill a browser's cookie jar until the real `__Host-` cookie is evicted, after which the legacy one is read.
      Both end when the window closes; nothing inside the window removes them.
    The writer is behind `HOST_PREFIXED_SESSION_COOKIE`.
    Unset, and for a request that carried no `__Host-nemar_session`, it sends today's header byte for byte.
    Unset, and for a request that carried one, it also sends a clear of `__Host-nemar_session`, so the flag is reversible: a person who signs out and in again after the flag is turned off is not left behind a stale `__Host-` cookie that the reader prefers.
    Set to exactly `"1"`, it sends the new name with `Secure; HttpOnly; SameSite=Lax; Path=/` and no `Domain`, followed by clears of the legacy name with the configured `Domain`, host-only, and for the parent domain `nemar.org` (none is sent twice, so staging, which configures no `Domain`, gets two).
    The cookie stays host-only (ADR 0056); the new name never goes through `WEB_SESSION_COOKIE_DOMAIN`.
    Sign-out ends the session behind every session cookie the request carries, under either name.
    The order of release is fixed because a reader must exist before a writer: the website's reader first, then the API, then the flag in production, which is the owner's act.
    The flag is `"1"` in the dev Worker's vars, so the dev Worker issues `__Host-nemar_session` as soon as it deploys: the website's reader (nemarOrg/website#499) must already be live on the website's `staging` before this epic reaches `dev`.
11. **The partner uses the `sub`, or a fixed and reversible transform of it, as the username of a person's compute credential, and is never trusted to say who ran a job.**
    The design asks for the `sub` "in a form the job platform accepts as a username", and this ADR keeps that latitude: the partner may apply a fixed transform (for example a change of case or of separator) that NEMAR can undo, so that the credential's username maps to exactly one `sub`.
    If the answer to design question 13 is that no such transform can satisfy the platform's username rules, the `sub` format itself is wrong and the only path is to supersede this ADR before any client registers.
    It mints that credential only while `GET /compute/me` says the person is active.
    Because whoever controls the partner site can mint a credential for any username, the owner of an unreserved job is never taken as proof of who ran it.
    The compute design carries the consequences; they are recorded here only so that the subject's form and its use are read together.
12. **The credential-ending table.**
    Every path that ends or downgrades a credential says what it does to OIDC grants and tokens.
    A new path that ends a credential adds a line here and a line to the callers named in `services/docs-auth.ts` and `services/private-auth.ts`.
    Because a path can be missed, every token use also re-checks the account's status, kind and proof against the client's sign-in rule (rule 7), so a path not listed here still takes effect at the next use of a token, even if it did not end the grant.

    | Path | OIDC grants and tokens | Why |
    |---|---|---|
    | Admin revocation (`finalizeRevocation`) | Ends all, and sends back-channel logout | The account is cut off; a client must stop honoring it. In the same batch as the other cascades. |
    | Owner soft delete (`tombstoneUserCascade`) | Ends all, and sends back-channel logout | Same, and the subject stays on the row. |
    | Account merge (manual, ADR 0043), through an owner command | Ends all of the loser's, and sends back-channel logout | The loser stops being a person; the winner's grants are untouched. |
    | Compute suspension | Ends only grants that carry a `compute.` scope, and tells only those clients | The person stays signed in elsewhere. |
    | ORCID unlink or relink | Ends the grants of every client whose rule is `person_proven_orcid`, and sends back-channel logout to those clients | The proof they were granted on is gone, and a client that relied on it should stop honoring the session. |
    | Account kind changed away from `person` (the owner route that holds `KIND_CHANGE_GUARDED_UPDATE_SQL`) | Ends the grants of every client whose rule is `person_proven_orcid`, and sends back-channel logout to those clients | The account no longer meets that rule. A change to `person` ends nothing. |
    | Client disable | Revokes everything the client holds, and sends no logout | The owner has cut the client off; telling it is not owed. |
    | Role demotion | Leaves them alone | A token carries no role and no OIDC scope confers admin authority (rule 4), so there is nothing to downgrade. `PRIVATE_REVOKE_ALL_SQL` says the same of private sessions. |
    | API key revocation | Leaves them alone | A grant is not minted from a key and depends on none. |
    | Sign-out of the app session | Leaves them alone | See the departure below. |

    **Leaving grants alone on sign-out is a departure from the cascade the earlier ADRs describe.**
    ADR 0021, ADR 0056 decision 5 and ADR 0079 end whatever was minted from a credential when that credential ends, and an OIDC grant is minted from an app session.
    This ADR does not follow them here, because signing out of NEMAR is not withdrawing a third party's delegated access, and ending every partner session whenever someone closes their NEMAR tab would make the partner unusable.
    The consequence is that a person has no self-service way to withdraw a partner's access for up to 90 days (the refresh token's absolute lifetime) until a connected-apps page exists, which is in the not-decided list.
    This is a decision for the repository owner, who can reverse it before the first client registers, and it is marked as such so that acceptance of this ADR does not carry it unseen.

### What this phase builds, and what it does not

This phase lands the ADR, the partner-host exclusion (rule 9), the cookie reader and writer (rule 10), and the subject with its reserved prefix (rule 5).
The client registry, the keys, discovery, authorization, tokens, the cascades and the logout are #2016 to #2019, and each builds against this text.

### Not decided here, and so not to be assumed by the phases that follow

- Public clients (PKCE with no secret).
- `private_key_jwt` client authentication.
- A connected-apps page where a person revokes a grant themselves, which is also what the sign-out departure in rule 12 waits for.
- The issuer of the staging Worker, which shares the shape of the production one and is for the discovery phase to fix.
- The date the legacy session cookie name stops being read, which is when the exposure in rule 10 ends. Rule 10 sets only the earliest: 31 days after the production flag is turned on.
- Whether the `sub` format satisfies the username rules of the partner's job platform, which only the platform's operator can answer (design question 13).
  If the answer makes the format unusable, it is superseded here before any client registers, and not worked around.

## Consequences

- **Easier:** another service can sign people in without a copy of anyone's identity, and revoking an account ends its grants in the transaction that revokes its keys.
  A reader of an ID token learns an opaque subject, so a client that stores only `sub` stores nothing it could later regret.
- **Harder:** the subject and the issuer are forever.
  Every later phase builds against them, and a mistake in this ADR is not an amendment.
- **The cookie rename is a three-step release.**
  Until the website reads the new name, turning the flag on logs everyone out of the website: the API would set a cookie the website's middleware does not know.
  The flag is `"1"` in the dev Worker's vars, so the dev Worker issues `__Host-nemar_session` as soon as it deploys, and the website pull request that reads it (nemarOrg/website#499) must already be live on the website's `staging` before this epic reaches `dev`.
  Production's flag is the owner's, after both releases.
  The ORCID state and pending cookies are not behind the flag: the API deploy moves them, and the website must already accept either pending name.
- **The dual-read window is a cost, and rule 10 says what it keeps open.**
  A legacy cookie never outranks a `__Host-` one, but it is still read for any browser that holds no `__Host-` cookie, and a sibling host can set one for the parent domain or evict the real `__Host-` cookie by filling the jar.
  The window ends by a later decision, not by this one, and no earlier than 31 days after the production flag is on.
- **The flag is reversible.**
  Turned off again, a request that carries a `__Host-nemar_session` gets a clear of it with the legacy header, and a request that carries none gets today's bytes exactly, so nothing production can receive changes.
  The clear is what keeps a person who signs out and in again after the flag is turned off from being locked out behind a stale `__Host-` cookie that the reader prefers.
- **Account kinds matter more.**
  `person_proven_orcid` makes ADR 0048's kinds a gate on a third party's sign-in.
- **A username that starts `nmu_` is refused from now on.**
  The owner checks that no live username already does before the release, because a migration cannot rename a person's handle.

## Alternatives considered

- **Use the app session cookie on `.nemar.org`.**
  Attaches a credential to `data.nemar.org` and to the partner host, which is exactly what ADR 0056 refused.
- **Widen the origin checks to an allow-list of NEMAR's own hosts instead of listing a partner.**
  Safer by default, and it would need every first-party host (the website, its preview and staging hosts, the docs and private hosts) enumerated at once, so that one omission breaks a working surface.
  A list of partners changes nothing else and fails open only for a host that is named; the list is short and in one file.
- **Make the subject the row number, the email address or the ORCID iD.**
  Each is guessable, reusable or a person's data, and an ORCID iD can change (ADR 0043 and the relink flow).
- **JSON Web Token access tokens.**
  Self-describing, but revocation would wait out the lifetime, which the revocation rule (ADR 0056, decision 5) forbids.
  An opaque token is looked up, so ending a grant ends its tokens at once.
- **An off-the-shelf provider.**
  It would bring a second user table and a second revocation path to keep in step with NEMAR's, and none of NEMAR's rules (kinds, ORCID proof, cascades) would be expressible in it.
- **Keep `nemar_session` and add a defensive check for a cookie that was set by another host.**
  There is no signal in a request that tells a cookie set by a sibling host from one the API issued.
  The `__Host-` prefix is enforced by the browser, which is the only party that can enforce it.
- **A different issuer than `https://api.nemar.org`.**
  The issuer cannot change once a client trusts it, so the choice is made once.
  `https://app.nemar.org` would put discovery and the signing keys on the website, a separate deployment that would have to proxy or duplicate them, and would tie the issuer to a host the API does not control.
  A dedicated host such as `auth.nemar.org` is cleaner and carries its own limits, at the cost of a new host, certificate and routing fork that nothing else on the platform needs.
  The API host already carries every other cross-host contract and the tokens, keys and revocation live there, so it is the issuer.
  The price is that discovery and the signing keys live on the API host for good and must be exempt from `maintenanceMode` and from the rate limiter: a client that cannot fetch them during maintenance or a burst cannot validate a token.
  Moving the issuer later means the old one keeps answering for as long as any client still trusts it.
- **A pairwise `sub` (a different subject per client) instead of one public subject.**
  Pairwise stops two clients from correlating an account, which matters for a general provider with unrelated clients.
  The first client needs a stable name that it and NEMAR's compute records share (rule 11), and there is one partner, so one public `sub` per account is the choice.
  Pairwise can be added per client later, as a client setting that derives a subject from the account's `sub` and the client's identifier, without changing the stored subject; a client switched to it would see a different value and is told first.

## Receipts

- Issue #2015 (this phase), epic #2014; design section 3 of `admin/design/compute-gateway`.
- `shared/partner-hosts.ts`, `backend/src/services/cors-origins.ts`, `backend/src/services/web-session.ts`.
- `shared/oidc-subject.ts`, `backend/src/services/oidc-subject.ts`, migration `0120_users_oidc_subject.sql`.
- ADR 0056 and ADR 0079 (host-scoped credentials, `__Host-` names), ADR 0043 and ADR 0048 (identity and kinds), ADR 0106 (an attestation is not a proof), ADR 0040 (the active statuses).
- OpenID Connect Core 1.0; RFC 6749 and 7636 (authorization code, PKCE), RFC 7009 (revocation), RFC 7662 (introspection), RFC 9207 (issuer in the authorization response).
