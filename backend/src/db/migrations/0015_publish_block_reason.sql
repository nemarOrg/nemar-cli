-- Add block_reason column to publication_requests for tracking why a request is blocked
ALTER TABLE publication_requests ADD COLUMN block_reason TEXT;
