# ADR 0043: One person, one account

**Status:** accepted
**Date:** 2026-09-05
**Owner:** Seyed Yahya Shirazi

> Numbering note: epic #1250 runs phases in parallel, and this one (phase 4,
> #1254) lands alongside phase 3 (#1253), which owns 0042 and migration 0076.
> Until phase 3 is rebased in, 0042 does not exist on this branch and the ADR
> index's gapless check fails here by construction; it goes green with the
> rebase.
> ADR 0041 carries an analogous note for the phase-1/phase-2 gap it saw at the
> time; this is the same situation one phase later, not a reference to the same
> gap.

## Context

Nothing has ever stopped one person from holding two live NEMAR accounts.

`users.email` carries an exact-case `UNIQUE` constraint (migration 0026),
so `Ada@Lab.org` and `ada@lab.org` are two accounts.
`users.orcid` carries no constraint at all;
the only ORCID uniqueness in the system is `UNIQUE(provider, provider_subject)`
on `oauth_identities`, which only the ORCID web flow ever writes.
A CLI signup therefore never touched it,
and the ORCID finalize route checked that table and nothing else.

Production shows exactly what that produces.
Two live rows carry the same iD `0000-0002-1974-1293` with `orcid_verified = 1`:

| id | email | oauth_identities row | name |
|---|---|---|---|
| 42 | robert.oostenveld@donders.ru.nl | no | none |
| 43 | r.oostenveld@donders.ru.nl | yes | from ORCID |

The identity row left row 42 — an unlink, or an identity insert whose rollback
did not run — while `users.orcid` and `orcid_verified` stayed behind on it.
The second sign-up then saw an iD that no `oauth_identities` row claimed,
and made a second account for the same person.

That is not a cosmetic problem.
Two accounts split one person's datasets, DOIs, upload grant and collaborator
access across two owners,
and epic #1250 makes it worse rather than better:
approval is now a per-account decision an admin makes once (ADR 0040),
and a DOI cites the depositing account by name (ADR 0041).
Both of those are answers to "who is this",
and both are wrong when the answer is "half of them".

## Decision

**An ORCID iD, an email address (compared case-insensitively), or a GitHub
handle backs at most one LIVE account.**
The database enforces it, the application refuses it with a typed error before
the database has to, and every write normalises the identifier first so the
three rules compare the same strings.

### Enforcement: flag, then partial-index

Migration 0077 adds `users.identity_conflict INTEGER NOT NULL DEFAULT 0`,
flags every NON-CANONICAL duplicate already in the catalog,
and only then creates the unique indexes — as PARTIAL indexes that exclude a
flagged row:

```sql
CREATE UNIQUE INDEX idx_users_orcid_live_unique ON users(orcid)
  WHERE orcid IS NOT NULL AND TRIM(orcid) <> ''
    AND deleted_at IS NULL AND identity_conflict = 0;

CREATE UNIQUE INDEX idx_users_email_live_unique ON users(email COLLATE NOCASE)
  WHERE deleted_at IS NULL AND identity_conflict = 0;
```

Canonical, in both the migration and the report, is:
for an ORCID group, the row that holds the `oauth_identities` row for that iD,
and the lowest id only when none does;
for an email group, the lowest live id.
The ORCID rule is not a detail — in the 42/43 case the lowest id is the ORPHAN,
so "lowest id wins" would have crowned the row that cannot sign in.

**The deploy can never fail on existing data, and no row is deleted.**
Those are the two properties the whole shape exists to buy.
A plain `CREATE UNIQUE INDEX` fails on rows 42/43 and takes the migration —
and therefore the deploy — with it,
and the only way to make it buildable would be to delete or merge somebody's
real account inside a migration.

A flagged row keeps everything except its claim on the identifier:
it signs in, owns its datasets, appears in every listing, and reads normally.

### Remediation: self-service first, manual merge last

`GET /admin/users/duplicates` (CLI `nemar admin duplicates`) reports the groups,
marks the canonical row, and shows what an operator actually weighs —
account age, dataset count, and whether the row can sign in with its iD.
`POST /admin/users/:id/clear-identity-conflict`
(CLI `nemar admin duplicates --clear <id>`)
clears a flag **only once the collision is actually gone**,
409ing with the still-colliding rows otherwise.

The fix itself is the person's own, on the account that already exists:
change its email, change its GitHub username,
or unlink and re-link its ORCID iD, in Settings on nemar.org.
Every refusal message says so.
**Merging two accounts stays manual** and is not automated here:
it means moving datasets, DOIs, S3 credentials and a GitHub collaborator set
between owners, and a wrong merge is not recoverable.

### Application refusals, typed

The pre-flight checks exist so a person gets a sentence instead of a
constraint error, and the website gets a code instead of a string to grep:
`orcid_in_use`, `orcid_already_linked`, `orcid_linked_other`, `email_in_use`,
`github_in_use`, `identity_conflict_remains`
(`shared/contract/identity.ts`, with the messages, so the CLI, the website and
the JSON body all read the same wording).

