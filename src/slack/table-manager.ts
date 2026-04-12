import { getDb } from '../db/client.js';
import {
  getOpenIssuesByArea,
  getAllOpenIssuesCounts,
  getPinnedMessageTs,
  savePinnedMessageTs,
  getAllTeamMembers,
  getOpenIssuesForRepo,
  upsertIssue,
  closeStaleIssues,
} from '../db/queries.js';
import { getChannelConfig } from '../config/channels.js';
import {
  getAreaLabel,
  getTypeLabel,
  getPriorityLabel,
  getSourceLabel,
} from '../config/labels.js';
import { postMessage, updateMessage, pinMessage } from './client.js';
import { buildAppActiveTable, buildCompanyOverviewTable, buildBugsTable } from './tables.js';
import type { TeamMemberStatus, AppSummary, UpsertIssueData } from '../types.js';
import { formatTimestamp } from '../utils/time.js';
import { logger } from '../utils/logger.js';
import type { BugsIssueCounts } from './tables.js';

// ---------------------------------------------------------------------------
// Debounce — collapse rapid-fire webhook events into single updates
// ---------------------------------------------------------------------------

const updateTimers = new Map<string, NodeJS.Timeout>();

/**
 * How long to wait before refreshing a table after an event.
 * Multiple events within this window are collapsed into one update.
 */
const DEBOUNCE_MS = 2000;

/**
 * Schedule a table update for a channel. If multiple webhook events
 * arrive within DEBOUNCE_MS (e.g., GitHub fires assigned + labeled
 * at the same time), they're collapsed into a single Slack API call.
 */
export function scheduleTableUpdate(
  channelId: string,
  repoName: string
): void {
  const timerKey = `${channelId}:${repoName}`;

  // Clear any pending timer for this channel+repo
  const existingTimer = updateTimers.get(timerKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Schedule a new update
  const timer = setTimeout(() => {
    updateTimers.delete(timerKey);

    // Fire-and-forget — log errors but don't crash
    refreshAppTable(repoName).catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to refresh app table', { repoName, error: message });
    });

    refreshBugsTable(repoName).catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to refresh bugs table', { repoName, error: message });
    });

    refreshOverviewTable().catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to refresh overview table', { error: message });
    });
  }, DEBOUNCE_MS);

  updateTimers.set(timerKey, timer);
}

// ---------------------------------------------------------------------------
// Table Refresh Logic
// ---------------------------------------------------------------------------

/**
 * Immediately rebuild and update the per-app active table.
 *
 * Flow:
 * 1. Get channel config for the repo
 * 2. Query open issues grouped by area
 * 3. Query team members working on this repo
 * 4. Build the Block Kit blocks
 * 5. Update existing pinned message or create a new one
 */
export async function refreshAppTable(repoName: string): Promise<void> {
  const config = getChannelConfig(repoName);
  if (!config) {
    logger.error('No channel config found for repo', { repoName });
    return;
  }

  const db = getDb();
  const channelId = config.activeChannelId;

  // Query data
  const issuesByArea = await getOpenIssuesByArea(db, repoName);
  const allMembers = await getAllTeamMembers(db);

  // Build team status for members working on this repo
  const teamStatus: TeamMemberStatus[] = allMembers
    .filter((m) => m.currentRepo === repoName)
    .map((m) => ({
      name: m.name,
      slackUserId: m.slackUserId,
      status: m.status ?? 'idle',
      currentRepo: m.currentRepo,
      activeIssues: '', // Will be populated from issues
      statusSince: m.statusSince ? formatTimestamp(m.statusSince) : null,
    }));

  // Enrich team status with their assigned issue numbers
  const repoIssues = await getOpenIssuesForRepo(db, repoName);
  for (const member of teamStatus) {
    const memberIssues = repoIssues
      .filter((i) => i.assigneeGithub === member.name || matchesMember(i.assigneeGithub, allMembers, member.name))
      .map((i) => `#${i.issueNumber}`);
    member.activeIssues = memberIssues.join(', ') || 'no assigned issues';
  }

  // Build the Slack blocks
  const blocks = buildAppActiveTable(config.displayName, issuesByArea, teamStatus);

  // Check if we already have a pinned message for this channel
  const existingTs = await getPinnedMessageTs(db, channelId, 'app_active');

  if (existingTs) {
    // Update the existing pinned message
    await updateMessage(channelId, existingTs, blocks, `${config.displayName} - Open Tasks`);
  } else {
    // Post a new message, pin it, and save the timestamp
    const newTs = await postMessage(channelId, blocks, `${config.displayName} - Open Tasks`);
    await pinMessage(channelId, newTs);
    await savePinnedMessageTs(db, channelId, 'app_active', newTs, repoName);
  }

  // Canvas creation disabled: every deploy wipes the in-memory canvas_id
  // cache, so the fallback kept creating a fresh canvas each time and
  // stacking them up in the channel header. Pinned message is enough.
}

