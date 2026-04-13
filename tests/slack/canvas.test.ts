import { describe, it, expect } from 'vitest';
import {
  buildTeamCanvasContent,
  buildBugsCanvasContent,
  buildOverviewCanvasContent,
  type BugsCanvasStats,
} from '../../src/slack/canvas.js';
import type { CanvasMemberData } from '../../src/types.js';

// Minimal stub matching the issues table $inferSelect shape that
// canvas only needs three fields from. Cast in the test factory.
function stubIssue(overrides: Record<string, unknown>): any {
  return {
    id: 1,
    repoName: 'PassCraft',
    issueNumber: 1,
    title: 'Sample',
    sourceLabel: 'internal',
    priorityLabel: 'medium',
    typeLabel: 'bug',
    areaLabel: 'dashboard',
    state: 'open',
    assigneeGithub: null,
    isHotfix: false,
    htmlUrl: '/issues/1',
    createdAt: new Date('2026-04-10'),
    closedAt: null,
    updatedAt: null,
    claimedAt: null,
    lastTouchedAt: null,
    ...overrides,
  };
}

describe('buildTeamCanvasContent', () => {
  it('should show active and idle members correctly', () => {
    const members: CanvasMemberData[] = [
      {
        name: 'Nabil',
        status: 'active',
        activeIssues: 'Dashboard #52, #78',
        files: ['filters.tsx', 'useFilters.ts'],
        previewUrl: 'preview-nabil.passcraft.com',
        statusSince: '09:45',
        completedToday: ['#53 Chart Export (45min)'],
      },
      {
        name: 'Chris',
        status: 'idle',
        activeIssues: '',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: ['#50 Payment Bug (1h 20min)'],
      },
    ];

    const content = buildTeamCanvasContent(members);

    // Active member section
    expect(content).toContain('Nabil');
    expect(content).toContain('\u{1F528}');
    expect(content).toContain('Dashboard #52, #78');
    expect(content).toContain('filters.tsx');
    expect(content).toContain('useFilters.ts');
    expect(content).toContain('preview-nabil.passcraft.com');
    expect(content).toContain('09:45');
    expect(content).toContain('#53 Chart Export (45min)');

    // Idle member section
    expect(content).toContain('Chris');
    expect(content).toContain('\u{1F4A4}');
    expect(content).toContain('#50 Payment Bug (1h 20min)');
  });

  it('should handle empty member list', () => {
    const content = buildTeamCanvasContent([]);
    expect(content).toContain('No team members configured');
  });

  it('should separate members with horizontal rule', () => {
    const members: CanvasMemberData[] = [
      {
        name: 'Alice',
        status: 'active',
        activeIssues: '#10',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: [],
      },
      {
        name: 'Bob',
        status: 'idle',
        activeIssues: '',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: [],
      },
    ];

    const content = buildTeamCanvasContent(members);
    expect(content).toContain('---');
  });

  it('should not show files section when no files', () => {
    const members: CanvasMemberData[] = [
      {
        name: 'Alice',
        status: 'active',
        activeIssues: '#10',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: [],
      },
    ];

    const content = buildTeamCanvasContent(members);
    expect(content).not.toContain('\u{1F4C1}');
  });

  it('should not show preview URL when null', () => {
    const members: CanvasMemberData[] = [
      {
        name: 'Alice',
        status: 'active',
        activeIssues: '#10',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: [],
      },
    ];

    const content = buildTeamCanvasContent(members);
    expect(content).not.toContain('\u{1F4CD}');
  });

  it('renders a Completed Today section when at least one member has completed work', () => {
    const members: CanvasMemberData[] = [
      {
        name: 'Alice',
        status: 'idle',
        activeIssues: '',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: ['#1 fix login'],
      },
    ];
    const content = buildTeamCanvasContent(members);
    expect(content).toContain('Completed Today');
    expect(content).toContain('#1 fix login');
  });
});

