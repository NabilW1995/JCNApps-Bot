import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startTeamOnboarding,
  startAppOnboarding,
  handleDMReply,
  processTeamOnboarding,
  processAppOnboarding,
  getSession,
  hasActiveSession,
  clearSession,
  getActiveSessionCount,
} from '../../src/onboarding/flow.js';
import type { OnboardingState } from '../../src/onboarding/flow.js';

// Mock the DM module
vi.mock('../../src/onboarding/dm.js', () => ({
  openDM: vi.fn().mockResolvedValue('D_TEST_DM_CHANNEL'),
  sendDM: vi.fn().mockResolvedValue('1234567890.123456'),
  startNewDMThread: vi.fn(),
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

// Mock the DB modules
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/db/queries.js', () => ({
  getTeamMemberBySlackId: vi.fn().mockResolvedValue(null),
}));

describe('Onboarding Flow', () => {
  const testUserId = 'U_TEST_USER';

  beforeEach(() => {
    clearSession(testUserId);
    process.env.TEAM_GENERAL_CHANNEL_ID = 'C_TEAM_GENERAL';
  });

  afterEach(() => {
    clearSession(testUserId);
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Flow 1: Team Registration
  // -------------------------------------------------------------------------

  describe('startTeamOnboarding', () => {
    it('should create a session and send the first DM', async () => {
      const { openDM, sendDM } = await import('../../src/onboarding/dm.js');

      await startTeamOnboarding(testUserId);

      expect(openDM).toHaveBeenCalledWith(testUserId);
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('first name')
      );

      const session = getSession(testUserId);
      expect(session).toBeDefined();
      expect(session!.flow).toBe('team');
      expect(session!.step).toBe('awaiting_name');
      expect(session!.dmChannelId).toBe('D_TEST_DM_CHANNEL');
    });

    it('should not create a duplicate session if one already exists', async () => {
      const { openDM } = await import('../../src/onboarding/dm.js');

      await startTeamOnboarding(testUserId);
      await startTeamOnboarding(testUserId);

      expect(openDM).toHaveBeenCalledTimes(1);
    });
  });

  describe('Team Flow - handleDMReply', () => {
    it('should advance from awaiting_name to awaiting_github', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await startTeamOnboarding(testUserId);
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

      await startTeamOnboarding(testUserId);
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

    it('should trigger team registration after email is provided', async () => {
      const { saveTeamMember } = await import('../../src/onboarding/provision.js');
      const { postChannelMessage, sendDM } = await import('../../src/onboarding/dm.js');

      await startTeamOnboarding(testUserId);
      await handleDMReply(testUserId, 'Chris');
      await handleDMReply(testUserId, 'chris-dev');
      await handleDMReply(testUserId, 'chris@example.com');

      // Team flow should save to DB with email
      expect(saveTeamMember).toHaveBeenCalledWith(
        'Chris',
        'chris-dev',
        testUserId,
        'chris@example.com'
      );

      // Should NOT call GitHub/Coolify/DNS -- those happen in app flow
      const { inviteToGitHub } = await import('../../src/onboarding/provision.js');
      expect(inviteToGitHub).not.toHaveBeenCalled();

      // Should post announcement in #team-general
      expect(postChannelMessage).toHaveBeenCalledWith(
        'C_TEAM_GENERAL',
        expect.stringContaining('Chris')
      );

      // Should tell user to go to an app channel next
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('Next step')
      );
    });

    it('should reject invalid GitHub usernames', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await startTeamOnboarding(testUserId);
      await handleDMReply(testUserId, 'Chris');
      await handleDMReply(testUserId, 'invalid user name with spaces');

      const session = getSession(testUserId);
      expect(session!.step).toBe('awaiting_github');
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('valid GitHub username')
      );
    });

    it('should reject invalid email addresses', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await startTeamOnboarding(testUserId);
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

      expect(sendDM).not.toHaveBeenCalled();
    });

    it('should ignore empty messages', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await startTeamOnboarding(testUserId);
      vi.mocked(sendDM).mockClear();

      await handleDMReply(testUserId, '   ');

      expect(sendDM).not.toHaveBeenCalled();
    });

    it('should not process messages during processing step', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await startTeamOnboarding(testUserId);
      await handleDMReply(testUserId, 'Chris');
      await handleDMReply(testUserId, 'chris-dev');
      await handleDMReply(testUserId, 'chris@example.com');
      vi.mocked(sendDM).mockClear();

      await handleDMReply(testUserId, 'another message');
      expect(sendDM).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Flow 2: App Provisioning
  // -------------------------------------------------------------------------

  describe('startAppOnboarding', () => {
    it('should block unregistered users and tell them to register first', async () => {
      const { sendDM, openDM } = await import('../../src/onboarding/dm.js');
      const { getTeamMemberBySlackId } = await import('../../src/db/queries.js');
      vi.mocked(getTeamMemberBySlackId).mockResolvedValueOnce(null);

      await startAppOnboarding(testUserId, 'passcraft', 'C_PASSCRAFT');

      expect(openDM).toHaveBeenCalledWith(testUserId);
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('register first')
      );

      // Should NOT create a session
      expect(hasActiveSession(testUserId)).toBe(false);
    });

    it('should start confirmation flow for registered users', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');
      const { getTeamMemberBySlackId } = await import('../../src/db/queries.js');
      vi.mocked(getTeamMemberBySlackId).mockResolvedValueOnce({
        id: 1,
        name: 'Chris',
        githubUsername: 'chris-dev',
        slackUserId: testUserId,
        email: 'chris@example.com',
        currentRepo: null,
        status: 'idle',
        statusSince: null,
      });

      await startAppOnboarding(testUserId, 'passcraft', 'C_PASSCRAFT');

      const session = getSession(testUserId);
      expect(session).toBeDefined();
      expect(session!.flow).toBe('app');
      expect(session!.step).toBe('awaiting_confirm');
      expect(session!.appRepoName).toBe('passcraft');
      expect(session!.appChannelId).toBe('C_PASSCRAFT');

      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('passcraft')
      );
    });

    it('should not create duplicate sessions', async () => {
      const { openDM } = await import('../../src/onboarding/dm.js');
      const { getTeamMemberBySlackId } = await import('../../src/db/queries.js');
      vi.mocked(getTeamMemberBySlackId).mockResolvedValue({
        id: 1,
        name: 'Chris',
        githubUsername: 'chris-dev',
        slackUserId: testUserId,
        email: 'chris@example.com',
        currentRepo: null,
        status: 'idle',
        statusSince: null,
      });

      await startAppOnboarding(testUserId, 'passcraft', 'C_PASSCRAFT');
      await startAppOnboarding(testUserId, 'passcraft', 'C_PASSCRAFT');

      expect(openDM).toHaveBeenCalledTimes(1);
    });
  });

  describe('App Flow - handleDMReply confirmation', () => {
    async function setupAppSession(): Promise<void> {
      const { getTeamMemberBySlackId } = await import('../../src/db/queries.js');
      vi.mocked(getTeamMemberBySlackId).mockResolvedValueOnce({
        id: 1,
        name: 'Chris',
        githubUsername: 'chris-dev',
        slackUserId: testUserId,
        email: 'chris@example.com',
        currentRepo: null,
        status: 'idle',
        statusSince: null,
      });
      await startAppOnboarding(testUserId, 'passcraft', 'C_PASSCRAFT');
    }

    it('should provision on YES confirmation', async () => {
      await setupAppSession();

      const { inviteToGitHub, inviteToCoolify, createPreviewDNS } =
        await import('../../src/onboarding/provision.js');
      const { sendDM } = await import('../../src/onboarding/dm.js');

      await handleDMReply(testUserId, 'yes');

      expect(inviteToGitHub).toHaveBeenCalledWith('chris-dev');
      expect(inviteToCoolify).toHaveBeenCalledWith('chris@example.com');
      expect(createPreviewDNS).toHaveBeenCalledWith('chris');

      // Should send completion message
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('All set for passcraft')
      );
    });

    it('should accept "y" as confirmation', async () => {
      await setupAppSession();

      const { inviteToGitHub } = await import('../../src/onboarding/provision.js');

      await handleDMReply(testUserId, 'y');

      expect(inviteToGitHub).toHaveBeenCalled();
    });

    it('should restart details on NO confirmation', async () => {
      await setupAppSession();

      const { sendDM } = await import('../../src/onboarding/dm.js');

      await handleDMReply(testUserId, 'no');

      const session = getSession(testUserId);
      expect(session!.step).toBe('awaiting_name');
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('first name')
      );
    });

    it('should post announcement in app channel after provisioning', async () => {
      await setupAppSession();

      const { postChannelMessage } = await import('../../src/onboarding/dm.js');

      await handleDMReply(testUserId, 'yes');

      expect(postChannelMessage).toHaveBeenCalledWith(
        'C_PASSCRAFT',
        expect.stringContaining('Chris')
      );
    });
  });

  // -------------------------------------------------------------------------
  // processTeamOnboarding
  // -------------------------------------------------------------------------

  describe('processTeamOnboarding', () => {
    it('should save to DB and post announcement', async () => {
      const { saveTeamMember } = await import('../../src/onboarding/provision.js');
      const { sendDM, postChannelMessage } = await import('../../src/onboarding/dm.js');

      const state: OnboardingState = {
        userId: testUserId,
        flow: 'team',
        step: 'processing',
        name: 'Chris',
        githubUsername: 'chris-dev',
        email: 'chris@example.com',
        dmChannelId: 'D_TEST_DM_CHANNEL',
      };

      await processTeamOnboarding(state);

      expect(saveTeamMember).toHaveBeenCalledWith(
        'Chris',
        'chris-dev',
        testUserId,
        'chris@example.com'
      );
      expect(postChannelMessage).toHaveBeenCalledWith(
        'C_TEAM_GENERAL',
        expect.stringContaining('Chris')
      );
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('Registration saved')
      );
      expect(state.step).toBe('complete');
    });

    it('should handle DB save failure gracefully', async () => {
      const { saveTeamMember } = await import('../../src/onboarding/provision.js');
      const { sendDM } = await import('../../src/onboarding/dm.js');
      vi.mocked(saveTeamMember).mockRejectedValueOnce(new Error('DB error'));

      const state: OnboardingState = {
        userId: testUserId,
        flow: 'team',
        step: 'processing',
        name: 'Chris',
        githubUsername: 'chris-dev',
        email: 'chris@example.com',
        dmChannelId: 'D_TEST_DM_CHANNEL',
      };

      await processTeamOnboarding(state);

      expect(state.step).toBe('complete');
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('could not be saved')
      );
    });
  });

  // -------------------------------------------------------------------------
  // processAppOnboarding
  // -------------------------------------------------------------------------

  describe('processAppOnboarding', () => {
    it('should call all provisioning functions', async () => {
      const { inviteToGitHub, inviteToCoolify, createPreviewDNS } =
        await import('../../src/onboarding/provision.js');
      const { sendDM, postChannelMessage } = await import('../../src/onboarding/dm.js');

      const state: OnboardingState = {
        userId: testUserId,
        flow: 'app',
        step: 'processing',
        name: 'Chris',
        githubUsername: 'chris-dev',
        email: 'chris@example.com',
        dmChannelId: 'D_TEST_DM_CHANNEL',
        appRepoName: 'passcraft',
        appChannelId: 'C_PASSCRAFT',
      };

      await processAppOnboarding(state);

      expect(inviteToGitHub).toHaveBeenCalledWith('chris-dev');
      expect(inviteToCoolify).toHaveBeenCalledWith('chris@example.com');
      expect(createPreviewDNS).toHaveBeenCalledWith('chris');
      expect(postChannelMessage).toHaveBeenCalledWith(
        'C_PASSCRAFT',
        expect.stringContaining('Chris')
      );
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('All set for passcraft')
      );
      expect(state.step).toBe('complete');
    });

    it('should handle partial failures gracefully', async () => {
      const { inviteToGitHub } = await import('../../src/onboarding/provision.js');
      const { sendDM } = await import('../../src/onboarding/dm.js');
      vi.mocked(inviteToGitHub).mockResolvedValueOnce(false);

      const state: OnboardingState = {
        userId: testUserId,
        flow: 'app',
        step: 'processing',
        name: 'Chris',
        githubUsername: 'chris-dev',
        email: 'chris@example.com',
        dmChannelId: 'D_TEST_DM_CHANNEL',
        appRepoName: 'passcraft',
        appChannelId: 'C_PASSCRAFT',
      };

      await processAppOnboarding(state);

      expect(state.step).toBe('complete');
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('Could not send invitation')
      );
    });

    it('should handle missing email gracefully', async () => {
      const { sendDM } = await import('../../src/onboarding/dm.js');

      const state: OnboardingState = {
        userId: testUserId,
        flow: 'app',
        step: 'processing',
        name: 'Chris',
        githubUsername: 'chris-dev',
        // No email
        dmChannelId: 'D_TEST_DM_CHANNEL',
        appRepoName: 'passcraft',
        appChannelId: 'C_PASSCRAFT',
      };

      await processAppOnboarding(state);

      expect(state.step).toBe('complete');
      expect(sendDM).toHaveBeenCalledWith(
        'D_TEST_DM_CHANNEL',
        expect.stringContaining('No email on file')
      );
    });
  });

  // -------------------------------------------------------------------------
  // Session Management
  // -------------------------------------------------------------------------

  describe('Session Management', () => {
    it('should track active sessions', async () => {
      expect(hasActiveSession(testUserId)).toBe(false);
      await startTeamOnboarding(testUserId);
      expect(hasActiveSession(testUserId)).toBe(true);
    });

    it('should clear sessions', async () => {
      await startTeamOnboarding(testUserId);
      clearSession(testUserId);
      expect(hasActiveSession(testUserId)).toBe(false);
      expect(getSession(testUserId)).toBeUndefined();
    });

    it('should count active sessions', async () => {
      const initialCount = getActiveSessionCount();
      await startTeamOnboarding(testUserId);
      expect(getActiveSessionCount()).toBe(initialCount + 1);
      clearSession(testUserId);
      expect(getActiveSessionCount()).toBe(initialCount);
    });
  });
});
