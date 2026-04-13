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

// Claim lifecycle queries added by Phase 1 — mocked so tests can assert
// the handlers actually call them with the right arguments.
const mockSetIssueClaim = vi.fn().mockResolvedValue(undefined);
const mockClearIssueClaim = vi.fn().mockResolvedValue(undefined);
const mockTouchIssue = vi.fn().mockResolvedValue(undefined);
const mockGetAllClaimedIssues = vi.fn().mockResolvedValue([]);
const mockGetRecentlyClosedIssues = vi.fn().mockResolvedValue([]);
const mockGetOpenIssuesByArea = vi.fn().mockResolvedValue(new Map());
const mockGetOpenIssuesForRepo = vi.fn().mockResolvedValue([]);
const mockGetAllTeamMembers = vi.fn().mockResolvedValue([]);
const mockGetPinnedMessageTs = vi.fn().mockResolvedValue(null);
const mockSavePinnedMessageTs = vi.fn().mockResolvedValue(undefined);
const mockCloseStaleIssues = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/db/queries.js', () => ({
  upsertIssue: vi.fn().mockResolvedValue(undefined),
  updateTeamMemberStatus: vi.fn().mockResolvedValue(undefined),
  logWebhook: vi.fn().mockResolvedValue(undefined),
  setIssueClaim: (...a: unknown[]) => mockSetIssueClaim(...a),
  clearIssueClaim: (...a: unknown[]) => mockClearIssueClaim(...a),
  touchIssue: (...a: unknown[]) => mockTouchIssue(...a),
  getAllClaimedIssues: (...a: unknown[]) => mockGetAllClaimedIssues(...a),
  getRecentlyClosedIssues: (...a: unknown[]) => mockGetRecentlyClosedIssues(...a),
  getOpenIssuesByArea: (...a: unknown[]) => mockGetOpenIssuesByArea(...a),
  getOpenIssuesForRepo: (...a: unknown[]) => mockGetOpenIssuesForRepo(...a),
  getAllTeamMembers: (...a: unknown[]) => mockGetAllTeamMembers(...a),
  getPinnedMessageTs: (...a: unknown[]) => mockGetPinnedMessageTs(...a),
  savePinnedMessageTs: (...a: unknown[]) => mockSavePinnedMessageTs(...a),
  closeStaleIssues: (...a: unknown[]) => mockCloseStaleIssues(...a),
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

  // -------------------------------------------------------------------------
  // Phase 1 Reconciler Paths — integration tests for Commit 3 + Commit 4.
  // These verify that webhook events trigger the right DB mutations + the
  // reconciler, not the old ad-hoc Slack posts.
  // -------------------------------------------------------------------------

  describe('Phase 1 Reconciler paths', () => {
    beforeEach(() => {
      mockSetIssueClaim.mockClear();
      mockClearIssueClaim.mockClear();
      mockTouchIssue.mockClear();
    });

    describe('push event (Commit 3)', () => {
      it('calls touchIssue for every #N reference across all commits', async () => {
        const pushPayload = {
          ref: 'refs/heads/feature/login',
          repository: { name: 'PassCraft' },
          sender: { login: 'NabilW1995' },
          commits: [
            { message: 'fix: #23 filter crash', added: [], modified: ['src/dashboard/Filter.tsx'], removed: [] },
            { message: 'wip: more work on #23 and also #45', added: [], modified: ['src/ui/a.ts'], removed: [] },
            { message: 'no issue ref here', added: [], modified: [], removed: [] },
          ],
        };
        const response = await sendWebhook(app, 'push', pushPayload);
        expect(response.status).toBe(200);

        // #23 and #45 should each be touched at least once (maybe twice
        // due to display-name casing double-write, but we only assert the
        // unique issue numbers are all covered).
        const touchedNumbers = new Set<number>();
        for (const call of mockTouchIssue.mock.calls) {
          touchedNumbers.add(call[2] as number);
        }
        expect(touchedNumbers.has(23)).toBe(true);
        expect(touchedNumbers.has(45)).toBe(true);
        expect(touchedNumbers.has(0)).toBe(false);
      });

      it('does not call touchIssue when no commit references any issue', async () => {
        const pushPayload = {
          ref: 'refs/heads/main',
          repository: { name: 'PassCraft' },
          sender: { login: 'NabilW1995' },
          commits: [
            { message: 'chore: update deps', added: [], modified: ['package.json'], removed: [] },
            { message: 'docs: fix typo', added: [], modified: ['README.md'], removed: [] },
          ],
        };
        const response = await sendWebhook(app, 'push', pushPayload);
        expect(response.status).toBe(200);
        expect(mockTouchIssue).not.toHaveBeenCalled();
      });

      it('returns 200 even when the push has an empty commits array', async () => {
        const pushPayload = {
          ref: 'refs/heads/main',
          repository: { name: 'PassCraft' },
          sender: { login: 'NabilW1995' },
          commits: [],
        };
        const response = await sendWebhook(app, 'push', pushPayload);
        expect(response.status).toBe(200);
        expect(mockTouchIssue).not.toHaveBeenCalled();
      });
    });

    describe('issues.assigned (Commit 4)', () => {
      it('calls setIssueClaim with the assignee GitHub username', async () => {
        const response = await sendWebhook(app, 'issues', issueAssignedPayload);
        expect(response.status).toBe(200);
        expect(mockSetIssueClaim).toHaveBeenCalled();
        // The call signature is (db, repoName, issueNumber, githubUsername)
        const firstCall = mockSetIssueClaim.mock.calls[0];
        const [, repoArg, issueNumArg, userArg] = firstCall;
        expect(typeof repoArg).toBe('string');
        expect(typeof issueNumArg).toBe('number');
        expect(typeof userArg).toBe('string');
        expect(userArg).toBeTruthy();
      });
    });

    describe('issues.closed (Commit 4)', () => {
      it('calls clearIssueClaim when an issue is closed', async () => {
        const response = await sendWebhook(app, 'issues', issueClosedPayload);
        expect(response.status).toBe(200);
        expect(mockClearIssueClaim).toHaveBeenCalled();
        const firstCall = mockClearIssueClaim.mock.calls[0];
        const [, repoArg, issueNumArg] = firstCall;
        expect(typeof repoArg).toBe('string');
        expect(typeof issueNumArg).toBe('number');
      });
    });

    describe('issues.unassigned (Commit 4)', () => {
      it('calls clearIssueClaim when an issue is unassigned', async () => {
        // Clone the assigned payload and flip the action to 'unassigned'
        // with assignee: null, which represents the after-unassign state.
        const unassignedPayload = {
          ...issueAssignedPayload,
          action: 'unassigned',
          issue: {
            ...issueAssignedPayload.issue,
            assignee: null,
          },
        };
        const response = await sendWebhook(app, 'issues', unassignedPayload);
        expect(response.status).toBe(200);
        expect(mockClearIssueClaim).toHaveBeenCalled();
      });
    });
  });
});
