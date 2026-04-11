import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createDraftChannel,
  checkDraftApproval,
  createAppChannels,
  handleThreadReply,
  clearDraftState,
  getAwaitingAppName,
  getAwaitingAppUrl,
  getDraftPinnedMessages,
  handleIdeaApproved,
  resetDraftClient,
} from '../../src/ideas/draft.js';

// ---------------------------------------------------------------------------
// Mocks — Slack Web API
// ---------------------------------------------------------------------------

const mockConversationsCreate = vi.fn();
const mockChatPostMessage = vi.fn();
const mockPinsAdd = vi.fn();
const mockReactionsAdd = vi.fn();
const mockReactionsGet = vi.fn();
const mockConversationsHistory = vi.fn();

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    conversations: { create: mockConversationsCreate },
    chat: { postMessage: mockChatPostMessage },
    pins: { add: mockPinsAdd },
    reactions: { add: mockReactionsAdd, get: mockReactionsGet },
  })),
}));

// Mock the voting module to prevent circular dependency issues
vi.mock('../../src/ideas/voting.js', () => ({
  getReactions: vi.fn().mockResolvedValue([]),
  getMessageText: vi.fn().mockResolvedValue('Original idea text here'),
  postThreadReply: vi.fn().mockResolvedValue('reply.ts.123'),
  postToChannel: vi.fn().mockResolvedValue('msg.ts.456'),
  APPROVAL_THRESHOLD: 3,
}));

// Import the mocked voting functions so we can control their return values
import {
  getReactions as mockGetReactions,
  postThreadReply as mockPostThreadReply,
  postToChannel as mockPostToChannel,
  getMessageText as mockGetMessageText,
} from '../../src/ideas/voting.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Draft Channel Creation', () => {
  beforeEach(() => {
    clearDraftState();
    resetDraftClient();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.TEAM_IDEAS_CHANNEL_ID = 'C_TEAM_IDEAS';
    vi.clearAllMocks();

    // Default mock: channel creation succeeds
    mockConversationsCreate.mockResolvedValue({
      channel: { id: 'C_NEW_DRAFT' },
    });
    mockChatPostMessage.mockResolvedValue({ ts: 'pinned.ts.001' });
    mockPinsAdd.mockResolvedValue({});
    mockReactionsAdd.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.TEAM_IDEAS_CHANNEL_ID;
  });

  describe('createDraftChannel', () => {
    it('should create a channel with the app name (no -draft suffix)', async () => {
      const channelId = await createDraftChannel(
        'banking',
        'An idea about banking',
        'C_TEAM_IDEAS'
      );

      expect(channelId).toBe('C_NEW_DRAFT');
      expect(mockConversationsCreate).toHaveBeenCalledWith({
        name: 'banking',
        is_private: false,
      });
    });

    it('should copy the original idea as the first message', async () => {
      await createDraftChannel(
        'banking',
        'Build a banking app',
        'C_TEAM_IDEAS'
      );

      // First call to postToChannel should be the original idea
      const firstCall = vi.mocked(mockPostToChannel).mock.calls[0];
      expect(firstCall[0]).toBe('C_NEW_DRAFT');
      expect(firstCall[1]).toContain('Original Idea');
      expect(firstCall[1]).toContain('Build a banking app');
    });

    it('should post and pin the draft instruction message', async () => {
      await createDraftChannel(
        'banking',
        'An idea',
        'C_TEAM_IDEAS'
      );

      // Second call should be the pinned instruction message
      const calls = vi.mocked(mockPostToChannel).mock.calls;
      const pinnedCall = calls[1];
      expect(pinnedCall[1]).toContain('Draft Phase');
      expect(pinnedCall[1]).toContain('REACT WITH :white_check_mark:');
    });

    it('should add a :white_check_mark: reaction to the pinned message', async () => {
      await createDraftChannel(
        'banking',
        'An idea',
        'C_TEAM_IDEAS'
      );

      expect(mockReactionsAdd).toHaveBeenCalledWith({
        channel: 'C_NEW_DRAFT',
        timestamp: 'msg.ts.456',
        name: 'white_check_mark',
      });
    });

    it('should announce in #team-ideas', async () => {
      await createDraftChannel(
        'banking',
        'An idea',
        'C_TEAM_IDEAS'
      );

      // Third postToChannel call is the announcement
      const calls = vi.mocked(mockPostToChannel).mock.calls;
      const announcementCall = calls[2];
      expect(announcementCall[0]).toBe('C_TEAM_IDEAS');
      expect(announcementCall[1]).toContain('banking');
      expect(announcementCall[1]).toContain('moved to Draft');
    });

    it('should track the pinned message for draft approval monitoring', async () => {
      await createDraftChannel(
        'banking',
        'An idea',
        'C_TEAM_IDEAS'
      );

      const tracked = getDraftPinnedMessages();
      expect(tracked.size).toBe(1);

      const entry = tracked.get('C_NEW_DRAFT:msg.ts.456');
      expect(entry).toBeDefined();
      expect(entry?.appName).toBe('banking');
    });

    it('should normalize channel name to lowercase with hyphens', async () => {
      await createDraftChannel(
        'My Cool App',
        'An idea',
        'C_TEAM_IDEAS'
      );

      expect(mockConversationsCreate).toHaveBeenCalledWith({
        name: 'my-cool-app',
        is_private: false,
      });
    });

    it('should return null and post warning when channel creation fails', async () => {
      mockConversationsCreate.mockRejectedValue(
        new Error('name_taken')
      );

      const channelId = await createDraftChannel(
        'banking',
        'An idea',
        'C_TEAM_IDEAS'
      );

      expect(channelId).toBeNull();
    });
  });

  describe('createAppChannels', () => {
    it('should create all 5 app channels', async () => {
      await createAppChannels('banking', 'banking.app', 'C_TEAM_IDEAS');

      const createCalls = mockConversationsCreate.mock.calls;
      const channelNames = createCalls.map(
        (call: [{ name: string }]) => call[0].name
      );

      expect(channelNames).toContain('banking');
      expect(channelNames).toContain('banking-active');
      expect(channelNames).toContain('banking-bugs');
      expect(channelNames).toContain('banking-preview');
      expect(channelNames).toContain('banking-deploy');
    });

    it('should pin welcome messages in each channel', async () => {
      await createAppChannels('banking', 'banking.app', 'C_TEAM_IDEAS');

      // Each of the 5 channels gets a postToChannel call for the welcome message
      // postToChannel is imported from voting.js (mocked) so we check that mock.
      // Plus one more postToChannel call for the summary in #team-ideas = 6 total.
      const postCalls = vi.mocked(mockPostToChannel).mock.calls;
      const welcomeCalls = postCalls.filter(
        (call) => call[0] !== 'C_TEAM_IDEAS'
      );
      expect(welcomeCalls.length).toBe(5);

      // Each channel also gets pinned via the local pinMessage -> WebClient.pins.add
      expect(mockPinsAdd.mock.calls.length).toBe(5);
    });

    it('should post a summary in #team-ideas', async () => {
      await createAppChannels('banking', 'banking.app', 'C_TEAM_IDEAS');

      const announceCalls = vi.mocked(mockPostToChannel).mock.calls;
      const summaryCall = announceCalls[announceCalls.length - 1];
      expect(summaryCall[0]).toBe('C_TEAM_IDEAS');
      expect(summaryCall[1]).toContain('banking');
      expect(summaryCall[1]).toContain('development');
    });

    it('should include manual setup TODO items in the summary', async () => {
      await createAppChannels('banking', 'banking.app', 'C_TEAM_IDEAS');

      const announceCalls = vi.mocked(mockPostToChannel).mock.calls;
      const summaryCall = announceCalls[announceCalls.length - 1];
      expect(summaryCall[1]).toContain('Manual setup needed');
      expect(summaryCall[1]).toContain('GitHub repo');
      expect(summaryCall[1]).toContain('Coolify');
    });
  });
});

