import {
  pgTable,
  serial,
  varchar,
  integer,
  boolean,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Issues — tracked from GitHub webhooks
// ---------------------------------------------------------------------------

export const issues = pgTable(
  'issues',
  {
    id: serial('id').primaryKey(),
    repoName: varchar('repo_name', { length: 128 }).notNull(),
    issueNumber: integer('issue_number').notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    state: varchar('state', { length: 16 }).notNull(), // 'open' or 'closed'
    assigneeGithub: varchar('assignee_github', { length: 64 }),
    areaLabel: varchar('area_label', { length: 64 }),
    typeLabel: varchar('type_label', { length: 64 }),
    priorityLabel: varchar('priority_label', { length: 64 }),
    sourceLabel: varchar('source_label', { length: 32 }),
    isHotfix: boolean('is_hotfix').default(false),
    htmlUrl: varchar('html_url', { length: 512 }).notNull(),
    createdAt: timestamp('created_at').notNull(),
    closedAt: timestamp('closed_at'),
    updatedAt: timestamp('updated_at').defaultNow(),
    // Claim tracking — see migration 0003_add_claim_timestamps.sql
    // claimedAt: when the issue was first claimed (via Slack modal or GitHub UI)
    // lastTouchedAt: when a commit referencing this issue (#N) was last pushed
    claimedAt: timestamp('claimed_at'),
    lastTouchedAt: timestamp('last_touched_at'),
  },
  (t) => [unique('issues_repo_number').on(t.repoName, t.issueNumber)]
);

// ---------------------------------------------------------------------------
// Pinned Messages — Slack messages that get updated in place
// ---------------------------------------------------------------------------

export const pinnedMessages = pgTable(
  'pinned_messages',
  {
    id: serial('id').primaryKey(),
    channelId: varchar('channel_id', { length: 64 }).notNull(),
    channelType: varchar('channel_type', { length: 32 }).notNull(), // 'app_active' or 'overview'
    repoName: varchar('repo_name', { length: 128 }),
    messageTs: varchar('message_ts', { length: 64 }).notNull(), // Slack message timestamp
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (t) => [unique('pinned_channel_type').on(t.channelId, t.channelType)]
);

// ---------------------------------------------------------------------------
// Team Members — GitHub <-> Slack mapping with current status
// ---------------------------------------------------------------------------

export const teamMembers = pgTable('team_members', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 64 }).notNull(),
  githubUsername: varchar('github_username', { length: 64 }).notNull().unique(),
  slackUserId: varchar('slack_user_id', { length: 32 }).notNull(),
  email: varchar('email', { length: 128 }),
  currentRepo: varchar('current_repo', { length: 128 }),
  status: varchar('status', { length: 32 }).default('idle'), // 'idle', 'active', 'testing'
  statusSince: timestamp('status_since'),
});

// ---------------------------------------------------------------------------
// Deploy Events — production, preview, and dev deployments
// ---------------------------------------------------------------------------

export const deployEvents = pgTable('deploy_events', {
  id: serial('id').primaryKey(),
  repoName: varchar('repo_name', { length: 128 }).notNull(),
  environment: varchar('environment', { length: 32 }).notNull(), // 'production', 'preview', 'dev'
  status: varchar('status', { length: 16 }).notNull(), // 'success', 'failure', 'building'
  branch: varchar('branch', { length: 128 }),
  triggeredBy: varchar('triggered_by', { length: 64 }),
  issueNumbers: integer('issue_numbers').array(),
  startedAt: timestamp('started_at').notNull(),
  completedAt: timestamp('completed_at'),
});

// ---------------------------------------------------------------------------
// Webhook Log — audit trail for all incoming webhooks
// ---------------------------------------------------------------------------

export const webhookLog = pgTable('webhook_log', {
  id: serial('id').primaryKey(),
  source: varchar('source', { length: 16 }).notNull(), // 'github' or 'coolify'
  eventType: varchar('event_type', { length: 64 }).notNull(),
  repoName: varchar('repo_name', { length: 128 }),
  payloadSummary: text('payload_summary'),
  slackChannel: varchar('slack_channel', { length: 64 }),
  createdAt: timestamp('created_at').defaultNow(),
});
