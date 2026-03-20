-- Cached copy of the nemar.org dataset catalog for unified listing and search.
-- Populated by a scheduled Worker cron that pulls from the nemar.org datapipeline API.

CREATE TABLE IF NOT EXISTS nemar_catalog (
  id TEXT PRIMARY KEY,                              -- Dataset ID (nm000103, ds004362, etc.)
  name TEXT NOT NULL,                               -- Dataset title from BIDS
  description TEXT,                                 -- Truncated README
  modalities TEXT,                                  -- Comma-separated: "eeg", "eeg,emg"
  participants INTEGER DEFAULT 0,                   -- Subject count
  age_min INTEGER DEFAULT 0,
  age_max INTEGER DEFAULT 0,
  tasks TEXT,                                       -- Comma-separated task names
  authors TEXT,                                     -- Author list
  doi TEXT,                                         -- DatasetDOI
  license TEXT,
  bids_version TEXT,
  file_size INTEGER DEFAULT 0,                      -- Bytes
  file_size_formatted TEXT,                         -- Human-readable: "1.2 GB"
  total_files INTEGER DEFAULT 0,
  sessions_count INTEGER DEFAULT 0,
  latest_version TEXT,
  publish_date TEXT,
  created_date TEXT,
  uploader TEXT,
  readme TEXT,                                      -- Full README content
  source TEXT NOT NULL DEFAULT 'nemar.org',          -- Origin: 'nemar.org', 'openneuro'
  source_id TEXT,                                   -- Original ID (ds000xxx for on000xxx)
  is_processed INTEGER DEFAULT 0,                   -- 0 = raw BIDS, 1 = derivative
  search_text TEXT,                                 -- Pre-computed lowercase concat for LIKE fallback
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_catalog_modalities ON nemar_catalog(modalities);
CREATE INDEX IF NOT EXISTS idx_catalog_doi ON nemar_catalog(doi);
CREATE INDEX IF NOT EXISTS idx_catalog_source ON nemar_catalog(source);
CREATE INDEX IF NOT EXISTS idx_catalog_publish_date ON nemar_catalog(publish_date);
CREATE INDEX IF NOT EXISTS idx_catalog_participants ON nemar_catalog(participants);

-- Track catalog sync runs for observability
CREATE TABLE IF NOT EXISTS catalog_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  records_synced INTEGER DEFAULT 0,
  records_indexed INTEGER DEFAULT 0,
  errors TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed'))
);
