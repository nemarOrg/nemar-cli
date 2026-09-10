-- Docs-scoped web sessions and their one-time handoff grants
-- (epic #1336 phase 0, issue #1338).
--
-- WHAT THIS CLOSES. `docs.nemar.org/admin/*` was reachable by anyone: the
-- Cloudflare Access app the docs repo's AGENTS.md described covers only that
-- Pages project's PREVIEW deployments, never production, so all 12 pages
-- answered 200 anonymously and sat in the public sitemap. The gate is now
-- NEMAR's own ORCID-backed session with an admin-role check, so `users.role`
-- stays the single source of truth for who is an admin instead of an
-- allowlist maintained somewhere else.
--
-- WHY A HANDOFF EXISTS AT ALL. `WEB_SESSION_COOKIE_DOMAIN` is
-- `app.nemar.org`, scoped that narrowly on purpose so the session never
-- attaches to `data.nemar.org` byte-range fetches or `api.nemar.org` search.
-- A cookie scoped to one host cannot authenticate another, so the docs host
-- needs its own credential; widening the cookie to `.nemar.org` would undo
-- the reason the scope exists. So the website's authorize page proves an
-- admin session, `POST /auth/docs/grant` writes a row here, and the docs
-- Pages Function exchanges it once for a cookie of its own.
--
-- NOTHING SECRET LIVES HERE, which is the rule ADR 0047 fixed for the device
-- flow. `code_hash` is the SHA-256 of the one-time code, and the docs session
-- is minted BY THE EXCHANGE, not by the grant -- so between the two steps
-- there is no cookie value at rest for a read of this table to steal.

-- Docs sessions are ordinary web_sessions rows, distinguished by scope, so
-- revocation, expiry, the `users.status != 'revoked'` join and the
-- `deleted_at` guard in findSessionByCookieId all apply unchanged. That reuse
-- is the point: a separate table would have needed its own copy of every one
-- of those predicates, and a copy is what drifts.
--
-- The DEFAULT is what makes this safe to add to a live table: every existing
-- row is an app session and must keep authenticating the app.
--
-- SEPARATION IS ENFORCED AT EVERY READER, AND THERE ARE TWO. `web_sessions` is
-- read by cookie hash in `services/web-session.ts` (`findSessionByCookieId`,
-- which defaults to 'app') and again in `middleware/auth.ts`
-- (`resolveCookieUser`, which backs the bearer/cookie middleware on the whole
-- management API). The first version of this change added the predicate to only
-- the first, and review found the consequence: the docs credential authenticated
-- `/admin/*`, so a read-only documentation session was an owner-grade API
-- session. A scope column is worth nothing unless every reader names the scope it
-- wants, so a third reader must do the same -- or go through
-- `findSessionByCookieId`.
ALTER TABLE web_sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'app';

-- Partial index: docs sessions are a tiny minority of this table, and the one
-- query that scans by user rather than by cookie hash (logout's revoke-all)
-- only ever wants those rows. Indexing just them leaves the app-session hot
-- path, which goes through `cookie_id_hash`, untouched.
CREATE INDEX IF NOT EXISTS idx_web_sessions_docs_scope
  ON web_sessions(user_id, expires_at) WHERE scope = 'docs';

CREATE TABLE IF NOT EXISTS docs_grants (
  -- SHA-256 of the one-time code carried in the redirect to the docs host.
  -- Primary key because the hash IS the row's identity at exchange time, the
  -- same pattern as `device_codes.device_code_hash`.
  code_hash TEXT PRIMARY KEY,
  -- Who the grant was minted for. The exchange re-reads role and status from
  -- `users` rather than trusting anything stored here, so an account demoted
  -- or revoked inside the grant's 60 seconds still refuses.
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Carried from the app session that authorized this grant ('orcid' or
  -- 'email_code'), and copied onto the docs session the exchange mints, so
  -- the docs session records how the identity behind it was actually proven
  -- instead of resetting that history at the host boundary.
  auth_method TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- SINGLE USE IS A DELETE, NOT A FLAG, and that is deliberate. Claiming a
-- grant has to be atomic against a concurrent second exchange, and a flag
-- needs two writes -- mark used, then record what it minted -- where the
-- second can fail and leave a row that is either replayable or lying. A
-- DELETE gated on the same conditions is one write that either wins or does
-- not, and it leaves nothing behind to replay. The exchange runs it in the
-- same `db.batch()` as the session INSERT, gated on `EXISTS` against the
-- cookie hash that INSERT wrote (never `last_insert_rowid()`, which is stale
-- after a zero-row `INSERT ... SELECT` on both D1 and bun:sqlite -- the
-- lesson `DEVICE_MINT_CONSUME_SQL` already carries). A grant whose mint was
-- refused therefore survives to expiry rather than being burned, which costs
-- nothing: it can never mint anything.
--
-- Drives only the opportunistic prune's scan (`grant` deletes rows more than
-- an hour past expiry, the same idea as `device_codes` in 0081 and
-- `orcid_link_intents` in 0078; nobody polls a grant, so no row needs to
-- survive to explain itself). Every other read goes through the primary key.
CREATE INDEX IF NOT EXISTS idx_docs_grants_expires ON docs_grants(expires_at);
