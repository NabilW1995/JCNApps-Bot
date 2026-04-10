import type {
  SlackBlock,
  NewIssueMessageData,
  MergeConflictMessageData,
  PreviewReadyMessageData,
  ProductionDeployedMessageData,
  DeployFailedMessageData,
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
 * Build a Slack Block Kit message for a preview deployment.
 *
 * Posted to #app-preview when a feature branch is deployed to the
 * team preview URL. Includes a test checklist generated from the
 * commit message.
 */
export function buildPreviewReadyMessage(
  data: PreviewReadyMessageData
): SlackBlock[] {
  const deployer = data.deployedBySlackId
    ? `<@${data.deployedBySlackId}>`
    : data.deployedBy;

  const issueRefs =
    data.issueNumbers.length > 0
      ? data.issueNumbers.map((n) => `#${n}`).join(', ')
      : 'none';

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{1F50D} *Preview Ready*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${data.previewUrl}*\nBranch: \`${data.branch}\`\nBy: ${deployer} | Issues: ${issueRefs}`,
      },
    },
  ];

  if (data.commitMessage) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*What changed:*\n${data.commitMessage}`,
      },
    });
  }

  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Please test:*\n\u{2610} Verify the changes work as expected\n\u{2610} Test on mobile\n\u{2610} Check for visual regressions`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open Preview', emoji: true },
          url: data.previewUrl,
          action_id: 'open_preview',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Report Bug', emoji: true },
          url: data.previewUrl,
          action_id: 'report_bug',
        },
      ],
    }
  );

  return blocks;
}

/**
 * Build a Slack Block Kit message for a successful production deploy.
 *
 * Posted to #app-deploy when main branch is deployed. Shows which
 * issues were resolved and how long the work took.
 */
export function buildProductionDeployedMessage(
  data: ProductionDeployedMessageData
): SlackBlock[] {
  const deployer = data.deployedBySlackId
    ? `<@${data.deployedBySlackId}>`
    : data.deployedBy;

  const issueRefs =
    data.issueNumbers.length > 0
      ? data.issueNumbers.map((n) => `#${n}`).join(', ')
      : '';

  const durationText = data.duration ? ` | \u{23F1}\u{FE0F} ${data.duration}` : '';
  const issueText = issueRefs ? `\n${issueRefs}` : '';

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{2705} *Live: ${data.productionUrl}*${issueText}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `By: ${deployer}${durationText}`,
        },
      ],
    },
  ];

  return blocks;
}

/**
 * Build a Slack Block Kit message for a failed deployment.
 *
 * Posted to #app-deploy when any deployment fails. Tags the deployer
 * so they get notified immediately and can take action.
 */
export function buildDeployFailedMessage(
  data: DeployFailedMessageData
): SlackBlock[] {
  const deployer = data.deployedBySlackId
    ? `<@${data.deployedBySlackId}>`
    : data.deployedBy;

  const errorText = data.errorMessage
    ? `\n\`\`\`${data.errorMessage}\`\`\``
    : '';

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{274C} *Deploy Failed!*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Repo:* ${data.repoName} | *Branch:* \`${data.branch}\`${errorText}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${deployer} Production is still running the previous version \u2014 customers are not affected.`,
      },
    },
  ];

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
