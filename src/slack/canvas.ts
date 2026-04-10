import type { CanvasMemberData } from '../types.js';
import type { issues } from '../db/schema.js';

// Type alias for an issue row from the database
type IssueRow = typeof issues.$inferSelect;

// ---------------------------------------------------------------------------
// Bugs & Feature Tracker Canvas
// ---------------------------------------------------------------------------

export interface BugsCanvasStats {
  total: number;
  bugs: number;
  features: number;
  customerReported: number;
}

/**
 * Build markdown content for a Slack Canvas showing bugs & features.
 *
 * Groups issues by area with source indicators and priority info.
 * Includes a stats footer for quick overview.
 */
export function buildBugsCanvasContent(
  issuesByArea: Map<string, IssueRow[]>,
  stats: BugsCanvasStats
): string {
  if (issuesByArea.size === 0) {
    return '# Bug & Feature Tracker\n\nNo open bugs or feature requests.';
  }

  const sections: string[] = ['# Bug & Feature Tracker'];

  for (const [area, areaIssues] of issuesByArea) {
    const areaTitle = area.charAt(0).toUpperCase() + area.slice(1);
    const areaEmoji = AREA_CANVAS_EMOJI_MAP[area.toLowerCase()] ?? '\u{1F4E6}';

    sections.push(`\n## ${areaEmoji} ${areaTitle}`);

    for (const issue of areaIssues) {
      const sourceIndicator =
        issue.sourceLabel === 'customer' || issue.sourceLabel === 'user-report'
          ? '\u{1F534}'
          : '\u{1F535}';

      const sourceLabel =
        issue.sourceLabel === 'customer' || issue.sourceLabel === 'user-report'
          ? 'customer'
          : 'internal';

      const priority = issue.priorityLabel ?? 'medium';

      sections.push(`- ${sourceIndicator} #${issue.issueNumber} ${issue.title} (${priority}, ${sourceLabel})`);
    }
  }

  sections.push('');
  sections.push('---');
  sections.push(
    `**Stats:** ${stats.total} open | ${stats.bugs} bugs, ${stats.features} features | ${stats.customerReported} from customers`
  );

  return sections.join('\n');
}

// Emoji map reused for canvas (same as tables.ts but kept here for independence)
const AREA_CANVAS_EMOJI_MAP: Record<string, string> = {
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

// ---------------------------------------------------------------------------
// Team Status Canvas
// ---------------------------------------------------------------------------

/**
 * Build markdown content for a Slack Canvas showing team status.
 *
 * The Canvas API accepts markdown-like content. Each team member
 * gets a section showing their current work, files, preview URL,
 * and completed tasks for today.
 *
 * If the Canvas API is not available on the workspace's Slack plan,
 * this content can be used as a second pinned message instead.
 */
export function buildTeamCanvasContent(members: CanvasMemberData[]): string {
  if (members.length === 0) {
    return '# Team Status\n\nNo team members configured.';
  }

  const sections = members.map((member) => {
    const lines: string[] = [];

    lines.push(`## \u{1F464} ${member.name}`);

    // Active work or idle status
    if (member.status === 'active' && member.activeIssues) {
      lines.push(`\u{1F528} Active: ${member.activeIssues}`);
    } else {
      lines.push('\u{1F4A4} No active tasks');
    }

    // Files being worked on
    if (member.files.length > 0) {
      lines.push(`\u{1F4C1} ${member.files.join(', ')}`);
    }

    // Preview URL
    if (member.previewUrl) {
      lines.push(`\u{1F4CD} ${member.previewUrl}`);
    }

    // Status since timestamp
    if (member.statusSince) {
      lines.push(`\u23F0 Since: ${member.statusSince}`);
    }

    // Completed today
    if (member.completedToday.length > 0) {
      const completedStr = member.completedToday.join(', ');
      lines.push(`\u2705 Today: ${completedStr}`);
    }

    return lines.join('\n');
  });

  return sections.join('\n\n---\n\n');
}