describe('Draft Approval', () => {
  const DRAFT_CHANNEL = 'C_DRAFT_BANKING';
  const PINNED_TS = 'pinned.ts.001';

  beforeEach(() => {
    clearDraftState();
    resetDraftClient();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.TEAM_IDEAS_CHANNEL_ID = 'C_TEAM_IDEAS';
    vi.clearAllMocks();

    // Register a tracked draft pinned message
    getDraftPinnedMessages().set(`${DRAFT_CHANNEL}:${PINNED_TS}`, {
      appName: 'banking',
      draftChannel: DRAFT_CHANNEL,
    });
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.TEAM_IDEAS_CHANNEL_ID;
  });

  it('should ask for app URL when 3 users approve the draft', async () => {
    vi.mocked(mockGetReactions).mockResolvedValue([
      { name: 'white_check_mark', count: 3, users: ['U1', 'U2', 'U3'] },
    ]);

    await checkDraftApproval(DRAFT_CHANNEL, PINNED_TS);

    expect(mockPostThreadReply).toHaveBeenCalledWith(
      DRAFT_CHANNEL,
      PINNED_TS,
      expect.stringContaining('Design approved')
    );
  });

  it('should not trigger when fewer than 3 users approve', async () => {
    vi.mocked(mockGetReactions).mockResolvedValue([
      { name: 'white_check_mark', count: 2, users: ['U1', 'U2'] },
    ]);

    await checkDraftApproval(DRAFT_CHANNEL, PINNED_TS);

    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });

  it('should ignore reactions on non-tracked messages', async () => {
    await checkDraftApproval('C_RANDOM', '9999.9999');

    expect(mockGetReactions).not.toHaveBeenCalled();
  });

  it('should track the awaiting URL state after approval', async () => {
    vi.mocked(mockGetReactions).mockResolvedValue([
      { name: 'white_check_mark', count: 3, users: ['U1', 'U2', 'U3'] },
    ]);

    await checkDraftApproval(DRAFT_CHANNEL, PINNED_TS);

    const urlState = getAwaitingAppUrl();
    const entry = urlState.get(`${DRAFT_CHANNEL}:${PINNED_TS}`);
    expect(entry).toBeDefined();
    expect(entry?.appName).toBe('banking');
  });

  it('should prevent duplicate draft approval processing', async () => {
    vi.mocked(mockGetReactions).mockResolvedValue([
      { name: 'white_check_mark', count: 3, users: ['U1', 'U2', 'U3'] },
    ]);

    await checkDraftApproval(DRAFT_CHANNEL, PINNED_TS);
    await checkDraftApproval(DRAFT_CHANNEL, PINNED_TS);

    expect(mockPostThreadReply).toHaveBeenCalledTimes(1);
  });
});

