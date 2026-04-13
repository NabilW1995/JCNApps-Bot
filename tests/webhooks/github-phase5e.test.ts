/**
 * Phase 5e wiring tests for the GitHub webhook handler.
 *
 * Verifies that when an issue is assigned, the bot now:
 *   1. Posts a Task Claimed message to the active channel webhook
 *   2. Posts a Hotfix message to the bugs channel webhook IFF the
 *      issue carries a priority/critical label
 *   3. Calls the file detection helper (we mock it to control the
 *      return value, then assert it was used)
 *
 * Lives in its own file because the mocking shape needed for these
 * assertions differs from tests/webhooks/github.test.ts which uses
 * an inline vi.mock pattern that's awkward to extend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { issueAssignedPayload } from '../fixtures/github-payloads.js';

const TEST_SECRET = 'test-webhook-secret';

const mockPostToChannel = vi.fn().mockResolvedValue(undefined);
const mockPostMessage = vi.fn().mockResolvedValue('1600000000.000100');
const mockSetChannelTopic = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/slack/client.js', () => ({
  postToChannel: (...a: unknown[]) => mockPostToChannel(...a),
  postMessage: (...a: unknown[]) => mockPostMessage(...a),
  setChannelTopic: (...a: unknown[]) => mockSetChannelTopic(...a),
  pinMessage: vi.fn().mockResolvedValue(undefined),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  addReaction: vi.fn().mockResolvedValue(undefined),
  getReactions: vi.fn().mockResolvedValue([]),
  postEphemeral: vi.fn().mockResolvedValue(undefined),
  openModal: vi.fn().mockResolvedValue(undefined),
  postThreadReply: vi.fn().mockResolvedValue(undefined),
  withRetry: async (fn: () => Promise<unknown>) => fn(),
  getWebClient: () => ({
    auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: 'U_BOT' }) },
    chat: { postMessage: vi.fn(), update: vi.fn() },
    reactions: { add: vi.fn() },
    users: { info: vi.fn() },
    conversations: { replies: vi.fn() },
  }),
}));

vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/db/queries.js', () => ({
  upsertIssue: vi.fn().mockResolvedValue(undefined),
  updateTeamMemberStatus: vi.fn().mockResolvedValue(undefined),
  logWebhook: vi.fn().mockResolvedValue(undefined),
  setIssueClaim: vi.fn().mockResolvedValue(undefined),
  clearIssueClaim: vi.fn().mockResolvedValue(undefined),
  touchIssue: vi.fn().mockResolvedValue(undefined),
  getAllClaimedIssues: vi.fn().mockResolvedValue([]),
  getRecentlyClosedIssues: vi.fn().mockResolvedValue([]),
  getOpenIssuesByArea: vi.fn().mockResolvedValue(new Map()),
  getOpenIssuesForRepo: vi.fn().mockResolvedValue([]),
  getAllTeamMembers: vi.fn().mockResolvedValue([]),
  getPinnedMessageTs: vi.fn().mockResolvedValue(null),
  savePinnedMessageTs: vi.fn().mockResolvedValue(undefined),
  closeStaleIssues: vi.fn().mockResolvedValue(undefined),
  getEarliestClaimAcrossIssues: vi.fn().mockResolvedValue(null),
}));

const mockDetectFiles = vi.fn().mockResolvedValue([
  'src/dashboard/Filter.tsx',
  'src/dashboard/util.ts',
]);
vi.mock('../../src/utils/code-search.js', () => ({
  detectFilesForIssue: (...a: unknown[]) => mockDetectFiles(...a),
}));

vi.mock('../../src/config/channels.js', () => ({
  getChannelConfig: vi.fn().mockReturnValue({
    displayName: 'PassCraft',
    activeChannelId: 'C_ACTIVE',
    bugsChannelId: 'C_BUGS',
    bugsWebhookUrl: 'https://hooks.slack.com/bugs',
    activeWebhookUrl: 'https://hooks.slack.com/active',
  }),
}));

vi.mock('../../src/config/team.js', () => ({
  getTeamMemberByGitHub: vi.fn().mockReturnValue({
    name: 'Nabil',
    githubUsername: 'NabilW1995',
    slackUserId: 'U_NABIL',
  }),
}));

function createSignature(body: string): string {
  return 'sha256=' + createHmac('sha256', TEST_SECRET).update(body).digest('hex');
}

async function send(app: Hono, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return app.request('/webhooks/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': createSignature(body),
    },
    body,
  });
}

describe('Phase 5e: handleIssueAssigned message wiring', () => {
  let app: Hono;
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv, GITHUB_WEBHOOK_SECRET: TEST_SECRET };
    vi.clearAllMocks();
    mockDetectFiles.mockResolvedValue(['src/dashboard/Filter.tsx', 'src/dashboard/util.ts']);

    const { handleGitHubWebhook } = await import('../../src/webhooks/github.js');
    app = new Hono();
    app.post('/webhooks/github', handleGitHubWebhook);
  });

  afterEach(() => {
    process.env = originalEnv;
    // Important: do NOT call vi.restoreAllMocks() here — it resets
    // the implementation of every vi.fn() created in module-level
    // mock factories, which wipes the channel config + slack client
    // return values for the next test in the file. clearAllMocks in
    // beforeEach handles call-history isolation; that's enough.
  });

  it('posts a Task Claimed message to the active webhook on issue assignment', async () => {
    const res = await send(app, issueAssignedPayload);
    expect(res.status).toBe(200);

    // postToChannel should have been called at least once with the
    // active webhook URL. The URL match is enough to prove the
    // wiring works without parsing block kit contents.
    const calls = mockPostToChannel.mock.calls;
    const activeCalls = calls.filter((c) => c[0] === 'https://hooks.slack.com/active');
    expect(activeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('calls detectFilesForIssue with the issue title and area', async () => {
    await send(app, issueAssignedPayload);
    expect(mockDetectFiles).toHaveBeenCalled();
    const call = mockDetectFiles.mock.calls[0];
    // Args: (repoName, title, area, maxResults)
    expect(typeof call[0]).toBe('string');
    expect(typeof call[1]).toBe('string');
    expect(call[1]).toBeTruthy();
  });

  it('does NOT post to the bugs webhook when there is no critical label', async () => {
    await send(app, issueAssignedPayload);
    const bugsCalls = mockPostToChannel.mock.calls.filter(
      (c) => c[0] === 'https://hooks.slack.com/bugs'
    );
    expect(bugsCalls.length).toBe(0);
  });

  it('posts a Hotfix message to the bugs webhook when priority/critical is set', async () => {
    // The base fixture has priority/high — getPriorityLabel returns the
    // first match, so we have to REPLACE the priority label, not append.
    const baseLabels = (issueAssignedPayload.issue.labels ?? []).filter(
      (l) => !l.name.startsWith('priority/')
    );
    const criticalPayload = {
      ...issueAssignedPayload,
      issue: {
        ...issueAssignedPayload.issue,
        number: 9999,
        labels: [
          ...baseLabels,
          { id: 99, name: 'priority/critical', color: 'ff0000', description: 'Critical' },
        ],
      },
    };

    await send(app, criticalPayload);

    const bugsCalls = mockPostToChannel.mock.calls.filter(
      (c) => c[0] === 'https://hooks.slack.com/bugs'
    );
    expect(bugsCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('still posts the Task Claimed message even when file detection fails', async () => {
    mockDetectFiles.mockRejectedValueOnce(new Error('rate limited'));

    const res = await send(app, issueAssignedPayload);
    expect(res.status).toBe(200);

    const activeCalls = mockPostToChannel.mock.calls.filter(
      (c) => c[0] === 'https://hooks.slack.com/active'
    );
    expect(activeCalls.length).toBeGreaterThanOrEqual(1);
  });
});
