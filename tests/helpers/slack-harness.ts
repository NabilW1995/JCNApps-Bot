/**
 * Test harness for Slack interactive endpoint tests.
 *
 * Builds form-encoded payloads shaped like what Slack sends, and posts
 * them to the Hono app via `app.request()` — no real HTTP roundtrip.
 *
 * Usage:
 *
 *   import { buildBlockActionsPayload, postSlackInteractive } from '../helpers/slack-harness.js';
 *
 *   const payload = buildBlockActionsPayload({
 *     actionId: 'assign_pick_bug',
 *     user: { id: 'U123', name: 'nabil' },
 *     channel: { id: 'C_BUGS' },
 *     view: { id: 'V1', callbackId: 'assign_step1_modal', privateMetadata: {...} },
 *   });
 *   const res = await postSlackInteractive(app, payload);
 *   expect(res.status).toBe(200);
 *
 * Note: the real endpoint does NOT verify Slack signatures (yet), so no
 * signing is needed. Once we add signature verification we should also
 * update this harness to include a valid `x-slack-signature` header.
 */

import type { Hono } from 'hono';

export interface BuildBlockActionsOpts {
  actionId: string;
  user: { id: string; name?: string };
  channel?: { id: string };
  triggerId?: string;
  selectedOption?: { value: string; text?: string };
  selectedOptions?: Array<{ value: string; text?: string }>;
  view?: {
    id: string;
    callbackId: string;
    privateMetadata?: Record<string, unknown>;
    stateValues?: Record<string, Record<string, any>>;
  };
  messageTs?: string;
  messageBlocks?: any[];
}

export function buildBlockActionsPayload(opts: BuildBlockActionsOpts): any {
  const action: any = {
    action_id: opts.actionId,
    block_id: 'test_block',
  };
  if (opts.selectedOption) {
    action.selected_option = {
      value: opts.selectedOption.value,
      text: { type: 'plain_text', text: opts.selectedOption.text ?? opts.selectedOption.value },
    };
  }
  if (opts.selectedOptions) {
    action.selected_options = opts.selectedOptions.map((o) => ({
      value: o.value,
      text: { type: 'plain_text', text: o.text ?? o.value },
    }));
  }

  const payload: any = {
    type: 'block_actions',
    user: {
      id: opts.user.id,
      name: opts.user.name ?? 'testuser',
    },
    trigger_id: opts.triggerId ?? 'trigger-12345.67890.abcdef',
    actions: [action],
  };

  if (opts.channel) {
    payload.channel = { id: opts.channel.id, name: 'test-channel' };
  }

  if (opts.view) {
    payload.view = {
      id: opts.view.id,
      callback_id: opts.view.callbackId,
      private_metadata: JSON.stringify(opts.view.privateMetadata ?? {}),
      state: { values: opts.view.stateValues ?? {} },
    };
  }

  if (opts.messageTs || opts.messageBlocks) {
    payload.message = {
      ts: opts.messageTs ?? '1600000000.000100',
      blocks: opts.messageBlocks ?? [],
    };
  }

  return payload;
}

export interface BuildViewSubmissionOpts {
  callbackId: string;
  user: { id: string; name?: string };
  viewId?: string;
  privateMetadata?: Record<string, unknown>;
  stateValues?: Record<string, Record<string, any>>;
}

export function buildViewSubmissionPayload(opts: BuildViewSubmissionOpts): any {
  return {
    type: 'view_submission',
    user: {
      id: opts.user.id,
      name: opts.user.name ?? 'testuser',
    },
    view: {
      id: opts.viewId ?? 'V_TEST_0001',
      callback_id: opts.callbackId,
      private_metadata: JSON.stringify(opts.privateMetadata ?? {}),
      state: { values: opts.stateValues ?? {} },
    },
  };
}

/**
 * Post a Slack interactive payload to the Hono app. Returns the
 * Response object so tests can assert on status + body.
 */
export async function postSlackInteractive(app: Hono, payload: any): Promise<Response> {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) });
  return app.request('/webhooks/slack-interactive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}