describe('Thread Reply Handler', () => {
  beforeEach(() => {
    clearDraftState();
    resetDraftClient();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.TEAM_IDEAS_CHANNEL_ID = 'C_TEAM_IDEAS';
    vi.clearAllMocks();

    mockConversationsCreate.mockResolvedValue({
      channel: { id: 'C_NEW_CHANNEL' },
    });
    mockChatPostMessage.mockResolvedValue({ ts: 'msg.ts.789' });
    mockPinsAdd.mockResolvedValue({});
    mockReactionsAdd.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.TEAM_IDEAS_CHANNEL_ID;
  });

  it('should create a draft channel when app name is received', async () => {
    // Register awaiting state
    getAwaitingAppName().set('C_TEAM_IDEAS:1234.5678', {
      ideasChannel: 'C_TEAM_IDEAS',
      ideaMessageTs: '1234.5678',
    });

    await handleThreadReply(
      'C_TEAM_IDEAS',
      '1234.5678',
      'banking',
      'U_NABIL'
    );

    // Should have tried to create the channel
    expect(mockConversationsCreate).toHaveBeenCalledWith({
      name: 'banking',
      is_private: false,
    });
  });

  it('should reject app names that are too short', async () => {
    getAwaitingAppName().set('C_TEAM_IDEAS:1234.5678', {
      ideasChannel: 'C_TEAM_IDEAS',
      ideaMessageTs: '1234.5678',
    });

    await handleThreadReply(
      'C_TEAM_IDEAS',
      '1234.5678',
      'a',
      'U_NABIL'
    );

    // Should NOT create a channel
    expect(mockConversationsCreate).not.toHaveBeenCalled();

    // Should re-register the awaiting state
    expect(getAwaitingAppName().has('C_TEAM_IDEAS:1234.5678')).toBe(true);
  });

  it('should ignore thread replies in threads we are not tracking', async () => {
    await handleThreadReply(
      'C_RANDOM',
      '9999.9999',
      'some text',
      'U_RANDOM'
    );

    expect(mockConversationsCreate).not.toHaveBeenCalled();
  });

  it('should ignore empty text', async () => {
    getAwaitingAppName().set('C_TEAM_IDEAS:1234.5678', {
      ideasChannel: 'C_TEAM_IDEAS',
      ideaMessageTs: '1234.5678',
    });

    await handleThreadReply(
      'C_TEAM_IDEAS',
      '1234.5678',
      '   ',
      'U_NABIL'
    );

    expect(mockConversationsCreate).not.toHaveBeenCalled();
  });
});

describe('handleIdeaApproved', () => {
  beforeEach(() => {
    clearDraftState();
    vi.clearAllMocks();
  });

  it('should post a thread reply asking for the app name', async () => {
    await handleIdeaApproved('C_TEAM_IDEAS', '1234.5678');

    expect(mockPostThreadReply).toHaveBeenCalledWith(
      'C_TEAM_IDEAS',
      '1234.5678',
      expect.stringContaining('All 3 team members approved')
    );
  });

  it('should register the thread for awaiting app name', async () => {
    await handleIdeaApproved('C_TEAM_IDEAS', '1234.5678');

    const state = getAwaitingAppName();
    const entry = state.get('C_TEAM_IDEAS:1234.5678');
    expect(entry).toBeDefined();
    expect(entry?.ideasChannel).toBe('C_TEAM_IDEAS');
    expect(entry?.ideaMessageTs).toBe('1234.5678');
  });
});
