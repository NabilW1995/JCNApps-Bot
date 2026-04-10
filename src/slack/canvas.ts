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
 * Uses markdown tables grouped by area for a clean, professional look.
 * Includes a stats footer for quick overview.
 */
export function buildBugsCanvasContent(
  issuesByArea: Map<string, IssueRow[]>,
  stats: BugsCanvasStats
): string {
  if (issuesByArea.size === 0) {
    return '# Bug & Feature Tracker\n\nNo open bugs or feature requests \u{1F389}';
  }

  const sections: string[] = ['# Bug & Feature Tracker\n'];

  for (const [area, areaIssues] of issuesByArea) {
    const areaTitle = area.charAt(0).toUpperCase() + area.slice(1);
    const areaEmoji = AREA_CANVAS_EMOJI_MAP[area.toLowerCase()] ?? '\u{1F4E6}';

    sections.push(`## ${areaEmoji} ${areaTitle} (${areaIssues.length})\n`);
    sections.push('| # | Source | Issue | Priority | Type |');
    sections.push('|---|--------|-------|----------|------|');

    for (const issue of areaIssues) {
      const source =
        issue.sourceLabel === 'customer' || issue.sourceLabel === 'user-report'
          ? '\u{1F534} Customer'
          : '\u{1F535} Internal';

      const priority = issue.priorityLabel ?? 'medium';
      const type = issue.typeLabel ?? '-';

      sections.push(`| #${issue.issueNumber} | ${source} | ${issue.title} | ${priority} | ${type} |`);
    }

    sections.push('');
  }

  sections.push('---\n');
  sections.push(`| Metric | Count |`);
  sections.push(`|--------|-------|`);
  sections.push(`| Total Open | ${stats.total} |`);
  sections.push(`| Bugs | ${stats.bugs} |`);
  sections.push(`| Features | ${stats.features} |`);
  sections.push(`| From Customers | ${stats.customerReported} |`);

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
 * Uses a clean table layout showing each team member's current
 * status, active work, files, and preview URL at a glance.
 */
export function buildTeamCanvasContent(members: CanvasMemberData[]): string {
  if (members.length === 0) {
    return '# Team Status\n\nNo team members configured.';
  }

  const lines: string[] = ['# Team Status\n'];

  // Main status table
  lines.push('| Member | Status | Working On | Since |');
  lines.push('|--------|--------|------------|-------|');

  for (const member of members) {
    const status = member.status === 'active'
      ? '\u{1F528} Active'
      : '\u{1F4A4} Idle';

    const workingOn = member.status === 'active' && member.activeIssues
      ? member.activeIssues
      : '-';

    const since = member.statusSince ?? '-';

    lines.push(`| \u{1F464} ${member.name} | ${status} | ${workingOn} | ${since} |`);
  }

  // Details section for active members
  const activeMembers = members.filter((m) => m.status === 'active');
  if (activeMembers.length > 0) {
    lines.push('\n---\n');
    lines.push('## Active Work Details\n');

    for (const member of activeMembers) {
      lines.push(`### \u{1F464} ${member.name}`);

      if (member.activeIssues) {
        lines.push(`- \u{1F528} **Tasks:** ${member.activeIssues}`);
      }
      if (member.files.length > 0) {
        lines.push(`- \u{1F4C1} **Files:** ${member.files.join(', ')}`);
      }
      if (member.previewUrl) {
        lines.push(`- \u{1F4CD} **Preview:** ${member.previewUrl}`);
      }
      if (member.completedToday.length > 0) {
        lines.push(`- \u{2705} **Today:** ${member.completedToday.join(', ')}`);
      }
      lines.push('');
    }
  }

  // Completed today section
  const membersWithCompleted = members.filter((m) => m.completedToday.length > 0);
  if (membersWithCompleted.length > 0) {
    lines.push('\n---\n');
    lines.push('## Completed Today\n');
    lines.push('| Member | Completed |');
    lines.push('|--------|-----------|');

    for (const member of membersWithCompleted) {
      lines.push(`| ${member.name} | ${member.completedToday.join(', ')} |`);
    }
  }

  return lines.join('\n');
}

/**
 * Build markdown content for a Company Overview Canvas.
 *
 * Shows all apps with their issue counts and team assignments
 * in a clean table format.
 */
export function buildOverviewCanvasContent(
  apps: Array<{ displayName: string; total: number; critical: number; activeMembers: string[] }>,
  members: CanvasMemberData[]
): string {
  const lines: string[] = ['# Company Overview\n'];

  // Apps table
  lines.push('## Apps\n');
  lines.push('| App | Open Issues | Critical | Team |');
  lines.push('|-----|------------|----------|------|');

  for (const app of apps) {
    const team = app.activeMembers.length > 0
      ? app.activeMembers.join(', ')
      : '-';
    const criticalText = app.critical > 0 ? `\u{1F534} ${app.critical}` : '0';

    lines.push(`| \u{1F4F1} ${app.displayName} | ${app.total} | ${criticalText} | ${team} |`);
  }

  // Team status table
  lines.push('\n---\n');
  lines.push('## Team\n');
  lines.push('| Member | Status | App | Tasks |');
  lines.push('|--------|--------|-----|-------|');

  for (const member of members) {
    const status = member.status === 'active'
      ? '\u{1F528} Active'
      : '\u{1F4A4} Idle';

    const app = member.status === 'active' && member.activeIssues
      ? member.activeIssues
      : '-';

    lines.push(`| \u{1F464} ${member.name} | ${status} | - | ${app} |`);
  }

  if (apps.length === 0) {
    lines.push('\nNo open issues across all apps \u{1F389}');
  }

  return lines.join('\n');
}
