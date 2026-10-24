-- Epic #1893 phase 2 (ADR 0110): announcements move onto a queue when the Cloudflare email
-- provider is active, so the audit row outlives the request and accumulates outcomes.
-- ADD COLUMN only (no table rebuild). Existing rows read as 'sent', their send having
-- completed inline.
--   status: 'sent' = finished inline; 'queued' = messages still being delivered;
--           'done' = every queued message has an outcome.
--   queued_count / delivered_count / unknown_count: per-message outcomes written by the
--   queue consumer; failure_count and failed_recipients keep their existing meaning.
ALTER TABLE broadcast_emails ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'
  CHECK (status IN ('sent', 'queued', 'done'));
ALTER TABLE broadcast_emails ADD COLUMN queued_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcast_emails ADD COLUMN delivered_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcast_emails ADD COLUMN unknown_count INTEGER NOT NULL DEFAULT 0;
