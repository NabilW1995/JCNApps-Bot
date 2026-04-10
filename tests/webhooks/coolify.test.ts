import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../../src/index.js';
import {
  previewSuccessPayload,
  productionSuccessPayload,
  deployFailedPayload,
  alternativeUrlPayload,
  errorPayload,
} from '../fixtures/coolify-payloads.js';

// Mock the Slack client so we don't make real HTTP calls
vi.mock('../../src/slack/client.js', () => ({
  postToChannel: vi.fn().mockResolvedValue(undefined),
}));

// Mock the DB module — database should never block Slack messages
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/db/queries.js', () => ({
  logDeployEvent: vi.fn().mockResolvedValue(undefined),
  logWebhook: vi.fn().mockResolvedValue(undefined),
}));

// Set up channel config for PassCraft (must match env var names in channels.ts)
beforeEach(() => {
  process.env.PASSCRAFT_BUGS_WEBHOOK_URL = 'https://hooks.slack.com/test-bugs';
  process.env.PASSCRAFT_ACTIVE_CHANNEL_ID = 'C_ACTIVE';
  process.env.PASSCRAFT_PREVIEW_WEBHOOK_URL = 'https://hooks.slack.com/test-preview';
  process.env.PASSCRAFT_DEPLOY_WEBHOOK_URL = 'https://hooks.slack.com/test-deploy';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Coolify Webhook Handler', () => {
  describe('Preview Deployments', () => {
    it('should post to preview channel on feature branch success', async () => {
      const { postToChannel } = await import('../../src/slack/client.js');

      const res = await app.request('/webhooks/coolify?repo=PassCraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewSuccessPayload),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe('preview_ready');
      expect(postToChannel).toHaveBeenCalledWith(
        'https://hooks.slack.com/test-preview',
        expect.any(Array)
      );
    });

    it('should handle alternative URL field (deployment_url)', async () => {
      const { postToChannel } = await import('../../src/slack/client.js');

      const res = await app.request('/webhooks/coolify?repo=PassCraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alternativeUrlPayload),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe('preview_ready');
      expect(postToChannel).toHaveBeenCalled();
    });
  });

  describe('Production Deployments', () => {
    it('should post to deploy channel on main branch success', async () => {
      const { postToChannel } = await import('../../src/slack/client.js');

      const res = await app.request('/webhooks/coolify?repo=PassCraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(productionSuccessPayload),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe('production_deployed');
      expect(postToChannel).toHaveBeenCalledWith(
        'https://hooks.slack.com/test-deploy',
        expect.any(Array)
      );
    });
  });

  describe('Failed Deployments', () => {
    it('should post to deploy channel on failure', async () => {
      const { postToChannel } = await import('../../src/slack/client.js');

      const res = await app.request('/webhooks/coolify?repo=PassCraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deployFailedPayload),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe('deploy_failed');
      expect(postToChannel).toHaveBeenCalledWith(
        'https://hooks.slack.com/test-deploy',
        expect.any(Array)
      );
    });

    it('should handle error status same as failed', async () => {
      const { postToChannel } = await import('../../src/slack/client.js');

      const res = await app.request('/webhooks/coolify?repo=PassCraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(errorPayload),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe('deploy_failed');
      expect(postToChannel).toHaveBeenCalled();
    });
  });

  describe('Database Integration', () => {
    it('should log deploy event on production success', async () => {
      const { logDeployEvent } = await import('../../src/db/queries.js');

      await app.request('/webhooks/coolify?repo=PassCraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(productionSuccessPayload),
      });

      expect(logDeployEvent).toHaveBeenCalled();
    });

    it('should log deploy event on preview success', async () => {
      const { logDeployEvent } = await import('../../src/db/queries.js');

      await app.request('/webhooks/coolify?repo=PassCraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewSuccessPayload),
      });

      expect(logDeployEvent).toHaveBeenCalled();
    });

    it('should log deploy event on failure', async () => {
      const { logDeployEvent } = await import('../../src/db/queries.js');

      await app.request('/webhooks/coolify?repo=PassCraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deployFailedPayload),
      });

      expect(logDeployEvent).toHaveBeenCalled();
    });

    it('should log every webhook event', async () => {
      const { logWebhook } = await import('../../src/db/queries.js');

      await app.request('/webhooks/coolify?repo=PassCraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewSuccessPayload),
      });

      expect(logWebhook).toHaveBeenCalled();
    });

    it('should still post to Slack when DB is unavailable', async () => {
      const queries = await import('../../src/db/queries.js');
      vi.mocked(queries.logDeployEvent).mockRejectedValue(new Error('DB down'));
      vi.mocked(queries.logWebhook).mockRejectedValue(new Error('DB down'));

      const { postToChannel } = await import('../../src/slack/client.js');

      const res = await app.request('/webhooks/coolify?repo=PassCraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(productionSuccessPayload),
      });

      expect(res.status).toBe(200);
      expect(postToChannel).toHaveBeenCalled();
    });
  });

  describe('Validation', () => {
    it('should return 400 when repo query parameter is missing', async () => {
      const res = await app.request('/webhooks/coolify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewSuccessPayload),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('repo');
    });

    it('should return 404 for unknown repo', async () => {
      const res = await app.request('/webhooks/coolify?repo=UnknownApp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewSuccessPayload),
      });

      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid JSON', async () => {
      const res = await app.request('/webhooks/coolify?repo=PassCraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      expect(res.status).toBe(400);
    });
  });
});
