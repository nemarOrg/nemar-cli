-- Community mail categories (epic #2260 phase 1, ADR 0132).
--
-- `users.email_preferences` kept one switch, `announcements`, for all community mail. It becomes
-- three: `news`, `rfcs` and `maintenance` (a recall is never stored, because nothing may turn it
-- off). Every live row carries today's `announcements` value into all three, explicitly, so an
-- account that opted out of announcements stays opted out of each category and nobody gains mail.
-- `announcements` is KEPT, unchanged, for now: migrations apply seconds before the new worker
-- deploys, and the previous worker reads `announcements` (a missing key as ON). Removing it would
-- let a notify in that window reach every account that had opted out. Nothing in the new code
-- reads or writes it; a migration in the release after this epic's drops the key.
--
-- Only strict JSON `false` counts as an opt-out, the way the parser reads every key
-- (`!== false`): json_type() tells JSON `false` from `0` and from the string "false", where
-- json_extract() returns 0 for the first and cannot tell it from the second kind of zero.
--
-- Idempotent on purpose: it touches only live rows that carry no `news` key yet, so a second run
-- cannot turn a person's later choice back on. The CASE around json_type() in the WHERE clauses
-- makes a deleted row's text unreachable by it whatever order the engine evaluates the terms in.

-- 1. A column that holds text which is not a JSON object (corrupt, empty, a bare string or an
--    array) becomes '{}'. The parser already reads all of those as "all on", so this loses
--    nothing. NULL is left alone here: the carry below treats it as '{}', and step 2 tells a row
--    that stored a choice from one that never did. The inner CASE keeps json_type() from ever
--    seeing malformed text, which would raise instead of answering.
UPDATE users
   SET email_preferences = '{}'
 WHERE deleted_at IS NULL
   AND email_preferences IS NOT NULL
   AND CASE
         WHEN NOT json_valid(email_preferences) THEN 1
         ELSE json_type(email_preferences) IS NOT 'object'
       END;

-- 2. One summary audit row, written BEFORE the rewrite so it counts what the rewrite will carry
--    (the rewrite adds the `news` key this counts rows by). Not one row per person: that would be a thousand
--    rows saying the same thing. Written only when some live account had stored preferences, so a
--    database with none (every fresh test database) gains no audit row from this migration.
INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
SELECT NULL, 'mail_category_changed', 'migration', '0146',
       json_object(
         'via', 'migration',
         'categories', json_array('news', 'rfcs', 'maintenance'),
         'carried', carried,
         'opted_out', COALESCE(opted_out, 0)
       )
  FROM (
    SELECT COUNT(*) AS carried,
           SUM(email_preferences IS NOT NULL) AS stored,
           SUM(json_type(email_preferences, '$.announcements') = 'false') AS opted_out
      FROM users
     WHERE deleted_at IS NULL
       AND CASE WHEN deleted_at IS NULL THEN json_type(COALESCE(email_preferences, '{}'), '$.news') IS NULL ELSE 0 END
  )
 WHERE stored > 0;

-- 3. Carry the value into the three categories. The old key stays (see the header).
UPDATE users
   SET email_preferences = json_set(
         COALESCE(email_preferences, '{}'),
         '$.news',
         json(CASE WHEN json_type(email_preferences, '$.announcements') = 'false' THEN 'false' ELSE 'true' END),
         '$.rfcs',
         json(CASE WHEN json_type(email_preferences, '$.announcements') = 'false' THEN 'false' ELSE 'true' END),
         '$.maintenance',
         json(CASE WHEN json_type(email_preferences, '$.announcements') = 'false' THEN 'false' ELSE 'true' END)
       )
 WHERE deleted_at IS NULL
   AND CASE WHEN deleted_at IS NULL THEN json_type(COALESCE(email_preferences, '{}'), '$.news') IS NULL ELSE 0 END;

-- Broadcast rows learn their category. Existing rows keep NULL, which means a legacy,
-- uncategorized send (the audience was "approved accounts with announcements on").
--   category:         one of the four; NULL for a legacy row.
--   recall_reference: what a recall is about (a dataset id and version, an issue or advisory URL,
--                     a ledger entry id); NULL for every other row.
--   skipped_count:    recipients the consumer left unsent because, between enqueue and send, the
--                     account went away, its address changed or the category was switched off.
ALTER TABLE broadcast_emails ADD COLUMN category TEXT
  CHECK (category IS NULL OR category IN ('news', 'rfcs', 'maintenance', 'recall'));
ALTER TABLE broadcast_emails ADD COLUMN recall_reference TEXT;
ALTER TABLE broadcast_emails ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;

-- The outcome vocabulary is a CHECK constraint, so adding 'skipped' rebuilds the table. Nothing
-- references broadcast_outcomes (no foreign key points at it), and its only index is the
-- primary key, so a copy, a drop and a rename lose nothing.
CREATE TABLE broadcast_outcomes_new (
  broadcast_id INTEGER NOT NULL,
  recipient_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'failed', 'unknown', 'unqueued', 'skipped')),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (broadcast_id, recipient_hash)
);
INSERT INTO broadcast_outcomes_new (broadcast_id, recipient_hash, outcome, recorded_at)
  SELECT broadcast_id, recipient_hash, outcome, recorded_at FROM broadcast_outcomes;
DROP TABLE broadcast_outcomes;
ALTER TABLE broadcast_outcomes_new RENAME TO broadcast_outcomes;
