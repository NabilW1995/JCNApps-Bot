import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkIdeaApproval,
  clearProcessedApprovals,
  isIdeaProcessed,
  setOnIdeaApproved,
  resetVotingClient,
  APPROVAL_THRESHOLD,
} from '../../src/ideas/voting.js';

// ---------------------------------------------------------------------------
// Mocks — Slack Web API
// ---------------------------------------------------------------------------

const mockReactionsGet = vi.fn();
const mockConversationsHistory = vi.fn();
const mockChatPostMessage = vi.fn();

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    reactions: { get: mockReactionsGet },
    conversations: { history: mockConversationsHistory },
    chat: { postMessage: mockChatPostMessage },
  })),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Idea Voting', () => {
  const CHANNEL = 'C_TEAM_IDEAS';
  const MESSAGE_TS = '1234567890.123456';

  beforeEach(() => {
    clearProcessedApprovals();
    resetVotingClient();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.TEAM_IDEAS_CHANNEL_ID = CHANNEL;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.TEAM_IDEAS_CHANNEL_ID;
  });

  it('should not trigger approval when fewer than 3 users react', async () => {
    const onApproved = vi.fn();
    setOnIdeaApproved(onApproved);

    mockReactionsGet.mockResolvedValue({
      message: {
        reactions: [
          { name: '+1', count: 2, users: ['U1', 'U2'] },
        ],
      },
    });

    await checkIdeaApproval(CHANNEL, MESSAGE_TS, '+1', 'U2');

    expect(onApproved).not.toHaveBeenCalled();
    expect(isIdeaProcessed(CHANNEL, MESSAGE_TS)).toBe(false);
  });

  it('should trigger approval when 3 unique users react with +1', async () => {
    const onApproved = vi.fn().mockResolvedValue(undefined);
    setOnIdeaApproved(onApproved);

    mockReactionsGet.mockResolvedValue({
      message: {
        reactions: [
          { name: '+1', count: 3, users: ['U1', 'U2', 'U3'] },
        ],
      },
    });

    await checkIdeaApproval(CHANNEL, MESSAGE_TS, '+1', 'U3');

    expect(onApproved).toHaveBeenCalledWith(CHANNEL, MESSAGE_TS);
    expect(isIdeaProcessed(CHANNEL, MESSAGE_TS)).toBe(true);
  });

  it('should trigger approval when thumbsup reaction is used', async () => {
    const onApproved = vi.fn().mockResolvedValue(undefined);
    setOnIdeaApproved(onApproved);

    mockReactionsGet.mockResolvedValue({
      message: {
        reactions: [
          { name: 'thumbsup', count: 3, users: ['U1', 'U2', 'U3'] },
        ],
      },
    });

    await checkIdeaApproval(CHANNEL, MESSAGE_TS, 'thumbsup', 'U3');

    expect(onApproved).toHaveBeenCalledWith(CHANNEL, MESSAGE_TS);
  });

  it('should prevent duplicate processing of the same message', async () => {
    const onApproved = vi.fn().mockResolvedValue(undefined);
    setOnIdeaApproved(onApproved);

    mockReactionsGet.mockResolvedValue({
      message: {
        reactions: [
          { name: '+1', count: 3, users: ['U1', 'U2', 'U3'] },
        ],
      },
    });

    // First call should trigger
    await checkIdeaApproval(CHANNEL, MESSAGE_TS, '+1', 'U3');
    expect(onApproved).toHaveBeenCalledTimes(1);

    // Second call should be skipped
    await checkIdeaApproval(CHANNEL, MESSAGE_TS, '+1', 'U4');
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it('should only trigger for +1 or thumbsup reactions', async () => {
    const onApproved = vi.fn();
    setOnIdeaApproved(onApproved);

    // heart reaction should be ignored
    await checkIdeaApproval(CHANNEL, MESSAGE_TS, 'heart', 'U1');
    expect(onApproved).not.toHaveBeenCalled();
    expect(mockReactionsGet).not.toHaveBeenCalled();

    // tada reaction should be ignored
    await checkIdeaApproval(CHANNEL, MESSAGE_TS, 'tada', 'U1');
    expect(onApproved).not.toHaveBeenCalled();
    expect(mockReactionsGet).not.toHaveBeenCalled();
  });

  it('should only monitor the #team-ideas channel', async () => {
    const onApproved = vi.fn();
    setOnIdeaApproved(onApproved);

    // Reaction in a different channel should be ignored
    await checkIdeaApproval('C_OTHER_CHANNEL', MESSAGE_TS, '+1', 'U1');
    expect(onApproved).not.toHaveBeenCalled();
    expect(mockReactionsGet).not.toHaveBeenCalled();
  });

  it('should warn when TEAM_IDEAS_CHANNEL_ID is not configured', async () => {
    delete process.env.TEAM_IDEAS_CHANNEL_ID;
    const onApproved = vi.fn();
    setOnIdeaApproved(onApproved);

    await checkIdeaApproval('C_ANY', MESSAGE_TS, '+1', 'U1');
    expect(onApproved).not.toHaveBeenCalled();
  });

  it('should not trigger when reaction count meets threshold but unique users do not', async () => {
    const onApproved = vi.fn();
    setOnIdeaApproved(onApproved);

    // count says 3 but only 2 unique users in the array
    mockReactionsGet.mockResolvedValue({
      message: {
        reactions: [
          { name: '+1', count: 3, users: ['U1', 'U2'] },
        ],
      },
    });

    await checkIdeaApproval(CHANNEL, MESSAGE_TS, '+1', 'U2');
    expect(onApproved).not.toHaveBeenCalled();
  });

  it('should export the approval threshold constant', () => {
    expect(APPROVAL_THRESHOLD).toBe(3);
  });
});
