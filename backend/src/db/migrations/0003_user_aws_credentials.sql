-- Migration: 0003_user_aws_credentials
-- Description: Add per-user AWS credentials storage for scoped S3 access
--
-- Security Model:
-- - Each approved user gets their own IAM user in AWS
-- - IAM user credentials stored encrypted in this table
-- - IAM user has inline policy scoped to their dataset prefixes
-- - When user creates dataset, their IAM policy is updated to include new prefix
-- - Credentials never exposed to CLI; backend uses them for presigned URLs

-- Add AWS credentials columns to users table
-- Credentials are encrypted with NEMAR_ENCRYPTION_KEY secret
ALTER TABLE users ADD COLUMN aws_access_key_id_encrypted TEXT;
ALTER TABLE users ADD COLUMN aws_secret_access_key_encrypted TEXT;
ALTER TABLE users ADD COLUMN aws_iam_username TEXT;

-- Track which S3 prefixes each user has access to
-- This mirrors their IAM policy for auditing/recovery
CREATE TABLE IF NOT EXISTS user_s3_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  s3_prefix TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read_write'
    CHECK (permission IN ('read', 'write', 'read_write')),
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by INTEGER,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id),
  UNIQUE(user_id, s3_prefix)
);

CREATE INDEX IF NOT EXISTS idx_user_s3_permissions_user ON user_s3_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_s3_permissions_prefix ON user_s3_permissions(s3_prefix);
