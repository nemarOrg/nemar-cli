-- The repeat guard's subject key (epic #2260 phase 3).
--
-- A categorized send is refused when the same category, subject and group went out in the last 24
-- hours. "Same subject" must survive trailing spaces, doubled spaces and letter case, but the stored
-- `subject` stays exactly as sent (it is the audit record, and what recipients saw), so the guard
-- compares a normalized copy: NFKC, trimmed, internal whitespace collapsed to one space, lowercased,
-- written by the sender in the same statement as the row. Legacy rows and per-user sends carry NULL
-- and are never matched.
ALTER TABLE broadcast_emails ADD COLUMN subject_key TEXT;
