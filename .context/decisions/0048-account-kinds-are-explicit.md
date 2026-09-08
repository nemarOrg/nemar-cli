# ADR 0048: Account kinds are explicit: person, service, test

**Status:** accepted
**Date:** 2026-09-07
**Owner:** Seyed Yahya Shirazi

## Context

Sign-in is now ORCID-first (ADR 0047): the web creates accounts only through ORCID
OAuth, and the CLI obtains its key through the same browser sign-in. ADR 0043's
one-person-one-account invariant and the unique index on `users.orcid` both assume
an ORCID iD identifies exactly one person, and both break the moment a shared
placeholder iD is asked to back more than one account.

Yet three operational accounts (`nemarOwner`, `nemarAdmin`, `test-admin`) hold no
ORCID and never will: nothing signs in to them as a person, so there is nothing to
link. And a person can legitimately need a second, non-person account: Yahya's
regular-user persona `cool-vibers` is a second account for a person whose ORCID is
already bound to `yahya`, and the seeded `test-*` fixtures play the same role in
lower environments.

Before this phase the `orcid_verified` gap in the shared profile-gap matrix
(`shared/contract/profile-gaps.ts`) exempted this population by an interim role
check, `isExemptRole` treating `admin`/`owner` as exempt, documented there as
provisional. A role is a permission level, not a fact about what an account is: a
person who happens to be an admin is not exempt from having a real identity, and an
operational account with no admin role at all (there is none today, but nothing
stopped one) would have had no exemption at all.

## Decision

**`users.account_kind` names what an account IS, not what it may do.** Three
values, `person` (default), `service` (automation; no human signs in to it
directly), `test` (a human's secondary persona: signs in and uploads like a
person, but is barred from real data). Kinds are set only by an owner
(`POST /admin/users/:username/kind`), never inferred from role, email, or
anything else.

**One refusal code covers both non-person kinds.** The device sign-in flow
(`shared/contract/device-auth.ts`) already declared `service_account` for this
population before this phase existed to give it a real answer. Rather than add a
second `test_account` code, `accountRefusal` (backend/src/services/device-auth.ts)
answers `service_account` for either kind: from the CLI's side of `nemar auth
login`, "service" and "test" are the same fact: a human is not meant to sign in
this way, and both the website and the CLI already parse this as a closed enum,
so widening its meaning costs nothing a new code would not also cost. The message
is reworded kind-neutrally ("This is a service or test account...") and still
names the fix: `nemar admin keys create`.

**The ORCID gap exempts by kind, and role leaves the gap matrix entirely.**
`ProfileGapAccount.account_kind` replaces `role`; `isExemptKind` replaces
`isExemptRole`. This is a strictly better predicate than the role check it
replaces: the operational accounts this phase moves to `service` keep their
exemption, and a person who happens to hold `admin`/`owner` is no longer exempt at
all. At the time of writing, the two real owner accounts (`yahya`,
`arnodelorme`) already hold verified iDs, so nothing regresses for them today.
That fact is an observation about the current catalog, not something this
migration or the kind exemption depends on: a future owner without a verified
iD would simply see the `orcid_verified` gap like any other `person`, which is
the fail-closed behavior this decision wants. An absent or unrecognized kind is
not exempt (fails closed, the same posture the role check held).

**Keys for non-person kinds are owner-minted, never self-served.** Self-service
`POST /auth/keys` and the device flow's own mint (`DEVICE_MINT_INSERT_SQL`) both
gain a `person`-only predicate. The mint moves to
`POST /admin/users/:username/keys`, and it runs in the opposite direction from
every other admin user-route: it refuses a `person` target (403 `person_account`)
because a person creates their own keys through sign-in, and it is the only path
that can mint one for `service`/`test`. `GET`/`DELETE` on the same resource work
for any kind: listing and revoking are administrative record-keeping, not a
liveness question.

**A `test` account on production may own only `xx` sandbox datasets.**
`realDatasetCreateGate` (backend/src/services/upload-gate.ts) checks the account kind first
and refuses a real (`nm`) create with `test_account_sandbox_only` when `account_kind === "test"`.
The gate runs only for a non-sandbox create,
and its caller (backend/src/routes/datasets/upload.ts) forces `sandbox` on outside production,
so reaching the gate already proves `isProduction && !sandbox`; the gate itself has no environment input.
No restriction off
production, and no restriction on a `service` account, deliberately: the
device/key gates above stop a `service`/`test` account only from SELF-serving a
key (self-minting, or the device flow's own sign-in). They say nothing about a
request already carrying a key an owner minted for it through
`POST /admin/users/:username/keys`. That key authenticates through
`authMiddleware` exactly like any other (it never reads `account_kind`), so an
owner-minted `service` key reaches the dataset-create route, and every other
authenticated route, normally. `test_account_sandbox_only` is therefore the one
and only place a `service` account is unrestricted here on purpose: it is what
an operational/automation account is FOR, while `test` stays fenced to `xx`
sandbox datasets on production (#1284 review corrected this section; it
previously and incorrectly claimed a service account could not reach this route
at all).

## Consequences

**A test persona is otherwise a person, on purpose.** Off production, or when
staying inside the `xx` sandbox band, a `test`-kind account can request upload
access, upload, and publish exactly like a `person` account: the kind restricts
where its DOIs can point, not whether it can act. Which EZID shoulder a DOI lands
on is controlled by the admin's own `sandbox` flag at DOI-creation time
(`POST /admin/datasets/:id/doi/concept`), independent of the uploading account's
kind; the sandbox-only dataset-create gate is what keeps a `test` account from
ever reaching a real `nm` dataset to attach a production DOI to in the first
place.

**A persona cannot accidentally collide with its owner's real identity.** If a
`test`-kind account tries to link the same ORCID iD its owner's `person` account
already holds, the attempt is refused the ordinary way: `orcid_in_use`, the
partial unique index migration 0077 built for ADR 0043, not by anything specific
to kind. Kind exempts the account from being ASKED for a verified iD; it does not
weaken the uniqueness the index already enforces if one is offered anyway.

**`test-web` stays a `person`.** It is the shared web-QA account (#1008) that has
to reach the ORCID authorize page and the Settings key form the way a real person
would; moving it to `test` would make it exempt from exactly the flows it exists
to exercise.

**The website does not render kind yet.** `nemarOrg/website#318` tracks showing
it in the admin user list and account settings; out of scope here (ADR 0045's
wire rule already covers it: `account_kind` is optional on `userSchema` and
`adminUserListItemSchema`, absent on `webUserSchema`, so no website change is
forced by this phase).

