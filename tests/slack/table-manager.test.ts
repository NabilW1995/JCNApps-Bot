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
});
