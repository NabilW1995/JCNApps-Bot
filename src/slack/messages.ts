import type {
  SlackBlock,
  NewIssueMessageData,
  MergeConflictMessageData,
} from '../types.js';
import { getPriorityEmoji } from '../config/labels.js';

/**
 * Build a Slack Block Kit message for a new GitHub issue (bug or feature).
 *
 * Uses a red indicator for customer-reported issues and blue for internal
 * ones, making it easy to spot which bugs came from real users.
 */
export function buildNewIssueMessage(data: NewIssueMessageData): SlackBlock[] {
  const sourceIndicator = data.isCustomerSource
    ? '\u{1F534}'  // Red circle — customer reported
    : '\u{1F535}'; // Blue circle — internal

  const priorityText = data.priority
    ? ` ${getPriorityEmoji(data.priority)} Priority: *${data.priority}*`
    : '';

  const areaText = data.area ? ` | Area: *${data.area}*` : '';

  const screenshotText =
    data.screenshotCount > 0
      ? ` | \u{1F4F7} ${data.screenshotCount} screenshot${data.screenshotCount > 1 ? 's' : ''}`
      : '';

  const labelList =
    data.labels.length > 0
      ? data.labels.map((l) => `\`${l}\``).join(' ')
      : '_no labels_';

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${sourceIndicator} *<${data.issueUrl}|#${data.issueNumber}: ${data.title}>*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Repo:* ${data.repoName}${areaText}${priorityText}${screenshotText}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Reported by *${data.reportedBy}* | Labels: ${labelList}`,
        },
      ],
    },
  ];

  // Add a truncated body preview if available
  if (data.body) {
    const MAX_BODY_LENGTH = 300;
    const truncatedBody =
      data.body.length > MAX_BODY_LENGTH
        ? data.body.slice(0, MAX_BODY_LENGTH) + '...'
        : data.body;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `>>> ${truncatedBody}`,
      },
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Open in GitHub', emoji: true },
        url: data.issueUrl,
        action_id: 'open_issue',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Claim', emoji: true },
        url: data.issueUrl,
        action_id: 'claim_issue',
        style: 'primary',
      },
    ],
  });

  return blocks;
}

/**
 * Build a Slack Block Kit message warning about a merge conflict.
 *
 * Tags all affected team members via their Slack user IDs so they
 * get notified immediately.
 */
export function buildMergeConflictMessage(
  data: MergeConflictMessageData
): SlackBlock[] {
  const mentions =
    data.affectedUserSlackIds.length > 0
      ? data.affectedUserSlackIds.map((id) => `<@${id}>`).join(' ')
      : data.author;

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u26A0\uFE0F *Merge Conflict Detected*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${data.prUrl}|#${data.prNumber}: ${data.prTitle}>*\n\`${data.headBranch}\` \u2192 \`${data.baseBranch}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Repo:* ${data.repoName} | *Affected:* ${mentions}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open PR', emoji: true },
          url: data.prUrl,
          action_id: 'open_pr',
        },
      ],
    },
  ];

  return blocks;
}
