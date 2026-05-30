-- Staleness warning tracking for the scheduled cleanup cron.
--
-- Before #662 the daily cron silently hard-deleted private, no-DOI `nm`
-- datasets once they passed 90 days inactive (it deleted nm000111/116/117
-- this way). The new behavior emails the owner an escalating warning runway
-- (30/14/7/2/1 days) and, at the deadline, notifies admins to delete manually
-- instead of auto-deleting. These two columns let the daily cron remember what
-- it has already sent so it does not re-spam, and are reset when a dataset
-- gets fresh activity.

-- Last owner-warning threshold (in days-until-deletion) already emailed:
-- one of 30, 14, 7, 2, 1. NULL means no warning sent / not in the window.
ALTER TABLE datasets ADD COLUMN staleness_warn_stage INTEGER;

-- Timestamp the day-0 "ready to delete, confirm manually" admin notice was
-- sent. NULL until the dataset passes the 90-day mark and admins are notified.
ALTER TABLE datasets ADD COLUMN staleness_admin_notified_at TEXT;
