import type { CanvasMemberData } from '../types.js';

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
