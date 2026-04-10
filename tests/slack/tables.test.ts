import { describe, it, expect } from 'vitest';
import { buildAppActiveTable, buildCompanyOverviewTable } from '../../src/slack/tables.js';
import type { TeamMemberStatus, AppSummary } from '../../src/types.js';
import type { issues } from '../../src/db/schema.js';

type IssueRow = typeof issues.$inferSelect;

// Helper to create a mock issue row
function mockIssue(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    id: 1,
    repoName: 'PassCraft',
    issueNumber: 78,
    title: 'Wont load on Safari',
    state: 'open',
    assigneeGithub: 'NabilW1995',
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

describe('buildAppActiveTable', () => {
  const teamStatus: TeamMemberStatus[] = [
    {
      name: 'Nabil',
      slackUserId: 'U_NABIL',
      status: 'active',
      currentRepo: 'PassCraft',
      activeIssues: '#78, #52',
      statusSince: '09:45',
    },
  ];

  it('should include app name and pinned emoji in header', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [mockIssue()]);

    const blocks = buildAppActiveTable('PassCraft', issuesByArea, teamStatus);
    const headerBlock = blocks[0];

    expect(headerBlock.type).toBe('section');
    if (headerBlock.type === 'section') {
      expect(headerBlock.text.text).toContain('PassCraft');
      expect(headerBlock.text.text).toContain('\u{1F4CC}');
      expect(headerBlock.text.text).toContain('Open Tasks');
    }
  });

  it('should show issues grouped by area with correct emojis', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [
      mockIssue({ issueNumber: 78, title: 'Wont load on Safari', priorityLabel: 'critical', sourceLabel: 'customer' }),
      mockIssue({ issueNumber: 52, title: 'Add filter', priorityLabel: 'high', sourceLabel: 'internal' }),
    ]);
    issuesByArea.set('settings', [
      mockIssue({ issueNumber: 55, title: 'Dark mode toggle', priorityLabel: 'low', areaLabel: 'settings', assigneeGithub: null }),
    ]);

    const blocks = buildAppActiveTable('PassCraft', issuesByArea, teamStatus);

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

  it('should show customer source as red and internal as blue', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [
      mockIssue({ issueNumber: 78, sourceLabel: 'customer' }),
      mockIssue({ issueNumber: 52, sourceLabel: 'internal' }),
    ]);

    const blocks = buildAppActiveTable('PassCraft', issuesByArea, teamStatus);

    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('\u{1F534}');
    expect(allText).toContain('\u{1F535}');
  });

  it('should show celebration message when no open tasks', () => {
    const emptyMap = new Map<string, IssueRow[]>();
    const blocks = buildAppActiveTable('PassCraft', emptyMap, []);

    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('No open tasks');
    expect(allText).toContain('\u{1F389}');
  });

  it('should show assigned issues with hammer emoji', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [
      mockIssue({ assigneeGithub: 'NabilW1995' }),
    ]);

    const blocks = buildAppActiveTable('PassCraft', issuesByArea, teamStatus);

    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('\u{1F528}');
    expect(allText).toContain('NabilW1995');
  });

  it('should show nobody for unassigned issues', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [
      mockIssue({ assigneeGithub: null }),
    ]);

    const blocks = buildAppActiveTable('PassCraft', issuesByArea, []);

    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('nobody');
  });

  it('should include active member status with time', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [mockIssue()]);

    const blocks = buildAppActiveTable('PassCraft', issuesByArea, teamStatus);

    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('In Progress');
    expect(allText).toContain('Nabil');
    expect(allText).toContain('#78, #52');
    expect(allText).toContain('09:45');
  });

  it('should include a divider between areas and team status', () => {
    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [mockIssue()]);

    const blocks = buildAppActiveTable('PassCraft', issuesByArea, teamStatus);
    const hasDivider = blocks.some((b) => b.type === 'divider');
    expect(hasDivider).toBe(true);
  });
});

describe('buildCompanyOverviewTable', () => {
  const appSummaries: AppSummary[] = [
    {
      repoName: 'passcraft',
      displayName: 'PassCraft',
      total: 5,
      critical: 2,
      activeMembers: [{ name: 'Nabil', issues: '#52, #78' }],
    },
    {
      repoName: 'wizard-crm',
      displayName: 'Wizard CRM',
      total: 3,
      critical: 0,
      activeMembers: [],
    },
  ];

  const teamMembers = [
    { name: 'Nabil', status: 'active', currentRepo: 'passcraft', activeIssues: '#52, #78' },
    { name: 'Alex', status: 'idle', currentRepo: null, activeIssues: '' },
  ];

  it('should include company overview header', () => {
    const blocks = buildCompanyOverviewTable(appSummaries, teamMembers);
    if (blocks[0].type === 'section') {
      expect(blocks[0].text.text).toContain('Company Overview');
      expect(blocks[0].text.text).toContain('All Apps');
    }
  });

  it('should show per-app critical and open counts', () => {
    const blocks = buildCompanyOverviewTable(appSummaries, teamMembers);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('PassCraft');
    expect(allText).toContain('2 critical');
    expect(allText).toContain('5 open');

    expect(allText).toContain('Wizard CRM');
    expect(allText).toContain('0 critical');
    expect(allText).toContain('3 open');
  });

  it('should show team status with active and idle members', () => {
    const blocks = buildCompanyOverviewTable(appSummaries, teamMembers);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('Team Status');
    expect(allText).toContain('Nabil');
    expect(allText).toContain('\u{1F528}');
    expect(allText).toContain('Alex');
    expect(allText).toContain('\u{1F4A4}');
  });

  it('should suggest tasks for idle members when apps have open work', () => {
    const blocks = buildCompanyOverviewTable(appSummaries, teamMembers);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    expect(allText).toContain('Suggestions');
    expect(allText).toContain('open tasks available');
  });

  it('should handle all tasks done gracefully', () => {
    const noWork: AppSummary[] = [
      { repoName: 'passcraft', displayName: 'PassCraft', total: 0, critical: 0, activeMembers: [] },
    ];
    const allIdle = [
      { name: 'Nabil', status: 'idle', currentRepo: null, activeIssues: '' },
    ];

    const blocks = buildCompanyOverviewTable(noWork, allIdle);
    expect(blocks.length).toBeGreaterThan(0);

    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');
    expect(allText).not.toContain('Suggestions');
  });
});
