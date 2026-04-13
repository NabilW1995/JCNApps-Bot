import type {
  SlackBlock,
  TeamMemberStatus,
  AppSummary,
  ActiveReconcileState,
  AssigneeGroup,
  ReconcilerIssue,
} from '../types.js';
import type { issues } from '../db/schema.js';

// ---------------------------------------------------------------------------
// Time formatting helpers for the reconciler pinned message
// ---------------------------------------------------------------------------

/** "12min ago", "3h ago", "2d ago" — humanish, bounded to days. */
export function formatAgo(date: Date | null | undefined, now: Date = new Date()): string {
  if (!date) return 'unknown';
  const diffMs = now.getTime() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** "14:30" from a Date, or empty string if null. */
export function formatHHMM(date: Date | null | undefined): string {
  if (!date) return '';
  return date.toTimeString().slice(0, 5);
}

// ---------------------------------------------------------------------------
// Area Emoji Mapping
// ---------------------------------------------------------------------------

const AREA_EMOJI_MAP: Record<string, string> = {
  dashboard: '\u{1F4CA}',       // chart
  settings: '\u2699\uFE0F',     // gear
  onboarding: '\u{1F680}',      // rocket
  profile: '\u{1F464}',         // person
  api: '\u{1F4E1}',             // satellite antenna
  payments: '\u{1F4B3}',        // credit card
  admin: '\u{1F527}',           // wrench
  'landing-page': '\u{1F3E0}',  // house
  integrations: '\u{1F517}',    // link
  navigation: '\u{1F9ED}',      // compass
  auth: '\u{1F510}',            // locked with key
  search: '\u{1F50D}',          // magnifying glass
  editor: '\u270F\uFE0F',       // pencil
  templates: '\u{1F4CB}',       // clipboard
  ui: '\u{1F3A8}',              // palette
  wallet: '\u{1F45B}',          // purse
  unassigned: '\u{1F4E6}',      // package
};

/**
 * Get the emoji for an area label. Falls back to the package emoji
 * for unknown areas.
 */
function getAreaEmoji(area: string): string {
  return AREA_EMOJI_MAP[area.toLowerCase()] ?? '\u{1F4E6}';
}

// Type alias for an issue row from the database
type IssueRow = typeof issues.$inferSelect;

// ---------------------------------------------------------------------------
// Per-App Active Table
// ---------------------------------------------------------------------------

/**
 * Build a Slack Block Kit message for the per-app pinned table.
 *
 * Shows all open issues grouped by area with assignee info and
 * a summary of who is actively working on what. This message
 * gets pinned in the app's active channel and updated in place
 * whenever issues change.
 */
export function buildAppActiveTable(
  appName: string,
  issuesByArea: Map<string, IssueRow[]>,
  teamStatus: TeamMemberStatus[]
): SlackBlock[] {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{1F4CC} *${appName} \u2014 Open Tasks*\n   Last updated: ${dateStr}, ${timeStr}`,
      },
    },
  ];

  // Show celebration if there are no open tasks
  if (issuesByArea.size === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'No open tasks \u{1F389}',
      },
    });
  } else {
    // Build a section per area
    for (const [area, areaIssues] of issuesByArea) {
      const emoji = getAreaEmoji(area);
      const areaTitle = area.charAt(0).toUpperCase() + area.slice(1);
      const issueLines = areaIssues.map((issue) => formatIssueLine(issue));

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${areaTitle}* (${areaIssues.length})\n${issueLines.join('\n')}`,
        },
      });
    }
  }

  // Divider before team status
  blocks.push({ type: 'divider' });

  // In-progress summary
  const activeMembers = teamStatus.filter((m) => m.status === 'active');
  if (activeMembers.length > 0) {
    const activeLines = activeMembers.map(
      (m) => `   ${m.name}: ${m.activeIssues}${m.statusSince ? ` (since ${m.statusSince})` : ''}`
    );
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{1F528} *In Progress:*\n${activeLines.join('\n')}`,
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '\u{1F528} *In Progress:*\n   _No one is actively working right now_',
      },
    });
  }

  return blocks;
}

/**
 * Format a single issue line for the pinned table.
 *
 * Layout: `   • [SRC] #NUMBER Title — priority ← assignee` — [SRC] is
 * plain text and only `#NUMBER Title` is the clickable GitHub link,
 * matching formatBugsIssueLine.
 */
function formatIssueLine(issue: IssueRow): string {
  const source =
    issue.sourceLabel === 'customer' || issue.sourceLabel === 'user-report'
      ? '[EXT]'
      : '[INT]';

  const priority = issue.priorityLabel ?? 'medium';
  const assignee = issue.assigneeGithub
    ? `\u2190 ${issue.assigneeGithub}`
    : '';

  return `   \u2022 ${source} <${issue.htmlUrl}|#${issue.issueNumber} ${issue.title}> \u2014 _${priority}_${assignee ? `  ${assignee}` : ''}`;
}

// ---------------------------------------------------------------------------
// Per-App Bugs Table
// ---------------------------------------------------------------------------

/** Count summary returned by buildBugsTable for the footer line. */
export interface BugsIssueCounts {
  bugs: number;
  features: number;
  critical: number;
}

/**
 * Build a Slack Block Kit message for the per-app bugs channel pinned table.
 *
 * Shows all open bugs and feature requests grouped by area, with
 * source indicators and type labels. A summary footer counts bugs
 * vs features and critical items.
 */
export function buildBugsTable(
  appName: string,
  issuesByArea: Map<string, IssueRow[]>,
  issueCounts: BugsIssueCounts
): SlackBlock[] {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);

  // Split all issues into bugs and features
  const bugsByArea = new Map<string, IssueRow[]>();
  const featuresByArea = new Map<string, IssueRow[]>();

  for (const [area, areaIssues] of issuesByArea) {
    const bugs = areaIssues.filter((i) => i.typeLabel === 'bug');
    const features = areaIssues.filter((i) => i.typeLabel !== 'bug');
    if (bugs.length > 0) bugsByArea.set(area, bugs);
    if (features.length > 0) featuresByArea.set(area, features);
  }

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{1F4CC} *${appName} \u2014 Bugs & Feature Requests*\n   Last updated: ${dateStr}, ${timeStr}`,
      },
    },
  ];

  // --- Bugs section ---
  // Use header block (Slack's biggest text size) for the category name.
  // No count subtitle — looked cluttered next to the big header.
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: '\u{1F41B} Bugs',
      emoji: true,
    },
  });

  if (bugsByArea.size === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '   _No open bugs_ \u{1F389}' },
    });
  } else {
    for (const [area, bugs] of bugsByArea) {
      const areaTitle = area.charAt(0).toUpperCase() + area.slice(1);
      const lines = bugs.map(formatBugsIssueLine);
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${areaTitle}*\n${lines.join('\n')}`,
        },
      });
    }
  }

  // Strong visual break between bugs and features: two dividers with
  // an empty section between to add vertical space. Slack's single
  // divider is too thin to clearly separate categories.
  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ' ' }],
    },
    { type: 'divider' }
  );

  // --- Features section ---
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: '\u{1F4A1} Feature Requests',
      emoji: true,
    },
  });

  if (featuresByArea.size === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '   _No open feature requests_' },
    });
  } else {
    for (const [area, features] of featuresByArea) {
      const areaTitle = area.charAt(0).toUpperCase() + area.slice(1);
      const lines = features.map(formatBugsIssueLine);
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${areaTitle}*\n${lines.join('\n')}`,
        },
      });
    }
  }

  // --- Action buttons ---
  // Slack only supports 3 button styles (primary/danger/default) — no yellow,
  // black, or transparent. Workaround: embed colored circle emojis in the
  // button text so the buttons *look* color-coded even though the background
  // is always gray. `style: primary` still colors the whole button for the
  // most important action (New Bug/Feature).
  blocks.push(
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: ':large_green_circle: New Bug/Feature', emoji: true },
          action_id: 'new_bug_or_feature',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':warning: Assign Tasks', emoji: true },
          action_id: 'assign_tasks',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':black_circle: Show/Edit Details', emoji: true },
          action_id: 'bug_details',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':pencil2: Edit Tasks', emoji: true },
          action_id: 'edit_tasks',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':arrows_counterclockwise: Refresh', emoji: true },
          action_id: 'refresh_bugs',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Summary:* ${issueCounts.bugs} bugs, ${issueCounts.features} features${issueCounts.critical > 0 ? `, ${issueCounts.critical} critical` : ''} | Auto-managed by JCNApps Bot`,
        },
      ],
    }
  );

  return blocks;
}

