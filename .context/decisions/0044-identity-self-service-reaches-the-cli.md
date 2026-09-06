# ADR 0044: Identity self-service reaches the CLI, and ORCID does it through the browser

**Status:** accepted
**Date:** 2026-09-05
**Owner:** Seyed Yahya Shirazi

## Context

Epic #1250 spent four phases making a NEMAR account something a person is
responsible for. ADR 0040 made upload access a per-account grant, ADR 0041 made
a DOI cite the depositor by real name, ADR 0042 made the person ask for the
grant themselves with their own name and handle on the request, and ADR 0043
made an email address, a GitHub handle and an ORCID iD each back at most one
live account.

Every one of those raises the price of a wrong identifier, and the CLI could
not fix a single one of them. `PATCH /auth/profile`, `POST
/auth/email/change/{request,verify}` and the ORCID link routes were all
cookie-only, so an account that signed up through the CLI — which is most of
them — had no in-product way to correct its own email, GitHub handle, username,
name, or ORCID link. Phase 4 shipped `nemar auth profile` as a READ, and its
footer said "not editable yet" for username and name and pointed at Settings
for the rest.

That is the exact shape ADR 0040 spent a year undoing: a refusal that names a
fix the person cannot reach from where they are. And #1054 had been open since
PR #1053: when an account's sign-in email moves, the address that lost it is
told nothing at all, in an architecture where an emailed code IS the password.

## Decision

**Every identifier a person can change in Settings, they can change from the
CLI, through the same handler and the same rules. ORCID stays a browser flow,
initiated by an authenticated POST that mints a signed, account-bound intent.
And a completed email change notifies the address that lost the account.**

### One handler, two credentials

`PATCH /auth/profile` and both `/auth/email/change/*` routes now resolve the
acting account through `resolveActingAccount` (backend/src/middleware/auth.ts),
which takes either the CLI's bearer token or the dashboard's `nemar_session`
cookie. `POST /auth/orcid/unlink` does the same. There is no CLI copy of any
rule: the GitHub existence check, the username uniqueness rule and its
post-approval lock, the ORCID-canonical name rule, the non-empty city/country
rule, and every typed refusal are reached identically by both credentials.

Two asymmetries are deliberate, and both follow from what a credential IS:

- **The Origin allow-list applies to the cookie path only.** A cookie rides
  along with any cross-site request a browser can be tricked into making; a
  bearer token does not. Demanding an `Origin` header a terminal has no reason
  to send would refuse every CLI.
- **The routes keep `webSessionMiddleware` rather than mounting
  `authMiddleware`.** `authMiddleware`'s cookie path refuses a `pending`
  account (ADR 0040), and `webSessionMiddleware` admits one. An account that
  typed its address wrong at sign-up is `pending` BECAUSE the address is wrong,
  and the email change is the one thing it must still be able to do. The token
  path uses the standard token rule, which admits only an active account; a
  `pending` CLI account has no token to present anyway, since the key is issued
  after verification.

The bearer lookup itself was EXTRACTED, not copied: `resolveBearerUser` is the
same SELECT, the same revoked/expired filter, the same active-account check and
the same `last_used_at` touch `authMiddleware` has always run. A second copy of
that query is how a route ends up honouring a token the middleware would have
refused.

### ORCID: a browser flow with the account inside the signature

There is no version of this that types an ORCID password into a terminal, and
no way to render ORCID's consent screen there. So `POST /auth/orcid/cli-start`
(bearer) mints the intent and returns a URL to open.

