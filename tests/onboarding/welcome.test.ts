import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postWelcomeMessage, postAppWelcomeMessage } from '../../src/onboarding/welcome.js';

vi.mock('../../src/onboarding/dm.js', () => ({
  postChannelMessage: vi.fn().mockResolvedValue('1234567890.123456'),
  pinChannelMessage: vi.fn().mockResolvedValue(undefined),
}));

describe('Welcome Messages', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, TEAM_GENERAL_CHANNEL_ID: 'C_TEAM_GENERAL' };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  describe('postWelcomeMessage', () => {
    it('should post and pin the team welcome message', async () => {
      const { postChannelMessage, pinChannelMessage } =
        await import('../../src/onboarding/dm.js');

      await postWelcomeMessage();

      expect(postChannelMessage).toHaveBeenCalledWith(
        'C_TEAM_GENERAL',
        expect.stringContaining('Welcome to JCN Apps')
      );
      expect(pinChannelMessage).toHaveBeenCalledWith(
        'C_TEAM_GENERAL',
        '1234567890.123456'
      );
    });

    it('should skip when TEAM_GENERAL_CHANNEL_ID is not set', async () => {
      delete process.env.TEAM_GENERAL_CHANNEL_ID;
      const { postChannelMessage } = await import('../../src/onboarding/dm.js');

      await postWelcomeMessage();

      expect(postChannelMessage).not.toHaveBeenCalled();
    });
  });

  describe('postAppWelcomeMessage', () => {
    it('should post and pin the app welcome message', async () => {
      const { postChannelMessage, pinChannelMessage } =
        await import('../../src/onboarding/dm.js');

      await postAppWelcomeMessage('C_PASSCRAFT_MAIN', 'PassCraft');

      expect(postChannelMessage).toHaveBeenCalledWith(
        'C_PASSCRAFT_MAIN',
        expect.stringContaining('PassCraft')
      );
      expect(postChannelMessage).toHaveBeenCalledWith(
        'C_PASSCRAFT_MAIN',
        expect.stringContaining('React with :white_check_mark:')
      );
      expect(pinChannelMessage).toHaveBeenCalledWith(
        'C_PASSCRAFT_MAIN',
        '1234567890.123456'
      );
    });

    it('should mention that team registration is required', async () => {
      const { postChannelMessage } = await import('../../src/onboarding/dm.js');

      await postAppWelcomeMessage('C_PASSCRAFT_MAIN', 'PassCraft');

      expect(postChannelMessage).toHaveBeenCalledWith(
        'C_PASSCRAFT_MAIN',
        expect.stringContaining('registered in #team-general first')
      );
    });

    it('should skip when no channel ID is provided', async () => {
      const { postChannelMessage } = await import('../../src/onboarding/dm.js');

      await postAppWelcomeMessage('', 'PassCraft');

      expect(postChannelMessage).not.toHaveBeenCalled();
    });
  });
});