/**
 * Format a single issue line for the bugs pinned table.
 *
 * Layout: "• [SRC] #NUMBER Title — priority — @assignee" where [SRC] is
 * plain (not part of the link) and only "#NUMBER Title" is the clickable
 * link to GitHub. Keeping the source tag outside the link stops Slack
 * from rendering it in link-blue, which helps the tag stay visually
 * distinct from the rest of the line.
 */
function formatBugsIssueLine(issue: IssueRow): string {
  const source =
    issue.sourceLabel === 'customer' || issue.sourceLabel === 'user-report'
      ? '[EXT]'
      : '[INT]';

  const priority = issue.priorityLabel ?? 'medium';
  const assignee = issue.assigneeGithub ? ` \u2014 @${issue.assigneeGithub}` : '';

  return `   \u2022 ${source} <${issue.htmlUrl}|#${issue.issueNumber} ${issue.title}> \u2014 _${priority}_${assignee}`;
}

// ---------------------------------------------------------------------------
// Company Overview Table
// ---------------------------------------------------------------------------

/**
 * Build a Slack Block Kit message for the company-wide overview table.
 *
 * Shows a summary of all apps with their open/critical issue counts
 * and who is working where. Pinned in the overview channel and
 * updated whenever any app's issues change.
 */
export function buildCompanyOverviewTable(
  appSummaries: AppSummary[],
  teamMembers: Array<{
    name: string;
    status: string;
    currentRepo: string | null;
    activeIssues: string;
  }>
): SlackBlock[] {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{1F4CC} *Company Overview \u2014 All Apps*\n   Last updated: ${dateStr}, ${timeStr}`,
      },
    },
  ];

  // Per-app summaries
  for (const app of appSummaries) {
    const activeMemberLines = app.activeMembers
      .map((m) => `\u{1F528} ${m.name}: ${m.issues}`)
      .join('  ');

    const memberText = activeMemberLines ? `  ${activeMemberLines}` : '';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{1F4F1} *${app.displayName}*\n   \u{1F534} ${app.critical} critical  \u{1F7E1} ${app.total} open${memberText}`,
      },
    });
  }

  // Divider before team status
  blocks.push({ type: 'divider' });

  // Team status section
  const memberLines = teamMembers.map((m) => {
    if (m.status === 'active' && m.currentRepo) {
      return `   ${m.name}  \u2192 \u{1F528} ${m.currentRepo} (${m.activeIssues})`;
    }
    return `   ${m.name}  \u2192 \u{1F4A4} No active tasks`;
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `\u{1F465} *Team Status:*\n${memberLines.join('\n')}`,
    },
  });

  // Suggestions for idle members
  const idleMembers = teamMembers.filter((m) => m.status !== 'active');
  const appsWithWork = appSummaries.filter((a) => a.total > 0);

  if (idleMembers.length > 0 && appsWithWork.length > 0) {
    const suggestions = idleMembers.map((_idle, index) => {
      // Rotate through available apps to spread the suggestions
      const suggested = appsWithWork[index % appsWithWork.length];
      return `   ${suggested.displayName}: ${suggested.total} open tasks available`;
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{1F4A1} *Suggestions:*\n${suggestions.join('\n')}`,
      },
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Active Channel Reconciler Message
// ---------------------------------------------------------------------------

/**
 * Build the new active-channel pinned message from a reconciled state.
 *
 * Sections (top to bottom):
 *   ⏳ LEFTOVER FROM YESTERDAY (big, bold header) — most urgent
 *   🔨 In Progress — who's working on what right now
 *   ✅ Done Today — recent wins for team morale
 *
 * Idempotent: same input state always produces the same blocks, so the
 * reconciler can safely call this on every event without worrying about
 * drift or race conditions.
 */
export function buildReconciledActiveMessage(state: ActiveReconcileState): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  // Top header + timestamp
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `\u{1F4CC} ${state.repoDisplayName} \u2014 Active Work`,
      emoji: true,
    },
  });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Last updated: ${state.generatedAt.toISOString().slice(0, 10)}, ${formatHHMM(state.generatedAt)}`,
      },
    ],
  });

  // --- ⏳ LEFTOVER SECTION (big header at the top) ---
  if (state.leftover.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: '\u{23F3} LEFTOVER FROM YESTERDAY',
        emoji: true,
      },
    });
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':warning: _Handle this first \u2014 claimed but no recent commits._',
        },
      ],
    });

    for (const group of state.leftover) {
      blocks.push(buildAssigneeSection(group, state.generatedAt, true));
    }
  }

  // --- 🔨 IN PROGRESS ---
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: '\u{1F528} In Progress',
      emoji: true,
    },
  });
  if (state.inProgress.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_No one is actively working right now._',
      },
    });
  } else {
    for (const group of state.inProgress) {
      blocks.push(buildAssigneeSection(group, state.generatedAt, false));
    }
  }

  // --- ✅ DONE TODAY ---
  if (state.doneToday.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: '\u{2705} Done Today',
        emoji: true,
      },
    });
    const lines = state.doneToday
      .slice(0, 10)
      .map((issue) => {
        const who = issue.assigneeGithub ? ` \u2014 @${issue.assigneeGithub}` : '';
        const closedAt = formatHHMM(issue.closedAt);
        const when = closedAt ? ` \u00b7 ${closedAt}` : '';
        return `\u2022 <${issue.htmlUrl}|#${issue.issueNumber}> ${issue.title}${who}${when}`;
      })
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: lines },
    });
  }

  return blocks;
}