## Alternatives considered

- **Add a distinct `test_account` refusal code.** Rejected: the CLI's and the
  website's actionable response to "you cannot sign in this way" is identical for
  both kinds (ask an owner for a key), so a second code would be a distinction
  with no behavioral difference on either client, only a wider enum to keep in
  sync.
- **Keep the role-based exemption and add kind alongside it.** Rejected: two
  predicates that can independently decide "exempt" is exactly the drift ADR 0045
  exists to end. Kind is the fact the exemption was always trying to approximate;
  once it exists, the role check has nothing left to do.
- **Let a `test` account's DOI shoulder follow its kind automatically.** Rejected:
  the shoulder is already an explicit admin decision at DOI-creation time
  (ADR 0007), made once per dataset regardless of who uploaded it; teaching kind
  to override that would be a second, silent way to pick a shoulder that could
  disagree with the explicit one.

## Receipts

- Epic #1272, sub-issue #1284.
- ADR 0043 (one person, one account), ADR 0044 (identity self-service on the
  CLI), ADR 0045 (the CLI and the web say one thing about an account: the
  `orcid_verified` row's role exemption, now superseded in part by this ADR),
  ADR 0047 (CLI sign-in is the device authorization grant).
- `backend/src/db/migrations/0082_account_kind.sql`,
  `shared/contract/profile-gaps.ts` (`isExemptKind`),
  `shared/contract/device-auth.ts` (`service_account`, `person_account`),
  `backend/src/services/device-auth.ts` (`accountRefusal`,
  `accountLivenessRefusal`), `backend/src/services/upload-gate.ts`
  (`realDatasetCreateGate`), `backend/src/routes/admin/user-keys.ts`.
- `backend/test/account-kind-migration.test.ts`,
  `test/profile-gaps-matrix.test.ts`, `backend/test/admin-keys-routes.test.ts`,
  `backend/test/admin-kind-route.test.ts`,
  `backend/test/dataset-create-test-kind.test.ts`.
