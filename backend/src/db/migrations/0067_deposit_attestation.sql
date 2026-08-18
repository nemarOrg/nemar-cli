-- 0067: Per-dataset deposit attestation (#1077, ADR 0024).
--
-- The Data Contributor Terms (docs.nemar.org/policies/contributor-terms/)
-- require every depositor to attest, at upload time, to the terms that keep
-- NEMAR datasets legally shareable: de-identification, the status of the
-- re-identification key, and (for non-owner deposits of licensed data) that
-- the dataset is not already archived elsewhere in BIDS form. The CLI's
-- provenance flow already asks a redistribution-rights question but persists
-- nothing; these columns close that gap by recording the attestation on the
-- dataset row itself (datasets is the single table of record, ADR 0003).
--
-- Column semantics (all nullable; NULL = no attestation on record, which
-- covers every row created before this migration, server-side imports from
-- OpenNeuro, exemplar clones, and uploads from CLIs older than the field):
--   attestation_deposit_type   'owner' (depositor owns/is authorized, holds
--                              ethics permissions) or 'redistribution'
--                              (non-owner deposit permitted by the dataset's
--                              public license).
--   attestation_key_status     'destroyed' (re-identification key destroyed;
--                              anonymous under GDPR Recital 26) or 'retained'
--                              (key stays with the depositing institution and
--                              is never transmitted to NEMAR).
--   attestation_no_duplicate   1 = depositor affirmed the dataset is not
--                              already on NEMAR or an upstream archive in
--                              BIDS format. Only collected for
--                              'redistribution' deposits; NULL for 'owner'.
--   attestation_upstream_source  Free-text pointer to the upstream release a
--                              redistribution deposit came from (URL or
--                              archive accession), for provenance.
--   attestation_accepted_at    UTC datetime the depositor accepted; doubles
--                              as the policy-version reference (the terms are
--                              versioned by date in the docs repo history).
ALTER TABLE datasets ADD COLUMN attestation_deposit_type TEXT
  CHECK (attestation_deposit_type IN ('owner', 'redistribution'));
ALTER TABLE datasets ADD COLUMN attestation_key_status TEXT
  CHECK (attestation_key_status IN ('destroyed', 'retained'));
ALTER TABLE datasets ADD COLUMN attestation_no_duplicate INTEGER
  CHECK (attestation_no_duplicate IN (0, 1));
ALTER TABLE datasets ADD COLUMN attestation_upstream_source TEXT;
ALTER TABLE datasets ADD COLUMN attestation_accepted_at TEXT;