/**
 * Render a single assignee's card — one person + their issues.
 * Used in both the leftover and in-progress sections.
 */
function buildAssigneeSection(
  group: AssigneeGroup,
  now: Date,
  isLeftover: boolean
): SlackBlock {
  const heading = isLeftover ? ':warning:' : ':hammer:';
  const who = group.slackMention ?? `*${group.displayName}*`;

  const issueLines = group.issues
    .map((i) => `   \u2022 <${i.htmlUrl}|#${i.issueNumber}> ${i.title}`)
    .join('\n');

  // Per-group status line: claim age + last touch time
  const oldest = group.issues.reduce<ReconcilerIssue | null>((acc, i) => {
    if (!acc) return i;
    const accRef = acc.claimedAt?.getTime() ?? 0;
    const iRef = i.claimedAt?.getTime() ?? 0;
    return iRef < accRef ? i : acc;
  }, null);
  const newestTouch = group.issues.reduce<ReconcilerIssue | null>((acc, i) => {
    if (!i.lastTouchedAt) return acc;
    if (!acc || !acc.lastTouchedAt) return i;
    return i.lastTouchedAt > acc.lastTouchedAt ? i : acc;
  }, null);

  let statusLine = '';
  if (isLeftover) {
    const claimedAgo = oldest?.claimedAt ? formatAgo(oldest.claimedAt, now) : 'unknown';
    statusLine = `_Claimed ${claimedAgo}, no commits referencing this issue yet._`;
  } else {
    if (newestTouch?.lastTouchedAt) {
      statusLine = `_Last touch: ${formatAgo(newestTouch.lastTouchedAt, now)}_`;
    } else if (oldest?.claimedAt) {
      statusLine = `_Claimed ${formatAgo(oldest.claimedAt, now)}, no commits yet._`;
    }
  }

  const text = `${heading} ${who}\n${issueLines}${statusLine ? `\n${statusLine}` : ''}`;

  return {
    type: 'section',
    text: { type: 'mrkdwn', text },
  };
}
