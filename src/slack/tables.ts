import type { SlackBlock, TeamMemberStatus, AppSummary } from '../types.js';
import type { issues } from '../db/schema.js';

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
 * Format: `   #NUMBER  SOURCE_INDICATOR TITLE  PRIORITY  <- ASSIGNEE`
 */
function formatIssueLine(issue: IssueRow): string {
  // Source indicator: red for customer, blue for internal
  const sourceIndicator =
    issue.sourceLabel === 'customer' || issue.sourceLabel === 'user-report'
      ? '\u{1F534}' // Red circle
      : '\u{1F535}'; // Blue circle

  const priority = issue.priorityLabel ?? 'medium';
  const assignee = issue.assigneeGithub
    ? `\u{1F528} ${issue.assigneeGithub}`
    : 'nobody';

  return `   #${issue.issueNumber}  ${sourceIndicator} ${issue.title}  _${priority}_  \u2190 ${assignee}`;
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

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u{1F4CC} *${appName} \u2014 Bugs & Feature Requests*\n   Last updated: ${dateStr}, ${timeStr}`,
      },
    },
  ];

  if (issuesByArea.size === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'No open bugs or feature requests \u{1F389}',
      },
    });
  } else {
    for (const [area, areaIssues] of issuesByArea) {
      const emoji = getAreaEmoji(area);
      const areaTitle = area.charAt(0).toUpperCase() + area.slice(1);
      const issueLines = areaIssues.map((issue) => formatBugsIssueLine(issue));

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${areaTitle}* (${areaIssues.length})\n${issueLines.join('\n')}`,
        },
      });
    }
  }

  // Divider before summary
  blocks.push({ type: 'divider' });

  const total = issueCounts.bugs + issueCounts.features;
  const criticalText = issueCounts.critical > 0 ? ` | ${issueCounts.critical} critical` : '';

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Summary:* ${total} open (${issueCounts.bugs} bugs, ${issueCounts.features} features)${criticalText}`,
    },
  });

  return blocks;
}

/**
 * Format a single issue line for the bugs pinned table.
 *
 * Shows type label [bug] or [feature] instead of assignee,
 * and source indicator (red = customer, blue = internal).
 */
function formatBugsIssueLine(issue: IssueRow): string {
  const sourceIndicator =
    issue.sourceLabel === 'customer' || issue.sourceLabel === 'user-report'
      ? '\u{1F534}'
      : '\u{1F535}';

  const priority = issue.priorityLabel ?? 'medium';
  const typeTag = issue.typeLabel === 'bug' ? '[bug]' : '[feature]';

  return `   #${issue.issueNumber}  ${sourceIndicator} ${issue.title}  _${priority}_  ${typeTag}`;
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
