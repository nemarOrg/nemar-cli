-- The legal-process queue (ADR 0112 amendment of 2026-11-22): official requests for compute records
-- arrive as tickets here, the queue is restricted (owners only) and the purge keeps its tickets
-- seven years instead of MAIL_RETENTION_DAYS (QUEUE_RETENTION_DAYS in services/ticket-retention.ts).
-- The restriction and the retention are both declared in code (RESTRICTED_TAGS and
-- QUEUE_RETENTION_DAYS), so neither depends on this row; the row is seeded, like security and
-- conduct in 0102, so the queue is listed and configurable from the start and mail to
-- legal-process@ has a queue before the compute terms publish that address.
-- It starts as a pool with no assignee, so every owner sees its tickets until an owner names the
-- custodians. OR IGNORE keeps a row an owner already created by command, with its settings.
INSERT OR IGNORE INTO mail_queues (tag, restricted, strategy) VALUES ('legal-process', 1, 'pool');
