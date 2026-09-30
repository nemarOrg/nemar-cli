-- A third web-session scope, 'private', and its one-time handoff grants
-- (ADR 0079).
--
-- WHAT THIS IS FOR. The private site (`private.nemar.org`) hosts NEMAR's
-- access-controlled features and needs a session on its own host. The app
-- session cookie is scoped to `app.nemar.org` on purpose and never reaches
-- another host, so the private site gets a credential of its own through the
-- same handoff the docs host uses (0083, ADR 0056): the website proves an app
-- session, `POST /auth/private/grant` writes a row in `private_grants`, and the
-- private site's Worker trades it once for a session, over the `NemarApiRpc`
-- service binding (ADR 0078). The session is an ordinary `web_sessions` row
-- with `scope = 'private'`, so revocation, expiry and the `deleted_at` guard
-- apply unchanged, for the reason 0083 gives.
--
-- WHY A REBUILD. 0083 added `scope` with `CHECK (scope IN ('app', 'docs'))`,
-- and that CHECK is what keeps the scope a closed set: every reader names the
-- scope it wants, so an unlisted value would be a credential no reader matches.
-- SQLite cannot alter a CHECK, so widening it means rebuilding the table, the
-- same way 0063 widened `notices.level`. Nothing else about `web_sessions`
-- changes: every column is copied in its current order, with its current type,
-- default and constraint, and every index is recreated with its current
-- definition.
--
-- A NEW SCOPE HAS TO BE NAMED BY EVERY READER, which is the lesson 0083 records.
-- `findSessionByCookieId` takes the scope as an argument (default 'app'), and
-- `resolveCookieUser` in `middleware/auth.ts` spells `ws.scope = 'app'`. So a
-- private session authenticates nothing but the private site: not the
-- management API, not `webSessionMiddleware`, not `/auth/docs/verify`. The two
-- scope-free statements, `userIdForCookieId` and `revokeSessionStatement`, are
-- scope-free by design (sign-out) and confer no access.
--
-- FOREIGN KEYS. No other table references `web_sessions`, so DROP TABLE's
-- implicit DELETE has no child to cascade onto, and no
-- `PRAGMA defer_foreign_keys` is needed. Checked two ways on 2026-09-30: a
-- case-insensitive, quote-tolerant search of every migration for a
-- `REFERENCES` clause naming it (only this header matches), and the schema
-- every migration replays to, where no table's `PRAGMA foreign_key_list` names
-- it and no trigger or view mentions it. The live `nemar-db-dev` schema was
-- compared the same day: exactly this table, its unique autoindex,
-- `idx_web_sessions_user_active` and `idx_web_sessions_docs_scope`, identical
-- to the migration-derived definitions, with no triggers, views or references.
-- The new table's own foreign key is to `users(id)`, which every copied row
-- already satisfies. There is no BEGIN/COMMIT: D1 refuses them (error 7500,
-- recorded in 0021 and 0063).
--
-- ATOMICITY IS LIKELY AND NOT GUARANTEED, so this file does not rely on it.
-- What was checked on 2026-09-30:
--   * `wrangler d1 migrations apply --remote` (wrangler 4.85.0, the version
--     backend/bun.lock pins; `wrangler-dist/cli.js`, the `unappliedMigrations`
--     loop and `executeRemotely`) appends its own INSERT INTO d1_migrations to
--     this text and sends the whole string as ONE POST to the D1 REST `/query`
--     endpoint. With `--local` it splits the text and runs `db.batch()`, which
--     is one transaction; that is the path `bun run migrations:d1-check` takes.
--   * The REST reference says a multi-statement `sql` "will be executed as a
--     batch" and says nothing about rollback
--     (developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).
--     "Batched statements are SQL transactions" is documented for the Worker
--     binding's `batch()` (developers.cloudflare.com/d1/worker-api/d1-database/),
--     not for that endpoint, and "D1 runs every query inside an implicit
--     transaction" (developers.cloudflare.com/d1/sql-api/foreign-keys/) does not
--     say whether one multi-statement request is one query. Migrations 0075 and
--     0077 reached the same reading.
--
-- WHAT THE GUARD RELIES ON. `_rebuild_guard` aborts the file BEFORE the DROP
-- if the copy is short or altered, the construction 0071 uses: inserting a
-- false comparison (0) violates CHECK (ok = 1) and fails that statement. That
-- only stops the DROP if the runner stops at the first failed statement:
--   * wrangler `--local` does (reproduced in review: `CHECK constraint failed:
--     ok = 1`, and the whole batch rolled back), and so does the Miniflare D1
--     `private-sessions-migration.test.ts` runs this file through;
--   * the Worker binding's `exec()` documents it ("execution stops and further
--     statements are not executed");
--   * the REST `/query` path wrangler uses remotely is unverified;
--   * bun:sqlite's multi-statement `exec()` does NOT (checked on bun 1.3.10: it
--     returns without throwing and runs the statements after the failure), so
--     the test drives this file one statement at a time there.
--
-- WHAT THE ORDERING PROTECTS, AND THE WINDOW IT LEAVES:
--   * Everything before the DROP is non-destructive. A failure there leaves
--     `web_sessions` untouched, plus the two scratch tables, which a re-run
--     trips over loudly.
--   * The window is DROP -> RENAME -> CREATE INDEX. Stopping after the DROP and
--     before the RENAME leaves no `web_sessions` table, so every session read
--     fails and sign-in is down, with every row intact in `web_sessions_new`
--     (the guard has already passed by then). `web_sessions_new` is then the
--     ONLY copy of the rows: never drop it, rename it. Stopping after the
--     RENAME leaves the table whole, `cookie_id_hash` still UNIQUE, without the
--     secondary indexes. Wrangler's d1_migrations row comes last, so a file
--     that stops early is not recorded and the next apply re-runs it.
--   * Recovery is D1 Time Travel (`wrangler d1 time-travel restore <db>
--     --timestamp=<unix>`; always on, up to 30 days back on this account:
--     developers.cloudflare.com/d1/reference/time-travel/) to the START of the
--     deploy workflow's migration-apply step, read from the Actions log, not
--     the merge time. It undoes every other write since then too. Redeploy the
--     previous Worker version before or together with the restore, because the
--     new one expects this schema. Or finish the remaining statements below by
--     hand, in order, then record the file in d1_migrations.
--
-- Ids are copied verbatim, never reassigned. Copying them into the
-- AUTOINCREMENT table reseeds `sqlite_sequence` at the highest surviving id, and
-- RENAME carries that entry to the new name. That can be lower than the old
-- sequence if the newest rows were removed by a hard user delete (ON DELETE
-- CASCADE), so an id could be reused; nothing stores a session id beyond the
-- request that read it, so a reused id refers to nothing.
--
-- NO `IF NOT EXISTS` in the rebuild, on purpose: a blind re-run after a partial
-- failure must fail loudly rather than skip steps (0071's rule).

CREATE TABLE _rebuild_guard (ok INTEGER NOT NULL CHECK (ok = 1));

CREATE TABLE web_sessions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cookie_id_hash TEXT NOT NULL UNIQUE,
  remember INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_agent TEXT,
  ip_hash TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  auth_method TEXT,
  scope TEXT NOT NULL DEFAULT 'app'
    CHECK (scope IN ('app', 'docs', 'private'))
);

