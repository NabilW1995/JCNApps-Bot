import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock external dependencies before importing the module under test
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/db/queries.js', () => ({
  getAllOpenIssuesCounts: vi.fn().mockResolvedValue([]),
  getOpenIssuesByArea: vi.fn().mockResolvedValue(new Map()),
  getPinnedMessageTs: vi.fn().mockResolvedValue(null),
  savePinnedMessageTs: vi.fn().mockResolvedValue(undefined),
  getAllTeamMembers: vi.fn().mockResolvedValue([]),
  getOpenIssuesForRepo: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/config/channels.js', () => ({
  getChannelConfig: vi.fn().mockImplementation((repoName: string) => {
    if (repoName === 'passcraft') {
      return { displayName: 'PassCraft' };
    }
    return null;
  }),
}));

vi.mock('../../src/slack/client.js', () => ({
  getWebClient: vi.fn().mockReturnValue({
    reactions: { add: vi.fn().mockResolvedValue({}) },
  }),
  postMessage: vi.fn().mockResolvedValue('1234.5678'),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  pinMessage: vi.fn().mockResolvedValue(undefined),
  withRetry: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
}));

import { buildOverviewMessage, refreshOverviewDashboard } from '../../src/overview/dashboard.js';
import {
  getAllOpenIssuesCounts,
  getOpenIssuesByArea,
  getAllTeamMembers,
  getOpenIssuesForRepo,
  getPinnedMessageTs,
  savePinnedMessageTs,
} from '../../src/db/queries.js';
import { postMessage, updateMessage, pinMessage } from '../../src/slack/client.js';
import type { issues } from '../../src/db/schema.js';

type IssueRow = typeof issues.$inferSelect;

function mockIssue(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    id: 1,
    repoName: 'passcraft',
    issueNumber: 52,
    title: 'Add filter',
    state: 'open',
    assigneeGithub: 'NabilW1995',
    areaLabel: 'dashboard',
    typeLabel: 'bug',
    priorityLabel: 'high',
    sourceLabel: 'internal',
    isHotfix: false,
    htmlUrl: 'https://github.com/JCNApps/PassCraft/issues/52',
    createdAt: new Date('2026-04-10T08:00:00Z'),
    closedAt: null,
    updatedAt: new Date('2026-04-10T09:00:00Z'),
    ...overrides,
  };
}

/**
 * Helper to extract all mrkdwn text from a block array for easy assertion.
 */
function extractAllText(blocks: ReturnType<typeof buildOverviewMessage> extends Promise<infer T> ? T : never): string {
  return (blocks as Array<{ type: string; text?: { text: string }; elements?: Array<{ text: string }> }>)
    .map((b) => {
      if (b.type === 'section' && b.text) return b.text.text;
      if (b.type === 'context' && b.elements) return b.elements.map((e) => e.text).join(' ');
      return '';
    })
    .join('\n');
}

