import { getDb } from '../db/client.js';
import {
  getAllOpenIssuesCounts,
  getOpenIssuesByArea,
  getPinnedMessageTs,
  savePinnedMessageTs,
  getAllTeamMembers,
  getOpenIssuesForRepo,
} from '../db/queries.js';
import { getChannelConfig } from '../config/channels.js';
import { getWebClient, postMessage, updateMessage, pinMessage, withRetry } from '../slack/client.js';
import { logger } from '../utils/logger.js';
import type { SlackBlock } from '../types.js';

// ---------------------------------------------------------------------------
// Area Emoji Mapping (reused from tables.ts for consistency)
// ---------------------------------------------------------------------------

const AREA_EMOJI_MAP: Record<string, string> = {
  dashboard: '\u{1F4CA}',
  settings: '\u2699\uFE0F',
  onboarding: '\u{1F680}',
  profile: '\u{1F464}',
  api: '\u{1F4E1}',
  payments: '\u{1F4B3}',
  admin: '\u{1F527}',
  'landing-page': '\u{1F3E0}',
  integrations: '\u{1F517}',
  navigation: '\u{1F9ED}',
  auth: '\u{1F510}',
  search: '\u{1F50D}',
  editor: '\u270F\uFE0F',
  templates: '\u{1F4CB}',
  ui: '\u{1F3A8}',
  wallet: '\u{1F45B}',
  unassigned: '\u{1F4E6}',
};

function getAreaEmoji(area: string): string {
  return AREA_EMOJI_MAP[area.toLowerCase()] ?? '\u{1F4E6}';
}

// ---------------------------------------------------------------------------
// Build the Overview Dashboard Message
// ---------------------------------------------------------------------------

/**
 * Build the full company dashboard message using Slack Block Kit.
 *
 * Sections:
 *   1. Header with last-updated timestamp
 *   2. Apps overview (issue counts per app)
 *   3. Open tasks grouped by area per app
 *   4. Team status (who is working on what)
 *   5. Footer with refresh hint
 */
