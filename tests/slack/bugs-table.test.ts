import { describe, it, expect } from 'vitest';
import { buildBugsTable } from '../../src/slack/tables.js';
import type { BugsIssueCounts } from '../../src/slack/tables.js';
import type { issues } from '../../src/db/schema.js';

type IssueRow = typeof issues.$inferSelect;

// Helper to create a mock issue row for bugs table testing
function mockBugsIssue(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    id: 1,
    repoName: 'PassCraft',
    issueNumber: 78,
    title: 'Wont load on Safari',
    state: 'open',
    assigneeGithub: null,
    areaLabel: 'dashboard',
    typeLabel: 'bug',
    priorityLabel: 'critical',
    sourceLabel: 'customer',
    isHotfix: false,
    htmlUrl: 'https://github.com/JCNApps/PassCraft/issues/78',
    createdAt: new Date('2026-04-10T08:00:00Z'),
    closedAt: null,
    updatedAt: new Date('2026-04-10T09:00:00Z'),
    ...overrides,
  };
}

describe('buildBugsTable', () => {
  const defaultCounts: BugsIssueCounts = { bugs: 2, features: 2, critical: 2 };

  it('should include app name and Bugs & Feature Requests in header', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [mockBugsIssue()]);

    const blocks = buildBugsTable('PassCraft', issuesByArea, defaultCounts);
    const headerBlock = blocks[0];

    expect(headerBlock.type).toBe('section');
    if (headerBlock.type === 'section') {
      expect(headerBlock.text.text).toContain('PassCraft');
      expect(headerBlock.text.text).toContain('Bugs & Feature Requests');
      expect(headerBlock.text.text).toContain('\u{1F4CC}');
    }
  });

  it('should show issues grouped by area with correct emojis', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [
      mockBugsIssue({ issueNumber: 78, title: 'Wont load on Safari', priorityLabel: 'critical', sourceLabel: 'customer', typeLabel: 'bug' }),
      mockBugsIssue({ issueNumber: 52, title: 'Add filter', priorityLabel: 'medium', sourceLabel: 'internal', typeLabel: 'feature' }),
    ]);
    issuesByArea.set('settings', [
      mockBugsIssue({ issueNumber: 55, title: 'Dark mode toggle', priorityLabel: 'low', areaLabel: 'settings', typeLabel: 'feature', sourceLabel: 'internal' }),
    ]);

    const blocks = buildBugsTable('PassCraft', issuesByArea, defaultCounts);

    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    // Dashboard area
    expect(allText).toContain('\u{1F4CA}');
    expect(allText).toContain('Dashboard');
    expect(allText).toContain('#78');
    expect(allText).toContain('#52');

    // Settings area
    expect(allText).toContain('\u2699\uFE0F');
    expect(allText).toContain('Settings');
    expect(allText).toContain('#55');
  });

  it('should show customer bugs as red and internal as blue', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [
      mockBugsIssue({ issueNumber: 78, sourceLabel: 'customer' }),
      mockBugsIssue({ issueNumber: 52, sourceLabel: 'internal' }),
    ]);

    const blocks = buildBugsTable('PassCraft', issuesByArea, defaultCounts);

    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('\u{1F534}');
    expect(allText).toContain('\u{1F535}');
  });

  it('should show type labels [bug] and [feature]', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [
      mockBugsIssue({ issueNumber: 78, typeLabel: 'bug' }),
      mockBugsIssue({ issueNumber: 52, typeLabel: 'feature' }),
    ]);

    const blocks = buildBugsTable('PassCraft', issuesByArea, defaultCounts);

    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('[bug]');
    expect(allText).toContain('[feature]');
  });

  it('should show celebration message when no open issues', () => {
    const emptyMap = new Map<string, IssueRow[]>();
    const emptyCounts: BugsIssueCounts = { bugs: 0, features: 0, critical: 0 };

    const blocks = buildBugsTable('PassCraft', emptyMap, emptyCounts);

    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('No open bugs or feature requests');
    expect(allText).toContain('\u{1F389}');
  });

  it('should show summary with correct counts', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [mockBugsIssue()]);

    const counts: BugsIssueCounts = { bugs: 2, features: 2, critical: 2 };
    const blocks = buildBugsTable('PassCraft', issuesByArea, counts);

    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('Summary');
    expect(allText).toContain('4 open');
    expect(allText).toContain('2 bugs');
    expect(allText).toContain('2 features');
    expect(allText).toContain('2 critical');
  });

  it('should not show critical count in summary when zero', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [mockBugsIssue({ priorityLabel: 'medium' })]);

    const counts: BugsIssueCounts = { bugs: 1, features: 0, critical: 0 };
    const blocks = buildBugsTable('PassCraft', issuesByArea, counts);

    const sectionTexts = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text);
    // The summary is the last section block
    const summaryText = sectionTexts[sectionTexts.length - 1] ?? '';

    expect(summaryText).toContain('1 open');
    expect(summaryText).not.toContain('critical');
  });

  it('should include a divider between issues and summary', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [mockBugsIssue()]);

    const blocks = buildBugsTable('PassCraft', issuesByArea, defaultCounts);
    const hasDivider = blocks.some((b) => b.type === 'divider');
    expect(hasDivider).toBe(true);
  });
});
