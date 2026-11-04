-- Issue #1899 (epic #1893, ADR 0113): screening of inbound support mail.
--
-- mail_blocklist: senders refused at delivery. The Worker looks a message's envelope sender and
-- header From up here (the address, its domain and every parent domain) before it stores anything.
-- value is lowercased; one row per (kind, value). created_by has no foreign key, like every other
-- user reference in the mail tables: an account that leaves keeps the block it made.
--
-- mail_tickets.filtered: why a ticket was filed quietly (bulk or list mail, an automatic reply, a
-- bounce, a sender over the hourly cap), else NULL. NULL for every existing ticket. A filtered
-- ticket is not assigned or announced and is hidden from the default list and the unread badge.
--
-- mail_queues.notify: 0 makes a queue quiet, so a new ticket in it announces nothing. Existing
-- queues keep announcing (default 1).
--
-- mail_ticket_events: the kind list gains 'unfiltered' (a person, or a genuine reply, took a
-- filtered ticket out of hiding). A CHECK cannot be altered, so the table is rebuilt exactly as
-- 0107 did it: it is a leaf (nothing references it), its rows and ids are copied verbatim, and
-- its index is recreated. The AUTOINCREMENT sequence restarts from the highest copied id, which
-- is harmless: event ids only order events within a ticket and nothing stores one elsewhere.
--
-- idx_mail_messages_from_created serves the per-sender hourly count of inbound messages.
--
-- FUTURE REBUILDS OF mail_tickets (see 0110): a rebuild must carry the filtered column over.

CREATE TABLE IF NOT EXISTS mail_blocklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
  value TEXT NOT NULL CHECK (length(value) > 0 AND value = lower(value)),
  reason TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, value)
);

ALTER TABLE mail_tickets ADD COLUMN filtered TEXT
  CHECK (filtered IS NULL OR filtered IN ('bulk', 'auto_reply', 'bounce', 'rate_limited'));

ALTER TABLE mail_queues ADD COLUMN notify INTEGER NOT NULL DEFAULT 1 CHECK (notify IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_mail_messages_from_created
  ON mail_messages (from_addr, created_at);

CREATE TABLE mail_ticket_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES mail_tickets (id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('created', 'assigned', 'unassigned', 'escalated', 'status', 'reopened',
                    'restricted', 'excluded', 'reply', 'reply_failed', 'note', 'summary',
                    'purged', 'unfiltered')),
  actor_user_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO mail_ticket_events_new (id, ticket_id, kind, actor_user_id, detail, created_at)
  SELECT id, ticket_id, kind, actor_user_id, detail, created_at FROM mail_ticket_events;
DROP TABLE mail_ticket_events;
ALTER TABLE mail_ticket_events_new RENAME TO mail_ticket_events;
CREATE INDEX IF NOT EXISTS idx_mail_ticket_events_ticket ON mail_ticket_events (ticket_id, id);
