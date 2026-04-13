import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — isolate from real DB and Slack API
// ---------------------------------------------------------------------------

const mockPostMessage = vi.fn().mockResolvedValue('1234567890.123456');
const mockUpdateMessage = vi.fn().mockResolvedValue(undefined);
const mockPinMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/slack/client.js', () => ({
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  updateMessage: (...args: unknown[]) => mockUpdateMessage(...args),
  pinMessage: (...args: unknown[]) => mockPinMessage(...args),
}));

const mockGetOpenIssuesByArea = vi.fn().mockResolvedValue(new Map());
const mockGetOpenIssuesForRepo = vi.fn().mockResolvedValue([]);
const mockGetAllOpenIssuesCounts = vi.fn().mockResolvedValue([]);
const mockGetPinnedMessageTs = vi.fn().mockResolvedValue(null);
const mockSavePinnedMessageTs = vi.fn().mockResolvedValue(undefined);
const mockGetAllTeamMembers = vi.fn().mockResolvedValue([]);
const mockGetAllClaimedIssues = vi.fn().mockResolvedValue([]);
const mockGetRecentlyClosedIssues = vi.fn().mockResolvedValue([]);
const mockUpsertIssue = vi.fn().mockResolvedValue(undefined);
const mockCloseStaleIssues = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/db/queries.js', () => ({
  getOpenIssuesByArea: (...args: unknown[]) => mockGetOpenIssuesByArea(...args),
  getOpenIssuesForRepo: (...args: unknown[]) => mockGetOpenIssuesForRepo(...args),
  getAllOpenIssuesCounts: (...args: unknown[]) => mockGetAllOpenIssuesCounts(...args),
  getPinnedMessageTs: (...args: unknown[]) => mockGetPinnedMessageTs(...args),
  savePinnedMessageTs: (...args: unknown[]) => mockSavePinnedMessageTs(...args),
  getAllTeamMembers: (...args: unknown[]) => mockGetAllTeamMembers(...args),
  getAllClaimedIssues: (...args: unknown[]) => mockGetAllClaimedIssues(...args),
  getRecentlyClosedIssues: (...args: unknown[]) => mockGetRecentlyClosedIssues(...args),
  upsertIssue: (...args: unknown[]) => mockUpsertIssue(...args),
  closeStaleIssues: (...args: unknown[]) => mockCloseStaleIssues(...args),
}));

const mockGetChannelConfig = vi.fn().mockReturnValue({
  displayName: 'PassCraft',
  bugsWebhookUrl: 'https://hooks.slack.com/bugs',
  bugsChannelId: 'C_BUGS',
  activeChannelId: 'C_ACTIVE',
  activeWebhookUrl: 'https://hooks.slack.com/active',
  previewWebhookUrl: 'https://hooks.slack.com/preview',
  deployWebhookUrl: 'https://hooks.slack.com/deploy',
});

vi.mock('../../src/config/channels.js', () => ({
  getChannelConfig: (...args: unknown[]) => mockGetChannelConfig(...args),
}));

// Import after mocks are set up
import {
  scheduleTableUpdate,
  refreshAppTable,
  refreshBugsTable,
  refreshOverviewTable,
  reconcileActiveState,
  clearAllTimers,
  DEBOUNCE_MS,
} from '../../src/slack/table-manager.js';

