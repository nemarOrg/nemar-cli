-- The reasons of an automatic denial's agreement (ADR 0139, decisions 1 and 4, as amended on
-- 2026-11-27).
--
-- In shadow mode an agreement is recorded as `would_deny` and nothing is mailed, so until now an
-- administrator could not read which reasons the denial mail would have named: the codes were
-- recomputed from the two reports, by whatever rule was deployed at the time of reading.
--
-- `publication_reviews` gains one column:
--
--   * `auto_deny_codes`: the eligible codes both runs agreed on (`AUTO_DENY_CODES`, comma-joined in
--     that order), written on the first run in the statement that records an agreement
--     (`would_deny`, `capped`, `denied`, `no_service_account`). NULL on every other row, on a
--     confirming row, and on every agreement recorded before this migration. The CHECK keeps it a
--     first run's alone and bounds it; the reader checks each word again before showing it.
ALTER TABLE publication_reviews ADD COLUMN auto_deny_codes TEXT
  CHECK (auto_deny_codes IS NULL OR (confirm_of IS NULL AND length(auto_deny_codes) BETWEEN 1 AND 512));
