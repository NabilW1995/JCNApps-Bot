import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkPreviewApproval,
  registerPreviewMessage,
  getPreviewMessage,
  findPreviewMessageByBranch,
  handleExternalMerge,
  clearProcessedApprovals,
  isPreviewApproved,
  isPreviewMerged,
  APPROVAL_THRESHOLD,
} from '../../src/preview/approval.js';

// ---------------------------------------------------------------------------
// Mocks — Slack Web API
// ---------------------------------------------------------------------------

const mockReactionsGet = vi.fn();
const mockReactionsAdd = vi.fn();
const mockChatPostMessage = vi.fn();

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    reactions: {
      get: mockReactionsGet,
      add: mockReactionsAdd,
    },
    chat: { postMessage: mockChatPostMessage },
  })),
}));

// Mock the merge module so tests don't call GitHub
vi.mock('../../src/preview/merge.js', () => ({
  mergeBranchToMain: vi.fn().mockResolvedValue(true),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Preview Approval Flow', () => {
  const CHANNEL = 'C_PREVIEW';
  const MESSAGE_TS = '1234567890.111111';

  beforeEach(() => {
    clearProcessedApprovals();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    vi.clearAllMocks();

    // Register a preview message for all tests
    registerPreviewMessage({
      channel: CHANNEL,
      messageTs: MESSAGE_TS,
      repoName: 'PassCraft',
      branch: 'feature/dashboard-filter',
      previewUrl: 'https://preview.passcraft.pro',
    });
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
  });

  describe('APPROVAL_THRESHOLD', () => {
    it('should require 3 approvals', () => {
      expect(APPROVAL_THRESHOLD).toBe(3);
    });
  });

  describe('registerPreviewMessage', () => {
    it('should store and retrieve preview message info', () => {
      const info = getPreviewMessage(CHANNEL, MESSAGE_TS);
      expect(info).toBeDefined();
      expect(info?.repoName).toBe('PassCraft');
      expect(info?.branch).toBe('feature/dashboard-filter');
    });

    it('should find preview message by branch', () => {
      const info = findPreviewMessageByBranch('PassCraft', 'feature/dashboard-filter');
      expect(info).toBeDefined();
      expect(info?.channel).toBe(CHANNEL);
    });

    it('should return undefined for unknown branch', () => {
      const info = findPreviewMessageByBranch('PassCraft', 'feature/nonexistent');
      expect(info).toBeUndefined();
    });
  });

  describe('checkmark reactions', () => {
    it('should NOT trigger approval with fewer than 3 checkmarks', async () => {
      mockReactionsGet.mockResolvedValue({
        message: {
          reactions: [
            { name: 'white_check_mark', count: 2, users: ['U1', 'U2'] },
          ],
        },
      });

      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'white_check_mark', 'U2');

      expect(isPreviewApproved(CHANNEL, MESSAGE_TS)).toBe(false);
      expect(mockReactionsAdd).not.toHaveBeenCalled();
      expect(mockChatPostMessage).not.toHaveBeenCalled();
    });

    it('should trigger approval with 3 checkmarks from unique users', async () => {
      mockReactionsGet.mockResolvedValue({
        message: {
          reactions: [
            { name: 'white_check_mark', count: 3, users: ['U1', 'U2', 'U3'] },
          ],
        },
      });

      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'white_check_mark', 'U3');

      expect(isPreviewApproved(CHANNEL, MESSAGE_TS)).toBe(true);
      // Should add :rocket: emoji
      expect(mockReactionsAdd).toHaveBeenCalledWith({
        channel: CHANNEL,
        timestamp: MESSAGE_TS,
        name: 'rocket',
      });
      // Should post thread reply about approval
      expect(mockChatPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: CHANNEL,
          thread_ts: MESSAGE_TS,
          text: expect.stringContaining('All 3 team members approved'),
        })
      );
    });

    it('should NOT count 3 reactions from fewer than 3 unique users', async () => {
      mockReactionsGet.mockResolvedValue({
        message: {
          reactions: [
            // count is 3 but only 2 unique users (Slack edge case)
            { name: 'white_check_mark', count: 3, users: ['U1', 'U2'] },
          ],
        },
      });

      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'white_check_mark', 'U1');

      expect(isPreviewApproved(CHANNEL, MESSAGE_TS)).toBe(false);
    });

    it('should trigger approval with more than 3 checkmarks', async () => {
      mockReactionsGet.mockResolvedValue({
        message: {
          reactions: [
            { name: 'white_check_mark', count: 5, users: ['U1', 'U2', 'U3', 'U4', 'U5'] },
          ],
        },
      });

      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'white_check_mark', 'U5');

      expect(isPreviewApproved(CHANNEL, MESSAGE_TS)).toBe(true);
    });
  });

  describe('duplicate processing prevention', () => {
    it('should not process the same approval twice', async () => {
      mockReactionsGet.mockResolvedValue({
        message: {
          reactions: [
            { name: 'white_check_mark', count: 3, users: ['U1', 'U2', 'U3'] },
          ],
        },
      });

      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'white_check_mark', 'U3');
      vi.clearAllMocks();

      // Second call with the same message
      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'white_check_mark', 'U4');

      // Should not call Slack API again
      expect(mockReactionsGet).not.toHaveBeenCalled();
      expect(mockReactionsAdd).not.toHaveBeenCalled();
    });
  });

  describe('rocket reaction (merge)', () => {
    it('should trigger merge when rocket is added after approval', async () => {
      const { mergeBranchToMain } = await import('../../src/preview/merge.js');

      // First: simulate approval
      mockReactionsGet.mockResolvedValue({
        message: {
          reactions: [
            { name: 'white_check_mark', count: 3, users: ['U1', 'U2', 'U3'] },
          ],
        },
      });
      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'white_check_mark', 'U3');
      vi.clearAllMocks();

      // Second: rocket reaction
      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'rocket', 'U1');

      expect(mergeBranchToMain).toHaveBeenCalledWith('PassCraft', 'feature/dashboard-filter');
      expect(isPreviewMerged(CHANNEL, MESSAGE_TS)).toBe(true);
      // Should post merge success message
      expect(mockChatPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Merged'),
        })
      );
    });

    it('should NOT trigger merge without prior approval', async () => {
      const { mergeBranchToMain } = await import('../../src/preview/merge.js');

      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'rocket', 'U1');

      expect(mergeBranchToMain).not.toHaveBeenCalled();
      expect(isPreviewMerged(CHANNEL, MESSAGE_TS)).toBe(false);
    });

    it('should not process the same merge twice', async () => {
      const { mergeBranchToMain } = await import('../../src/preview/merge.js');

      // Approve first
      mockReactionsGet.mockResolvedValue({
        message: {
          reactions: [
            { name: 'white_check_mark', count: 3, users: ['U1', 'U2', 'U3'] },
          ],
        },
      });
      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'white_check_mark', 'U3');

      // First rocket
      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'rocket', 'U1');
      vi.clearAllMocks();

      // Second rocket — should be ignored
      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'rocket', 'U2');

      expect(mergeBranchToMain).not.toHaveBeenCalled();
    });

    it('should handle merge failure gracefully', async () => {
      const { mergeBranchToMain } = await import('../../src/preview/merge.js');
      vi.mocked(mergeBranchToMain).mockResolvedValueOnce(false);

      // Approve first
      mockReactionsGet.mockResolvedValue({
        message: {
          reactions: [
            { name: 'white_check_mark', count: 3, users: ['U1', 'U2', 'U3'] },
          ],
        },
      });
      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'white_check_mark', 'U3');
      vi.clearAllMocks();

      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'rocket', 'U1');

      // Should post failure message
      expect(mockChatPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Failed to merge'),
        })
      );
    });
  });

  describe('unregistered messages', () => {
    it('should ignore reactions on messages not in the registry', async () => {
      await checkPreviewApproval('C_OTHER', '9999.9999', 'white_check_mark', 'U1');

      expect(mockReactionsGet).not.toHaveBeenCalled();
    });
  });

  describe('handleExternalMerge', () => {
    it('should notify Slack when a branch is merged via GitHub', async () => {
      await handleExternalMerge('PassCraft', 'feature/dashboard-filter');

      expect(mockReactionsAdd).toHaveBeenCalledWith({
        channel: CHANNEL,
        timestamp: MESSAGE_TS,
        name: 'tada',
      });
      expect(mockChatPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Already merged to master via GitHub'),
        })
      );
    });

    it('should not double-notify if merge was already handled via Slack', async () => {
      // First: go through the full approval + merge flow
      mockReactionsGet.mockResolvedValue({
        message: {
          reactions: [
            { name: 'white_check_mark', count: 3, users: ['U1', 'U2', 'U3'] },
          ],
        },
      });
      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'white_check_mark', 'U3');
      await checkPreviewApproval(CHANNEL, MESSAGE_TS, 'rocket', 'U1');
      vi.clearAllMocks();

      // Then: GitHub webhook fires for the same merge
      await handleExternalMerge('PassCraft', 'feature/dashboard-filter');

      // Should not post again
      expect(mockChatPostMessage).not.toHaveBeenCalled();
    });

    it('should ignore unknown branches', async () => {
      await handleExternalMerge('PassCraft', 'feature/unknown-branch');

      expect(mockReactionsAdd).not.toHaveBeenCalled();
    });
  });
});
