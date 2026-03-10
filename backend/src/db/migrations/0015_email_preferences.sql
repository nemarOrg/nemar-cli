-- Add email notification preferences for admins/owners
-- Default NULL means all notifications enabled (opt-in by default)
-- Stored as JSON: {"user_approval": true, "publication_request": true}
ALTER TABLE users ADD COLUMN email_preferences TEXT DEFAULT NULL;
