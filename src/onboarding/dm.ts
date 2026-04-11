import { withRetry } from '../slack/client.js';
import { WebClient } from '@slack/web-api';

// ---------------------------------------------------------------------------
// Slack DM Helpers — open direct message channels and send messages
// ---------------------------------------------------------------------------

let webClient: WebClient | null = null;

/**
 * Get or create the shared Slack Web API client.
 * Reuses the singleton from the main slack client module pattern.
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
 * Open a direct message channel with a Slack user.
 *
 * Uses conversations.open which is idempotent — calling it
 * multiple times for the same user returns the same channel ID.
 *
 * Returns the DM channel ID.
 */
export async function openDM(userId: string): Promise<string> {
  return withRetry(async () => {
    const client = getWebClient();
    const result = await client.conversations.open({ users: userId });

    if (!result.channel?.id) {
      throw new Error(`Failed to open DM channel with user ${userId}`);
    }

    return result.channel.id;
  });
}

// Stores the thread parent timestamp per DM channel
// so all onboarding messages stay in the same thread
const dmThreads = new Map<string, string>();

/**
 * Send a plain-text message in a DM channel.
 *
 * If a thread already exists for this channel (from a previous message),
 * the message is posted as a reply in that thread automatically.
 * The first message in a channel creates a new thread.
 *
 * Returns the message timestamp.
 */
export async function sendDM(
  channelId: string,
  text: string,
  threadTs?: string
): Promise<string> {
  // Use provided threadTs, or look up existing thread for this channel
  const effectiveThreadTs = threadTs ?? dmThreads.get(channelId);

  return withRetry(async () => {
    const client = getWebClient();
    const result = await client.chat.postMessage({
      channel: channelId,
      text,
      ...(effectiveThreadTs ? { thread_ts: effectiveThreadTs } : {}),
    });

    const ts = result.ts ?? '';

    // If this was the first message (no thread yet), save it as the thread parent
    if (!effectiveThreadTs && ts) {
      dmThreads.set(channelId, ts);
    }

    return ts;
  });
}

/**
 * Start a new thread in a DM channel.
 * Clears the existing thread so the next sendDM creates a new parent message.
 */
export function startNewDMThread(channelId: string): void {
  dmThreads.delete(channelId);
}

/**
 * Post a message to a channel (used for team announcements).
 *
 * Returns the message timestamp for pinning or reference.
 */
export async function postChannelMessage(
  channelId: string,
  text: string
): Promise<string> {
  return withRetry(async () => {
    const client = getWebClient();
    const result = await client.chat.postMessage({
      channel: channelId,
      text,
    });

    if (!result.ts) {
      throw new Error('Slack API did not return a message timestamp');
    }

    return result.ts;
  });
}

/**
 * Pin a message in a channel.
 */
export async function pinChannelMessage(
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
 * Reset the singleton Web API client. Used in tests
 * to ensure a fresh client between test runs.
 */
export function resetDMClient(): void {
  webClient = null;
}