// ---------------------------------------------------------------------------
// GitHub Issue Sync
// ---------------------------------------------------------------------------

/**
 * Fetch all open issues from GitHub and sync them into the local database.
 * Called on Refresh button click and at bot startup to ensure the DB
 * is always up-to-date, even if webhooks were missed.
 */
export async function syncIssuesFromGitHub(repoName: string): Promise<void> {
  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg) return;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${githubOrg}/${repoName}/issues?state=open&per_page=100`,
      {
        headers: {
          Authorization: `token ${githubPat}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      logger.error('Failed to fetch issues from GitHub', { repoName, status: response.status });
      return;
    }

    const ghIssues = (await response.json()) as Array<{
      number: number;
      title: string;
      state: string;
      html_url: string;
      user: { login: string };
      assignee: { login: string } | null;
      labels: Array<{ name: string }>;
      pull_request?: unknown;
      created_at: string;
      closed_at: string | null;
    }>;

    const db = getDb();

    // Filter out pull requests (GitHub API includes them in /issues)
    const issuesOnly = ghIssues.filter((i) => !i.pull_request);

    for (const issue of issuesOnly) {
      const labelNames = issue.labels.map((l) => l.name);
      const data: UpsertIssueData = {
        repoName,
        issueNumber: issue.number,
        title: issue.title,
        state: issue.state as 'open' | 'closed',
        assigneeGithub: issue.assignee?.login ?? null,
        areaLabel: getAreaLabel(labelNames),
        typeLabel: getTypeLabel(labelNames),
        priorityLabel: getPriorityLabel(labelNames),
        sourceLabel: getSourceLabel(labelNames),
        isHotfix: labelNames.some((l) => l.toLowerCase() === 'hotfix'),
        htmlUrl: issue.html_url,
        createdAt: new Date(issue.created_at),
        closedAt: issue.closed_at ? new Date(issue.closed_at) : null,
      };
      await upsertIssue(db, data);
    }

    // Reconcile: any issue still marked 'open' in the DB that GitHub did NOT
    // return is stale (closed, deleted, or renamed) — flip it to 'closed' so
    // it disappears from the pinned table. This is the fix for "ghost bugs"
    // that linger in Slack after being resolved elsewhere.
    const currentOpenNumbers = issuesOnly.map((i) => i.number);
    await closeStaleIssues(db, repoName, currentOpenNumbers);

    logger.info('GitHub issues synced', { repoName, synced: issuesOnly.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('GitHub issue sync failed', { repoName, error: message });
  }
}

// ---------------------------------------------------------------------------
// Bugs Table Refresh Logic
// ---------------------------------------------------------------------------

/**
 * Immediately rebuild and update the per-app bugs table.
 *
 * Flow:
 * 1. Get channel config for the repo
 * 2. Query open issues grouped by area
 * 3. Compute bug/feature/critical counts
 * 4. Build the Block Kit blocks
 * 5. Update existing pinned message or create a new one
 * 6. Update (or create) the bugs canvas content
 */
export async function refreshBugsTable(repoName: string): Promise<void> {
  const config = getChannelConfig(repoName);
  if (!config) {
    logger.error('No channel config found for repo', { repoName });
    return;
  }

  const bugsChannelId = config.bugsChannelId;
  if (!bugsChannelId) {
    return;
  }

  // Sync issues from GitHub first to ensure DB is up-to-date
  await syncIssuesFromGitHub(repoName);

  const db = getDb();

  // Query open issues grouped by area
  const issuesByAreaAll = await getOpenIssuesByArea(db, repoName);

  // Filter assigned tasks OUT of the bugs pinned table. Once someone
  // claims a task it's no longer a 'triage target' — it belongs in
  // the active channel, not the bugs channel. Prevents the same task
  // from appearing in both places.
  const issuesByArea = new Map<string, typeof issuesByAreaAll extends Map<string, infer V> ? V : never>();
  for (const [area, list] of issuesByAreaAll) {
    const unassigned = list.filter((i) => !i.assigneeGithub);
    if (unassigned.length > 0) issuesByArea.set(area, unassigned);
  }

  // Compute issue counts
  const issueCounts: BugsIssueCounts = { bugs: 0, features: 0, critical: 0 };
  let customerReported = 0;

  for (const areaIssues of issuesByArea.values()) {
    for (const issue of areaIssues) {
      if (issue.typeLabel === 'bug') {
        issueCounts.bugs++;
      } else {
        issueCounts.features++;
      }
      if (issue.priorityLabel === 'critical') {
        issueCounts.critical++;
      }
      if (issue.sourceLabel === 'customer' || issue.sourceLabel === 'user-report') {
        customerReported++;
      }
    }
  }

  // Build the Slack blocks for pinned table
  const blocks = buildBugsTable(config.displayName, issuesByArea, issueCounts);

  // Check if we already have a pinned message for bugs in this channel
  const existingTs = await getPinnedMessageTs(db, bugsChannelId, 'app_bugs');

  if (existingTs) {
    await updateMessage(bugsChannelId, existingTs, blocks, `${config.displayName} - Bugs & Features`);
  } else {
    const newTs = await postMessage(bugsChannelId, blocks, `${config.displayName} - Bugs & Features`);
    await pinMessage(bugsChannelId, newTs);
    await savePinnedMessageTs(db, bugsChannelId, 'app_bugs', newTs, repoName);
  }

  // Canvas creation disabled: see comment in refreshAppActiveTable.
  // Pinned bugs message is the single source of truth in this channel.
}

