-- Drop the retired `announcements` key from `users.email_preferences` (ADR 0132).
--
-- Migration 0146 carried each live row's `announcements` value into `news`, `rfcs` and
-- `maintenance` and kept the old key one release longer, because the worker that was still
-- serving during that deploy read it. Since 0.10.38 nothing reads or writes it
-- (`parseEmailPreferences` reads only the current keys, and the admin route refuses it by name),
-- so removing it changes what no reader sees.
--
-- Only a row whose column is a JSON object that holds the key is rewritten; every other key stays
-- as it is. Corrupt text, NULL and non-object JSON are left alone: json_remove would raise on
-- malformed text, so the CASE keeps json_type() from seeing it, and a member path on JSON that is
-- not an object answers NULL.
-- Safe to run twice: the second run matches no row.
-- No audit row: the key carried no choice that `news`, `rfcs` and `maintenance` do not already
-- hold.
UPDATE users
   SET email_preferences = json_remove(email_preferences, '$.announcements')
 WHERE CASE
         WHEN email_preferences IS NULL OR NOT json_valid(email_preferences) THEN 0
         ELSE json_type(email_preferences, '$.announcements') IS NOT NULL
       END;
