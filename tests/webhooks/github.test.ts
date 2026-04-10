import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { handleGitHubWebhook } from '../../src/webhooks/github.js';
import {
  issueOpenedPayload,
  issueAssignedPayload,
  issueClosedPayload,
  pullRequestConflictPayload,
} from '../fixtures/github-payloads.js';

// Mock the DB module — database should never block Slack messages
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/db/queries.js', () => ({
  upsertIssue: vi.fn().mockResolvedValue(undefined),
  logWebhook: vi.fn().mockResolvedValue(undefined),
}));

const TEST_SECRET = 'test-webhook-secret';

function createSignature(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Helper: send a webhook request to the test app.
 */
async function sendWebhook(
  app: Hono,
  event: string,
  payload: unknown,
  options?: { signature?: string; secret?: string }
): Promise<Response> {
  const body = JSON.stringify(payload);
  const secret = options?.secret ?? TEST_SECRET;
  const signature = options?.signature ?? createSignature(body, secret);

  return app.request('/webhooks/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': signature,
    },
    body,
  });
}

describe('GitHub Webhook Handler', () => {
  let app: Hono;
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env for each test
    process.env = { ...originalEnv, GITHUB_WEBHOOK_SECRET: TEST_SECRET };
    app = new Hono();
    app.post('/webhooks/github', handleGitHubWebhook);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Signature Verification', () => {
    it('should return 200 with valid signature', async () => {
      // Mock postToChannel to avoid actual Slack calls
      vi.mock('../../src/slack/client.js', () => ({
        postToChannel: vi.fn().mockResolvedValue(undefined),
      }));

      const response = await sendWebhook(app, 'issues', issueOpenedPayload);
      expect(response.status).toBe(200);
    });

    it('should return 401 with invalid signature', async () => {
      const response = await sendWebhook(app, 'issues', issueOpenedPayload, {
        signature: 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      });
      expect(response.status).toBe(401);
    });

    it('should return 401 with missing signature', async () => {
      const body = JSON.stringify(issueOpenedPayload);
      const response = await app.request('/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issues',
          // No X-Hub-Signature-256 header
        },
        body,
      });
      expect(response.status).toBe(401);
    });
  });

  describe('Event Dispatch', () => {
    beforeEach(() => {
      vi.mock('../../src/slack/client.js', () => ({
        postToChannel: vi.fn().mockResolvedValue(undefined),
      }));
    });

    it('should return 200 for issues.opened event', async () => {
      const response = await sendWebhook(app, 'issues', issueOpenedPayload);
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ ok: true });
    });

    it('should return 200 for pull_request event', async () => {
      const response = await sendWebhook(app, 'pull_request', pullRequestConflictPayload);
      expect(response.status).toBe(200);
    });

    it('should return 200 for unknown events (graceful handling)', async () => {
      const response = await sendWebhook(app, 'star', { action: 'created' });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ ok: true });
    });

    it('should return 200 for ping event', async () => {
      const response = await sendWebhook(app, 'ping', { zen: 'Keep it simple' });
      expect(response.status).toBe(200);
    });
  });

  describe('Database Integration', () => {
    beforeEach(() => {
      vi.mock('../../src/slack/client.js', () => ({
        postToChannel: vi.fn().mockResolvedValue(undefined),
      }));
    });

    it('should persist issue to DB on issues.opened', async () => {
      const { upsertIssue } = await import('../../src/db/queries.js');

      const response = await sendWebhook(app, 'issues', issueOpenedPayload);
      expect(response.status).toBe(200);
      expect(upsertIssue).toHaveBeenCalled();
    });

    it('should persist issue to DB on issues.assigned', async () => {
      const { upsertIssue } = await import('../../src/db/queries.js');

      const response = await sendWebhook(app, 'issues', issueAssignedPayload);
      expect(response.status).toBe(200);
      expect(upsertIssue).toHaveBeenCalled();
    });

    it('should persist issue to DB on issues.closed', async () => {
      const { upsertIssue } = await import('../../src/db/queries.js');

      const response = await sendWebhook(app, 'issues', issueClosedPayload);
      expect(response.status).toBe(200);
      expect(upsertIssue).toHaveBeenCalled();
    });

    it('should log every webhook event', async () => {
      const { logWebhook } = await import('../../src/db/queries.js');

      await sendWebhook(app, 'issues', issueOpenedPayload);
      expect(logWebhook).toHaveBeenCalled();
    });

    it('should still return 200 when DB is unavailable', async () => {
      // Make DB functions throw
      const queries = await import('../../src/db/queries.js');
      vi.mocked(queries.upsertIssue).mockRejectedValue(new Error('DB down'));
      vi.mocked(queries.logWebhook).mockRejectedValue(new Error('DB down'));

      const response = await sendWebhook(app, 'issues', issueOpenedPayload);
      // The handler should gracefully degrade — Slack message still goes out
      expect(response.status).toBe(200);
    });
  });

  describe('Missing Configuration', () => {
    it('should return 500 when GITHUB_WEBHOOK_SECRET is not set', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      const body = JSON.stringify(issueOpenedPayload);
      const response = await app.request('/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issues',
          'X-Hub-Signature-256': 'sha256=doesntmatter',
        },
        body,
      });
      expect(response.status).toBe(500);
    });
  });
});
