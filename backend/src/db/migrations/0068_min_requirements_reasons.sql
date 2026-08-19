-- Migration 0068: persist submission-minimums rejection reasons (#1087, ADR 0026)
--
-- The publish-request 422 states each failed minimum (name length, authors,
-- ethics statement), but the GUI reads GET /publish/status later, after the
-- immediate response is gone. Store the reasons on the request row so the
-- status view stays as specific as the rejection itself. JSON array of
-- user-facing strings; mirrors prescreen_reasons (migration 0045). NULL when
-- the block is not min_requirements_failed; cleared on unblock.
ALTER TABLE publication_requests ADD COLUMN min_requirements_reasons TEXT;