describe('buildOverviewMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OVERVIEW_CHANNEL_ID = 'C0AS03H5XQB';
  });

  afterEach(() => {
    delete process.env.OVERVIEW_CHANNEL_ID;
  });

  it('should return correct sections with no issues', async () => {
    vi.mocked(getAllOpenIssuesCounts).mockResolvedValue([]);
    vi.mocked(getAllTeamMembers).mockResolvedValue([]);

    const blocks = await buildOverviewMessage();
    const text = extractAllText(blocks);

    expect(text).toContain('JCN Apps');
    expect(text).toContain('Company Dashboard');
    expect(text).toContain('No open tasks');
    expect(text).toContain('TEAM STATUS');
    expect(text).toContain('arrows_counterclockwise');
  });

  it('should show app issue counts', async () => {
    vi.mocked(getAllOpenIssuesCounts).mockResolvedValue([
      { repoName: 'passcraft', total: 5, critical: 2 },
    ]);
    vi.mocked(getAllTeamMembers).mockResolvedValue([]);

    const blocks = await buildOverviewMessage();
    const text = extractAllText(blocks);

    expect(text).toContain('PassCraft');
    expect(text).toContain('5 open');
    expect(text).toContain('2 critical');
  });

  it('should show open tasks grouped by area', async () => {
    vi.mocked(getAllOpenIssuesCounts).mockResolvedValue([
      { repoName: 'passcraft', total: 3, critical: 1 },
    ]);

    const issuesByArea = new Map<string, IssueRow[]>();
    issuesByArea.set('dashboard', [
      mockIssue({ issueNumber: 52, title: 'Add filter' }),
      mockIssue({ issueNumber: 78, title: 'Safari bug', priorityLabel: 'critical' }),
    ]);
    issuesByArea.set('settings', [
      mockIssue({ issueNumber: 55, title: 'Dark mode', areaLabel: 'settings' }),
    ]);
    vi.mocked(getOpenIssuesByArea).mockResolvedValue(issuesByArea);
    vi.mocked(getAllTeamMembers).mockResolvedValue([]);

    const blocks = await buildOverviewMessage();
    const text = extractAllText(blocks);

    expect(text).toContain('OPEN TASKS');
    expect(text).toContain('Dashboard');
    expect(text).toContain('#52');
    expect(text).toContain('#78');
    expect(text).toContain('Settings');
    expect(text).toContain('#55');
  });

  it('should show team status with active and idle members', async () => {
    vi.mocked(getAllOpenIssuesCounts).mockResolvedValue([
      { repoName: 'passcraft', total: 2, critical: 0 },
    ]);
    vi.mocked(getAllTeamMembers).mockResolvedValue([
      {
        id: 1,
        name: 'Nabil',
        githubUsername: 'NabilW1995',
        slackUserId: 'U_NABIL',
        email: null,
        currentRepo: 'passcraft',
        status: 'active',
        statusSince: null,
      },
      {
        id: 2,
        name: 'Chris',
        githubUsername: 'ChrisGH',
        slackUserId: 'U_CHRIS',
        email: null,
        currentRepo: null,
        status: 'idle',
        statusSince: null,
      },
    ]);
    vi.mocked(getOpenIssuesForRepo).mockResolvedValue([
      mockIssue({ issueNumber: 52, assigneeGithub: 'NabilW1995' }),
    ]);

    const blocks = await buildOverviewMessage();
    const text = extractAllText(blocks);

    expect(text).toContain('Nabil');
    expect(text).toContain('Working on');
    expect(text).toContain('#52');
    expect(text).toContain('Chris');
    expect(text).toContain('No active tasks');
  });

  it('should include multiple apps with mixed priorities', async () => {
    vi.mocked(getAllOpenIssuesCounts).mockResolvedValue([
      { repoName: 'passcraft', total: 5, critical: 2 },
      { repoName: 'wizard-crm', total: 3, critical: 0 },
    ]);
    vi.mocked(getAllTeamMembers).mockResolvedValue([]);

    const blocks = await buildOverviewMessage();
    const text = extractAllText(blocks);

    expect(text).toContain('PassCraft');
    expect(text).toContain('5 open');
    expect(text).toContain('wizard-crm'); // No config so raw name
    expect(text).toContain('3 open');
  });
});

describe('refreshOverviewDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OVERVIEW_CHANNEL_ID = 'C0AS03H5XQB';
  });

  afterEach(() => {
    delete process.env.OVERVIEW_CHANNEL_ID;
  });

  it('should skip when OVERVIEW_CHANNEL_ID is not set', async () => {
    delete process.env.OVERVIEW_CHANNEL_ID;
    await refreshOverviewDashboard();
    expect(postMessage).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('should create and pin a new message when none exists', async () => {
    vi.mocked(getAllOpenIssuesCounts).mockResolvedValue([]);
    vi.mocked(getAllTeamMembers).mockResolvedValue([]);
    vi.mocked(getPinnedMessageTs).mockResolvedValue(null);

    await refreshOverviewDashboard();

    expect(postMessage).toHaveBeenCalledWith(
      'C0AS03H5XQB',
      expect.any(Array),
      'Company Dashboard'
    );
    expect(pinMessage).toHaveBeenCalledWith('C0AS03H5XQB', '1234.5678');
    expect(savePinnedMessageTs).toHaveBeenCalledWith(
      expect.anything(),
      'C0AS03H5XQB',
      'overview_dashboard',
      '1234.5678'
    );
  });

  it('should update existing message when one exists', async () => {
    vi.mocked(getAllOpenIssuesCounts).mockResolvedValue([]);
    vi.mocked(getAllTeamMembers).mockResolvedValue([]);
    vi.mocked(getPinnedMessageTs).mockResolvedValue('9999.1111');

    await refreshOverviewDashboard();

    expect(updateMessage).toHaveBeenCalledWith(
      'C0AS03H5XQB',
      '9999.1111',
      expect.any(Array),
      'Company Dashboard'
    );
    expect(postMessage).not.toHaveBeenCalled();
  });
});
