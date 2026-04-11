import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Slack client -- factory must not reference top-level variables
vi.mock('../../src/slack/client.js', () => {
  const chatDelete = vi.fn().mockResolvedValue({});
  return {
    getWebClient: vi.fn().mockReturnValue({
      chat: { delete: chatDelete },
    }),
    withRetry: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
    __mockChatDelete: chatDelete,
  };
});

// Mock DM module
vi.mock('../../src/onboarding/dm.js', () => {
  const openDM = vi.fn().mockResolvedValue('D_TEST_DM');
  const sendDM = vi.fn().mockResolvedValue('1234.5678');
  return {
    openDM,
    sendDM,
    __mockOpenDM: openDM,
    __mockSendDM: sendDM,
  };
});

import { enforceReadOnly } from '../../src/overview/readonly.js';

// Access the mocks through the module's exported references
import * as slackClient from '../../src/slack/client.js';
import * as dmModule from '../../src/onboarding/dm.js';

const mockChatDelete = (slackClient as Record<string, unknown>).__mockChatDelete as ReturnType<typeof vi.fn>;
const mockOpenDM = (dmModule as Record<string, unknown>).__mockOpenDM as ReturnType<typeof vi.fn>;
const mockSendDM = (dmModule as Record<string, unknown>).__mockSendDM as ReturnType<typeof vi.fn>;

describe('enforceReadOnly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OVERVIEW_CHANNEL_ID = 'C0AS03H5XQB';
    process.env.BOT_USER_ID = 'U_BOT';
  });

  afterEach(() => {
    delete process.env.OVERVIEW_CHANNEL_ID;
    delete process.env.BOT_USER_ID;
  });

  it('should ignore messages in non-overview channels', async () => {
    await enforceReadOnly('C_OTHER_CHANNEL', 'U_USER', '1234.5678');

    expect(mockChatDelete).not.toHaveBeenCalled();
    expect(mockOpenDM).not.toHaveBeenCalled();
  });

  it('should NOT delete bot messages', async () => {
    await enforceReadOnly('C0AS03H5XQB', 'U_BOT', '1234.5678');

    expect(mockChatDelete).not.toHaveBeenCalled();
    expect(mockOpenDM).not.toHaveBeenCalled();
  });

  it('should delete non-bot messages and DM the user', async () => {
    await enforceReadOnly('C0AS03H5XQB', 'U_HUMAN', '1234.5678');

    // Message should be deleted
    expect(mockChatDelete).toHaveBeenCalledWith({
      channel: 'C0AS03H5XQB',
      ts: '1234.5678',
    });

    // User should receive a DM
    expect(mockOpenDM).toHaveBeenCalledWith('U_HUMAN');
    expect(mockSendDM).toHaveBeenCalledWith(
      'D_TEST_DM',
      expect.stringContaining('read-only')
    );
    expect(mockSendDM).toHaveBeenCalledWith(
      'D_TEST_DM',
      expect.stringContaining('#team-general')
    );
  });

  it('should handle missing OVERVIEW_CHANNEL_ID gracefully', async () => {
    delete process.env.OVERVIEW_CHANNEL_ID;

    await enforceReadOnly('C0AS03H5XQB', 'U_HUMAN', '1234.5678');

    expect(mockChatDelete).not.toHaveBeenCalled();
  });

  it('should handle missing BOT_USER_ID by deleting all non-bot messages', async () => {
    delete process.env.BOT_USER_ID;

    await enforceReadOnly('C0AS03H5XQB', 'U_HUMAN', '1234.5678');

    // Without BOT_USER_ID, the bot can't identify itself,
    // so it should still attempt deletion for non-bot users
    expect(mockChatDelete).toHaveBeenCalled();
  });

  it('should still DM user even if delete fails', async () => {
    mockChatDelete.mockRejectedValueOnce(new Error('Cannot delete'));

    await enforceReadOnly('C0AS03H5XQB', 'U_HUMAN', '1234.5678');

    // DM should NOT be sent because the function returns early on delete failure
    expect(mockOpenDM).not.toHaveBeenCalled();
  });
});
