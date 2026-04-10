import { IncomingWebhook } from '@slack/webhook';
import { WebClient } from '@slack/web-api';
import type { SlackBlock } from '../types.js';

// ---------------------------------------------------------------------------
// Incoming Webhook (existing — for posting to webhook-configured channels)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Web API Client (Phase 4 — for pinned messages and live table updates)
// ---------------------------------------------------------------------------

let webClient: WebClient | null = null;

/**
 * Get or create the shared Slack Web API client.
 * Uses a singleton so the same client is reused across requests.
 * Throws if SLACK_BOT_TOKEN is not set.
 */
function getWebClient(): WebClient {
  if (!webClient) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error('SLACK_BOT_TOKEN is not configured');
    }
    webClient = new WebClient(token);
  }
  return webClient;
}

/**
 * Post a new Block Kit message to a channel via Web API.
 * Returns the message timestamp (ts) which is needed for pinning
 * and later updates.
 *
 * The `text` parameter is a plain-text fallback — Slack shows it in
 * notifications and when blocks can't render.
 */
export async function postMessage(
  channelId: string,
  blocks: SlackBlock[],
  text?: string
): Promise<string> {
  const client = getWebClient();
  const result = await client.chat.postMessage({
    channel: channelId,
    blocks,
    text: text ?? 'Table updated',
  });

  if (!result.ts) {
    throw new Error('Slack API did not return a message timestamp');
  }

  return result.ts;
}

/**
 * Update an existing message in place. Used for live tables that
 * refresh when issues change — the pinned message stays the same
 * but its content gets replaced.
 */
export async function updateMessage(
  channelId: string,
  messageTs: string,
  blocks: SlackBlock[],
  text?: string
): Promise<void> {
  const client = getWebClient();
  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    blocks,
    text: text ?? 'Table updated',
  });
}

/**
 * Pin a message in a channel. Called once when a table message
 * is first created — subsequent updates just edit the message
 * content without re-pinning.
 */
export async function pinMessage(
  channelId: string,
  messageTs: string
): Promise<void> {
  const client = getWebClient();
  await client.pins.add({
    channel: channelId,
    timestamp: messageTs,
  });
}

/**
 * Reset the singleton Web API client. Only used in tests
 * to ensure a fresh client between test runs.
 */
export function resetWebClient(): void {
  webClient = null;
}
