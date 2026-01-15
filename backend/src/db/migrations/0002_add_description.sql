-- Migration: 0002_add_description
-- Description: Add description field for user signup reason

-- Add description field to users table
-- Users provide a reason for why they need NEMAR access
ALTER TABLE users ADD COLUMN description TEXT;
