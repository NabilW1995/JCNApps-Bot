import { getDb } from '../db/client.js';
import {
  getOpenIssuesByArea,
  getAllOpenIssuesCounts,
  getPinnedMessageTs,
  savePinnedMessageTs,
  getAllTeamMembers,
  getOpenIssuesForRepo,
} from '../db/queries.js';
import { getChannelConfig } from '../config/channels.js';
import { postMessage, updateMessage, pinMessage, createOrUpdateCanvas } from './client.js';
import { buildAppActiveTable, buildCompanyOverviewTable, buildBugsTable } from './tables.js';
import { buildBugsCanvasContent } from './canvas.js';
import type { TeamMemberStatus, AppSummary } from '../types.js';
import { formatTimestamp } from '../utils/time.js';
import { logger } from '../utils/logger.js';
import type { BugsIssueCounts } from './tables.js';
import type { BugsCanvasStats } from './canvas.js';

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

  // Try to create/update a Canvas with team status for this channel
  try {
    const canvasMembers = teamStatus.map((m) => ({
      name: m.name,
      status: m.status,
      activeIssues: m.activeIssues,
      files: [] as string[],
      previewUrl: null,
      statusSince: m.statusSince,
      completedToday: [] as string[],
    }));

    if (canvasMembers.length > 0) {
      const { buildTeamCanvasContent } = await import('./canvas.js');
      const canvasContent = buildTeamCanvasContent(canvasMembers);
      await createOrUpdateCanvas(channelId, canvasContent, `${config.displayName} - Team Status`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('Active canvas update skipped', { error: message });
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
    // Bugs channel not configured — skip silently
    return;
  }

  const db = getDb();

  // Query open issues grouped by area
  const issuesByArea = await getOpenIssuesByArea(db, repoName);

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

  // Try to create/update a Slack Canvas for the bugs channel.
  // Canvas API may not be available on all plans — fail silently.
  try {
    const canvasStats: BugsCanvasStats = {
      total: issueCounts.bugs + issueCounts.features,
      bugs: issueCounts.bugs,
      features: issueCounts.features,
      customerReported,
    };

    const canvasContent = buildBugsCanvasContent(issuesByArea, canvasStats);
    await createOrUpdateCanvas(bugsChannelId, canvasContent, `${config.displayName} - Bug Tracker`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('Canvas update skipped (may not be available on this plan)', { error: message });
  }
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

  // Try to create/update an overview Canvas with team status
  try {
    const { buildTeamCanvasContent } = await import('./canvas.js');
    const canvasMembers = allMembers.map((m) => ({
      name: m.name,
      status: m.status ?? 'idle',
      activeIssues: '',
      files: [] as string[],
      previewUrl: null,
      statusSince: m.statusSince ? formatTimestamp(m.statusSince) : null,
      completedToday: [] as string[],
    }));

    if (canvasMembers.length > 0) {
      const canvasContent = buildTeamCanvasContent(canvasMembers);
      await createOrUpdateCanvas(overviewChannelId, canvasContent, 'Company Team Status');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('Overview canvas update skipped', { error: message });
  }
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
