import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpsertIssueData, DeployEventData, WebhookLogData } from '../../src/types.js';

// Mock the Drizzle DB with chainable query builders
function createMockDb() {
  const calls = {
    insert: [] as unknown[],
    select: [] as unknown[],
    update: [] as unknown[],
  };

  const chainable = () => {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn().mockReturnValue(chain);
    chain.onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.groupBy = vi.fn().mockResolvedValue([]);
    chain.limit = vi.fn().mockResolvedValue([]);
    chain.set = vi.fn().mockReturnValue(chain);
    chain.then = (resolve: (v: unknown) => void) => resolve([]);
    return chain;
  };

  const db = {
    insert: vi.fn().mockImplementation((table: unknown) => {
      calls.insert.push(table);
      return chainable();
    }),
    select: vi.fn().mockImplementation((columns?: unknown) => {
      calls.select.push(columns);
      return chainable();
    }),
    update: vi.fn().mockImplementation((table: unknown) => {
      calls.update.push(table);
      return chainable();
    }),
    _calls: calls,
  };

  return db;
}

vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn(),
}));

describe('Database Queries', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockDb = createMockDb();
  });

  describe('upsertIssue', () => {
    it('should call db.insert with issue data', async () => {
      const { upsertIssue } = await import('../../src/db/queries.js');

      const data: UpsertIssueData = {
        repoName: 'PassCraft',
        issueNumber: 42,
        title: 'Dashboard shows wrong revenue numbers',
        state: 'open',
        assigneeGithub: null,
        areaLabel: 'dashboard',
        typeLabel: 'bug',
        priorityLabel: 'high',
        sourceLabel: 'customer',
        isHotfix: false,
        htmlUrl: 'https://github.com/JCNApps/PassCraft/issues/42',
        createdAt: new Date('2026-04-10T09:00:00Z'),
        closedAt: null,
      };

      await upsertIssue(mockDb as any, data);

      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      const insertResult = mockDb.insert.mock.results[0].value;
      expect(insertResult.values).toHaveBeenCalledTimes(1);
      expect(insertResult.onConflictDoUpdate).toHaveBeenCalledTimes(1);

      const conflictArg = insertResult.onConflictDoUpdate.mock.calls[0][0];
      expect(conflictArg).toHaveProperty('target');
      expect(conflictArg).toHaveProperty('set');
      expect(conflictArg.set).toHaveProperty('title', 'Dashboard shows wrong revenue numbers');
      expect(conflictArg.set).toHaveProperty('state', 'open');
    });

    it('should include closedAt when issue is closed', async () => {
      const { upsertIssue } = await import('../../src/db/queries.js');

      const closedDate = new Date('2026-04-10T14:30:00Z');
      const data: UpsertIssueData = {
        repoName: 'PassCraft',
        issueNumber: 42,
        title: 'Dashboard shows wrong revenue numbers',
        state: 'closed',
        assigneeGithub: 'NabilW1995',
        areaLabel: 'dashboard',
        typeLabel: null,
        priorityLabel: 'high',
        sourceLabel: null,
        isHotfix: false,
        htmlUrl: 'https://github.com/JCNApps/PassCraft/issues/42',
        createdAt: new Date('2026-04-10T09:00:00Z'),
        closedAt: closedDate,
      };

      await upsertIssue(mockDb as any, data);

      const insertResult = mockDb.insert.mock.results[0].value;
      const valuesArg = insertResult.values.mock.calls[0][0];
      expect(valuesArg.closedAt).toEqual(closedDate);
      expect(valuesArg.state).toBe('closed');
      expect(valuesArg.assigneeGithub).toBe('NabilW1995');
    });
  });

  describe('getOpenIssuesForRepo', () => {
    it('should call db.select with correct filters', async () => {
      const { getOpenIssuesForRepo } = await import('../../src/db/queries.js');

      await getOpenIssuesForRepo(mockDb as any, 'PassCraft');

      expect(mockDb.select).toHaveBeenCalledTimes(1);
      const selectResult = mockDb.select.mock.results[0].value;
      expect(selectResult.from).toHaveBeenCalledTimes(1);
      expect(selectResult.where).toHaveBeenCalledTimes(1);
      expect(selectResult.orderBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getOpenIssuesByArea', () => {
    it('should group issues by areaLabel', async () => {
      const { getOpenIssuesByArea } = await import('../../src/db/queries.js');

      const testIssues = [
        { id: 1, areaLabel: 'dashboard', title: 'Bug 1', state: 'open', repoName: 'PassCraft' },
        { id: 2, areaLabel: 'dashboard', title: 'Bug 2', state: 'open', repoName: 'PassCraft' },
        { id: 3, areaLabel: 'settings', title: 'Bug 3', state: 'open', repoName: 'PassCraft' },
        { id: 4, areaLabel: null, title: 'Bug 4', state: 'open', repoName: 'PassCraft' },
      ];

      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockReturnValue(selectChain);
      selectChain.orderBy = vi.fn().mockResolvedValue(testIssues);
      mockDb.select.mockReturnValue(selectChain);

      const result = await getOpenIssuesByArea(mockDb as any, 'PassCraft');

      expect(result).toBeInstanceOf(Map);
      expect(result.get('dashboard')).toHaveLength(2);
      expect(result.get('settings')).toHaveLength(1);
      expect(result.get('unassigned')).toHaveLength(1);
    });

    it('should return empty map when no issues exist', async () => {
      const { getOpenIssuesByArea } = await import('../../src/db/queries.js');

      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockReturnValue(selectChain);
      selectChain.orderBy = vi.fn().mockResolvedValue([]);
      mockDb.select.mockReturnValue(selectChain);

      const result = await getOpenIssuesByArea(mockDb as any, 'PassCraft');

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  describe('logDeployEvent', () => {
    it('should insert a deploy event record', async () => {
      const { logDeployEvent } = await import('../../src/db/queries.js');

      const data: DeployEventData = {
        repoName: 'PassCraft',
        environment: 'production',
        status: 'success',
        branch: 'main',
        triggeredBy: 'Coolify',
        issueNumbers: [52, 53],
        startedAt: new Date('2026-04-10T12:00:00Z'),
        completedAt: new Date('2026-04-10T12:05:00Z'),
      };

      await logDeployEvent(mockDb as any, data);

      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      const insertResult = mockDb.insert.mock.results[0].value;
      const valuesArg = insertResult.values.mock.calls[0][0];
      expect(valuesArg.repoName).toBe('PassCraft');
      expect(valuesArg.environment).toBe('production');
      expect(valuesArg.status).toBe('success');
      expect(valuesArg.issueNumbers).toEqual([52, 53]);
    });

    it('should set issueNumbers to null when array is empty', async () => {
      const { logDeployEvent } = await import('../../src/db/queries.js');

      const data: DeployEventData = {
        repoName: 'PassCraft',
        environment: 'preview',
        status: 'success',
        branch: 'feature/test',
        triggeredBy: null,
        issueNumbers: [],
        startedAt: new Date(),
        completedAt: null,
      };

      await logDeployEvent(mockDb as any, data);

      const insertResult = mockDb.insert.mock.results[0].value;
      const valuesArg = insertResult.values.mock.calls[0][0];
      expect(valuesArg.issueNumbers).toBeNull();
    });
  });

  describe('logWebhook', () => {
    it('should insert a webhook log record', async () => {
      const { logWebhook } = await import('../../src/db/queries.js');

      const data: WebhookLogData = {
        source: 'github',
        eventType: 'issues.opened',
        repoName: 'PassCraft',
        payloadSummary: '#42: Dashboard shows wrong revenue numbers',
        slackChannel: null,
      };

      await logWebhook(mockDb as any, data);

      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      const insertResult = mockDb.insert.mock.results[0].value;
      const valuesArg = insertResult.values.mock.calls[0][0];
      expect(valuesArg.source).toBe('github');
      expect(valuesArg.eventType).toBe('issues.opened');
      expect(valuesArg.repoName).toBe('PassCraft');
    });
  });

  describe('getPinnedMessageTs', () => {
    it('should return message timestamp when found', async () => {
      const { getPinnedMessageTs } = await import('../../src/db/queries.js');

      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockReturnValue(selectChain);
      selectChain.limit = vi.fn().mockResolvedValue([{ messageTs: '1712750400.123456' }]);
      mockDb.select.mockReturnValue(selectChain);

      const result = await getPinnedMessageTs(mockDb as any, 'C_ACTIVE', 'app_active');

      expect(result).toBe('1712750400.123456');
    });

    it('should return null when no pinned message exists', async () => {
      const { getPinnedMessageTs } = await import('../../src/db/queries.js');

      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockReturnValue(selectChain);
      selectChain.limit = vi.fn().mockResolvedValue([]);
      mockDb.select.mockReturnValue(selectChain);

      const result = await getPinnedMessageTs(mockDb as any, 'C_ACTIVE', 'app_active');

      expect(result).toBeNull();
    });
  });

  describe('savePinnedMessageTs', () => {
    it('should upsert a pinned message record', async () => {
      const { savePinnedMessageTs } = await import('../../src/db/queries.js');

      await savePinnedMessageTs(mockDb as any, 'C_ACTIVE', 'app_active', '1712750400.123456', 'PassCraft');

      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      const insertResult = mockDb.insert.mock.results[0].value;
      expect(insertResult.values).toHaveBeenCalledTimes(1);
      expect(insertResult.onConflictDoUpdate).toHaveBeenCalledTimes(1);

      const valuesArg = insertResult.values.mock.calls[0][0];
      expect(valuesArg.channelId).toBe('C_ACTIVE');
      expect(valuesArg.channelType).toBe('app_active');
      expect(valuesArg.messageTs).toBe('1712750400.123456');
      expect(valuesArg.repoName).toBe('PassCraft');
    });
  });

  describe('getTeamMember', () => {
    it('should return team member when found', async () => {
      const { getTeamMember } = await import('../../src/db/queries.js');

      const mockMember = {
        id: 1,
        name: 'Nabil',
        githubUsername: 'NabilW1995',
        slackUserId: 'U_NABIL',
        currentRepo: null,
        status: 'idle',
        statusSince: null,
      };

      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockReturnValue(selectChain);
      selectChain.limit = vi.fn().mockResolvedValue([mockMember]);
      mockDb.select.mockReturnValue(selectChain);

      const result = await getTeamMember(mockDb as any, 'NabilW1995');

      expect(result).toEqual(mockMember);
    });

    it('should return null when member not found', async () => {
      const { getTeamMember } = await import('../../src/db/queries.js');

      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockReturnValue(selectChain);
      selectChain.limit = vi.fn().mockResolvedValue([]);
      mockDb.select.mockReturnValue(selectChain);

      const result = await getTeamMember(mockDb as any, 'unknown-user');

      expect(result).toBeNull();
    });
  });

  describe('updateTeamMemberStatus', () => {
    it('should update status and currentRepo', async () => {
      const { updateTeamMemberStatus } = await import('../../src/db/queries.js');

      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update.mockReturnValue(updateChain);

      await updateTeamMemberStatus(mockDb as any, 'NabilW1995', 'active', 'PassCraft');

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(updateChain.set).toHaveBeenCalledTimes(1);

      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(setArg.status).toBe('active');
      expect(setArg.currentRepo).toBe('PassCraft');
    });
  });

  // -----------------------------------------------------------------------
  // Claim lifecycle — part of the active-reconciler feature set
  // -----------------------------------------------------------------------

  describe('Claim lifecycle', () => {
    function setupUpdateChain() {
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update.mockReturnValue(chain);
      return chain;
    }

    describe('setIssueClaim', () => {
      it('should set assigneeGithub + claimedAt when a user claims', async () => {
        const { setIssueClaim } = await import('../../src/db/queries.js');
        const chain = setupUpdateChain();

        await setIssueClaim(mockDb as any, 'PassCraft', 23, 'NabilW1995');

        expect(mockDb.update).toHaveBeenCalledTimes(1);
        const setArg = (chain.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(setArg.assigneeGithub).toBe('NabilW1995');
        expect(setArg.claimedAt).toBeInstanceOf(Date);
        // lastTouchedAt must NOT be set — it's only touched by real commits
        expect(setArg.lastTouchedAt).toBeUndefined();
      });
    });

    describe('touchIssue', () => {
      it('should update only lastTouchedAt', async () => {
        const { touchIssue } = await import('../../src/db/queries.js');
        const chain = setupUpdateChain();

        await touchIssue(mockDb as any, 'PassCraft', 23);

        expect(mockDb.update).toHaveBeenCalledTimes(1);
        const setArg = (chain.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(setArg.lastTouchedAt).toBeInstanceOf(Date);
        // Must NOT mess with assignment or claimedAt
        expect(setArg.assigneeGithub).toBeUndefined();
        expect(setArg.claimedAt).toBeUndefined();
      });
    });

    describe('clearIssueClaim', () => {
      it('should null out claimedAt and lastTouchedAt but not assignee', async () => {
        const { clearIssueClaim } = await import('../../src/db/queries.js');
        const chain = setupUpdateChain();

        await clearIssueClaim(mockDb as any, 'PassCraft', 23);

        expect(mockDb.update).toHaveBeenCalledTimes(1);
        const setArg = (chain.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(setArg.claimedAt).toBeNull();
        expect(setArg.lastTouchedAt).toBeNull();
        // assigneeGithub is GitHub's source of truth, don't clobber it here
        expect(setArg.assigneeGithub).toBeUndefined();
      });
    });

    describe('upsertIssue claim preservation', () => {
      it('should NOT include claimedAt / lastTouchedAt in the update set when caller omits them', async () => {
        const { upsertIssue } = await import('../../src/db/queries.js');

        const data: UpsertIssueData = {
          repoName: 'PassCraft',
          issueNumber: 23,
          title: 'Filter crashes on Safari',
          state: 'open',
          assigneeGithub: 'NabilW1995',
          areaLabel: 'dashboard',
          typeLabel: 'bug',
          priorityLabel: 'critical',
          sourceLabel: 'customer',
          isHotfix: false,
          htmlUrl: 'https://github.com/JCNApps/PassCraft/issues/23',
          createdAt: new Date('2026-04-10T09:00:00Z'),
          closedAt: null,
          // claimedAt + lastTouchedAt intentionally omitted
        };

        await upsertIssue(mockDb as any, data);

        const insertResult = mockDb.insert.mock.results[0].value;
        const conflictArg = insertResult.onConflictDoUpdate.mock.calls[0][0];
        // Critical: sync from GitHub must not wipe claim state
        expect(conflictArg.set).not.toHaveProperty('claimedAt');
        expect(conflictArg.set).not.toHaveProperty('lastTouchedAt');
      });

      it('should include claimedAt in the update set when explicitly provided', async () => {
        const { upsertIssue } = await import('../../src/db/queries.js');

        const claimDate = new Date('2026-04-12T14:30:00Z');
        const data: UpsertIssueData = {
          repoName: 'PassCraft',
          issueNumber: 23,
          title: 'Filter crashes on Safari',
          state: 'open',
          assigneeGithub: 'NabilW1995',
          areaLabel: 'dashboard',
          typeLabel: 'bug',
          priorityLabel: 'critical',
          sourceLabel: 'customer',
          isHotfix: false,
          htmlUrl: 'https://github.com/JCNApps/PassCraft/issues/23',
          createdAt: new Date('2026-04-10T09:00:00Z'),
          closedAt: null,
          claimedAt: claimDate,
          lastTouchedAt: null,
        };

        await upsertIssue(mockDb as any, data);

        const insertResult = mockDb.insert.mock.results[0].value;
        const conflictArg = insertResult.onConflictDoUpdate.mock.calls[0][0];
        expect(conflictArg.set.claimedAt).toBe(claimDate);
        expect(conflictArg.set.lastTouchedAt).toBeNull();
      });
    });

    describe('getLeftoverClaimedIssues', () => {
      it('should issue a select against the issues table', async () => {
        const { getLeftoverClaimedIssues } = await import('../../src/db/queries.js');

        await getLeftoverClaimedIssues(mockDb as any, 'PassCraft', 18);

        expect(mockDb.select).toHaveBeenCalledTimes(1);
      });
    });
  });
});
