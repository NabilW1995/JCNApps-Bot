import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  buildBlockActionsPayload,
  buildViewSubmissionPayload,
  postSlackInteractive,
} from './slack-harness.js';

describe('Slack test harness', () => {
  describe('buildBlockActionsPayload', () => {
    it('builds a minimal block_actions payload with user + action', () => {
      const payload = buildBlockActionsPayload({
        actionId: 'test_action',
        user: { id: 'U123', name: 'nabil' },
      });

      expect(payload.type).toBe('block_actions');
      expect(payload.user.id).toBe('U123');
      expect(payload.actions[0].action_id).toBe('test_action');
      expect(payload.trigger_id).toBeTruthy();
    });

    it('includes selected_option when provided', () => {
      const payload = buildBlockActionsPayload({
        actionId: 'area_picked',
        user: { id: 'U1' },
        selectedOption: { value: 'dashboard' },
      });
      expect(payload.actions[0].selected_option.value).toBe('dashboard');
    });

    it('includes selected_options for multi-select', () => {
      const payload = buildBlockActionsPayload({
        actionId: 'tasks_picked',
        user: { id: 'U1' },
        selectedOptions: [{ value: '23' }, { value: '45' }],
      });
      expect(payload.actions[0].selected_options).toHaveLength(2);
      expect(payload.actions[0].selected_options[0].value).toBe('23');
    });

    it('serializes private_metadata as a JSON string (Slack format)', () => {
      const payload = buildBlockActionsPayload({
        actionId: 'x',
        user: { id: 'U1' },
        view: {
          id: 'V1',
          callbackId: 'some_modal',
          privateMetadata: { repoName: 'PassCraft', type: 'bug' },
        },
      });
      expect(typeof payload.view.private_metadata).toBe('string');
      expect(JSON.parse(payload.view.private_metadata)).toEqual({
        repoName: 'PassCraft',
        type: 'bug',
      });
    });
  });

  describe('buildViewSubmissionPayload', () => {
    it('builds a minimal view_submission with state.values', () => {
      const payload = buildViewSubmissionPayload({
        callbackId: 'assign_step3_modal',
        user: { id: 'U123' },
        privateMetadata: { repoName: 'PassCraft', taskNumbers: [23] },
        stateValues: {
          files: { value: { type: 'plain_text_input', value: 'src/x.ts' } },
        },
      });

      expect(payload.type).toBe('view_submission');
      expect(payload.view.callback_id).toBe('assign_step3_modal');
      expect(payload.view.state.values.files.value.value).toBe('src/x.ts');
    });
  });

  describe('postSlackInteractive', () => {
    it('form-encodes the payload and delivers it to the Hono route', async () => {
      let capturedBody = '';
      const app = new Hono();
      app.post('/webhooks/slack-interactive', async (c) => {
        capturedBody = await c.req.text();
        return c.json({ ok: true });
      });

      const payload = buildBlockActionsPayload({
        actionId: 'ping',
        user: { id: 'U1' },
      });
      const res = await postSlackInteractive(app, payload);

      expect(res.status).toBe(200);
      // Slack always sends the JSON as form field `payload=`
      expect(capturedBody).toMatch(/^payload=/);
      const decoded = decodeURIComponent(capturedBody.slice('payload='.length));
      const parsed = JSON.parse(decoded);
      expect(parsed.actions[0].action_id).toBe('ping');
    });
  });
});
