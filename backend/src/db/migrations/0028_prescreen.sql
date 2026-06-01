-- Automated publication pre-screen state (issue #666).
--
-- When a user requests publication and the dataset passes the BIDS-validation
-- readiness check, the Worker dispatches `run-prescreen` to
-- nemarDatasets/.github. That workflow runs `claude -p` against the dataset's
-- README / dataset_description.json / declared-data size and POSTs a verdict
-- back to /webhooks/prescreen-result. These columns track that round-trip on
-- the publication_requests row.

-- 'pending'  : dispatched, awaiting the workflow callback
-- 'passed'   : screen cleared (request stays 'requested' for admin approval)
-- 'failed'   : screen blocked the request (status flips to 'blocked',
--              block_reason='prescreen_failed', requester emailed)
-- NULL       : screen not run (feature disabled, no repo, or dispatch failed)
ALTER TABLE publication_requests ADD COLUMN prescreen_status TEXT;

-- HMAC nonce the Worker signed into the dispatch callback token. The callback
-- handler recovers it from this row to verify the echoed token, then the
-- one-shot 'pending' -> 'passed'/'failed' flip defeats replays.
ALTER TABLE publication_requests ADD COLUMN prescreen_nonce TEXT;

-- URL of the GitHub issue the workflow opened on the dataset repo when it
-- blocked, surfaced to the requester in the block email and publish status.
ALTER TABLE publication_requests ADD COLUMN prescreen_issue_url TEXT;

-- When the screen last completed (passed or failed).
ALTER TABLE publication_requests ADD COLUMN prescreen_at TEXT;