INSERT INTO web_sessions_new
  (id, user_id, cookie_id_hash, remember, expires_at, last_used_at,
   user_agent, ip_hash, revoked_at, created_at, auth_method, scope)
SELECT id, user_id, cookie_id_hash, remember, expires_at, last_used_at,
       user_agent, ip_hash, revoked_at, created_at, auth_method, scope
  FROM web_sessions;

-- The copy is exact before anything is destroyed: the same number of rows, no
-- row of the old table missing from or different in the new one, and no row
-- in the new table that the old one lacks. `EXCEPT` compares every column,
-- NULLs included, so "short or altered" means exactly that. The id checksum an
-- earlier draft carried is gone: the id is one of the columns, so the EXCEPT
-- pair subsumes it. The three rows overlap on purpose (rows are distinct by
-- id, so the count plus either direction already forces equality); each reads
-- as one plain question.
INSERT INTO _rebuild_guard
SELECT (SELECT COUNT(*) FROM web_sessions_new) = (SELECT COUNT(*) FROM web_sessions);
INSERT INTO _rebuild_guard
SELECT COUNT(*) = 0 FROM (SELECT * FROM web_sessions EXCEPT SELECT * FROM web_sessions_new);
INSERT INTO _rebuild_guard
SELECT COUNT(*) = 0 FROM (SELECT * FROM web_sessions_new EXCEPT SELECT * FROM web_sessions);

DROP TABLE web_sessions;

ALTER TABLE web_sessions_new RENAME TO web_sessions;

-- The two pre-existing indexes, definitions verbatim from 0026 and 0083.
CREATE INDEX idx_web_sessions_user_active
  ON web_sessions(user_id, revoked_at, expires_at);
CREATE INDEX idx_web_sessions_docs_scope
  ON web_sessions(user_id, expires_at) WHERE scope = 'docs';

-- Partial, for the reason 0083 gives for the docs one: private sessions are a
-- minority of the table, and the one query that scans by user rather than by
-- cookie hash (sign-out's revoke-all for this scope) only ever wants them.
CREATE INDEX idx_web_sessions_private_scope
  ON web_sessions(user_id, expires_at) WHERE scope = 'private';

DROP TABLE _rebuild_guard;

-- Shaped like `docs_grants` (0083) plus one column, `state_hash`, and a
-- SEPARATE table rather than a scope column on that one, for two reasons. The statements the live docs gate
-- runs stay untouched. And a docs code can never be spent at the private site,
-- or the reverse, by construction: the two exchanges read different tables, so
-- keeping them apart depends on no predicate anyone could drop.
--
-- Nothing secret lives here either (ADR 0047): `code_hash` is the SHA-256 of
-- the one-time code, and the session is minted by the exchange, never by the
-- grant. Single use is a DELETE gated on the minted row, not a flag, for the
-- reasons 0083 records.
CREATE TABLE private_grants (
  -- SHA-256 of the one-time code carried in the redirect to the private site.
  code_hash TEXT PRIMARY KEY,
  -- Who the grant was minted for. The exchange re-reads status and
  -- `deleted_at` from `users` rather than trusting anything stored here.
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Copied from the app session that authorized the grant, and onto the
  -- private session the exchange mints.
  auth_method TEXT,
  -- SHA-256 of the `state` the private site generated for the browser that
  -- started the sign-in, and holds in a host-only cookie there. The exchange
  -- mints only when the same value comes back, so a code cannot finish a
  -- sign-in in a DIFFERENT browser: without it, an attacker could complete
  -- their own grant in a victim's browser (login CSRF) and receive whatever
  -- the victim then uploads. The docs gate needs none, being read-only.
  state_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Drives only the opportunistic prune the grant route runs; every other read
-- goes through the primary key.
CREATE INDEX idx_private_grants_expires ON private_grants(expires_at);
