import { IncomingWebhook } from '@slack/webhook';
import type { SlackBlock } from '../types.js';

/**
 * Post a Block Kit message to a Slack channel via incoming webhook.
 *
 * Wraps the @slack/webhook library so the rest of the codebase does
 * not need to know about webhook internals. Throws on failure so
 * callers can handle errors explicitly.
 */
export async function postToChannel(
  webhookUrl: string,
  blocks: SlackBlock[]
): Promise<void> {
  if (!webhookUrl) {
    throw new Error('Slack webhook URL is not configured');
  }

  const webhook = new IncomingWebhook(webhookUrl);
  await webhook.send({ blocks });
}

// Planned for Phase 2 — update existing messages via Slack Web API
// export async function updateMessage(
//   channelId: string,
//   ts: string,
//   blocks: SlackBlock[]
// ): Promise<void> { ... }
