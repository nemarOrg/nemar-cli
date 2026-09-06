-- One person, one account: identity uniqueness for ORCID and email
-- (ADR 0043, epic #1250 phase #1254).
--
-- WHAT IS BROKEN. Nothing has ever stopped one person from holding two live
-- accounts. `users.email` carries an exact-case UNIQUE constraint (0026), so
-- `Ada@Lab.org` and `ada@lab.org` are two accounts; `users.orcid` carries no
-- constraint at all, and the only ORCID uniqueness that exists is
-- UNIQUE(provider, provider_subject) on `oauth_identities`, which the ORCID
-- finalize route checks. That check is not enough, and production proves it:
--
--   id 42  robert.oostenveld@donders.ru.nl  orcid 0000-0002-1974-1293
--          orcid_verified=1, NO oauth_identities row, no name, no GitHub
--   id 43  r.oostenveld@donders.ru.nl       orcid 0000-0002-1974-1293
--          orcid_verified=1, HAS the oauth_identities row and the ORCID name
--
-- The identity row left row 42 (an unlink, or an identity insert whose
-- rollback did not run) while `users.orcid`/`orcid_verified` stayed behind on
-- it, so the second sign-up saw an unclaimed iD and made a second account.
--
-- WHY THIS MIGRATION CANNOT JUST ADD THE INDEXES. A plain
-- `CREATE UNIQUE INDEX ON users(orcid)` fails on rows 42/43 and takes the
-- whole deploy with it. Deleting or merging a row to make the index buildable
-- is not this migration's call either: merging accounts is manual, and 42 is
-- somebody's real account.
--
-- THE STRATEGY. Add `identity_conflict`, flag every NON-CANONICAL duplicate
-- with it, and make the unique indexes PARTIAL so a flagged row is invisible
-- to them. Nothing is deleted, nothing is merged, and the index is buildable
-- on any catalog whatever it contains -- the flag absorbs exactly the rows
-- that would otherwise fail it. A flagged row still logs in, still owns its
-- datasets, still reads normally; the ONLY thing it loses is its claim on the
-- identifier. `GET /admin/users/duplicates` is how an admin sees the groups,
-- and `POST /admin/users/:id/clear-identity-conflict` clears a flag ONLY once
-- the collision is actually gone (409 with the colliding rows otherwise), so
-- the flag cannot be cleared back into a state the index would refuse.
--
-- NOT ONE TRANSACTION (same reasoning as 0075's header: wrangler hands the
-- file to executeSql as one string whose transactional scope is not
-- guaranteed on the remote path). Statements 2-5 are individually idempotent
-- and each narrows its own predicate by succeeding, so re-running finishes a
-- partial application. Statement 1, the ALTER, is the exception: SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so a re-run after it landed fails on it. That is
-- the standing shape for every column-adding migration here (0037, 0062), and
-- the recovery is the same: if the ALTER already landed, re-run statements 2
-- onward. Do not hand-repair the flags.

-- (1) The flag. 0 = this row's identifiers are its own; 1 = at least one of
-- them is claimed by another live row and this row is not the canonical
-- holder. NOT NULL DEFAULT 0 so every existing and future row starts clean and
-- the partial-index predicate is never NULL.
ALTER TABLE users ADD COLUMN identity_conflict INTEGER NOT NULL DEFAULT 0;

-- (2) Canonicalise the ORCID check digit before anything compares iDs.
-- An ORCID iD's last character is a checksum that is `X` when it is not a
-- digit, and uppercase is the canonical spelling. The index in (4) compares
-- `orcid` exactly, so a stored lowercase `x` would read as a different iD
-- from the same person's uppercase one and slip past both the flagging below
-- and the index. Every write path now uppercases it (services/identity.ts),
-- which closes the future; this closes the past.
--
-- The GLOB is deliberately narrow: it matches ONLY a bare iD ending in a
-- lowercase `x`, so a row holding a full `https://orcid.org/...` URI (or
-- anything else unexpected) is left exactly as it is rather than being
-- uppercased into mojibake by a blanket UPPER().
UPDATE users
   SET orcid = UPPER(orcid)
 WHERE orcid GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9]x';