`orcid_already_linked` is a **deprecated alias** for `orcid_in_use`: the two
differ only in which constraint noticed, which is not a distinction a user can
act on. It survives because the website switches on it today
(nemarOrg/website#305 removes that need).

`error` deliberately carries different things on the two families of route,
because they are read by different things and both are already right:
the browser-facing routes put the CODE there (the website reads it there, and
`email_in_use` predates this phase),
while CLI signup puts a short human label there because that is the field the
CLI prints. `code` and `message` are additive on both.

### Unlink now clears `users.orcid`

Unlinking used to keep `users.orcid` on the reasoning that it is the
citation-facing value a DOI-discovery pass may have found.
That reasoning does not survive the row it produces:
an account still claiming an iD it can no longer prove,
invisible to every check that looked at `oauth_identities`.
That row is id 42.

**The way back is a manual re-link, and nothing else.**
`users.orcid` is written in exactly three places — ORCID finalize,
`linkIdentity` and `relinkIdentity` — so an account that unlinks has no iD on
file until someone signs in through ORCID again.
That is a real cost and it is the smaller one:
the alternative is a row that permanently claims an identifier it cannot prove,
invisible to every check that looked at `oauth_identities`,
silently blocking the person's own next sign-up.
(An earlier draft of this ADR claimed the DOI-discovery pass would refill the
column. It does not; nothing but those three paths writes it.)

### Normalisation at every write

One module, `backend/src/services/identity.ts`:
email trimmed and lowercased; ORCID reduced to a bare iD with an uppercase
check digit; GitHub handle trimmed with a leading `@` stripped.
Applied at CLI signup, ORCID finalize, the email change, the admin
test-fixture route, and (already) `PATCH /auth/profile`, which now imports the
GitHub rule instead of spelling it out again.

Migration 0077 also canonicalises the check digit on existing rows,
narrowly (a `GLOB` that matches only a bare iD ending in a lowercase `x`),
so a legacy case variant cannot slip past an index that compares exactly.

## Consequences

- **A second sign-up by the same person is now refused, not silently created.**
  That is the point, and it is also the new failure mode: someone who has lost
  access to an old account cannot route around it by making a new one. The
  messages point at Settings on the existing account; when that is not enough,
  it is an admin conversation.
- **Two production rows are flagged on deploy** (42 loses the iD to 43), plus
  whatever case-variant email pairs the catalog holds. Nothing is emailed and
  nothing changes for those users until someone acts on the report.
- **The flag is one-way without an admin.** Only
  `clear-identity-conflict` clears it, and only once the collision is gone.
  A person cannot un-flag themselves, and should not be able to.
- **A row can be flagged for a collision that no longer exists** (the other
  account changed its email). The report says so — `flagged_count` exceeding
  what the groups explain is exactly that signal — and clearing is a one-line
  admin command.
- **GitHub gets a report but no new index.** `idx_users_github` (0012) has been
  a table-wide unique NOCASE index all along, so a live GitHub duplicate cannot
  exist. The grouping is carried anyway so the report is complete and so the
  three identifiers are described in one place.
- **Email lowercasing is lossy** and deliberately so. RFC 5321 leaves the local
  part case-significant; no provider anyone signs up with treats `Ada@` and
  `ada@` as two people, and storing both is one of the two ways this catalog
  grew duplicates.
- **The exact-case `UNIQUE` from 0026 stays.** Both constraints are enforced;
  a case-variant collision now fails at the partial index. SQLite reports
  either as `UNIQUE constraint failed: users.email` — the column, not the index
  name — so the existing column-scoped catch clauses keep working unchanged.
- **`nemar auth profile` exists because refusals need somewhere to send
  people.** It prints each identifier with its verification state and says where
  each is changed. Username and name are not self-service yet
  (nemarOrg/website#301, and phase 3's `PATCH /auth/profile` work), and the
  footer says that rather than leaving someone hunting for a field.

## Alternatives considered

- **Add the unique indexes and fix the duplicates by hand first.** The
  honest-looking option, and it makes the deploy depend on a manual step being
  done in the right order against the right database. If it is not, the
  migration fails and takes the deploy with it. The flag makes the index
  buildable on any catalog, which is what makes the deploy safe to repeat.
- **Delete or merge the duplicate row inside the migration.** Row 42 is a real
  person's account. A migration is the worst possible place to decide that.
- **Enforce ORCID uniqueness on `oauth_identities` alone.** It is already
  unique there, and that is exactly the constraint rows 42/43 satisfy. The
  claim that matters lives on `users.orcid`, which is what a CLI signup writes
  and what DOIs cite.
- **A `users_identities` side table keyed by (kind, value).** Cleaner in the
  abstract, and it would need every read path taught about a join for a
  property that is three columns on a ~600-row table. ADR 0034's column-budget
  reasoning cuts the same way: derive and constrain, do not add structure.
- **Refuse the duplicate silently and sign the person into the existing
  account.** A takeover vector: completing an ORCID flow would hand the browser
  a session on an account the person may not own. The finalize route already
  refuses email collisions for this reason (#832) and this keeps it.
- **Let a person clear their own flag.** The flag means "somebody else holds
  this identifier". Self-service clearing is self-service duplicate creation.

## Receipts

- Issue #1254, epic #1250 (phase 4). Related: #1249, #1012, #832, #913.
- Migration `backend/src/db/migrations/0077_identity_uniqueness.sql`,
  service `backend/src/services/identity.ts`,
  routes `backend/src/routes/admin/user-duplicates.ts`,
  contract `shared/contract/identity.ts`.
- ADR 0040 (approval is the single writer of upload access) and ADR 0041 (DOIs
  cite the uploader by real name) are the two decisions that make a split
  identity expensive rather than untidy.
- ADR 0022 (relink intent is never minted on a GET) — the ORCID link surface
  this phase adds a second gate to.
- ADR 0034 (derive, do not store) — why this is a flag plus two indexes rather
  than a new table.
