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
export function getWebClient(): WebClient {
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
 * Add an emoji reaction to a message. Silently ignores errors
 * (e.g. if the reaction already exists).
 */
export async function addReaction(
  channelId: string,
  messageTs: string,
  emoji: string
): Promise<void> {
  try {
    const client = getWebClient();
    await client.reactions.add({
      channel: channelId,
      timestamp: messageTs,
      name: emoji,
    });
  } catch {
    // Ignore — reaction may already exist
  }
}

/**
 * Get all reactions on a message.
 */
export async function getReactions(
  channelId: string,
  messageTs: string
): Promise<Array<{ name: string; count: number; users: string[] }>> {
  const client = getWebClient();
  const result = await client.reactions.get({
    channel: channelId,
    timestamp: messageTs,
    full: true,
  });
  return ((result.message as any)?.reactions as Array<{ name: string; count: number; users: string[] }>) ?? [];
}

/**
 * Post a reply in a thread.
 */
export async function postThreadReply(
  channelId: string,
  threadTs: string,
  text: string
): Promise<void> {
  const client = getWebClient();
  await client.chat.postMessage({
    channel: channelId,
    text,
    thread_ts: threadTs,
  });
}

// In-memory cache of canvas IDs per channel to avoid creating duplicates
const canvasIdCache = new Map<string, string>();

/**
 * Create or update a Canvas on a Slack channel.
 *
 * Tracks canvas IDs in memory to update existing canvases instead
 * of creating new ones. The title parameter sets the canvas name
 * on first creation.
 */
export async function createOrUpdateCanvas(
  channelId: string,
  markdownContent: string,
  title?: string
): Promise<void> {
  await withRetry(async () => {
    const client = getWebClient();

    // Check if we already know the canvas ID for this channel
    const cachedCanvasId = canvasIdCache.get(channelId);
    if (cachedCanvasId) {
      try {
        await (client as any).canvases.edit({
          canvas_id: cachedCanvasId,
          changes: [{
            operation: 'replace',
            document_content: {
              type: 'markdown',
              markdown: markdownContent,
            },
          }],
        });
        return;
      } catch {
        // Canvas might have been deleted — remove from cache and recreate
        canvasIdCache.delete(channelId);
      }
    }

    // Try to find existing canvas via channel info
    try {
      const info = await client.conversations.info({ channel: channelId });
      const channelData = info.channel as Record<string, any> | undefined;
      const existingCanvasId: string | null = channelData?.properties?.canvas?.file_id ?? null;

      if (existingCanvasId) {
        canvasIdCache.set(channelId, existingCanvasId);
        await (client as any).canvases.edit({
          canvas_id: existingCanvasId,
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

    // Create new canvas for the channel with a title
    const result = await (client as any).conversations.canvases.create({
      channel_id: channelId,
      document_content: {
        type: 'markdown',
        markdown: title ? `# ${title}\n\n${markdownContent}` : markdownContent,
      },
    });

    // Cache the new canvas ID
    if (result?.canvas_id) {
      canvasIdCache.set(channelId, result.canvas_id);
    }
  });
}

/**
 * Reset the singleton Web API client. Only used in tests
 * to ensure a fresh client between test runs.
 */
export function resetWebClient(): void {
  webClient = null;
}