export async function buildOverviewMessage(): Promise<SlackBlock[]> {
  const db = getDb();
  const issueCounts = await getAllOpenIssuesCounts(db);
  const allMembers = await getAllTeamMembers(db);

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const timeStr = now.toTimeString().slice(0, 5);

  const blocks: SlackBlock[] = [];

  // -- Section 1: Header --
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:bar_chart: *JCN Apps \u2014 Company Dashboard*\nLast updated: ${dateStr}, ${timeStr}`,
    },
  });

  blocks.push({ type: 'divider' });

  // -- Section 2: Apps Overview --
  if (issueCounts.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':iphone: *APPS*\n\nNo open tasks across any app :tada:',
      },
    });
  } else {
    const appLines = issueCounts.map((repo) => {
      const config = getChannelConfig(repo.repoName);
      const appName = config?.displayName ?? repo.repoName;
      const criticalText = repo.critical > 0 ? ` | :rotating_light: ${repo.critical} critical` : '';
      return `*${appName}* | ${repo.total} open${criticalText}`;
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:iphone: *APPS*\n\n${appLines.join('\n')}`,
      },
    });
  }

  blocks.push({ type: 'divider' });

  // -- Section 3: Open Tasks by App and Area --
  if (issueCounts.length > 0) {
    const taskSections: string[] = [];

    for (const repo of issueCounts) {
      const config = getChannelConfig(repo.repoName);
      const appName = config?.displayName ?? repo.repoName;
      const issuesByArea = await getOpenIssuesByArea(db, repo.repoName);

      if (issuesByArea.size === 0) continue;

      const areaLines: string[] = [];
      for (const [area, areaIssues] of issuesByArea) {
        const emoji = getAreaEmoji(area);
        const areaTitle = area.charAt(0).toUpperCase() + area.slice(1);
        const issueRefs = areaIssues.map((i) => `#${i.issueNumber} ${i.title}`).join(', ');
        areaLines.push(`  ${emoji} ${areaTitle} (${areaIssues.length}) \u2014 ${issueRefs}`);
      }

      taskSections.push(`*${appName}:*\n${areaLines.join('\n')}`);
    }

    if (taskSections.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:clipboard: *OPEN TASKS*\n\n${taskSections.join('\n\n')}`,
        },
      });

      blocks.push({ type: 'divider' });
    }
  }

  // -- Section 4: Team Status --
  // Build a mapping of member -> assigned issues across all repos
  const memberIssueMap = new Map<string, Array<{ repo: string; issueNumbers: number[] }>>();

  for (const repo of issueCounts) {
    const repoIssues = await getOpenIssuesForRepo(db, repo.repoName);
    for (const issue of repoIssues) {
      if (!issue.assigneeGithub) continue;

      // Match assignee to a team member
      const member = allMembers.find(
        (m) => m.githubUsername.toLowerCase() === issue.assigneeGithub!.toLowerCase()
      );
      if (!member) continue;

      const existing = memberIssueMap.get(member.name) ?? [];
      const repoEntry = existing.find((e) => e.repo === repo.repoName);
      if (repoEntry) {
        repoEntry.issueNumbers.push(issue.issueNumber);
      } else {
        existing.push({ repo: repo.repoName, issueNumbers: [issue.issueNumber] });
      }
      memberIssueMap.set(member.name, existing);
    }
  }

  const memberLines = allMembers.map((m) => {
    const assignments = memberIssueMap.get(m.name);
    if (assignments && assignments.length > 0) {
      const details = assignments
        .map((a) => {
          const config = getChannelConfig(a.repo);
          const appName = config?.displayName ?? a.repo;
          const refs = a.issueNumbers.map((n) => `#${n}`).join(', ');
          return `${appName}: ${refs}`;
        })
        .join(', ');
      return `${m.name} \u2014 :hammer_and_wrench: Working on ${details}`;
    }
    return `${m.name} \u2014 :zzz: No active tasks`;
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:busts_in_silhouette: *TEAM STATUS*\n\n${memberLines.join('\n')}`,
    },
  });

  blocks.push({ type: 'divider' });

  // -- Section 5: Footer with refresh hint --
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: ':arrows_counterclockwise: React with :arrows_counterclockwise: to refresh this dashboard',
      },
    ],
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Post / Update the Pinned Dashboard Message
// ---------------------------------------------------------------------------

/** The pinned message type key used in the pinned_messages table. */
const DASHBOARD_TYPE = 'overview_dashboard';

/**
 * Refresh the overview dashboard: rebuild the blocks and update
 * (or create) the pinned message in the overview channel.
 *
 * On first run it posts a new message, pins it, and adds the
 * refresh emoji reaction. Subsequent runs update in place.
 */
export async function refreshOverviewDashboard(): Promise<void> {
  const channelId = process.env.OVERVIEW_CHANNEL_ID;
  if (!channelId) {
    logger.warn('OVERVIEW_CHANNEL_ID is not configured — skipping dashboard refresh');
    return;
  }

  const db = getDb();
  const blocks = await buildOverviewMessage();

  const existingTs = await getPinnedMessageTs(db, channelId, DASHBOARD_TYPE);

  if (existingTs) {
    await updateMessage(channelId, existingTs, blocks, 'Company Dashboard');
    logger.info('Overview dashboard updated', { channelId });
  } else {
    const ts = await postMessage(channelId, blocks, 'Company Dashboard');
    await pinMessage(channelId, ts);
    await savePinnedMessageTs(db, channelId, DASHBOARD_TYPE, ts);

    // Add the refresh emoji so users can see what to click
    try {
      const client = getWebClient();
      await withRetry(async () => {
        await client.reactions.add({
          channel: channelId,
          timestamp: ts,
          name: 'arrows_counterclockwise',
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Could not add refresh emoji to dashboard', { error: message });
    }

    logger.info('Overview dashboard created and pinned', { channelId, ts });
  }
}
