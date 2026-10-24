-- Epic #1893 phase 6a (#1943, ADR 0111): support-ticket retention. After the retention period only
-- a short written summary of a ticket is kept; the raw messages and everything personal are purged
-- by services/ticket-retention.ts.
--   summary: written through the admin API by whoever may see the ticket (never by the Worker, which
--     calls no model). summary_author_user_id and summarized_at say who and when. It is read-only
--     once purged_at is set.
--   purged_at: set by the purge. requester_email and subject are NOT NULL in 0102, so a purged
--     ticket holds the empty string in both rather than NULL; rebuilding the table to relax two
--     constraints would risk the ticket data for no gain, and '' reads as "cleared" everywhere.
ALTER TABLE mail_tickets ADD COLUMN summary TEXT;
ALTER TABLE mail_tickets ADD COLUMN summary_author_user_id INTEGER;
ALTER TABLE mail_tickets ADD COLUMN summarized_at TEXT;
ALTER TABLE mail_tickets ADD COLUMN purged_at TEXT;

-- The purge scan (oldest not-yet-purged first) and the "closed, still to summarize" list.
CREATE INDEX IF NOT EXISTS idx_mail_tickets_purge ON mail_tickets (last_message_at)
  WHERE purged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mail_tickets_unsummarized ON mail_tickets (last_message_at)
  WHERE status = 'closed' AND purged_at IS NULL AND summary IS NULL;

-- A purge deletes a ticket's messages, and with them the raw_key that tells reprocessRawKey the
-- stored message was already ticketed. Without a trace a reprocess of a raw object that outlived
-- its ticket would rebuild the purged conversation as a new ticket. The key is a random id and a
-- date; it carries nothing about the sender.
CREATE TABLE IF NOT EXISTS mail_purged_raw_keys (
  raw_key TEXT PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  purged_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The event kinds gain 'summary' and 'purged'. A CHECK cannot be altered in place, so the table is
-- rebuilt (nothing references it).
CREATE TABLE mail_ticket_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES mail_tickets (id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('created', 'assigned', 'unassigned', 'escalated', 'status', 'reopened',
                    'restricted', 'excluded', 'reply', 'reply_failed', 'note', 'summary',
                    'purged')),
  actor_user_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO mail_ticket_events_new (id, ticket_id, kind, actor_user_id, detail, created_at)
  SELECT id, ticket_id, kind, actor_user_id, detail, created_at FROM mail_ticket_events;
DROP TABLE mail_ticket_events;
ALTER TABLE mail_ticket_events_new RENAME TO mail_ticket_events;
CREATE INDEX IF NOT EXISTS idx_mail_ticket_events_ticket ON mail_ticket_events (ticket_id, id);
