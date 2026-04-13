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

/**
 * Build a Slack Block Kit message for a new GitHub issue (bug or feature).
 *
 * Uses a red indicator for customer-reported issues and blue for internal
 * ones, making it easy to spot which bugs came from real users.
 */
export function buildNewIssueMessage(data: NewIssueMessageData): SlackBlock[] {
  const sourceTag = data.isCustomerSource ? '[EXT]' : '[INT]';
  const isBug = data.labels.some((l) => l.toLowerCase() === 'type/bug' || l.toLowerCase() === 'bug');
  const typeLabel = isBug ? 'Bug' : 'Feature';
  const emoji = isBug ? ':bug:' : ':bulb:';

  const areaTitle = data.area
    ? data.area.charAt(0).toUpperCase() + data.area.slice(1).replace(/-/g, ' ')
    : 'No area';

  const bodyText = data.body
    ? `\n>>> ${data.body.length > 300 ? data.body.slice(0, 300) + '...' : data.body}`
    : '';

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *New ${typeLabel}*\nReported by *${data.reportedBy}*\n\n*${areaTitle}*\n${sourceTag} <${data.issueUrl}|#${data.issueNumber}: ${data.title}>${bodyText}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View on GitHub', emoji: true },
          url: data.issueUrl,
          action_id: 'view_issue_github',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Create Prompt to Fix', emoji: true },
          action_id: 'fix_with_claude',
          style: 'primary',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':speech_balloon: Reply in thread to discuss \u2014 all messages sync to GitHub',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':hammer: claim this bug  \u2022  :white_check_mark: mark as fixed  \u2022  :eyes: investigating',
        },
      ],
    },
  ];

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

  const displayUrl = data.previewUrl.replace(/^https?:\/\//, '');
  const org = process.env.GITHUB_ORG ?? 'NabilW1995';

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

  // "What to test" from issue titles linked to this branch
  if (data.testItems.length > 0) {
    const items = data.testItems
      .slice(0, 5)
      .map((t) => `\u2022 ${t}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:clipboard: *What to test:*\n${items}`,
      },
    });
  }

  blocks.push(
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Issues', emoji: true },
          url: `https://github.com/${org}/${data.repoName}/issues?q=${encodeURIComponent(`is:issue ${data.branch}`)}`,
          action_id: 'view_issues',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Create Issue', emoji: true },
          action_id: 'create_issue',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Done', emoji: true },
          action_id: 'preview_done',
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
          text: 'React with :white_check_mark: when testing is done. React with :rocket: to approve and merge to master.',
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
/**
 * Format a commit message with a readable type prefix.
 */
function formatCommitLine(msg: string): string | null {
  const cleaned = msg.split('\n')[0].trim();
  if (!cleaned) return null;

  const match = cleaned.match(/^(feat|fix|bug|refactor|perf|docs|style|test|chore|ci|build|revert)\s*[:(]/i);
  const prefix = match ? match[1].toLowerCase() : null;

  const labelMap: Record<string, string> = {
    feat: 'Feat',
    fix: 'Bug',
    bug: 'Bug',
    refactor: 'Refactor',
    perf: 'Perf',
    revert: 'Revert',
    chore: 'Chore',
    docs: 'Docs',
  };

  const label = prefix ? labelMap[prefix] ?? null : null;
  const description = cleaned.replace(/^(feat|fix|bug|refactor|perf|docs|style|test|chore|ci|build|revert)\s*[:(]\s*/i, '').replace(/\)$/, '');

  return label
    ? `\u2022 *${label}:* ${description || cleaned}`
    : `\u2022 ${cleaned}`;
}

/**
 * Generate a plain-language summary of what changed from commit messages.
 */
function generateChangeSummary(commits: string[]): string {
  const feats = commits.filter(c => /^feat/i.test(c)).length;
  const fixes = commits.filter(c => /^(fix|bug)/i.test(c)).length;
  const others = commits.length - feats - fixes;

  const parts: string[] = [];
  if (feats > 0) parts.push(`${feats} new feature${feats > 1 ? 's' : ''}`);
  if (fixes > 0) parts.push(`${fixes} fix${fixes > 1 ? 'es' : ''}`);
  if (others > 0) parts.push(`${others} other change${others > 1 ? 's' : ''}`);

  return parts.length > 0 ? parts.join(', ') : 'Updates deployed';
}

export function buildProductionDeployedMessage(
  data: ProductionDeployedMessageData
): SlackBlock[] {
  const deployer = data.deployedBySlackId
    ? `<@${data.deployedBySlackId}>`
    : data.deployedBy;

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{2705} *Production Deployed* \u2014 ${data.repoName}\n\n:link: ${data.productionUrl}\n:bust_in_silhouette: By: ${deployer}`,
      },
    },
  ];

  // What changed — with type labels, linked commits, and copyable SHAs
  if (data.commits && data.commits.length > 0) {
    const summary = generateChangeSummary(data.commitMessages);
    const changes = data.commits
      .slice(0, 8)
      .map((c) => {
        const shortSha = c.sha.substring(0, 7);
        const line = formatCommitLine(c.message);
        if (!line) return null;
        return `${line}  \u2014  <${c.url}|\`${shortSha}\`>`;
      })
      .filter(Boolean)
      .join('\n');

    if (changes) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:page_facing_up: *What changed* (${summary}):\n${changes}`,
        },
      });
    }
  } else if (data.commitMessages && data.commitMessages.length > 0) {
    // Fallback if no commit details available
    const summary = generateChangeSummary(data.commitMessages);
    const changes = data.commitMessages
      .map(formatCommitLine)
      .filter(Boolean)
      .slice(0, 8)
      .join('\n');

    if (changes) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:page_facing_up: *What changed* (${summary}):\n${changes}`,
        },
      });
    }
  }

  blocks.push(
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Hotfix', emoji: true },
          action_id: 'deploy_hotfix',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Rollback', emoji: true },
          action_id: 'deploy_rollback',
          style: 'danger',
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `\u{2705} Live now${formatDeployDurationLine(data.deployDuration, data.workDuration)} \u2014 Rollback requires confirmation`,
        },
      ],
    }
  );

  return blocks;
}

/**
 * Render the deploy/work duration suffix for the production deployed
 * message context line. Shows whichever of the two values are present:
 *
 *   both:           " — 12min build + 4h 5min work"
 *   pipeline only:  " — deployed in 12min"
 *   work only:      " — 4h 5min from claim to deploy"
 *   neither:        ""
 */
export function formatDeployDurationLine(
  deployDuration: string | null,
  workDuration: string | null
): string {
  if (deployDuration && workDuration) {
    return ` \u2014 ${deployDuration} build + ${workDuration} work`;
  }
  if (deployDuration) {
    return ` \u2014 deployed in ${deployDuration}`;
  }
  if (workDuration) {
    return ` \u2014 ${workDuration} from claim to deploy`;
  }
  return '';
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
