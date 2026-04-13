/**
 * Integration tests for the Slack interactive webhook.
 *
 * Uses the slack-harness helper to build realistic block_actions and
 * view_submission payloads and POSTs them to a minimal Hono app
 * wired with handleSlackInteractive. All outward dependencies
 * (Slack Web API, DB queries, refresh helpers) are mocked so we can
 * assert which functions got called with what.
 *
 * Focus: dispatch correctness — when the user clicks button X,
 * does the handler call function Y? Full DB state / full Slack
 * block assertions live in other test files.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  buildBlockActionsPayload,
  buildViewSubmissionPayload,
  postSlackInteractive,
} from '../helpers/slack-harness.js';

// ---------------------------------------------------------------------------
// Mocks for every side-effect dependency
// ---------------------------------------------------------------------------

const mockOpenModal = vi.fn().mockResolvedValue(undefined);
const mockPostEphemeral = vi.fn().mockResolvedValue(undefined);
const mockSetChannelTopic = vi.fn().mockResolvedValue(undefined);
const mockViewsUpdate = vi.fn().mockResolvedValue({ ok: true });
const mockChatUpdate = vi.fn().mockResolvedValue({ ok: true });
const mockChatPostMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1600000000.000100' });
const mockReactionsAdd = vi.fn().mockResolvedValue({ ok: true });
const mockUsersInfo = vi.fn().mockResolvedValue({ user: { real_name: 'Test User' } });
const mockConversationsReplies = vi.fn().mockResolvedValue({ messages: [] });

vi.mock('../../src/slack/client.js', () => ({
  getWebClient: () => ({
    views: { update: mockViewsUpdate, open: vi.fn().mockResolvedValue({ ok: true }) },
    chat: { postMessage: mockChatPostMessage, update: mockChatUpdate },
    reactions: { add: mockReactionsAdd },
    users: { info: mockUsersInfo },
    conversations: { replies: mockConversationsReplies },
  }),
  openModal: (...a: unknown[]) => mockOpenModal(...a),
  postEphemeral: (...a: unknown[]) => mockPostEphemeral(...a),
  setChannelTopic: (...a: unknown[]) => mockSetChannelTopic(...a),
  postMessage: vi.fn().mockResolvedValue('1600000000.000100'),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  pinMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

const mockGetOpenIssuesForRepo = vi.fn().mockResolvedValue([]);
const mockGetTeamMemberBySlackId = vi.fn().mockResolvedValue(null);

vi.mock('../../src/db/queries.js', () => ({
  getOpenIssuesForRepo: (...a: unknown[]) => mockGetOpenIssuesForRepo(...a),
  getTeamMemberBySlackId: (...a: unknown[]) => mockGetTeamMemberBySlackId(...a),
  upsertIssue: vi.fn().mockResolvedValue(undefined),
  setIssueClaim: vi.fn().mockResolvedValue(undefined),
  clearIssueClaim: vi.fn().mockResolvedValue(undefined),
  touchIssue: vi.fn().mockResolvedValue(undefined),
}));

const mockRefreshBugsTable = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/slack/table-manager.js', () => ({
  refreshBugsTable: (...a: unknown[]) => mockRefreshBugsTable(...a),
  reconcileActiveState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/config/channels.js', () => ({
  getRepoNameFromChannel: vi.fn().mockReturnValue('PassCraft'),
  getChannelConfig: vi.fn().mockReturnValue({
    displayName: 'PassCraft',
    activeChannelId: 'C_ACTIVE',
    bugsChannelId: 'C_BUGS',
  }),
}));

vi.mock('../../src/webhooks/github.js', () => ({
  markBotCreatedIssue: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('Slack Interactive Webhook', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-establish default resolved values — clearAllMocks wipes the
    // implementation of hoisted mocks on some vitest versions.
    mockGetOpenIssuesForRepo.mockResolvedValue([]);
    mockGetTeamMemberBySlackId.mockResolvedValue(null);
    mockRefreshBugsTable.mockResolvedValue(undefined);
    mockChatPostMessage.mockResolvedValue({ ok: true, ts: '1600000000.000100' });
    mockViewsUpdate.mockResolvedValue({ ok: true });
    mockChatUpdate.mockResolvedValue({ ok: true });
    mockUsersInfo.mockResolvedValue({ user: { real_name: 'Test User' } });
    mockConversationsReplies.mockResolvedValue({ messages: [] });

    const { handleSlackInteractive } = await import(
      '../../src/webhooks/slack-interactive.js'
    );
    app = new Hono();
    app.post('/webhooks/slack-interactive', handleSlackInteractive);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------
  // Assign Tasks Modal — the 3-step flow
  // -------------------------------------------------------------------

  describe('Assign Tasks — Step 1 click-to-select', () => {
    it('clicking the Bug button updates the view (no advance)', async () => {
      const payload = buildBlockActionsPayload({
        actionId: 'assign_pick_bug',
        user: { id: 'U_USER', name: 'nabil' },
        channel: { id: 'C_BUGS' },
        view: {
          id: 'V_STEP1',
          callbackId: 'assign_step1_modal',
          privateMetadata: {
            channelId: 'C_BUGS',
            repoName: 'PassCraft',
            userId: 'U_USER',
            type: 'feature',
          },
        },
      });

      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
      // views.update should have been called — the view is swapped in
      // place with Bug now primary instead of Feature
      expect(mockViewsUpdate).toHaveBeenCalled();
    });

    it('clicking the Feature button updates the view (no advance)', async () => {
      const payload = buildBlockActionsPayload({
        actionId: 'assign_pick_feature',
        user: { id: 'U_USER' },
        channel: { id: 'C_BUGS' },
        view: {
          id: 'V_STEP1',
          callbackId: 'assign_step1_modal',
          privateMetadata: {
            channelId: 'C_BUGS',
            repoName: 'PassCraft',
            userId: 'U_USER',
            type: 'bug',
          },
        },
      });

      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
      expect(mockViewsUpdate).toHaveBeenCalled();
    });
  });

  describe('Assign Tasks — Step 1 submit advances to Step 2', () => {
    it('returns response_action: update with the Step 2 view', async () => {
      // Populate open issues so buildAssignStep2ViewFromMeta has real data
      mockGetOpenIssuesForRepo.mockResolvedValueOnce([
        {
          id: 1,
          repoName: 'PassCraft',
          issueNumber: 23,
          title: 'Filter crash',
          state: 'open',
          assigneeGithub: null,
          areaLabel: 'dashboard',
          typeLabel: 'bug',
          priorityLabel: 'high',
          sourceLabel: 'customer',
          isHotfix: false,
          htmlUrl: '/issues/23',
          createdAt: new Date('2026-04-10'),
          closedAt: null,
          updatedAt: null,
          claimedAt: null,
          lastTouchedAt: null,
        },
      ]);

      const payload = buildViewSubmissionPayload({
        callbackId: 'assign_step1_modal',
        user: { id: 'U_USER' },
        viewId: 'V_STEP1',
        privateMetadata: {
          channelId: 'C_BUGS',
          repoName: 'PassCraft',
          userId: 'U_USER',
          type: 'bug',
        },
      });

      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.response_action).toBe('update');
      expect(body.view).toBeDefined();
      expect(body.view.callback_id).toBe('assign_step2_modal');
    });
  });

  describe('Assign Tasks — Step 2 area dispatch', () => {
    it('picking an area triggers views.update with inline task preview', async () => {
      mockGetOpenIssuesForRepo.mockResolvedValueOnce([
        {
          id: 1,
          repoName: 'PassCraft',
          issueNumber: 23,
          title: 'Filter crash',
          state: 'open',
          assigneeGithub: null,
          areaLabel: 'dashboard',
          typeLabel: 'bug',
          priorityLabel: null,
          sourceLabel: null,
          isHotfix: false,
          htmlUrl: '/issues/23',
          createdAt: new Date('2026-04-10'),
          closedAt: null,
          updatedAt: null,
          claimedAt: null,
          lastTouchedAt: null,
        },
      ]);

      const payload = buildBlockActionsPayload({
        actionId: 'assign_area_picked',
        user: { id: 'U_USER' },
        channel: { id: 'C_BUGS' },
        selectedOption: { value: 'dashboard' },
        view: {
          id: 'V_STEP2',
          callbackId: 'assign_step2_modal',
          privateMetadata: {
            channelId: 'C_BUGS',
            repoName: 'PassCraft',
            userId: 'U_USER',
            type: 'bug',
          },
        },
      });

      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
      expect(mockViewsUpdate).toHaveBeenCalled();
    });
  });

  describe('Assign Tasks — Back button', () => {
    it('returns to Step 1 via views.update', async () => {
      const payload = buildBlockActionsPayload({
        actionId: 'assign_back_to_step1',
        user: { id: 'U_USER' },
        channel: { id: 'C_BUGS' },
        view: {
          id: 'V_STEP2',
          callbackId: 'assign_step2_modal',
          privateMetadata: {
            channelId: 'C_BUGS',
            repoName: 'PassCraft',
            userId: 'U_USER',
            type: 'bug',
          },
        },
      });

      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
      expect(mockViewsUpdate).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Edit Tasks Modal — type chooser
  // -------------------------------------------------------------------

  describe('Edit Tasks — type chooser', () => {
    it('clicking Bug button in edit_type_chooser swaps the view', async () => {
      const payload = buildBlockActionsPayload({
        actionId: 'edit_type_bug',
        user: { id: 'U_USER' },
        channel: { id: 'C_BUGS' },
        view: {
          id: 'V_EDIT',
          callbackId: 'edit_tasks_modal',
          privateMetadata: {
            channelId: 'C_BUGS',
            repoName: 'PassCraft',
            userId: 'U_USER',
            issueNumber: 23,
            type: 'feature',
          },
          stateValues: {
            title: { value: { type: 'plain_text_input', value: 'Filter crash' } },
            area: { value: { selected_option: { value: 'dashboard' } } },
          },
        },
      });

      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
      expect(mockViewsUpdate).toHaveBeenCalled();
    });

    it('clicking Feature button in edit_type_chooser swaps the view', async () => {
      const payload = buildBlockActionsPayload({
        actionId: 'edit_type_feature',
        user: { id: 'U_USER' },
        channel: { id: 'C_BUGS' },
        view: {
          id: 'V_EDIT',
          callbackId: 'edit_tasks_modal',
          privateMetadata: {
            channelId: 'C_BUGS',
            repoName: 'PassCraft',
            userId: 'U_USER',
            issueNumber: 23,
            type: 'bug',
          },
          stateValues: {
            title: { value: { type: 'plain_text_input', value: 'Filter crash' } },
            area: { value: { selected_option: { value: 'dashboard' } } },
            priority: { value: { selected_option: { value: 'high' } } },
            source: { value: { selected_option: { value: 'internal' } } },
          },
        },
      });

      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
      expect(mockViewsUpdate).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Bug Details Modal — the dropdown-driven details + comment flow
  // -------------------------------------------------------------------

  describe('Bug Details — open modal', () => {
    it('posts an ephemeral message when there are no open issues', async () => {
      mockGetOpenIssuesForRepo.mockResolvedValueOnce([]);
      const payload = buildBlockActionsPayload({
        actionId: 'bug_details',
        user: { id: 'U_USER' },
        channel: { id: 'C_BUGS' },
      });

      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
      expect(mockPostEphemeral).toHaveBeenCalled();
      expect(mockOpenModal).not.toHaveBeenCalled();
    });

    it('opens the modal when there are open issues', async () => {
      mockGetOpenIssuesForRepo.mockResolvedValueOnce([
        {
          id: 1,
          repoName: 'PassCraft',
          issueNumber: 23,
          title: 'Filter crash',
          state: 'open',
          assigneeGithub: null,
          areaLabel: 'dashboard',
          typeLabel: 'bug',
          priorityLabel: 'high',
          sourceLabel: 'customer',
          isHotfix: false,
          htmlUrl: '/issues/23',
          createdAt: new Date('2026-04-10'),
          closedAt: null,
          updatedAt: null,
          claimedAt: null,
          lastTouchedAt: null,
        },
      ]);

      const payload = buildBlockActionsPayload({
        actionId: 'bug_details',
        user: { id: 'U_USER' },
        channel: { id: 'C_BUGS' },
      });

      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
      expect(mockOpenModal).toHaveBeenCalled();
      // The 2nd argument to openModal is the view object
      const openCallArgs = mockOpenModal.mock.calls[0];
      const view = openCallArgs[1];
      expect(view.callback_id).toBe('bug_details_modal');
    });
  });

  describe('Bug Details — submission routing', () => {
    it('returns 200 when the modal is submitted with missing fields', async () => {
      // No stateValues => issueNumber will be 0 and comment empty,
      // so handleBugDetailsSubmission returns early. We just want to
      // verify the router dispatches correctly and returns 200.
      const payload = buildViewSubmissionPayload({
        callbackId: 'bug_details_modal',
        user: { id: 'U_USER' },
        privateMetadata: {
          channelId: 'C_BUGS',
          repoName: 'PassCraft',
          userId: 'U_USER',
        },
      });
      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------
  // Router coverage — unknown actions should not crash
  // -------------------------------------------------------------------

  describe('Router robustness', () => {
    it('returns 200 for an unknown action_id', async () => {
      const payload = buildBlockActionsPayload({
        actionId: 'this_action_does_not_exist',
        user: { id: 'U_USER' },
        channel: { id: 'C_BUGS' },
      });
      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
    });

    it('returns 200 for an unknown view_submission callback_id', async () => {
      const payload = buildViewSubmissionPayload({
        callbackId: 'unknown_modal',
        user: { id: 'U_USER' },
        privateMetadata: {},
      });
      const res = await postSlackInteractive(app, payload);
      expect(res.status).toBe(200);
    });

    it('returns 400 for malformed payload', async () => {
      const body = 'not_a_valid_form_body';
      const res = await app.request('/webhooks/slack-interactive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      expect(res.status).toBe(400);
    });
  });
});
