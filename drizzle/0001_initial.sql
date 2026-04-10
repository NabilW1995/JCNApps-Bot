-- Initial schema for JCNApps-Bot
-- Creates all tables needed for issue tracking, pinned messages, team members, deploy events, and webhook logging

CREATE TABLE IF NOT EXISTS issues (
  id SERIAL PRIMARY KEY,
  repo_name VARCHAR(128) NOT NULL,
  issue_number INTEGER NOT NULL,
  title VARCHAR(512) NOT NULL,
  state VARCHAR(16) NOT NULL,
  assignee_github VARCHAR(64),
  area_label VARCHAR(64),
  type_label VARCHAR(64),
  priority_label VARCHAR(64),
  source_label VARCHAR(32),
  is_hotfix BOOLEAN DEFAULT FALSE,
  html_url VARCHAR(512) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  closed_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT issues_repo_number UNIQUE (repo_name, issue_number)
);

CREATE TABLE IF NOT EXISTS pinned_messages (
  id SERIAL PRIMARY KEY,
  channel_id VARCHAR(64) NOT NULL,
  channel_type VARCHAR(32) NOT NULL,
  repo_name VARCHAR(128),
  message_ts VARCHAR(64) NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT pinned_channel_type UNIQUE (channel_id, channel_type)
);

CREATE TABLE IF NOT EXISTS team_members (
  id SERIAL PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  github_username VARCHAR(64) NOT NULL UNIQUE,
  slack_user_id VARCHAR(32) NOT NULL,
  current_repo VARCHAR(128),
  status VARCHAR(32) DEFAULT 'idle',
  status_since TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deploy_events (
  id SERIAL PRIMARY KEY,
  repo_name VARCHAR(128) NOT NULL,
  environment VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  branch VARCHAR(128),
  triggered_by VARCHAR(64),
  issue_numbers INTEGER[],
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_log (
  id SERIAL PRIMARY KEY,
  source VARCHAR(16) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  repo_name VARCHAR(128),
  payload_summary TEXT,
  slack_channel VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_issues_repo_state ON issues(repo_name, state);
CREATE INDEX IF NOT EXISTS idx_issues_area ON issues(repo_name, area_label) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_deploy_events_repo ON deploy_events(repo_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_log_created ON webhook_log(created_at DESC);
