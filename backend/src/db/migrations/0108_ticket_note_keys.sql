-- Issue #1941 (epic #1893, ADR 0112): an optional Idempotency-Key on an internal ticket note, so a
-- note retried after a lost response is stored once.
-- A note sends no mail, so there is no pending or unknown state: the note and its key are written in
-- one batch and a repeat of the key returns the stored message id. The namespace is separate from
-- mail_reply_keys on purpose: a key used for a reply never answers a note and the reverse, so one
-- caller-chosen string can serve both without either replaying the other's outcome.
-- message_id is the mail_messages id of the note; it is deliberately not a foreign key, because the
-- retention purge deletes the messages and the keys in the same batch (ticket_id cascades anyway).
CREATE TABLE IF NOT EXISTS mail_note_keys (
  ticket_id INTEGER NOT NULL REFERENCES mail_tickets (id) ON DELETE CASCADE,
  idem_key TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticket_id, idem_key)
);
