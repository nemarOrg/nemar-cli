-- The identifier screen of a publication request (epic #1610, phase 4).
--
-- When a depositor requests publication, the Worker dispatches a workflow to
-- nemarDatasets/.github that screens the dataset for identifying information
-- (names, birth dates and record numbers in EDF/BDF headers, sidecars, file
-- names) and posts a report back to /webhooks/identifier-screen-result. The
-- admin's publication-request email is sent when that report lands and states
-- it; a screen that could not start, failed or never reported is mailed too,
-- and says so. These columns are that round-trip, per request.
--
-- The report's shape, and every word that may appear in it, is declared in
-- `shared/identifier-screen-report.ts`. The Worker stores only what
-- `parseScreenReport` accepted, re-serialized, never the raw callback body, so
-- the row carries kinds, counts and fixed words and never a value.
--
--   * `identifier_screen_status`: a `ScreenState` from that module, as TEXT.
--     NULL means no screen was started for this request: it predates the
--     screen, or it was blocked before one ran, or the dataset is a sandbox
--     (`xx`) exemplar that never publishes real data. A reader must not trust
--     the column (`isScreenState`), and NULL is never read as clean.
--   * `identifier_screen_nonce`: the nonce signed into the callback token, the
--     same one-shot handshake as `prescreen_nonce` (migration 0028). Cleared
--     when a result is stored, so a replayed callback finds nothing to verify.
--     KEPT when the watchdog marks a screen 'unreported', so a late but valid
--     report is still accepted; a re-run replaces it.
--   * `identifier_screen_dispatched_at`: when the screen was handed to GitHub.
--     The watchdog turns a screen still pending 50 minutes later into
--     'unreported', because GitHub answers a dispatch 204 even when no
--     workflow listens for it.
--   * `identifier_screen_at`: when the result (or the failure to get one) was
--     recorded.
--   * `identifier_screen_report`: the parsed report, re-serialized JSON.
--   * `identifier_screen_emailed_at`: the admin email for this result reached at
--     least one admin. Set only after a send that landed.
--   * `identifier_screen_mail_claimed_at`: a five-minute lease on sending that
--     email, taken before the send and released when nobody received it. A
--     process that dies between claim and send, or a release that fails, leaves
--     a lease that expires, and the watchdog retries the mail then.
--   * `identifier_screen_ack_by` / `_ack_reason` / `_ack_at`: an admin approved
--     over a screen that needed a person to look (users.id, their stated
--     reason, when). No FOREIGN KEY, matching `approved_by` and `denied_by`:
--     an account ending must not be blocked by, or cascade into, a request.
--
-- Re-requesting a blocked request, or re-running the screen, resets every one
-- of these columns in the same statement, so a stale 'clean' or an old
-- acknowledgment can never carry over to new content.
--
-- All nullable with no backfill: every existing request predates the screen,
-- and NULL is the truth for it. Nothing is indexed: the callback looks a row up
-- by `id`, and the watchdog's candidates are a handful of active requests.

ALTER TABLE publication_requests ADD COLUMN identifier_screen_status TEXT;
ALTER TABLE publication_requests ADD COLUMN identifier_screen_nonce TEXT;
ALTER TABLE publication_requests ADD COLUMN identifier_screen_dispatched_at TEXT;
ALTER TABLE publication_requests ADD COLUMN identifier_screen_at TEXT;
ALTER TABLE publication_requests ADD COLUMN identifier_screen_report TEXT;
ALTER TABLE publication_requests ADD COLUMN identifier_screen_emailed_at TEXT;
ALTER TABLE publication_requests ADD COLUMN identifier_screen_mail_claimed_at TEXT;
ALTER TABLE publication_requests ADD COLUMN identifier_screen_ack_by INTEGER;
ALTER TABLE publication_requests ADD COLUMN identifier_screen_ack_reason TEXT;
ALTER TABLE publication_requests ADD COLUMN identifier_screen_ack_at TEXT;
