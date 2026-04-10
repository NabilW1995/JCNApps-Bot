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
import { postMessage, updateMessage, pinMessage } from './client.js';
import { buildAppActiveTable, buildCompanyOverviewTable } from './tables.js';
import type { TeamMemberStatus, AppSummary } from '../types.js';
import { formatTimestamp } from '../utils/time.js';

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
      console.error(`Failed to refresh app table for ${repoName}: ${message}`);
    });

    refreshOverviewTable().catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to refresh overview table: ${message}`);
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
    console.error(`No channel config found for repo: ${repoName}`);
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
    console.error('OVERVIEW_CHANNEL_ID is not configured — skipping overview table');
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
}

/**
 * Initialize all tables on bot startup.
 *
 * Called once after the server starts. Fetches all open issues from
 * the database and creates or updates pinned messages in all
 * configured channels. Non-fatal — logs errors but doesn't crash.
 */
export async function initializeTables(): Promise<void> {
  console.log('Initializing live tables...');

  const db = getDb();
  const issueCounts = await getAllOpenIssuesCounts(db);

  // Refresh the per-app table for each repo that has open issues
  for (const repo of issueCounts) {
    try {
      await refreshAppTable(repo.repoName);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to initialize table for ${repo.repoName}: ${message}`);
    }
  }

  // Refresh the company overview
  try {
    await refreshOverviewTable();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to initialize overview table: ${message}`);
  }

  console.log('Live tables initialized');
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
