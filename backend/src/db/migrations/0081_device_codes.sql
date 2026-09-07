-- Device authorization grant codes (RFC 8628; epic #1272 phase 1, #1281;
-- ADR 0047).
--
-- WHAT THIS CLOSES. `nemar auth login` cannot receive an OAuth redirect on
-- a headless host, so CLI sign-in mints a device code here
-- (`POST /auth/device/start`), a person authorizes it in a browser they are
-- already signed into (`GET /auth/device/lookup`,
-- `POST /auth/device/{confirm,deny}`), and the CLI collects an API key by
-- polling `POST /auth/device/token`.
--
-- LIFECYCLE. pending -> confirmed -> consumed (a key was minted), or
-- pending -> denied, or any non-terminal status -> expired once something
-- observes `expires_at` has passed (no cron: the first poll, lookup, confirm
-- or deny past expiry stamps it). Rows older than 24 hours past expiry are
-- pruned opportunistically at `start` -- the same opportunistic-prune-
-- instead-of-cron IDEA as `orcid_link_intents` (migration 0078), but not
-- the same retention: that table deletes a row the moment it expires
-- (nothing there is useful once its ten minutes are up), while a device
-- code stays around for 24 hours past expiry so one more `token` poll can
-- still answer `expired_token` with a sentence instead of "unknown code".
--
-- NOTHING SECRET LIVES HERE. `device_code_hash` is the SHA-256 hash of the
-- polling secret the CLI holds (`hashApiKey`, same function `tokens
-- .api_key_hash` uses) -- a read of this table cannot be turned into a
-- working device code. `user_code` is the short code a person types or has
-- pre-filled into a link; it identifies the row for the browser half of the
-- flow but authorizes nothing by itself; the CLI's poll requires the
-- device_code_hash's preimage.
--
-- The key itself is never written here. Confirm stamps `status='confirmed'`
-- and `user_id` only; the token endpoint mints the `tokens` row and
-- consumes this row's `status -> 'consumed'` in one batch, so a confirmed
-- code yields at most one key and no plaintext key is ever at rest.

CREATE TABLE IF NOT EXISTS device_codes (
  -- SHA-256 hash of the 256-bit polling secret the CLI holds. Primary key:
  -- the hash IS the identity of the row for the token endpoint's lookup,
  -- same pattern as `orcid_link_intents.nonce`.
  device_code_hash TEXT PRIMARY KEY,
  -- The short code shown in the terminal and typed/pre-filled in the
  -- browser. Globally UNIQUE so a lookup by code is never ambiguous; `start`
  -- retries on a collision (services/device-auth.ts).
  user_code TEXT NOT NULL UNIQUE,
  -- Client-supplied text (RFC 8628 section 5.4), shown back to the person
  -- authorizing so they can recognise "did I just run this". The website
  -- (phase 2) must escape and frame it; this table stores it verbatim.
  machine_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'denied', 'consumed', 'expired')),
  -- Set by confirm. NULL until then; NEVER set by deny (the denier is
  -- recorded on the audit row, not on this table -- ADR 0047).
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  -- Set by the token endpoint's mint, once. Lets an admin trace which
  -- device-auth row produced a given tokens row.
  token_id INTEGER REFERENCES tokens(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  -- Poll floor bookkeeping (ADR 0047): a poll sooner than 5 seconds after
  -- the previous one is answered `slow_down` without resetting the timer.
  last_polled_at TEXT,
  poll_count INTEGER NOT NULL DEFAULT 0,
  confirmed_at TEXT,
  consumed_at TEXT,
  -- A row cannot claim to be confirmed or consumed without naming the
  -- account it was confirmed for -- the same shape `orcid_link_intents`
  -- guarantees with NOT NULL, expressed as a CHECK here because `user_id`
  -- is NULL through 'pending' and 'denied'.
  CHECK (status NOT IN ('confirmed', 'consumed') OR user_id IS NOT NULL)
);

-- Drives ONLY the opportunistic prune's scan (`DELETE ... WHERE expires_at
-- < ...`, the one statement here that has to search by `expires_at` rather
-- than look a single row up). The observed-expiry stamp and every row read
-- go through the primary key (`device_code_hash`) or the `user_code` unique
-- index instead -- `expires_at` is a filter on those lookups, not the path
-- to the row.
CREATE INDEX IF NOT EXISTS idx_device_codes_expires ON device_codes(expires_at);