The browser that opens it holds **no NEMAR session** — which is precisely what
the callback used to resolve the user from. So the account travels inside the
state, and **the state is HMAC-signed with `ENCRYPTION_KEY`**, the same
construction as the pending-signup cookie (#832). The callback tries the signed
shape first and falls back to the website's plain `decodeState`.

**A state minted for user A can never link to user B.** The id is covered by
the signature, and the plain web state — the only shape a forged cookie can
produce — carries no id at all. When a CLI state is present it also OUTRANKS
whatever session the browser happens to hold: the signature is proof of intent
from a live API token for that account, and a bystanding cookie for a different
account is not evidence of anything.

**ADR 0022 survives.** Its rule is that relink intent is never minted on a GET.
It still is not: `cli-start` is an authenticated POST, and a bearer token is a
credential no browser sends on its own, so no link click can arm an identity
swap. `GET /auth/orcid/cli-handoff` mints nothing — it verifies a signature the
POST made, puts that same signed value in the state cookie, and redirects. That
is transport, not creation.

The handoff exists rather than putting the signed state straight in ORCID's
`state` parameter, because it keeps the browser binding the website's flow has:
the state travels in a cookie, so a URL that leaks (browser history, a referrer,
a log) is not on its own enough to finish a link from somewhere else. The
intent expires in ten minutes.

**The residual risk, stated plainly:** a signed intent is a bearer capability
for the ten minutes it lives. Someone who mints one for their own account and
persuades a victim to open it and complete ORCID consent would attach the
victim's iD to the attacker's account. This is the standard OAuth
account-linking CSRF, it is bounded by the TTL, by ADR 0043's refusal to link an
iD another live account already holds, and by the victim having to complete a
consent screen on a link they were handed. It is the price of ORCID being
completable in a browser that carries no session of ours, and the alternative —
requiring a web session — is exactly the dead end this ADR exists to close.

### The old address is told

`POST /auth/email/change/verify` mails the PREVIOUS address a notice naming the
new one, MASKED (`a******@lab.org`). Best-effort by construction: it runs after
the write, its failure is logged and reported as `old_address_notified: false`,
and it never fails a change that has already landed. Off production it goes
through `sendEmail`'s existing fence, so a non-allow-listed recipient is
refused before the Resend call — the old address is the one recipient in this
flow that the caller did not choose, and on the dev mirror it is a real
person's.

Masked and not full: whoever reads the old inbox may no longer be the account
owner, which is the whole case this mail exists for. What they need is that the
address changed and where to report it, not what it changed to.

## Consequences

- **`nemar auth profile` grows subcommands** — `set-email` / `verify-email`,
  `set-github`, `set-username`, `set-name`, `set-location`, `orcid
  link|relink|unlink` — and its footer names a command per identifier instead
  of the "not editable yet" line ADR 0043 had to ship. Every subcommand still
  says the change can also be made in Settings: the CLI is the second surface,
  not a replacement.
- **A refusal has to be readable in a terminal.** These routes answer with a
  machine code in `error` and the sentence in `message`, which is right for the
  website and useless in a shell. `PROFILE_EDIT_ERROR_CODES`
  (shared/contract/user.ts) and `IDENTITY_CONFLICT_CODES`
  (shared/contract/identity.ts) declare which strings are codes, and
  lib/api/client.ts prefers `message` for them — the same mechanism ADR 0042
  added for the upload-access vocabulary. A code the backend adds and the
  contract does not know about prints as a bare token, so
  `_profileErrorsAreDeclared` in services/profile.ts fails to compile instead.
- **`same_email` gained a `message`.** It shipped as a bare code, which the
  website could switch on and a terminal could only print as the word
  `same_email`.
- **The CLI remembers the pending address** (`pendingEmailChange` in the account
  config), so `verify-email <code>` takes a code and nothing else. Stale is
  harmless: the code is bound to both address and account and simply will not
  verify. `--email` covers finishing a change started on another machine.
- **The link flow polls.** Nothing pushes the CLI when the browser finishes, so
  `orcid link` re-reads `/users/me` every three seconds until the iD appears or
  the timeout runs out, and a timeout says "check with `nemar auth profile`"
  rather than claiming a failure it cannot see. A relink is judged against the
  PREVIOUS iD, since `orcid` stays non-null throughout one.
- **Opening a browser is a convenience, never the mechanism.** The URL is
  printed first, always; `NEMAR_NO_BROWSER=1` and `--no-open` suppress the
  spawn. A headless or remote machine is a copy-and-paste, not a dead end.
- **`/auth/orcid/cli-start` and `/auth/orcid/cli-handoff` join the strict
  auth rate bucket** (10/min/IP). The rest of `/auth/orcid/*` deliberately does
  not: the callback is a browser landing and moving it would change the web
  flow's bucket.
- **Two surfaces can now race on one field.** Both write through the same
  handler and the same constraints, so the loser gets a typed refusal rather
  than a corrupt row, but "I changed it in Settings and the terminal still
  shows the old value" is a new support question. Every subcommand re-reads
  `/users/me` after a successful change to keep the local cache honest.

## Alternatives considered

- **Mount `authMiddleware` on the existing routes.** The obvious reading of
  "accept a bearer token too", and it silently narrows the cookie path: a
  `pending` account would lose the email change, which is the one flow it needs
  most. `resolveActingAccount` keeps each credential's own acceptance rule.
- **A parallel set of `/cli/...` routes.** A second copy of the username lock,
  the ORCID name rule and the GitHub check, drifting from the website's copy at
  the first change to either. The point of this phase is that there is one rule
  per field, not one per surface.
- **Put the signed state in ORCID's `state` parameter and skip the handoff.**
  Simpler, and it drops the browser binding: any holder of the leaked URL could
  finish the link from anywhere inside the TTL. The handoff costs one route.
- **Carry the account id in the plain state cookie.** The web state cookie is
  base64 JSON with no signature, so this would let anyone write a cookie naming
  any user id and link an iD to a stranger's account. The signature is the
  whole mechanism.
- **A device-code flow (`gh auth login`-style) for ORCID.** Correct in the
  abstract and a much larger build: a code table, a polling endpoint, an
  expiry sweep, and a second consent surface — to replace a URL the person
  opens anyway. Revisit if the printed-link flow proves confusing in practice.
- **Let the CLI complete ORCID itself with a loopback redirect URI.** Requires
  registering a second ORCID redirect URI, opening a local port on a
  researcher's machine, and a second callback implementation. The registered
  redirect stays one, and the browser stays the only place ORCID consent
  happens.
- **Tell the old address nothing, as before.** #911 marked it optional; PR
  #1053's review argued it should be a real P2 and was right. With passwordless
  sign-in the old inbox is the only channel that reaches a legitimate owner
  whose address was moved with a stolen session or key, and an audit row is
  visible to nobody but an admin.
- **Put the full new address in the notice.** It reads better and it hands the
  account's new sign-in address to whoever now reads an inbox the account left.

## Receipts

- Issue #1266 (phase 7) and #1054 (the old-address notice), epic #1250.
- Routes `routes/auth-web.ts` (profile PATCH, email change),
  `routes/auth-orcid.ts` (`cli-start`, `cli-handoff`, callback, unlink),
  middleware `middleware/auth.ts` (`resolveBearerUser`,
  `resolveActingAccount`), service `services/orcid-auth.ts`
  (`signCliState` / `verifyCliState`), template
  `services/email.ts#sendEmailChangedNoticeEmail`.
- CLI `src/commands/auth.ts` (the `profile` subcommands),
  `src/lib/api/auth.ts`, `src/lib/browser.ts`.
- Contract `shared/contract/user.ts` (`profileEditErrorCodeSchema`),
  `shared/contract/identity.ts` (`IDENTITY_CONFLICT_CODES`).
- ADR 0022 (relink intent is never minted on a GET) — narrowed to say where
  intent is CREATED, not how it is carried.
- ADR 0040, 0041, 0042, 0043 — the four decisions that made a wrong identifier
  expensive enough to be worth fixing from wherever the person is.
- ADR 0037 (make versus take) — why `src/lib/browser.ts` is nine lines of
  platform table rather than a dependency.