describe('buildBugsCanvasContent', () => {
  const stats: BugsCanvasStats = {
    total: 0,
    bugs: 0,
    features: 0,
    customerReported: 0,
  };

  it('returns the empty-state message when no issues exist', () => {
    const content = buildBugsCanvasContent(new Map(), stats);
    expect(content).toContain('No open bugs or feature requests');
  });

  it('groups issues by area with correct count headers', () => {
    const issuesByArea = new Map([
      [
        'dashboard',
        [
          stubIssue({ issueNumber: 23, title: 'Filter crash', priorityLabel: 'high', typeLabel: 'bug' }),
          stubIssue({ issueNumber: 45, title: 'Date picker bug', priorityLabel: 'medium' }),
        ],
      ],
      ['settings', [stubIssue({ issueNumber: 99, title: 'PW change fails', sourceLabel: 'customer' })]],
    ]);
    const content = buildBugsCanvasContent(issuesByArea, {
      total: 3,
      bugs: 3,
      features: 0,
      customerReported: 1,
    });

    expect(content).toContain('Dashboard (2)');
    expect(content).toContain('Settings (1)');
    expect(content).toContain('#23');
    expect(content).toContain('Filter crash');
    expect(content).toContain('#99');
    expect(content).toContain('PW change fails');
  });

  it('marks customer-reported issues with the customer source emoji', () => {
    const issuesByArea = new Map([
      ['dashboard', [stubIssue({ issueNumber: 1, sourceLabel: 'customer' })]],
    ]);
    const content = buildBugsCanvasContent(issuesByArea, stats);
    // Red circle is the customer source marker
    expect(content).toContain('\u{1F534} Customer');
    expect(content).not.toContain('\u{1F535} Internal');
  });

  it('marks internal issues with the internal source emoji', () => {
    const issuesByArea = new Map([
      ['dashboard', [stubIssue({ issueNumber: 1, sourceLabel: 'internal' })]],
    ]);
    const content = buildBugsCanvasContent(issuesByArea, stats);
    expect(content).toContain('\u{1F535} Internal');
    expect(content).not.toContain('\u{1F534} Customer');
  });

  it('falls back to medium priority and dash type when fields are null', () => {
    const issuesByArea = new Map([
      ['dashboard', [stubIssue({ issueNumber: 1, priorityLabel: null, typeLabel: null })]],
    ]);
    const content = buildBugsCanvasContent(issuesByArea, stats);
    expect(content).toContain('medium');
    // The typeLabel '-' fallback shows up in the column
    expect(content).toMatch(/\| -/);
  });

  it('renders the stats footer with all four metrics', () => {
    const issuesByArea = new Map([['dashboard', [stubIssue({})]]]);
    const content = buildBugsCanvasContent(issuesByArea, {
      total: 12,
      bugs: 7,
      features: 5,
      customerReported: 3,
    });
    expect(content).toContain('Total Open');
    expect(content).toContain('| 12 |');
    expect(content).toContain('Bugs');
    expect(content).toContain('| 7 |');
    expect(content).toContain('Features');
    expect(content).toContain('| 5 |');
    expect(content).toContain('From Customers');
    expect(content).toContain('| 3 |');
  });

  it('uses the package emoji fallback for unknown areas', () => {
    const issuesByArea = new Map([
      ['random-thing', [stubIssue({ issueNumber: 1, areaLabel: 'random-thing' })]],
    ]);
    const content = buildBugsCanvasContent(issuesByArea, stats);
    expect(content).toContain('\u{1F4E6}');
  });
});

describe('buildOverviewCanvasContent', () => {
  const noMembers: CanvasMemberData[] = [];

  it('renders an apps table with display name + counts + critical marker', () => {
    const content = buildOverviewCanvasContent(
      [
        { displayName: 'PassCraft', total: 12, critical: 3, activeMembers: ['Nabil', 'Chris'] },
        { displayName: 'OtherApp', total: 0, critical: 0, activeMembers: [] },
      ],
      noMembers
    );
    expect(content).toContain('PassCraft');
    expect(content).toContain('| 12 |');
    expect(content).toContain('\u{1F534} 3');
    expect(content).toContain('Nabil, Chris');
    expect(content).toContain('OtherApp');
  });

  it('shows a celebration message when there are no apps with open issues', () => {
    const content = buildOverviewCanvasContent([], noMembers);
    expect(content).toContain('No open issues');
  });

  it('renders a team status table with active and idle members', () => {
    const members: CanvasMemberData[] = [
      {
        name: 'Nabil',
        status: 'active',
        activeIssues: '#52',
        files: [],
        previewUrl: null,
        statusSince: '09:00',
        completedToday: [],
      },
      {
        name: 'Chris',
        status: 'idle',
        activeIssues: '',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: [],
      },
    ];
    const content = buildOverviewCanvasContent([], members);
    expect(content).toContain('Nabil');
    expect(content).toContain('\u{1F528}');
    expect(content).toContain('#52');
    expect(content).toContain('Chris');
    expect(content).toContain('\u{1F4A4}');
  });

  it('renders zero-critical apps without the red circle', () => {
    const content = buildOverviewCanvasContent(
      [{ displayName: 'PassCraft', total: 5, critical: 0, activeMembers: [] }],
      noMembers
    );
    expect(content).not.toContain('\u{1F534}');
    expect(content).toContain('| 0 |');
  });
});
