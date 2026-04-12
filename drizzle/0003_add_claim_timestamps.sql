-- Add claim tracking columns to the issues table.
--
-- claimed_at: set when a user first claims this issue (either via Slack
--             Assign Tasks modal or directly via GitHub UI assignment).
--             Cleared when the issue is closed or unassigned.
--
-- last_touched_at: updated every time a commit referencing this issue
--                  (e.g. "fix: #23") is pushed. Drives the "⏳ Leftover
--                  from yesterday" detection in the active pinned
--                  message — an issue is leftover if it's claimed but
--                  hasn't been touched in > 18 hours.
--
-- Both are nullable so existing rows don't need backfilling.

ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP NULL;

ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS last_touched_at TIMESTAMP NULL;

-- Index for the morning-cron leftover query:
--   SELECT * FROM issues
--   WHERE state = 'open'
--     AND assignee_github IS NOT NULL
--     AND (last_touched_at IS NULL OR last_touched_at < NOW() - INTERVAL '18 hours');
CREATE INDEX IF NOT EXISTS idx_issues_claim_leftover
  ON issues (state, assignee_github, last_touched_at);
