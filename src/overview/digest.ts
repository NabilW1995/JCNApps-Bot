import { getDb } from '../db/client.js';
import { getAllOpenIssuesCounts, getAllTeamMembers } from '../db/queries.js';
import { getChannelConfig } from '../config/channels.js';
import { postMessage } from '../slack/client.js';
import { logger } from '../utils/logger.js';
import type { SlackBlock } from '../types.js';

// ---------------------------------------------------------------------------
// Morning Digest — posted as a new message each morning
// ---------------------------------------------------------------------------

/**
 * Post a morning digest to the overview channel.
 *
 * Unlike the pinned dashboard (which gets edited in place), the
 * digest is a new message each day. It gives the team a quick
 * snapshot of where things stand when they start their workday.
 */
export async function postMorningDigest(): Promise<void> {
  const channelId = process.env.OVERVIEW_CHANNEL_ID;
  if (!channelId) {
    logger.warn('OVERVIEW_CHANNEL_ID is not configured — skipping morning digest');
    return;
  }

  const db = getDb();
  const issueCounts = await getAllOpenIssuesCounts(db);
  const members = await getAllTeamMembers(db);

  const blocks = buildMorningDigestBlocks(issueCounts, members);

  await postMessage(channelId, blocks, 'Morning Digest');
  logger.info('Morning digest posted', { channelId });
}

/**
 * Build the Block Kit blocks for the morning digest.
 *
 * Exported separately from postMorningDigest so it can be unit-tested
 * without needing a real Slack connection or database.
 */
export function buildMorningDigestBlocks(
  issueCounts: Array<{ repoName: string; total: number; critical: number }>,
  members: Array<{
    name: string;
    githubUsername: string;
    status: string | null;
    currentRepo: string | null;
  }>
): SlackBlock[] {
  const totalOpen = issueCounts.reduce((sum, r) => sum + r.total, 0);
  const totalCritical = issueCounts.reduce((sum, r) => sum + r.critical, 0);
  const activeMembers = members.filter((m) => m.status === 'active');

  const criticalLine =
    totalCritical > 0
      ? `\n:rotating_light: *${totalCritical} critical* issue${totalCritical !== 1 ? 's' : ''} need attention`
      : '\n:white_check_mark: No critical issues';

  const appCount = issueCounts.length;

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:sunrise: *Good Morning JCN Team!*\n\n*Today's Overview:*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `:clipboard: *${totalOpen} open task${totalOpen !== 1 ? 's' : ''}* across ${appCount} app${appCount !== 1 ? 's' : ''}` +
          criticalLine +
          `\n:busts_in_silhouette: ${activeMembers.length}/${members.length} team members active`,
      },
    },
    { type: 'divider' },
  ];

  // Per-app summary
  for (const repo of issueCounts) {
    const config = getChannelConfig(repo.repoName);
    const appName = config?.displayName ?? repo.repoName;
    const criticalText = repo.critical > 0 ? ` | :rotating_light: ${repo.critical} critical` : '';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:iphone: *${appName}*: ${repo.total} open${criticalText}`,
      },
    });
  }

  // Team status
  blocks.push({ type: 'divider' });

  const memberLines = members.map((m) => {
    if (m.status === 'active') {
      const repoName = m.currentRepo ?? 'unknown';
      const config = getChannelConfig(repoName);
      const appName = config?.displayName ?? repoName;
      return `${m.name} \u2014 :hammer_and_wrench: Working on ${appName}`;
    }
    return `${m.name} \u2014 :zzz: No active tasks`;
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:busts_in_silhouette: *Team:*\n${memberLines.join('\n')}`,
    },
  });

  // Footer with date
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Morning digest | ${today}`,
      },
    ],
  });

  return blocks;
}
