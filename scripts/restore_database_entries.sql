-- ============================================================================
-- NEMAR Database Restoration
-- Restore deleted datasets nm000103-nm000107
--
-- Date: 2026-01-18
-- Context: Accidental deletion during test dataset cleanup
-- Recovery: Datasets restored from Zenodo archives to GitHub
--
-- IMPORTANT: Run this AFTER verifying GitHub repositories are restored
-- ============================================================================

-- Verify owner exists (yahya@osc.earth, user_id=2)
-- SELECT id, username, email FROM users WHERE id = 2;

-- ============================================================================
-- Dataset Restorations
-- ============================================================================

-- nm000103: HBN-EEG NC v1.0.0
INSERT INTO datasets (
  dataset_id,
  name,
  description,
  owner_user_id,
  status,
  github_repo,
  concept_doi,
  latest_version_doi,
  zenodo_concept_id,
  zenodo_latest_version_id,
  created_at,
  updated_at
) VALUES (
  'nm000103',
  'HBN-EEG NC',
  'NEMAR Dataset nm000103: HBN-EEG NC - Healthy Brain Network EEG data',
  2,  -- yahya@osc.earth
  'active',
  'nemarDatasets/nm000103',
  '10.5281/zenodo.17306881',  -- Concept DOI
  NULL,  -- No specific version DOI in records
  '17306881',  -- Zenodo concept record ID
  NULL,
  datetime('now'),  -- Restoration timestamp
  datetime('now')
);

-- nm000104: emg2qwerty v1.1.0
INSERT INTO datasets (
  dataset_id,
  name,
  description,
  owner_user_id,
  status,
  github_repo,
  concept_doi,
  latest_version_doi,
  zenodo_concept_id,
  zenodo_latest_version_id,
  created_at,
  updated_at
) VALUES (
  'nm000104',
  'emg2qwerty',
  'NEMAR Dataset nm000104: emg2qwerty - EMG-based typing detection',
  2,  -- yahya@osc.earth
  'active',
  'nemarDatasets/nm000104',
  '10.5281/zenodo.17613953',  -- Concept DOI
  NULL,
  '17613953',
  NULL,
  datetime('now'),
  datetime('now')
);

-- nm000105: discrete_gestures v1.1.0
INSERT INTO datasets (
  dataset_id,
  name,
  description,
  owner_user_id,
  status,
  github_repo,
  concept_doi,
  latest_version_doi,
  zenodo_concept_id,
  zenodo_latest_version_id,
  created_at,
  updated_at
) VALUES (
  'nm000105',
  'discrete_gestures',
  'NEMAR Dataset nm000105: discrete_gestures - Discrete hand gesture detection from EMG',
  2,  -- yahya@osc.earth
  'active',
  'nemarDatasets/nm000105',
  '10.5281/zenodo.17613958',  -- Concept DOI
  NULL,
  '17613958',
  NULL,
  datetime('now'),
  datetime('now')
);

-- nm000106: handwriting v1.1.0
INSERT INTO datasets (
  dataset_id,
  name,
  description,
  owner_user_id,
  status,
  github_repo,
  concept_doi,
  latest_version_doi,
  zenodo_concept_id,
  zenodo_latest_version_id,
  created_at,
  updated_at
) VALUES (
  'nm000106',
  'handwriting',
  'NEMAR Dataset nm000106: handwriting - Handwriting movement detection from EMG',
  2,  -- yahya@osc.earth
  'active',
  'nemarDatasets/nm000106',
  '10.5281/zenodo.17613961',  -- Concept DOI
  NULL,
  '17613961',
  NULL,
  datetime('now'),
  datetime('now')
);

-- nm000107: wrist v1.1.0
INSERT INTO datasets (
  dataset_id,
  name,
  description,
  owner_user_id,
  status,
  github_repo,
  concept_doi,
  latest_version_doi,
  zenodo_concept_id,
  zenodo_latest_version_id,
  created_at,
  updated_at
) VALUES (
  'nm000107',
  'wrist',
  'NEMAR Dataset nm000107: wrist - Wrist movement control from EMG',
  2,  -- yahya@osc.earth
  'active',
  'nemarDatasets/nm000107',
  '10.5281/zenodo.17613963',  -- Concept DOI
  NULL,
  '17613963',
  NULL,
  datetime('now'),
  datetime('now')
);

-- ============================================================================
-- Audit Log Entries
-- ============================================================================

-- Log the restoration action
INSERT INTO audit_log (
  user_id,
  action,
  resource_type,
  resource_id,
  details,
  timestamp
) VALUES
  (2, 'dataset_restored', 'dataset', 'nm000103', 'Restored from Zenodo archive after accidental deletion', datetime('now')),
  (2, 'dataset_restored', 'dataset', 'nm000104', 'Restored from Zenodo archive after accidental deletion', datetime('now')),
  (2, 'dataset_restored', 'dataset', 'nm000105', 'Restored from Zenodo archive after accidental deletion', datetime('now')),
  (2, 'dataset_restored', 'dataset', 'nm000106', 'Restored from Zenodo archive after accidental deletion', datetime('now')),
  (2, 'dataset_restored', 'dataset', 'nm000107', 'Restored from Zenodo archive after accidental deletion', datetime('now'));

-- ============================================================================
-- Verification Queries
-- ============================================================================

-- Run these to verify restoration:
-- SELECT dataset_id, name, status, concept_doi, github_repo FROM datasets WHERE dataset_id LIKE 'nm0001%' AND CAST(SUBSTR(dataset_id, 3) AS INTEGER) <= 107 ORDER BY dataset_id;
-- SELECT COUNT(*) as restored_count FROM datasets WHERE dataset_id IN ('nm000103', 'nm000104', 'nm000105', 'nm000106', 'nm000107');

-- ============================================================================
-- Notes
-- ============================================================================
--
-- These datasets were accidentally deleted on 2026-01-18 during cleanup of
-- test datasets nm000108-nm000145. The SQL query incorrectly included
-- production datasets nm000103-nm000107.
--
-- Recovery Process:
-- 1. ✅ Verified S3 data intact (7,976 files)
-- 2. ✅ Retrieved Zenodo archives (concept DOIs preserved)
-- 3. ✅ Restored GitHub repositories with git-annex configuration
-- 4. ✅ Registered S3 URLs for all annexed files
-- 5. ⏳ Restore database entries (THIS FILE)
--
-- All datasets have concept DOIs registered on Zenodo and are preserved
-- in the Zenodo archive system for long-term preservation.
--
-- Owner: yahya@osc.earth (user_id=2)
-- Restored by: NEMAR Restore <nemarRestore@osc.earth>
-- GitHub Organization: nemarDatasets
-- S3 Bucket: s3://nemar/
--
-- ============================================================================
