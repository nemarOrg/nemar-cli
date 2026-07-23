-- Epic #999 phase 2 (#1001): backfill sweep marker for
-- `.nemar/availability-report.json` (services/availability-report.ts, phase
-- 1 #1000).
--
-- availability_report_at: sweep resumability marker (mirrors hed_checked_at
-- 0056 and data_checked_at 0059), stamped by the sweep only, once per dataset
-- after writeAvailabilityReport commits the report (success only -- a failed
-- write leaves it NULL so a re-run retries) so `POST
-- /admin/datasets/availability-report-sweep` can drain the never-generated
-- set without re-touching already-written datasets. NULL for every existing
-- row (no sweep write yet, including any report the Phase 1 single-dataset
-- endpoint already committed out-of-band -- this column tracks the SWEEP's
-- own progress, not report existence).

ALTER TABLE datasets ADD COLUMN availability_report_at TEXT;
