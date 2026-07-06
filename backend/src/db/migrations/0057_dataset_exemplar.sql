-- Epic #923 phase 1 (#930): mark curated "exemplar" test datasets.
--
-- The staging environment (test.nemar.org) hosts a small fleet of xx-prefixed
-- copies of real datasets that must be publishable through the full pipeline
-- with sandbox EZID DOIs. Those xx datasets are blocked everywhere today by a
-- literal `dataset_id LIKE 'xx%'` / is_sandbox filter (publish, DOI, reindex,
-- catalog, search). An `is_sandbox`-only exception is not enough: stepDoiCreate
-- rewrites `is_sandbox = sandbox ? 1 : 0` at DOI mint, so a sandbox-DOI publish
-- flips a would-be-visible row back to is_sandbox=1 and it vanishes from the
-- catalog on the next read.
--
-- is_exemplar is orthogonal to is_sandbox: it survives that rewrite, keeps every
-- gate a single env-independent predicate (production D1 never has is_exemplar=1
-- rows because the creation endpoint 403s in production), and gives the sandbox
-- cleanup cron a precise exemption. Phases 4-5 relax the xx gates to
-- `... OR is_exemplar = 1` and add the creation endpoint; this migration only
-- adds the column so it can ship to prod ahead of them as an inert no-op.
--
-- is_exemplar: 0/1, default 0. 1 marks a staging exemplar copy. Never 1 in prod.

ALTER TABLE datasets ADD COLUMN is_exemplar INTEGER NOT NULL DEFAULT 0 CHECK (is_exemplar IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_datasets_is_exemplar ON datasets(is_exemplar);
