import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startOnboarding,
  handleDMReply,
  provisionUser,
  getSession,
  hasActiveSession,
  clearSession,
  getActiveSessionCount,
} from '../../src/onboarding/flow.js';
import type { OnboardingState } from '../../src/onboarding/flow.js';

// Mock the DM module
vi.mock('../../src/onboarding/dm.js', () => ({
  openDM: vi.fn().mockResolvedValue('D_TEST_DM_CHANNEL'),
  sendDM: vi.fn().mockResolvedValue(undefined),
  postChannelMessage: vi.fn().mockResolvedValue('1234567890.123456'),
  pinChannelMessage: vi.fn().mockResolvedValue(undefined),
}));

// Mock the provision module
vi.mock('../../src/onboarding/provision.js', () => ({
  inviteToGitHub: vi.fn().mockResolvedValue(true),
  inviteToCoolify: vi.fn().mockResolvedValue(true),
  createPreviewDNS: vi.fn().mockResolvedValue(true),
  saveTeamMember: vi.fn().mockResolvedValue(undefined),
}));

describe('Onboarding Flow', () => {
  const testUserId = 'U_TEST_USER';

  beforeEach(() => {
    clearSession(testUserId);
    process.env.TEAM_GENERAL_CHANNEL_ID = 'C_TEAM_GENERAL';
  });

  afterEach(() => {
    clearSession(testUserId);
    vi.restoreAllMocks();
  });

  describe('startOnboarding', () => {
    it('should create a session and send the first DM', async () => {
      const { openDM, sendDM } = await import('../../src/onboarding/dm.js');

      await startOnboarding(testUserId);

      expect(openDM).toHaveBeenCalledWith(testUserId);
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('first name')
      );

      const session = getSession(testUserId);
      expect(session).toBeDefined();
      expect(session!.step).toBe('awaiting_name');
      expect(session!.dmChannelId).toBe('D_TEST_DM_CHANNEL');
    });

    it('should not create a duplicate session if one already exists', async () => {
      const { openDM } = await import('../../src/onboarding/dm.js');

      await startOnboarding(testUserId);
      await startOnboarding(testUserId);

      // openDM should only be called once
      expect(openDM).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleDMReply', () => {
    it('should advance from awaiting_name to awaiting_github', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await startOnboarding(testUserId);
      await handleDMReply(testUserId, 'Chris');

      const session = getSession(testUserId);
      expect(session!.step).toBe('awaiting_github');
      expect(session!.name).toBe('Chris');
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('GitHub username')
      );
    });

    it('should advance from awaiting_github to awaiting_email', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await startOnboarding(testUserId);
      await handleDMReply(testUserId, 'Chris');
      await handleDMReply(testUserId, 'chris-dev');

      const session = getSession(testUserId);
      expect(session!.step).toBe('awaiting_email');
      expect(session!.githubUsername).toBe('chris-dev');
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('email')
      );
    });

    it('should trigger provisioning after email is provided', async () => {
      const { inviteToGitHub, inviteToCoolify, createPreviewDNS, saveTeamMember } =
        await import('../../src/onboarding/provision.js');

      await startOnboarding(testUserId);
      await handleDMReply(testUserId, 'Chris');
      await handleDMReply(testUserId, 'chris-dev');
      await handleDMReply(testUserId, 'chris@example.com');

      expect(inviteToGitHub).toHaveBeenCalledWith('chris-dev');
      expect(inviteToCoolify).toHaveBeenCalledWith('chris@example.com');
      expect(createPreviewDNS).toHaveBeenCalledWith('chris');
      expect(saveTeamMember).toHaveBeenCalledWith('Chris', 'chris-dev', testUserId);
    });

    it('should reject invalid GitHub usernames', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await startOnboarding(testUserId);
      await handleDMReply(testUserId, 'Chris');
      await handleDMReply(testUserId, 'invalid user name with spaces');

      const session = getSession(testUserId);
      // Should stay on the same step
      expect(session!.step).toBe('awaiting_github');
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('valid GitHub username')
      );
    });

    it('should reject invalid email addresses', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await startOnboarding(testUserId);
      await handleDMReply(testUserId, 'Chris');
      await handleDMReply(testUserId, 'chris-dev');
      await handleDMReply(testUserId, 'not-an-email');

      const session = getSession(testUserId);
      expect(session!.step).toBe('awaiting_email');
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('valid email')
      );
    });

    it('should ignore messages from users without an active session', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');
      vi.mocked(sendDM).mockClear();

      await handleDMReply('U_UNKNOWN_USER', 'Hello');

      // sendDM should not be called for users not in onboarding
      expect(sendDM).not.toHaveBeenCalled();
    });

    it('should ignore empty messages', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await startOnboarding(testUserId);
      vi.mocked(sendDM).mockClear();

      await handleDMReply(testUserId, '   ');

      // No reply should be sent for empty input
      expect(sendDM).not.toHaveBeenCalled();
    });

    it('should not process messages during provisioning step', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await startOnboarding(testUserId);
      await handleDMReply(testUserId, 'Chris');
      await handleDMReply(testUserId, 'chris-dev');
      await handleDMReply(testUserId, 'chris@example.com');
      vi.mocked(sendDM).mockClear();

      // Try to send another message while processing
      await handleDMReply(testUserId, 'another message');
      expect(sendDM).not.toHaveBeenCalled();
    });
  });

  describe('provisionUser', () => {
    it('should call all provisioning functions', async () => {
      const { inviteToGitHub, inviteToCoolify, createPreviewDNS, saveTeamMember } =
        await import('../../src/onboarding/provision.js');
      const { sendDM, postChannelMessage } = await import('../../src/onboarding/dm.js');

      const state: OnboardingState = {
        userId: testUserId,
        step: 'processing',
        name: 'Chris',
        githubUsername: 'chris-dev',
        email: 'chris@example.com',
        dmChannelId: 'D_TEST_DM_CHANNEL',
      };

      await provisionUser(state);

      expect(inviteToGitHub).toHaveBeenCalledWith('chris-dev');
      expect(inviteToCoolify).toHaveBeenCalledWith('chris@example.com');
      expect(createPreviewDNS).toHaveBeenCalledWith('chris');
      expect(saveTeamMember).toHaveBeenCalledWith('Chris', 'chris-dev', testUserId);
      expect(postChannelMessage).toHaveBeenCalledWith(
        'C_TEAM_GENERAL',
        expect.stringContaining('Chris just joined')
      );
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('all set')
      );
      expect(state.step).toBe('complete');
    });

    it('should handle partial failures gracefully', async () => {
      const { inviteToGitHub } = await import('../../src/onboarding/provision.js');
      const { sendDM } = await import('../../src/onboarding/dm.js');
      vi.mocked(inviteToGitHub).mockResolvedValueOnce(false);

      const state: OnboardingState = {
        userId: testUserId,
        step: 'processing',
        name: 'Chris',
        githubUsername: 'chris-dev',
        email: 'chris@example.com',
        dmChannelId: 'D_TEST_DM_CHANNEL',
      };

      await provisionUser(state);

      // Should still complete and show warning for failed step
      expect(state.step).toBe('complete');
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('failed')
      );
    });
  });

  describe('Session Management', () => {
    it('should track active sessions', async () => {
      expect(hasActiveSession(testUserId)).toBe(false);
      await startOnboarding(testUserId);
      expect(hasActiveSession(testUserId)).toBe(true);
    });

    it('should clear sessions', async () => {
      await startOnboarding(testUserId);
      clearSession(testUserId);
      expect(hasActiveSession(testUserId)).toBe(false);
      expect(getSession(testUserId)).toBeUndefined();
    });

    it('should count active sessions', async () => {
      const initialCount = getActiveSessionCount();
      await startOnboarding(testUserId);
      expect(getActiveSessionCount()).toBe(initialCount + 1);
      clearSession(testUserId);
      expect(getActiveSessionCount()).toBe(initialCount);
    });
  });
});