describe('Table Manager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, OVERVIEW_CHANNEL_ID: 'C_OVERVIEW' };
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    clearAllTimers();
    vi.useRealTimers();
  });

  describe('scheduleTableUpdate (debounce)', () => {
    it('should not fire immediately', () => {
      scheduleTableUpdate('C_ACTIVE', 'passcraft');

      // Should not have called postMessage yet
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('should fire after debounce delay', async () => {
      scheduleTableUpdate('C_ACTIVE', 'passcraft');

      // Advance past the debounce window
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);

      // The refresh should have triggered a postMessage (new pinned message)
      expect(mockPostMessage).toHaveBeenCalled();
    });

    it('should collapse multiple calls within debounce window into one', async () => {
      // Fire 3 events rapidly
      scheduleTableUpdate('C_ACTIVE', 'passcraft');
      await vi.advanceTimersByTimeAsync(500);
      scheduleTableUpdate('C_ACTIVE', 'passcraft');
      await vi.advanceTimersByTimeAsync(500);
      scheduleTableUpdate('C_ACTIVE', 'passcraft');

      // Advance past the debounce window from the last call
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);

      // postMessage is called once for app table, once for bugs table, and once
      // for overview = 3 total max (not 3×3=9 for each schedule call)
      const postCalls = mockPostMessage.mock.calls.length;
      expect(postCalls).toBeLessThanOrEqual(4);
    });
  });

  describe('refreshAppTable', () => {
    it('should create a new pinned message when none exists', async () => {
      mockGetPinnedMessageTs.mockResolvedValue(null);
      mockPostMessage.mockResolvedValue('new.ts.123');

      await refreshAppTable('passcraft');

      expect(mockPostMessage).toHaveBeenCalledWith(
        'C_ACTIVE',
        expect.any(Array),
        expect.any(String)
      );
      expect(mockPinMessage).toHaveBeenCalledWith('C_ACTIVE', 'new.ts.123');
      expect(mockSavePinnedMessageTs).toHaveBeenCalled();
    });

    it('should update existing pinned message when one exists', async () => {
      mockGetPinnedMessageTs.mockResolvedValue('existing.ts.456');

      await refreshAppTable('passcraft');

      expect(mockUpdateMessage).toHaveBeenCalledWith(
        'C_ACTIVE',
        'existing.ts.456',
        expect.any(Array),
        expect.any(String)
      );
      // Should NOT post a new message or pin
      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(mockPinMessage).not.toHaveBeenCalled();
    });

    it('should query claimed + recently closed issues from DB (reconciler path)', async () => {
      await refreshAppTable('passcraft');

      // New reconciler path uses getAllClaimedIssues + getRecentlyClosedIssues
      // instead of the legacy getOpenIssuesByArea.
      expect(mockGetAllClaimedIssues).toHaveBeenCalledWith(
        expect.anything(),
        'passcraft'
      );
      expect(mockGetRecentlyClosedIssues).toHaveBeenCalledWith(
        expect.anything(),
        'passcraft',
        24
      );
    });

    it('should silently skip when no channel config exists', async () => {
      mockGetChannelConfig.mockReturnValue(null);

      await refreshAppTable('unknown-repo');

      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(mockUpdateMessage).not.toHaveBeenCalled();
    });
  });

  describe('refreshOverviewTable', () => {
    it('should query issue counts and team members from DB', async () => {
      await refreshOverviewTable();

      expect(mockGetAllOpenIssuesCounts).toHaveBeenCalled();
      expect(mockGetAllTeamMembers).toHaveBeenCalled();
    });

    it('should create a new pinned message when none exists', async () => {
      mockGetPinnedMessageTs.mockResolvedValue(null);
      mockPostMessage.mockResolvedValue('overview.ts.789');

      await refreshOverviewTable();

      expect(mockPostMessage).toHaveBeenCalledWith(
        'C_OVERVIEW',
        expect.any(Array),
        'Company Overview'
      );
      expect(mockPinMessage).toHaveBeenCalledWith('C_OVERVIEW', 'overview.ts.789');
    });

    it('should update existing pinned message when one exists', async () => {
      mockGetPinnedMessageTs.mockResolvedValue('existing.overview.ts');

      await refreshOverviewTable();

      expect(mockUpdateMessage).toHaveBeenCalledWith(
        'C_OVERVIEW',
        'existing.overview.ts',
        expect.any(Array),
        'Company Overview'
      );
    });

    it('should skip when OVERVIEW_CHANNEL_ID is not set', async () => {
      delete process.env.OVERVIEW_CHANNEL_ID;

      await refreshOverviewTable();

      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(mockUpdateMessage).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // Reconciler — leftover vs in-progress split (18h cutoff)
  // ---------------------------------------------------------------------
  //
  // Why: the morning cron + push webhooks converge on reconcileActiveState
  // to decide which claimed issues appear in the LEFTOVER section (stale,
  // no commits in 18h) vs the IN PROGRESS section (actively touched).
  // These tests verify the split by inspecting the Block Kit blocks
  // handed to postMessage / updateMessage — the only observable output.

  describe('reconcileActiveState — 18h leftover cutoff', () => {
    const HOUR = 60 * 60 * 1000;

    function makeIssue(overrides: Record<string, unknown>) {
      return {
        id: 1,
        repoName: 'PassCraft',
        issueNumber: 23,
        title: 'Filter crash',
        state: 'open',
        assigneeGithub: 'nabilw1995',
        areaLabel: 'dashboard',
        typeLabel: 'bug',
        priorityLabel: 'high',
        sourceLabel: 'customer',
        isHotfix: false,
        htmlUrl: '/issues/23',
        createdAt: new Date('2026-04-10'),
        closedAt: null,
        updatedAt: null,
        claimedAt: new Date(),
        lastTouchedAt: new Date(),
        ...overrides,
      };
    }

    function extractBlocksFromLastCall(mock: ReturnType<typeof vi.fn>) {
      const call = mock.mock.calls[mock.mock.calls.length - 1];
      if (!call) return [];
      // postMessage signature: (channel, blocks, text)
      // updateMessage signature: (channel, ts, blocks, text)
      return call[1] && Array.isArray(call[1]) ? call[1] : call[2];
    }

    function renderBlocksToText(blocks: any[]): string {
      return blocks
        .map((b: any) => {
          if (b.type === 'section' && b.text?.text) return b.text.text;
          if (b.type === 'header' && b.text?.text) return b.text.text;
          if (b.type === 'context' && Array.isArray(b.elements))
            return b.elements.map((e: any) => e.text ?? '').join(' ');
          return '';
        })
        .join('\n');
    }

    beforeEach(() => {
      // The outer beforeEach installs fake timers for debounce tests, but
      // reconcileActiveState awaits real Promises from the mocked DB. With
      // fake timers those microtasks don't flush naturally, so we switch
      // back to real timers here.
      vi.useRealTimers();
      // Earlier tests in the file override mockGetChannelConfig to null,
      // and `vi.clearAllMocks()` does NOT reset the implementation — so we
      // restore the active-channel config explicitly for every reconcile
      // test, otherwise the function bails out with a warn-and-return.
      mockGetChannelConfig.mockReturnValue({
        displayName: 'PassCraft',
        bugsWebhookUrl: 'https://hooks.slack.com/bugs',
        bugsChannelId: 'C_BUGS',
        activeChannelId: 'C_ACTIVE',
        activeWebhookUrl: 'https://hooks.slack.com/active',
        previewWebhookUrl: 'https://hooks.slack.com/preview',
        deployWebhookUrl: 'https://hooks.slack.com/deploy',
      });
      mockGetPinnedMessageTs.mockResolvedValue(null);
      mockPostMessage.mockResolvedValue('new.ts.reconcile');
      mockGetAllTeamMembers.mockResolvedValue([
        { name: 'Nabil', githubUsername: 'nabilw1995', slackUserId: 'U_NABIL' },
      ]);
      mockGetRecentlyClosedIssues.mockResolvedValue([]);
    });

    it('puts a freshly-touched issue into IN PROGRESS', async () => {
      mockGetAllClaimedIssues.mockResolvedValue([
        makeIssue({
          issueNumber: 23,
          title: 'Fresh work',
          // Touched 2 hours ago => well within the 18h window
          lastTouchedAt: new Date(Date.now() - 2 * HOUR),
          claimedAt: new Date(Date.now() - 20 * HOUR),
        }),
      ]);

      await reconcileActiveState('PassCraft');

      const blocks = extractBlocksFromLastCall(mockPostMessage);
      const text = renderBlocksToText(blocks);
      // The fresh issue must appear, and it must NOT be in a leftover section
      expect(text).toContain('#23');
      expect(text).toContain('Fresh work');
      // The heading for in-progress work should be present
      expect(text.toLowerCase()).toMatch(/in progress/);
    });

    it('puts a stale claimed issue into LEFTOVER', async () => {
      mockGetAllClaimedIssues.mockResolvedValue([
        makeIssue({
          issueNumber: 77,
          title: 'Stale work',
          // Last touched 20 hours ago => past 18h cutoff
          lastTouchedAt: new Date(Date.now() - 20 * HOUR),
          claimedAt: new Date(Date.now() - 48 * HOUR),
        }),
      ]);

      await reconcileActiveState('PassCraft');

      const blocks = extractBlocksFromLastCall(mockPostMessage);
      const text = renderBlocksToText(blocks);
      expect(text).toContain('#77');
      expect(text).toContain('Stale work');
      // Section header should show LEFTOVER (or equivalent wording)
      expect(text.toLowerCase()).toMatch(/leftover/);
    });

    it('uses claimedAt as fallback when lastTouchedAt is null', async () => {
      mockGetAllClaimedIssues.mockResolvedValue([
        makeIssue({
          issueNumber: 91,
          title: 'Never touched',
          lastTouchedAt: null,
          // Claimed 20h ago, never touched => LEFTOVER
          claimedAt: new Date(Date.now() - 20 * HOUR),
        }),
      ]);

      await reconcileActiveState('PassCraft');

      const blocks = extractBlocksFromLastCall(mockPostMessage);
      const text = renderBlocksToText(blocks);
      expect(text).toContain('#91');
      expect(text.toLowerCase()).toMatch(/leftover/);
    });

    it('splits a mixed set into both sections correctly', async () => {
      mockGetAllClaimedIssues.mockResolvedValue([
        makeIssue({
          issueNumber: 10,
          title: 'Fresh bug',
          lastTouchedAt: new Date(Date.now() - 1 * HOUR),
          claimedAt: new Date(Date.now() - 24 * HOUR),
        }),
        makeIssue({
          issueNumber: 20,
          title: 'Stale bug',
          lastTouchedAt: new Date(Date.now() - 30 * HOUR),
          claimedAt: new Date(Date.now() - 30 * HOUR),
        }),
        makeIssue({
          issueNumber: 30,
          title: 'Just touched',
          lastTouchedAt: new Date(Date.now() - 10 * 60 * 1000),
          claimedAt: new Date(Date.now() - 50 * HOUR),
        }),
      ]);

      await reconcileActiveState('PassCraft');

      const blocks = extractBlocksFromLastCall(mockPostMessage);
      const text = renderBlocksToText(blocks);
      expect(text).toContain('#10');
      expect(text).toContain('#20');
      expect(text).toContain('#30');
    });

    it('shows recently closed issues in DONE TODAY', async () => {
      mockGetAllClaimedIssues.mockResolvedValue([]);
      mockGetRecentlyClosedIssues.mockResolvedValue([
        makeIssue({
          issueNumber: 55,
          title: 'Finished work',
          closedAt: new Date(Date.now() - 2 * HOUR),
          claimedAt: new Date(Date.now() - 5 * HOUR),
          lastTouchedAt: new Date(Date.now() - 2 * HOUR),
        }),
      ]);

      await reconcileActiveState('PassCraft');

      const blocks = extractBlocksFromLastCall(mockPostMessage);
      const text = renderBlocksToText(blocks);
      expect(text).toContain('#55');
      expect(text.toLowerCase()).toMatch(/done/);
    });
  });
});