-- (3a) Flag non-canonical ORCID holders.
--
-- CANONICAL = the row that holds the `oauth_identities` row for that iD, and
-- the lowest id only when no row does. That ordering is the whole point in the
-- 42/43 case: 43 is the row that can actually sign in with the iD and carries
-- the ORCID name, and 42 is the orphan the identity row left behind. Picking
-- the lowest id would have flagged the working account and left the orphan
-- holding the identifier.
--
-- At most one row can be identity-backed for a given iD
-- (UNIQUE(provider, provider_subject) on oauth_identities), so the LIMIT 1
-- picks from a set of at most one and the choice is deterministic.
--
-- A singleton -- one live row holding an iD nobody else holds -- IS its own
-- canonical row, so `id <> canonical` is false and it is not flagged. There is
-- no separate "is this a duplicate at all" clause because that one is
-- redundant with this one.
--
-- The subqueries read `id`, `orcid`, `deleted_at` and `oauth_identities`, none
-- of which this statement writes, so the result does not depend on the order
-- SQLite visits rows in.
UPDATE users
   SET identity_conflict = 1,
       updated_at = datetime('now')
 WHERE deleted_at IS NULL
   AND identity_conflict = 0
   AND orcid IS NOT NULL
   AND TRIM(orcid) <> ''
   AND id <> COALESCE(
         (SELECT c.id
            FROM users c
            JOIN oauth_identities oi
              ON oi.user_id = c.id
             AND oi.provider = 'orcid'
             AND oi.provider_subject = c.orcid
           WHERE c.deleted_at IS NULL
             AND c.orcid = users.orcid
           LIMIT 1),
         (SELECT MIN(m.id)
            FROM users m
           WHERE m.deleted_at IS NULL
             AND m.orcid = users.orcid));

-- (3b) Flag non-canonical email holders, case-insensitively.
--
-- CANONICAL = the lowest live id in the group. There is no identity row to
-- prefer here and no other principled tiebreak: the oldest account is the one
-- most likely to be the one in use.
--
-- `m.identity_conflict = 0` makes this statement compose with (3a) instead of
-- fighting it. Without it, a pair that collides on BOTH iD and email -- where
-- (3a) flagged the LOWER id because the identity row sits on the higher one --
-- would then have its higher id flagged here too, leaving the group with no
-- canonical row at all and neither row able to hold the identifier.
--
-- Reading a column this statement also writes is safe here, and the reason is
-- worth stating because it is not obvious: this statement only ever flags rows
-- that are NOT the minimum, so the minimum it computes stays unflagged and the
-- MIN is stable no matter which order rows are visited in. (The migration test
-- pins this with a three-row case-variant group.)
--
-- If (3a) flagged EVERY row in an email group, the subquery is NULL, `id <>
-- NULL` is NULL, and nothing is flagged here -- the group keeps whatever (3a)
-- decided rather than being flagged twice over.
UPDATE users
   SET identity_conflict = 1,
       updated_at = datetime('now')
 WHERE deleted_at IS NULL
   AND identity_conflict = 0
   AND id <> (SELECT MIN(m.id)
                FROM users m
               WHERE m.deleted_at IS NULL
                 AND m.identity_conflict = 0
                 AND m.email = users.email COLLATE NOCASE);

-- (4) The ORCID index. Partial on three counts: NULL/blank iDs are not an
-- identity (most CLI-era rows have none and multiple NULLs would collide even
-- in a plain unique index only if SQLite treated NULLs as equal -- it does
-- not, but the blank string is not so forgiving, hence the TRIM); tombstones
-- are not live accounts; and a flagged row has already lost its claim.
--
-- The TRIM predicate matches (3a)'s exactly. That correspondence is
-- load-bearing rather than tidy: if the index admitted a row the flagging pass
-- skipped, the CREATE could fail on a catalog the flags said was clean.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_orcid_live_unique
  ON users(orcid)
  WHERE orcid IS NOT NULL
    AND TRIM(orcid) <> ''
    AND deleted_at IS NULL
    AND identity_conflict = 0;

-- (5) The email index, case-insensitive. This is a strictly stronger
-- constraint than the exact-case table-level UNIQUE from 0026, which stays --
-- both are enforced, and a case-variant collision now fails at THIS index.
--
-- SQLite reports such a failure as `UNIQUE constraint failed: users.email`
-- (the column, not the index name), which is what the existing column-scoped
-- catch clauses in signup and /auth/email/change/verify already match on.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_live_unique
  ON users(email COLLATE NOCASE)
  WHERE deleted_at IS NULL
    AND identity_conflict = 0;

-- Cheap lookup for the duplicate report's "show me the flagged rows" half.
CREATE INDEX IF NOT EXISTS idx_users_identity_conflict
  ON users(identity_conflict);
