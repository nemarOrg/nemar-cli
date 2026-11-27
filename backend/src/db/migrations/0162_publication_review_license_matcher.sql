-- The license matcher in a publication review's reproducibility record (ADR 0142; ADR 0139,
-- decision 9, as amended on 2026-11-27).
--
-- A version-3 report names the license matcher that identified the dataset's LICENSE: the pinned
-- matcher's version (`scancode-<release>+spdx-<list>`) or `unavailable` when it did not run. It
-- joins the record beside migration 0152's seven columns, so every surface that prints the record
-- reads it from the row and an administrator can count the reviews the matcher missed
-- (`WHERE license_matcher = 'unavailable'`), which ADR 0142 says must never be silent.
--
--   * `license_matcher`: set only on a reported row whose report is version 3, in the same
--     statement as the rest of the record; NULL for a run error and for a version-1 or version-2
--     report, which named no matcher. The CHECK keeps it a reported row's alone and bounds it; the
--     parser checks the word itself, and the read-back checks it again before showing it.
--
-- The word is not pinned here: a ScanCode bump changes it, and a stored row keeps the pin it was
-- reviewed under.
ALTER TABLE publication_reviews ADD COLUMN license_matcher TEXT
  CHECK (license_matcher IS NULL OR (state = 'reported' AND length(license_matcher) BETWEEN 1 AND 64));
