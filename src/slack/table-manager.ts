import { getDb } from '../db/client.js';
import {
  getOpenIssuesByArea,
  getAllOpenIssuesCounts,
  getPinnedMessageTs,
  savePinnedMessageTs,
  getAllTeamMembers,
  getAllClaimedIssues,
  getRecentlyClosedIssues,
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
import {
  buildCompanyOverviewTable,
  buildBugsTable,
  buildReconciledActiveMessage,
} from './tables.js';
import type {
  AppSummary,
  UpsertIssueData,
  ActiveReconcileState,
  AssigneeGroup,
  ReconcilerIssue,
} from '../types.js';
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
/**
 * Reconcile the active-channel pinned message from the current DB state.
 *
 * This is the entry point the Reconciler pattern centers around. Any
 * event (claim, push, close, unassign) that changes the active state
 * ends up here — it reads the DB, builds the desired pinned message,
 * and brings Slack to that state. Idempotent: calling it twice with
 * no state changes produces zero changes.
 *
 * State shape:
 *   - leftover: claimed issues with no commits in the last 18h
 *   - inProgress: claimed issues actively touched
 *   - doneToday: issues closed in the last 24h
 */
export async function reconcileActiveState(repoName: string): Promise<void> {
  const config = getChannelConfig(repoName);
  if (!config?.activeChannelId) {
    logger.warn('reconcileActiveState: no active channel for repo', { repoName });
    return;
  }
  const channelId = config.activeChannelId;
  const db = getDb();

  const now = new Date();
  const leftoverCutoff = new Date(now.getTime() - 18 * 60 * 60 * 1000);

  const [claimed, closed, members] = await Promise.all([
    getAllClaimedIssues(db, repoName),
    getRecentlyClosedIssues(db, repoName, 24),
    getAllTeamMembers(db),
  ]);

  // Split claimed issues into leftover vs. in-progress based on recency.
  // An issue counts as "leftover" if nobody has committed with its
  // reference (#N) in the last 18h — we use lastTouchedAt as the signal
  // and fall back to claimedAt when no touch has happened yet.
  const leftoverIssues: ReconcilerIssue[] = [];
  const inProgressIssues: ReconcilerIssue[] = [];
  for (const issue of claimed) {
    const reconcilerIssue: ReconcilerIssue = {
      issueNumber: issue.issueNumber,
      title: issue.title,
      htmlUrl: issue.htmlUrl,
      assigneeGithub: issue.assigneeGithub,
      typeLabel: issue.typeLabel,
      areaLabel: issue.areaLabel,
      claimedAt: issue.claimedAt,
      lastTouchedAt: issue.lastTouchedAt,
      closedAt: issue.closedAt,
    };
    const ref = issue.lastTouchedAt ?? issue.claimedAt;
    if (!ref || ref < leftoverCutoff) {
      leftoverIssues.push(reconcilerIssue);
    } else {
      inProgressIssues.push(reconcilerIssue);
    }
  }

  // Group by assignee (github username). Resolve display names + Slack
  // mentions from the team_members table.
  const leftover = groupIssuesByAssignee(leftoverIssues, members);
  const inProgress = groupIssuesByAssignee(inProgressIssues, members);

  const doneToday: ReconcilerIssue[] = closed.map((i) => ({
    issueNumber: i.issueNumber,
    title: i.title,
    htmlUrl: i.htmlUrl,
    assigneeGithub: i.assigneeGithub,
    typeLabel: i.typeLabel,
    areaLabel: i.areaLabel,
    claimedAt: i.claimedAt,
    lastTouchedAt: i.lastTouchedAt,
    closedAt: i.closedAt,
  }));

  const state: ActiveReconcileState = {
    repoDisplayName: config.displayName,
    generatedAt: now,
    leftover,
    inProgress,
    doneToday,
  };

  const blocks = buildReconciledActiveMessage(state);

  // Update or create the pinned message. If the saved ts points to a
  // message that's been deleted from Slack (message_not_found), fall
  // back to posting a new one — this handles channel cleanup, manual
  // unpinning, or workspace migrations gracefully.
  const existingTs = await getPinnedMessageTs(db, channelId, 'app_active');
  let postedFresh = false;
  if (existingTs) {
    try {
      await updateMessage(channelId, existingTs, blocks, `${config.displayName} - Active Work`);
    } catch (error) {
      const msg = (error as Error).message ?? '';
      if (msg.includes('message_not_found')) {
        logger.info('Active pinned message missing in Slack, recreating', {
          repoName,
          oldTs: existingTs,
        });
        postedFresh = true;
      } else {
        throw error;
      }
    }
  }
  if (!existingTs || postedFresh) {
    const newTs = await postMessage(channelId, blocks, `${config.displayName} - Active Work`);
    await pinMessage(channelId, newTs);
    await savePinnedMessageTs(db, channelId, 'app_active', newTs, repoName);
  }

  logger.info('Active state reconciled', {
    repoName,
    leftoverCount: leftover.reduce((n, g) => n + g.issues.length, 0),
    inProgressCount: inProgress.reduce((n, g) => n + g.issues.length, 0),
    doneTodayCount: doneToday.length,
  });
}

/**
 * Group reconciler issues by GitHub assignee, resolving display names
 * and Slack mentions via the team_members table.
 */
function groupIssuesByAssignee(
  issues: ReconcilerIssue[],
  members: Array<{ githubUsername: string; name: string; slackUserId: string }>
): AssigneeGroup[] {
  const groups = new Map<string, AssigneeGroup>();
  for (const issue of issues) {
    const gh = issue.assigneeGithub;
    if (!gh) continue;
    const existing = groups.get(gh);
    if (existing) {
      existing.issues.push(issue);
    } else {
      const member = members.find(
        (m) => m.githubUsername.toLowerCase() === gh.toLowerCase()
      );
      groups.set(gh, {
        githubUsername: gh,
        displayName: member?.name ?? gh,
        slackMention: member?.slackUserId ? `<@${member.slackUserId}>` : null,
        issues: [issue],
      });
    }
  }
  return Array.from(groups.values());
}

/**
 * Legacy entry point — keeps callers compatible while the migration to
 * reconcileActiveState happens. Just delegates now.
 */
export async function refreshAppTable(repoName: string): Promise<void> {
  await reconcileActiveState(repoName);
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

// (Removed legacy matchesMember helper — the reconciler uses its own
// groupIssuesByAssignee lookup now.)

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
