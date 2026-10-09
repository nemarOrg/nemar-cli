# ADR 0093: Admins find an account by any field and edit a closed set of fields

**Status:** proposed
**Date:** 2026-10-09
**Owner:** Seyed Yahya Shirazi

## Context

`nemar admin users` listed accounts and filtered them by status, role, kind and tier.
Finding one person by anything else (a surname, an affiliation, half an ORCID iD, the month
they signed up) meant listing everyone and reading. Reading one account in full was
`GET /admin/users/:username`, which cannot reach a web or ORCID account (their username is
NULL by design, #1012) and selects `u.*`, so it returns every column of the table,
including `password_hash`, `verification_token` and the two encrypted AWS columns.
Changing anything about an account other than its role or kind had no admin path at all.

Two constraints shape any fix. Cloudflare D1 allows 100 bound parameters per statement, so a
`LIKE ?` on each of about 25 columns breaks at four search words. And an edit that touches
who can act as an account (its email receives sign-in codes, its handle receives repository
access) is an account-takeover route if any admin can use it.

## Decision

**Search covers every text field, and "every" stays true by construction.**
`GET /admin/users?q=` splits the text into words (at most 8, each at most 100 characters)
and requires every word to be found, in any field, in any order. Matching is a case-insensitive
substring (ASCII, like SQLite `LIKE`), with a purely numeric word also matching the account id
exactly. The searchable columns are concatenated into one string, so a search costs one bound
parameter per word. Each row reports `matched_in`, the columns that matched. An empty,
over-long or over-wide query is a 400, never a listing of everyone.

**Results are ranked, and an exact hit is named.** Each row carries `match_kind`, best first:
`exact` (the text IS the account's id, username, email, GitHub handle or ORCID iD, in the
spellings people paste: `@name`, an ORCID URL, any case), `name` (every word is a whole word of
the name or username), `prefix`, `substring`; newest first among equals. The server decides
what "exact" means, through the same normalisers that store an email, a handle or an ORCID iD
(ADR 0043), and looks identifiers up directly, because a pasted `@name` is not a substring of
anything stored. The CLI goes straight to a single exact hit and lists the other matches
beneath it.

**When nothing matches, close matches are offered.** A second pass over the same filters
scores names, username, email, GitHub handle, affiliation, city and country by edit distance
(one swap or slip per word of 4 to 6 characters, two from 7; none for 3 or fewer) with accents
and case folded, so `lovelase` finds Lovelace and `ekstrom` finds Ekström. It runs only on a
miss, returns at most 20 accounts, closest first, marked `match_kind: "fuzzy"`, and the CLI
labels them as near misses. Dates, status, role, the ORCID iD and the description are never
fuzzy-matched, and a test pins that every fuzzy column is an ordinary text column.

**One classification of every `users` column decides what is searched and what is returned.**
`USER_COLUMN_ROLES` (`backend/src/services/user-search.ts`) labels each column `id`, `text`,
`flag`, `ref`, `secret` or `omit`. The search and the detail `SELECT` are derived from it.
Credentials are `secret`: never searched (a hash would become recoverable from match counts)
and never returned. A test compares the table's keys with `PRAGMA table_info(users)` in both
directions, so a migration that adds a column fails until someone decides what it is.

**`GET /admin/users/by-id/:id`** returns one account's non-secret columns, an explicit list and
never `u.*`, plus dataset count, live key count and linked sign-in providers. By id because
web accounts have no username.

**`PATCH /admin/users/by-id/:id` edits a closed set of fields, in two tiers.**
Any admin: `given_name`, `family_name`, `affiliation`, `city`, `country`.
Owners only, and never on their own account: `username`, `email`, `github_username`, the three
that decide who can act as the account (the same line `role`, `kind` and key minting draw).
Values go through the self-service normalisers (`normalizeProfilePatch`, `normalizeEmail`), so
an admin cannot store what the person could not have typed. Everything else is refused with a
sentence saying where that change IS made:
role, status and upload access (their own commands and ADR 0040), account kind (ADR 0048), the
ORCID iD (proven by signing in, never typed, ADR 0043), the identity-conflict flag, the person's
own `description`, and credentials.

Rules the edit enforces: names are refused on an account with a verified ORCID iD (ORCID would
overwrite them at the next sign-in, ADR 0041); an address or handle another live account holds
is refused naming the holder (ADR 0043), with the database constraint as the last word; a new
email address resets `email_verified` and sends nothing to either address; a changed username
clears `username_auto_assigned`; the change and its audit row (old and new values) are one
batch; re-sending current values is a 200 that writes nothing.

**CLI.** `nemar admin users --search`, `users show <query>`, `users edit <query> --flag ...`.
A query that is exactly one account's id, username, email, GitHub handle or ORCID iD picks it
even when longer names contain the text; `edit -y` is refused unless the account was named
exactly. Failures of `show` and `edit` exit non-zero.

## Consequences

- A search scans the table, and a miss reads every account's name fields a second time to
  score them in code (SQLite has no edit distance). At about 600 accounts that is nothing;
  revisit both before the table is two orders of magnitude larger.
- The substring search folds ASCII case only: `ekström` finds `Ekström`, `EKSTRÖM` does not.
  The close-match pass folds accents, so on a miss `EKSTRÖM` is still found, labelled a near miss.
- Close matching is edit distance, not a search engine: it does not know that Bob is Robert,
  and it never stretches a word of three letters or fewer.
- `edit -y` is refused for any account not named exactly, a near miss included.
- Flags (`email_verified`, `service_access`, ...) are not searchable, because the word `1`
  would match every account. The existing filters are how a flag is asked for.
- The GitHub handle is checked for format and uniqueness, NOT against GitHub, because that
  check is a live network call the no-mocks test policy cannot exercise. Owner-only, the audit
  row and a printed note carry the risk.
- An admin who is not an owner cannot fix a mistyped email, username or handle. They ask an
  owner, or the person fixes it in Settings.
- `GET /admin/users/:username` used to select the whole row and so returned `password_hash`,
  `verification_token` and the encrypted AWS key pair to any admin. It now selects every column
  that is not a secret (`ADMIN_USER_NON_SECRET_SELECT`: the detail list plus the notification
  preferences it has always returned), so a caller reading a non-secret column keeps working.
  A source scan (`backend/test/users-table-no-whole-row-read.test.ts`) fails on any query that
  reads a whole row of `users`, so the pattern cannot return unnoticed.
- How the credentials are stored (hashed, keyed-hashed, encrypted, or plaintext) is a separate
  question this ADR does not decide; it only keeps them from being read out.
- Changing an email sends no notice to the old address. An audit row is the only record.

## Alternatives considered

- **A `LIKE ?` per column.** The obvious query, and over D1's 100-parameter limit at four words.
- **An FTS5 table or a trigram index for fuzzy search.** A second copy of personal data to
  keep in sync and back up, for a table this small. ADR 0034's reasoning (derive, do not
  store) cuts the same way.
