import type {
  SlackBlock,
  NewIssueMessageData,
  MergeConflictMessageData,
  PreviewReadyMessageData,
  ProductionDeployedMessageData,
  DeployFailedMessageData,
  TaskClaimedMessageData,
  HotfixMessageData,
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
 * team preview URL. Includes a test checklist and approval instructions
 * so the team can approve and merge directly from Slack.
 */
export function buildPreviewReadyMessage(
  data: PreviewReadyMessageData
): SlackBlock[] {
  const deployer = data.deployedBySlackId
    ? `<@${data.deployedBySlackId}>`
    : data.deployedBy;

  // Strip protocol for a cleaner display URL
  const displayUrl = data.previewUrl.replace(/^https?:\/\//, '');

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:mag: *Preview Ready* \u2014 ${data.repoName}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:link: ${displayUrl}\n:twisted_rightwards_arrows: Branch: \`${data.branch}\`\n:bust_in_silhouette: By: ${deployer}`,
      },
    },
  ];

  if (data.commitMessage) {
    // Format commit message lines as bullet points
    const lines = data.commitMessage
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 5);
    const bullets = lines.map((l) => `\u2022 ${l}`).join('\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:page_facing_up: *What changed:*\n${bullets}`,
      },
    });
  }

  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:clipboard: *Please test:*\n\u2022 Verify the changes work as expected\n\u2022 Test on mobile\n\u2022 Check for visual regressions`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Issues', emoji: true },
          url: data.issueNumbers.length > 0
            ? `https://github.com/${process.env.GITHUB_ORG ?? 'NabilW1995'}/${data.repoName}/issues?q=${data.issueNumbers.map(n => n).join('+')}`
            : `https://github.com/${process.env.GITHUB_ORG ?? 'NabilW1995'}/${data.repoName}/issues?q=${encodeURIComponent(data.branch)}`,
          action_id: 'view_issues',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Create Issue', emoji: true },
          action_id: 'create_issue',
          style: 'primary',
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'React with :white_check_mark: when testing is done. When all 3 team members approve, react with :rocket: to merge to master.',
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

  const issueText = issueRefs ? ` | Issues: ${issueRefs}` : '';

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{2705} *Production Deployed*\n\n*${data.repoName}* is now live at *${data.productionUrl}*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:bust_in_silhouette: *Deployed by:* ${deployer}${issueText}`,
      },
    },
  ];

  // Add commit messages as "What changed" section
  if (data.commitMessages && data.commitMessages.length > 0) {
    const changes = data.commitMessages
      .map((msg) => {
        // Clean up commit messages: remove "Co-Authored-By" lines and trim
        const cleaned = msg.split('\n')[0].trim();
        if (!cleaned) return null;
        return `\u{2022} ${cleaned}`;
      })
      .filter(Boolean)
      .slice(0, 10) // Max 10 items
      .join('\n');

    if (changes) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:page_facing_up: *What changed:*\n${changes}`,
        },
      });
    }
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `\u{2705} Live now`,
        },
      ],
    }
  );

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

/**
 * Build a Slack Block Kit message when someone claims an issue.
 *
 * Posted to #app-active when a GitHub issue is assigned to a team
 * member, so the team sees who is working on what in real time.
 */
export function buildTaskClaimedMessage(
  data: TaskClaimedMessageData
): SlackBlock[] {
  const claimant = data.claimedBySlackId
    ? `<@${data.claimedBySlackId}>`
    : data.claimedBy;

  const filesText =
    data.files.length > 0
      ? `\n\u{1F4C1} ${data.files.join(', ')}`
      : '';

  const areaText = data.area ? `\n\u{1F3F7}\uFE0F ${data.area}` : '';

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{1F528} ${claimant} is working on:`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${data.issueUrl}|${data.title} (#${data.issueNumber})>*${filesText}${areaText}\n\u{23F0} Started: ${data.startedAt}`,
      },
    },
  ];

  return blocks;
}

/**
 * Build a Slack Block Kit message when someone starts a hotfix.
 *
 * Uses an ambulance emoji to visually distinguish urgent hotfix
 * work from regular task claims. Posted to the bugs channel for
 * maximum visibility.
 */
export function buildHotfixStartedMessage(
  data: HotfixMessageData
): SlackBlock[] {
  const fixer = data.fixedBySlackId
    ? `<@${data.fixedBySlackId}>`
    : data.fixedBy;

  const relatedText =
    data.relatedIssueNumber !== null && data.relatedIssueTitle
      ? `\n\u{1F517} Related: #${data.relatedIssueNumber} (${data.relatedIssueTitle})`
      : '';

  const filesText =
    data.files.length > 0
      ? `\n\u{1F4C1} ${data.files.join(', ')}`
      : '';

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{1F691} *Hotfix:* ${fixer}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${data.issueUrl}|${data.title} (#${data.issueNumber})>*${relatedText}${filesText}\n\u{23F0} Started: ${data.startedAt}`,
      },
    },
  ];

  return blocks;
}
