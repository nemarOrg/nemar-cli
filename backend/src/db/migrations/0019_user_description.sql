-- Add description column to users table
-- This column stores the user's reason for requesting NEMAR access
ALTER TABLE users ADD COLUMN description TEXT;