- **Always blending close matches into the results.** A real hit buried among guesses is worse
  than an empty page, and "no exact matches" is information. They appear only on a miss.
- **Filtering the full listing in the CLI.** The listing omits most fields, and every search
  would ship every account to the terminal.
- **Letting any admin edit identity fields.** Changing an email is a sign-in takeover for
  whoever holds the new inbox, owners' accounts included.
- **Editing role, status or upload access here.** Each has a route that carries side effects
  (token and docs-session revocation, ADR 0040's single writer) this one would skip.
- **Fixing `handleCommandError` to set an exit code.** It is shared by most admin commands and
  would change all of them; `show` and `edit` set the code themselves.

## Receipts

- `backend/src/services/user-search.ts`, `backend/src/services/admin-user-edit.ts`,
  `backend/src/routes/admin/user-edit.ts`, `backend/src/routes/admin/users.ts`,
  `shared/contract/admin-user.ts`, `src/lib/admin-user-lookup.ts`, `src/commands/admin.ts`.
- `backend/test/admin-user-search-route.test.ts`, `backend/test/admin-user-edit-route.test.ts`,
  `test/admin-users-search-edit-cli.test.ts` (the CLI against the real backend router).
- ADR 0040, 0041, 0043, 0045, 0048; #1012 (web accounts have no username).
