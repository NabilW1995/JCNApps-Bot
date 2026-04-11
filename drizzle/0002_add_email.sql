-- Add email column to team_members for Coolify invitations
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS email VARCHAR(128);
