-- Issue #1893 follow-up (ADR 0112): per-admin "unread" for support tickets, for the Mail badge.
-- One row per (admin, ticket) holds the highest message id that admin has seen when opening the
-- ticket. A ticket is unread for an admin when it has an inbound message above that marker, or no
-- marker and any inbound message; outgoing replies and notes never make it unread. One admin
-- opening a ticket marks nothing for anyone else.
--
-- user_id has no foreign key, like every other user reference in the mail tables: the rows are
-- removed by mailReleaseStatements (demotion, revocation, soft delete), which names this table.
-- ticket_id cascades with its ticket; the index serves that cascade's child lookup, and the
-- primary key serves the per-user lookups of the list and the count.
--
-- FUTURE REBUILDS OF mail_tickets. This is a sixth child table of mail_tickets(id) ON DELETE
-- CASCADE. A rebuild like 0109's (DROP TABLE on the parent cascades into its children, even under
-- PRAGMA defer_foreign_keys) must copy this table to a backup first and restore it afterwards, or
-- every read marker is lost and every ticket turns unread.

CREATE TABLE IF NOT EXISTS mail_ticket_reads (
  user_id INTEGER NOT NULL,
  ticket_id INTEGER NOT NULL REFERENCES mail_tickets(id) ON DELETE CASCADE,
  read_message_id INTEGER NOT NULL,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_ticket_reads_ticket ON mail_ticket_reads (ticket_id);
