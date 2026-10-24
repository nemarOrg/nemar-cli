-- Epic #1893 phase 3b (#1896, ADR 0111): who an escalated ticket goes to.
-- A queue's own escalation_user_id wins; a queue with none falls back to the '*' row's. The
-- reference is a plain INTEGER with no foreign key, like every user reference in 0102, and is
-- re-checked for eligibility (role, restricted, exclusion) at the moment of escalation, so a
-- stale value can only refuse an escalation and never widen access.
ALTER TABLE mail_queues ADD COLUMN escalation_user_id INTEGER;
