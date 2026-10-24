-- Epic #1893 phase 3b (#1896, ADR 0111): who an escalated ticket goes to.
-- A queue's own escalation_user_id wins; a queue with none falls back to the '*' row's. The
-- reference is a plain INTEGER with no foreign key, like every user reference in 0102, and is
-- re-checked for eligibility (role, restricted, exclusion) at the moment of escalation, so a
-- stale value can only refuse an escalation and never widen access.
ALTER TABLE mail_queues ADD COLUMN escalation_user_id INTEGER;

-- Idempotent replies (phase 3b review). An agent that holds the default assignee account may retry
-- a reply whose answer it lost, so a reply may carry an Idempotency-Key, stored here BEFORE the
-- send and unique per ticket. state: pending (being sent), sent (outcome holds the response to
-- repeat), unknown (the provider did not confirm; a repeat is refused, never re-sent). A reply
-- that certainly sent nothing deletes its row so the retry can go.
CREATE TABLE IF NOT EXISTS mail_reply_keys (
  ticket_id INTEGER NOT NULL REFERENCES mail_tickets (id) ON DELETE CASCADE,
  idem_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'unknown')),
  header_message_id TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticket_id, idem_key)
);
