-- Real researcher name on the user row, for display, uploads, and citations
-- instead of the username (#832 follow-up; supersedes the display_name sketch
-- in the #833 onboarding plan).
--
-- ORCID is the source of truth: the OAuth flow can populate given_name /
-- family_name from the iD's record. Existing accounts are backfilled manually
-- (only a handful of users). Additive + nullable, so no rebuild and no impact
-- on rows that don't have a name yet.
ALTER TABLE users ADD COLUMN given_name TEXT;
ALTER TABLE users ADD COLUMN family_name TEXT;
