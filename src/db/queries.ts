import { eq, and, sql } from 'drizzle-orm';
import {
  issues,
  pinnedMessages,
  teamMembers,
  deployEvents,
  webhookLog,
} from './schema.js';
import type { Database } from './client.js';
import type {
  UpsertIssueData,
  DeployEventData,
  WebhookLogData,
} from '../types.js';

// ---------------------------------------------------------------------------
// Issue Operations
// ---------------------------------------------------------------------------

/**
 * Insert or update an issue. Uses the (repo_name, issue_number) unique
 * constraint to decide whether to INSERT or UPDATE.
 */
export async function upsertIssue(
  db: Database,
  data: UpsertIssueData
): Promise<void> {
  await db
    .insert(issues)
    .values({
      repoName: data.repoName,
      issueNumber: data.issueNumber,
      title: data.title,
      state: data.state,
      assigneeGithub: data.assigneeGithub,
      areaLabel: data.areaLabel,
      typeLabel: data.typeLabel,
      priorityLabel: data.priorityLabel,
      sourceLabel: data.sourceLabel,
      isHotfix: data.isHotfix,
      htmlUrl: data.htmlUrl,
      createdAt: data.createdAt,
      closedAt: data.closedAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [issues.repoName, issues.issueNumber],
      set: {
        title: data.title,
        state: data.state,
        assigneeGithub: data.assigneeGithub,
        areaLabel: data.areaLabel,
        typeLabel: data.typeLabel,
        priorityLabel: data.priorityLabel,
        sourceLabel: data.sourceLabel,
        isHotfix: data.isHotfix,
        htmlUrl: data.htmlUrl,
        closedAt: data.closedAt,
        updatedAt: new Date(),
      },
    });
}

/**
 * Get all open issues for a specific repository, ordered by creation date.
 */
export async function getOpenIssuesForRepo(
  db: Database,
  repoName: string
): Promise<(typeof issues.$inferSelect)[]> {
  return db
    .select()
    .from(issues)
    .where(and(eq(issues.repoName, repoName), eq(issues.state, 'open')))
    .orderBy(issues.createdAt);
}

/**
 * Group all open issues for a repo by their area label.
 * Issues without an area label are grouped under "unassigned".
 */
export async function getOpenIssuesByArea(
  db: Database,
  repoName: string
): Promise<Map<string, (typeof issues.$inferSelect)[]>> {
  const rows = await getOpenIssuesForRepo(db, repoName);
  const grouped = new Map<string, (typeof issues.$inferSelect)[]>();

  for (const row of rows) {
    const area = row.areaLabel ?? 'unassigned';
    const existing = grouped.get(area) ?? [];
    existing.push(row);
    grouped.set(area, existing);
  }

  return grouped;
}

/**
 * Get a summary of open issues across all repos: total count and
 * number of critical-priority issues per repo.
 */
export async function getAllOpenIssuesCounts(
  db: Database
): Promise<Array<{ repoName: string; total: number; critical: number }>> {
  const rows = await db
    .select({
      repoName: issues.repoName,
      total: sql<number>`count(*)::int`,
      critical: sql<number>`count(*) filter (where ${issues.priorityLabel} = 'critical')::int`,
    })
    .from(issues)
    .where(eq(issues.state, 'open'))
    .groupBy(issues.repoName);

  return rows;
}

// ---------------------------------------------------------------------------
// Pinned Message Operations
// ---------------------------------------------------------------------------

/**
 * Retrieve the Slack message timestamp for a pinned message, or null
 * if no pinned message exists for this channel + type combination.
 */
export async function getPinnedMessageTs(
  db: Database,
  channelId: string,
  channelType: string
): Promise<string | null> {
  const rows = await db
    .select({ messageTs: pinnedMessages.messageTs })
    .from(pinnedMessages)
    .where(
      and(
        eq(pinnedMessages.channelId, channelId),
        eq(pinnedMessages.channelType, channelType)
      )
    )
    .limit(1);

  return rows[0]?.messageTs ?? null;
}

/**
 * Insert or update the pinned message timestamp for a channel + type.
 */
export async function savePinnedMessageTs(
  db: Database,
  channelId: string,
  channelType: string,
  messageTs: string,
  repoName?: string
): Promise<void> {
  await db
    .insert(pinnedMessages)
    .values({
      channelId,
      channelType,
      messageTs,
      repoName: repoName ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pinnedMessages.channelId, pinnedMessages.channelType],
      set: {
        messageTs,
        repoName: repoName ?? null,
        updatedAt: new Date(),
      },
    });
}

// ---------------------------------------------------------------------------
// Team Member Operations
// ---------------------------------------------------------------------------

/**
 * Find a team member by their GitHub username.
 */
export async function getTeamMember(
  db: Database,
  githubUsername: string
): Promise<(typeof teamMembers.$inferSelect) | null> {
  const rows = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.githubUsername, githubUsername))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Update a team member's status and optionally the repo they are working on.
 */
export async function updateTeamMemberStatus(
  db: Database,
  githubUsername: string,
  status: string,
  currentRepo?: string
): Promise<void> {
  await db
    .update(teamMembers)
    .set({
      status,
      currentRepo: currentRepo ?? null,
      statusSince: new Date(),
    })
    .where(eq(teamMembers.githubUsername, githubUsername));
}

/**
 * Get all team members, ordered by name.
 */
export async function getAllTeamMembers(
  db: Database
): Promise<(typeof teamMembers.$inferSelect)[]> {
  return db.select().from(teamMembers).orderBy(teamMembers.name);
}

// ---------------------------------------------------------------------------
// Deploy Event Operations
// ---------------------------------------------------------------------------

/**
 * Log a deployment event (preview, production, or dev).
 */
export async function logDeployEvent(
  db: Database,
  data: DeployEventData
): Promise<void> {
  await db.insert(deployEvents).values({
    repoName: data.repoName,
    environment: data.environment,
    status: data.status,
    branch: data.branch,
    triggeredBy: data.triggeredBy,
    issueNumbers: data.issueNumbers.length > 0 ? data.issueNumbers : null,
    startedAt: data.startedAt,
    completedAt: data.completedAt,
  });
}

/**
 * Get the start time of the most recent successful deploy for a repo.
 * Used to calculate deploy-to-live duration: now - startedAt.
 * Returns null if no prior deploy event exists.
 */
export async function getLastDeployStartTime(
  db: Database,
  repoName: string
): Promise<Date | null> {
  const rows = await db
    .select({ startedAt: deployEvents.startedAt })
    .from(deployEvents)
    .where(
      and(
        eq(deployEvents.repoName, repoName),
        eq(deployEvents.environment, 'production'),
        eq(deployEvents.status, 'success')
      )
    )
    .orderBy(sql`${deployEvents.startedAt} DESC`)
    .limit(1);

  return rows[0]?.startedAt ?? null;
}

// ---------------------------------------------------------------------------
// Webhook Log Operations
// ---------------------------------------------------------------------------

/**
 * Log an incoming webhook for auditing and debugging.
 */
export async function logWebhook(
  db: Database,
  data: WebhookLogData
): Promise<void> {
  await db.insert(webhookLog).values({
    source: data.source,
    eventType: data.eventType,
    repoName: data.repoName,
    payloadSummary: data.payloadSummary,
    slackChannel: data.slackChannel,
  });
}
