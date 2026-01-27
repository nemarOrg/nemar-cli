-- NEMAR Database Schema
-- Migration: 0001_initial
-- Description: Initial schema for users, tokens, datasets, and ID sequence

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  github_username TEXT NOT NULL,

  -- Status workflow: pending -> verified -> approved | revoked
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'approved', 'revoked')),

  -- Email verification
  email_verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT,
  verification_expires_at TEXT,

  -- Admin flag
  is_admin INTEGER NOT NULL DEFAULT 0,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  revoked_at TEXT
);

-- API tokens table
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  api_key_prefix TEXT NOT NULL,

  -- Token metadata
  name TEXT,
  last_used_at TEXT,

  -- Revocation
  revoked_at TEXT,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Datasets table
CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id INTEGER NOT NULL,

  -- Status: lifecycle state
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),

  -- GitHub info
  github_repo TEXT,

  -- DOI info
  concept_doi TEXT,
  latest_version_doi TEXT,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

-- ID sequence for nm000XXX generation
CREATE TABLE IF NOT EXISTS id_sequence (
  prefix TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL DEFAULT 1
);

-- Initialize with nm prefix starting at 108 (after existing datasets)
INSERT OR IGNORE INTO id_sequence (prefix, next_number) VALUES ('nm', 108);

-- Audit log for tracking actions
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details TEXT,
  ip_address TEXT,

  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_github ON users(github_username);

CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_datasets_id ON datasets(dataset_id);
CREATE INDEX IF NOT EXISTS idx_datasets_owner ON datasets(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_datasets_status ON datasets(status);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
