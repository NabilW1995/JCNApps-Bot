import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { handleSlackEvents, clearEventCache } from '../../src/webhooks/slack-events.js';

// Mock the onboarding flow module
vi.mock('../../src/onboarding/flow.js', () => ({
  startOnboarding: vi.fn().mockResolvedValue(undefined),
  handleDMReply: vi.fn().mockResolvedValue(undefined),
  hasActiveSession: vi.fn().mockReturnValue(false),
}));

// Mock the DM module (needed indirectly by flow)
vi.mock('../../src/onboarding/dm.js', () => ({
  openDM: vi.fn().mockResolvedValue('D_TEST'),
  sendDM: vi.fn().mockResolvedValue(undefined),
  postChannelMessage: vi.fn().mockResolvedValue('1234.5678'),
  pinChannelMessage: vi.fn().mockResolvedValue(undefined),
}));

// Mock the provision module (needed indirectly by flow)
vi.mock('../../src/onboarding/provision.js', () => ({
  inviteToGitHub: vi.fn().mockResolvedValue(true),
  inviteToCoolify: vi.fn().mockResolvedValue(true),
  createPreviewDNS: vi.fn().mockResolvedValue(true),
  saveTeamMember: vi.fn().mockResolvedValue(undefined),
}));

describe('Slack Events Webhook Handler', () => {
  let app: Hono;

  beforeEach(() => {
    clearEventCache();
    app = new Hono();
    app.post('/webhooks/slack-events', handleSlackEvents);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('URL Verification', () => {
    it('should respond with the challenge for url_verification', async () => {
      const body = {
        type: 'url_verification',
        challenge: 'test-challenge-token-123',
      };

      const response = await app.request('/webhooks/slack-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.challenge).toBe('test-challenge-token-123');
    });
  });

  describe('Reaction Added Events', () => {
    it('should trigger onboarding on white_check_mark reaction', async () => {
      const { startOnboarding } = await import('../../src/onboarding/flow.js');

      const body = {
        type: 'event_callback',
        event_id: 'Ev_TEST_001',
        event: {
          type: 'reaction_added',
          user: 'U_NEW_USER',
          reaction: 'white_check_mark',
          item: { type: 'message', channel: 'C_TEAM_GENERAL', ts: '1234.5678' },
          event_ts: '1234567890.123456',
        },
      };

      const response = await app.request('/webhooks/slack-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
      expect(startOnboarding).toHaveBeenCalledWith('U_NEW_USER');
    });

    it('should ignore non-checkmark reactions', async () => {
      const { startOnboarding } = await import('../../src/onboarding/flow.js');

      const body = {
        type: 'event_callback',
        event_id: 'Ev_TEST_002',
        event: {
          type: 'reaction_added',
          user: 'U_RANDOM',
          reaction: 'thumbsup',
          item: { type: 'message', channel: 'C_TEAM_GENERAL', ts: '1234.5678' },
          event_ts: '1234567890.123456',
        },
      };

      const response = await app.request('/webhooks/slack-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
      expect(startOnboarding).not.toHaveBeenCalled();
    });
  });

  describe('DM Message Events', () => {
    it('should forward DM messages to the onboarding handler', async () => {
      const { handleDMReply } = await import('../../src/onboarding/flow.js');

      const body = {
        type: 'event_callback',
        event_id: 'Ev_TEST_003',
        event: {
          type: 'message',
          user: 'U_ONBOARDING_USER',
          text: 'Chris',
          channel: 'D_DM_CHANNEL',
          channel_type: 'im',
          ts: '1234567890.654321',
        },
      };

      const response = await app.request('/webhooks/slack-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
      expect(handleDMReply).toHaveBeenCalledWith('U_ONBOARDING_USER', 'Chris');
    });

    it('should ignore bot messages to prevent loops', async () => {
      const { handleDMReply } = await import('../../src/onboarding/flow.js');

      const body = {
        type: 'event_callback',
        event_id: 'Ev_TEST_004',
        event: {
          type: 'message',
          user: 'U_BOT',
          text: 'Bot reply',
          channel: 'D_DM_CHANNEL',
          channel_type: 'im',
          ts: '1234567890.654321',
          bot_id: 'B_TEST_BOT',
        },
      };

      const response = await app.request('/webhooks/slack-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
      expect(handleDMReply).not.toHaveBeenCalled();
    });

    it('should ignore non-DM messages', async () => {
      const { handleDMReply } = await import('../../src/onboarding/flow.js');

      const body = {
        type: 'event_callback',
        event_id: 'Ev_TEST_005',
        event: {
          type: 'message',
          user: 'U_SOMEONE',
          text: 'Hello channel',
          channel: 'C_SOME_CHANNEL',
          channel_type: 'channel',
          ts: '1234567890.654321',
        },
      };

      const response = await app.request('/webhooks/slack-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
      expect(handleDMReply).not.toHaveBeenCalled();
    });
  });

  describe('Idempotency', () => {
    it('should deduplicate events with the same event_id', async () => {
      const { startOnboarding } = await import('../../src/onboarding/flow.js');

      const body = {
        type: 'event_callback',
        event_id: 'Ev_DUPLICATE',
        event: {
          type: 'reaction_added',
          user: 'U_TEST',
          reaction: 'white_check_mark',
          item: { type: 'message', channel: 'C_TEST', ts: '1234.5678' },
          event_ts: '1234567890.123456',
        },
      };

      // Send the same event twice
      await app.request('/webhooks/slack-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const response2 = await app.request('/webhooks/slack-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const json = await response2.json();
      expect(json.duplicate).toBe(true);

      // startOnboarding should only be called once
      expect(startOnboarding).toHaveBeenCalledTimes(1);
    });
  });

  describe('Error Handling', () => {
    it('should return 400 for invalid JSON', async () => {
      const response = await app.request('/webhooks/slack-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      expect(response.status).toBe(400);
    });

    it('should return 200 even when event handler throws', async () => {
      const { startOnboarding } = await import('../../src/onboarding/flow.js');
      vi.mocked(startOnboarding).mockRejectedValueOnce(new Error('Boom'));

      const body = {
        type: 'event_callback',
        event_id: 'Ev_ERROR',
        event: {
          type: 'reaction_added',
          user: 'U_TEST',
          reaction: 'white_check_mark',
          item: { type: 'message', channel: 'C_TEST', ts: '1234.5678' },
          event_ts: '1234567890.123456',
        },
      };

      const response = await app.request('/webhooks/slack-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // Should return 200 to prevent Slack retries for permanent failures
      expect(response.status).toBe(200);
    });

    it('should handle unknown event types gracefully', async () => {
      const body = {
        type: 'event_callback',
        event_id: 'Ev_UNKNOWN',
        event: {
          type: 'app_mention',
          user: 'U_TEST',
          text: 'Hey bot',
          channel: 'C_TEST',
          ts: '1234567890.123456',
        },
      };

      const response = await app.request('/webhooks/slack-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
    });
  });
});
