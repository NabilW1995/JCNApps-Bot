import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getDashboardData } from '../../src/dashboard/data.js';
import type { DashboardData } from '../../src/dashboard/data.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the database client
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn(() => 'mock-db'),
}));

// Mock the query functions
const mockGetAllTeamMembers = vi.fn();
const mockGetAllOpenIssuesCounts = vi.fn();
const mockGetOpenIssuesByArea = vi.fn();

vi.mock('../../src/db/queries.js', () => ({
  getAllTeamMembers: (...args: unknown[]) => mockGetAllTeamMembers(...args),
  getAllOpenIssuesCounts: (...args: unknown[]) => mockGetAllOpenIssuesCounts(...args),
  getOpenIssuesByArea: (...args: unknown[]) => mockGetOpenIssuesByArea(...args),
}));

// Mock the channel config
vi.mock('../../src/config/channels.js', () => ({
  getChannelConfig: (repoName: string) => {
    if (repoName.toLowerCase() === 'passcraft') {
      return { displayName: 'PassCraft' };
    }
    return null;
  },
}));

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

function createApp(): Hono {
  const app = new Hono();
  app.get('/api/dashboard-data', getDashboardData);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getDashboardData', () => {
  it('should return team members, apps, and issues as JSON', async () => {
    mockGetAllTeamMembers.mockResolvedValue([
      {
        id: 1,
        name: 'Nabil',
        githubUsername: 'NabilW1995',
        slackUserId: 'U_NABIL',
        currentRepo: 'passcraft',
        status: 'active',
        statusSince: new Date('2026-04-10T09:00:00Z'),
      },
    ]);

    mockGetAllOpenIssuesCounts.mockResolvedValue([
      { repoName: 'passcraft', total: 3, critical: 1 },
    ]);

    const issueMap = new Map<string, Array<Record<string, unknown>>>();
    issueMap.set('dashboard', [
      {
        issueNumber: 78,
        title: 'Wont load on Safari',
        priorityLabel: 'critical',
        sourceLabel: 'customer',
        typeLabel: 'bug',
        assigneeGithub: 'NabilW1995',
        htmlUrl: 'https://github.com/JCNApps/PassCraft/issues/78',
      },
    ]);
    mockGetOpenIssuesByArea.mockResolvedValue(issueMap);

    const app = createApp();
    const res = await app.request('/api/dashboard-data');
    expect(res.status).toBe(200);

    const data: DashboardData = await res.json();

    // Team
    expect(data.team).toHaveLength(1);
    expect(data.team[0].name).toBe('Nabil');
    expect(data.team[0].status).toBe('active');
    expect(data.team[0].currentRepo).toBe('passcraft');

    // Apps
    expect(data.apps).toHaveLength(1);
    expect(data.apps[0].displayName).toBe('PassCraft');
    expect(data.apps[0].total).toBe(3);
    expect(data.apps[0].critical).toBe(1);

    // Issues by repo and area
    expect(data.issues).toHaveProperty('passcraft');
    expect(data.issues.passcraft).toHaveProperty('dashboard');
    expect(data.issues.passcraft.dashboard).toHaveLength(1);
    expect(data.issues.passcraft.dashboard[0].issueNumber).toBe(78);
    expect(data.issues.passcraft.dashboard[0].title).toBe('Wont load on Safari');
    expect(data.issues.passcraft.dashboard[0].priority).toBe('critical');
    expect(data.issues.passcraft.dashboard[0].source).toBe('customer');

    // Last updated
    expect(data.lastUpdated).toBeTruthy();
  });

  it('should use repo name as display name when no channel config exists', async () => {
    mockGetAllTeamMembers.mockResolvedValue([]);
    mockGetAllOpenIssuesCounts.mockResolvedValue([
      { repoName: 'unknown-repo', total: 1, critical: 0 },
    ]);
    mockGetOpenIssuesByArea.mockResolvedValue(new Map());

    const app = createApp();
    const res = await app.request('/api/dashboard-data');
    const data: DashboardData = await res.json();

    expect(data.apps[0].displayName).toBe('unknown-repo');
  });

  it('should handle empty data gracefully', async () => {
    mockGetAllTeamMembers.mockResolvedValue([]);
    mockGetAllOpenIssuesCounts.mockResolvedValue([]);

    const app = createApp();
    const res = await app.request('/api/dashboard-data');
    expect(res.status).toBe(200);

    const data: DashboardData = await res.json();

    expect(data.team).toEqual([]);
    expect(data.apps).toEqual([]);
    expect(data.issues).toEqual({});
  });

  it('should return idle status when team member status is null', async () => {
    mockGetAllTeamMembers.mockResolvedValue([
      {
        id: 1,
        name: 'Alex',
        githubUsername: 'alex',
        slackUserId: 'U_ALEX',
        currentRepo: null,
        status: null,
        statusSince: null,
      },
    ]);
    mockGetAllOpenIssuesCounts.mockResolvedValue([]);

    const app = createApp();
    const res = await app.request('/api/dashboard-data');
    const data: DashboardData = await res.json();

    expect(data.team[0].status).toBe('idle');
    expect(data.team[0].statusSince).toBeNull();
  });

  it('should return 500 when database throws an error', async () => {
    const { getDb } = await import('../../src/db/client.js');
    (getDb as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('DATABASE_URL is not configured');
    });

    const app = createApp();
    const res = await app.request('/api/dashboard-data');
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBe('Failed to load dashboard data');
  });
});
