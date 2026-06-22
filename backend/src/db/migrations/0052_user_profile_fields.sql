-- Standardized profile fields (#835): institution + export-control screening.
--
-- affiliation is optional; city/country are required at the app/CLI layer for
-- US export-control / sanctions screening. Kept nullable here so existing rows
-- aren't broken and SQLite doesn't need a table rebuild; the "required" check
-- lives in the signup/onboarding validators, not a NOT NULL constraint.
ALTER TABLE users ADD COLUMN affiliation TEXT;
ALTER TABLE users ADD COLUMN city TEXT;
ALTER TABLE users ADD COLUMN country TEXT;