/**
 * Check if a GitHub username matches a team member's name.
 * Team members are stored by name but issues have GitHub usernames.
 */
function matchesMember(
  githubUsername: string | null,
  allMembers: Array<{ name: string; githubUsername: string }>,
  memberName: string
): boolean {
  if (!githubUsername) return false;
  const member = allMembers.find(
    (m) => m.githubUsername.toLowerCase() === githubUsername.toLowerCase()
  );
  return member?.name === memberName;
}

/**
 * Immediately rebuild and update the company overview table.
 *
 * Flow:
 * 1. Get overview channel ID from env
 * 2. Query issue counts across all repos
 * 3. Query all team members
 * 4. Build the Block Kit blocks
 * 5. Update existing pinned message or create a new one
 */
export async function refreshOverviewTable(): Promise<void> {
  const overviewChannelId = process.env.OVERVIEW_CHANNEL_ID;
  if (!overviewChannelId) {
    logger.warn('OVERVIEW_CHANNEL_ID is not configured — skipping overview table');
    return;
  }

  const db = getDb();

  // Query data
  const issueCounts = await getAllOpenIssuesCounts(db);
  const allMembers = await getAllTeamMembers(db);

  // Build app summaries with active member info
  const appSummaries: AppSummary[] = issueCounts.map((repo) => {
    const config = getChannelConfig(repo.repoName);
    const activeOnRepo = allMembers.filter(
      (m) => m.currentRepo === repo.repoName && m.status === 'active'
    );

    return {
      repoName: repo.repoName,
      displayName: config?.displayName ?? repo.repoName,
      total: repo.total,
      critical: repo.critical,
      activeMembers: activeOnRepo.map((m) => ({
        name: m.name,
        issues: '', // Simplified for overview
      })),
    };
  });

  // Build team member summaries
  const teamSummaries = allMembers.map((m) => ({
    name: m.name,
    status: m.status ?? 'idle',
    currentRepo: m.currentRepo,
    activeIssues: '', // Simplified for overview
  }));

  // Build the Slack blocks
  const blocks = buildCompanyOverviewTable(appSummaries, teamSummaries);

  // Check if we already have a pinned message for the overview channel
  const existingTs = await getPinnedMessageTs(db, overviewChannelId, 'overview');

  if (existingTs) {
    await updateMessage(overviewChannelId, existingTs, blocks, 'Company Overview');
  } else {
    const newTs = await postMessage(overviewChannelId, blocks, 'Company Overview');
    await pinMessage(overviewChannelId, newTs);
    await savePinnedMessageTs(db, overviewChannelId, 'overview', newTs);
  }

  // Canvas creation disabled: see comment in refreshAppActiveTable.
}

/**
 * Initialize all tables on bot startup.
 *
 * Called once after the server starts. Fetches all open issues from
 * the database and creates or updates pinned messages in all
 * configured channels. Non-fatal — logs errors but doesn't crash.
 */
export async function initializeTables(): Promise<void> {
  logger.info('Initializing live tables...');

  const db = getDb();
  const issueCounts = await getAllOpenIssuesCounts(db);

  // Refresh the per-app active table and bugs table for each repo
  for (const repo of issueCounts) {
    try {
      await refreshAppTable(repo.repoName);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to initialize app table', { repoName: repo.repoName, error: message });
    }

    try {
      await refreshBugsTable(repo.repoName);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to initialize bugs table', { repoName: repo.repoName, error: message });
    }
  }

  // Refresh the company overview
  try {
    await refreshOverviewTable();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to initialize overview table', { error: message });
  }

  logger.info('Live tables initialized');
}

/**
 * Clear all debounce timers. Used in tests to prevent timers
 * from leaking between test cases.
 */
export function clearAllTimers(): void {
  for (const timer of updateTimers.values()) {
    clearTimeout(timer);
  }
  updateTimers.clear();
}

/**
 * Expose the debounce delay for testing.
 */
export { DEBOUNCE_MS };
