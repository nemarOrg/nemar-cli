-- Issue #1893 follow-up (ADR 0112): ticket references become three words, `amber-falcon-river`.
-- 0102 constrained `ref` to ten base32 characters, and a CHECK cannot be altered in place, so
-- mail_tickets is rebuilt with a CHECK that accepts either form:
--   legacy: exactly ten of a-z and 2-7 (tickets already issued keep theirs, and mail in flight
--           carries `support+t<ref>@`);
--   words:  lowercase a-z words joined by exactly two dashes, at most 64 characters in all.
-- Every other column, default, check, index and the trigger are carried over unchanged from 0102
-- and 0107. No ticket is rewritten and ids are copied verbatim.
--
-- FOREIGN KEYS. Five tables reference mail_tickets(id) ON DELETE CASCADE (mail_messages,
-- mail_ticket_tags, mail_ticket_events, mail_reply_keys, mail_note_keys). DROP TABLE on the parent
-- runs an implicit DELETE FROM that CASCADES into them, and `PRAGMA defer_foreign_keys` only defers
-- the violation check, not the cascade action, so deferral alone would lose every child row. The
-- children are therefore copied to plain backup tables first, the parent is swapped, and the
-- children are restored from the backups (ids verbatim) once the new parent carries its name.
-- Child tables are never dropped, so their indexes and AUTOINCREMENT sequences are untouched. There
-- is no BEGIN/COMMIT: D1 refuses them.
--
-- The sqlite_sequence row of mail_tickets dies with the dropped table, and the new table's would
-- restart from the highest copied id, which is lower than the old one if the newest tickets were
-- deleted (the retention purge keeps rows, but a hand delete does not). It is restored below so an
-- id is never reused.

CREATE TABLE mail_bak_messages AS SELECT * FROM mail_messages;
CREATE TABLE mail_bak_tags AS SELECT * FROM mail_ticket_tags;
CREATE TABLE mail_bak_events AS SELECT * FROM mail_ticket_events;
CREATE TABLE mail_bak_reply_keys AS SELECT * FROM mail_reply_keys;
CREATE TABLE mail_bak_note_keys AS SELECT * FROM mail_note_keys;
CREATE TABLE mail_bak_seq AS SELECT seq FROM sqlite_sequence WHERE name = 'mail_tickets';

CREATE TABLE mail_tickets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL CHECK (
    (length(ref) = 10 AND ref NOT GLOB '*[^a-z2-7]*')
    OR (length(ref) <= 64 AND ref NOT GLOB '*[^a-z-]*' AND ref NOT GLOB '-*' AND ref NOT GLOB '*-'
        AND ref NOT GLOB '*--*' AND length(ref) - length(replace(ref, '-', '')) = 2)
  ),
  queue_tag TEXT NOT NULL CHECK (length(queue_tag) > 0),
  restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),
  excluded_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'pending', 'escalated', 'closed', 'spam')),
  assignee_user_id INTEGER,
  requester_email TEXT NOT NULL,
  requester_user_id INTEGER,
  subject TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  summary TEXT,
  summary_author_user_id INTEGER,
  summarized_at TEXT,
  purged_at TEXT,
  last_activity_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'
);

INSERT INTO mail_tickets_new (id, ref, queue_tag, restricted, excluded_user_id, status,
    assignee_user_id, requester_email, requester_user_id, subject, created_at, updated_at,
    last_message_at, summary, summary_author_user_id, summarized_at, purged_at, last_activity_at)
  SELECT id, ref, queue_tag, restricted, excluded_user_id, status,
    assignee_user_id, requester_email, requester_user_id, subject, created_at, updated_at,
    last_message_at, summary, summary_author_user_id, summarized_at, purged_at, last_activity_at
  FROM mail_tickets;

DROP TABLE mail_tickets;
ALTER TABLE mail_tickets_new RENAME TO mail_tickets;

-- Indexes and the trigger, identical to 0102 and 0107 (dropped with the old table).
CREATE UNIQUE INDEX idx_mail_tickets_ref ON mail_tickets (ref);
CREATE INDEX idx_mail_tickets_status ON mail_tickets (status, last_message_at);
CREATE INDEX idx_mail_tickets_queue ON mail_tickets (queue_tag, last_message_at);
CREATE INDEX idx_mail_tickets_assignee ON mail_tickets (assignee_user_id, last_message_at);
CREATE INDEX idx_mail_tickets_requester_user ON mail_tickets (requester_user_id);
CREATE INDEX idx_mail_tickets_excluded_user ON mail_tickets (excluded_user_id);
CREATE INDEX idx_mail_tickets_purge ON mail_tickets (last_activity_at, id)
  WHERE purged_at IS NULL;
CREATE INDEX idx_mail_tickets_unsummarized ON mail_tickets (last_message_at)
  WHERE status = 'closed' AND purged_at IS NULL AND summary IS NULL;
CREATE TRIGGER mail_tickets_activity_default AFTER INSERT ON mail_tickets
  WHEN NEW.last_activity_at = '1970-01-01 00:00:00'
BEGIN
  UPDATE mail_tickets SET last_activity_at = NEW.last_message_at WHERE id = NEW.id;
END;

-- The cascade emptied the children when the old parent went; restore them with their ids. Each
-- DELETE is a no-op after that cascade and keeps the restore exact if a runner ever skipped it.
DELETE FROM mail_messages;
INSERT INTO mail_messages SELECT * FROM mail_bak_messages;
DELETE FROM mail_ticket_tags;
INSERT INTO mail_ticket_tags SELECT * FROM mail_bak_tags;
DELETE FROM mail_ticket_events;
INSERT INTO mail_ticket_events SELECT * FROM mail_bak_events;
DELETE FROM mail_reply_keys;
INSERT INTO mail_reply_keys SELECT * FROM mail_bak_reply_keys;
DELETE FROM mail_note_keys;
INSERT INTO mail_note_keys SELECT * FROM mail_bak_note_keys;

-- The sequence never goes backwards.
UPDATE sqlite_sequence SET seq = (SELECT seq FROM mail_bak_seq)
  WHERE name = 'mail_tickets' AND seq < (SELECT seq FROM mail_bak_seq);
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'mail_tickets', seq FROM mail_bak_seq
  WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'mail_tickets');

DROP TABLE mail_bak_messages;
DROP TABLE mail_bak_tags;
DROP TABLE mail_bak_events;
DROP TABLE mail_bak_reply_keys;
DROP TABLE mail_bak_note_keys;
DROP TABLE mail_bak_seq;
