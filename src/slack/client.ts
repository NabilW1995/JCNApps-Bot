import { IncomingWebhook } from '@slack/webhook';
import { WebClient } from '@slack/web-api';
import type { SlackBlock } from '../types.js';

// ---------------------------------------------------------------------------
// Retry Wrapper — handles Slack 429 rate limits with backoff
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3;

/**
 * Wrap a Slack API call with automatic retry on rate-limit (429) errors.
 *
 * When Slack returns a 429 it includes a Retry-After value telling us
 * how long to wait. We sleep for that duration and try again, up to
 * maxRetries times.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = DEFAULT_MAX_RETRIES
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const slackError = error as { code?: string; retryAfter?: number };
      if (
        slackError?.code === 'slack_webapi_rate_limited' &&
        attempt < maxRetries
      ) {
        const retryAfter = (slackError.retryAfter ?? 1) * 1000;
        console.warn(`Slack rate limited, retrying in ${retryAfter}ms...`);
        await new Promise((r) => setTimeout(r, retryAfter));
        continue;
      }
      throw error;
    }
  }
  // Should be unreachable but TypeScript needs an explicit return
  throw new Error('Max retries exceeded');
}

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

  await withRetry(async () => {
    const webhook = new IncomingWebhook(webhookUrl);
    await webhook.send({ blocks });
  });
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
  return withRetry(async () => {
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
  });
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
  await withRetry(async () => {
    const client = getWebClient();
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      blocks,
      text: text ?? 'Table updated',
    });
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
  await withRetry(async () => {
    const client = getWebClient();
    await client.pins.add({
      channel: channelId,
      timestamp: messageTs,
    });
  });
}

/**
 * Create or update a Canvas on a Slack channel.
 *
 * Slack Canvas API uses conversations.canvases.create for new canvases
 * and canvases.edit for updates. If the Canvas API is not available
 * (depends on Slack plan), this will throw — callers should catch.
 */
export async function createOrUpdateCanvas(
  channelId: string,
  markdownContent: string,
  _title?: string
): Promise<void> {
  await withRetry(async () => {
    const client = getWebClient();

    // Try to get existing canvas for this channel
    try {
      const info = await client.conversations.info({ channel: channelId });
      const channelData = info.channel as Record<string, any> | undefined;
      const canvasId: string | null = channelData?.properties?.canvas?.file_id ?? null;

      if (canvasId) {
        // Update existing canvas
        await (client as any).canvases.edit({
          canvas_id: canvasId,
          changes: [{
            operation: 'replace',
            document_content: {
              type: 'markdown',
              markdown: markdownContent,
            },
          }],
        });
        return;
      }
    } catch {
      // Canvas doesn't exist yet or API not available
    }

    // Create new canvas for the channel
    await (client as any).conversations.canvases.create({
      channel_id: channelId,
      document_content: {
        type: 'markdown',
        markdown: markdownContent,
      },
    });
  });
}

/**
 * Reset the singleton Web API client. Only used in tests
 * to ensure a fresh client between test runs.
 */
export function resetWebClient(): void {
  webClient = null;
}
