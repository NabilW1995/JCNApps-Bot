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

/**
 * Send a plain-text message in a DM channel.
 *
 * Uses chat.postMessage with the text parameter.
 * The text doubles as the notification fallback.
 */
export async function sendDM(channelId: string, text: string): Promise<void> {
  await withRetry(async () => {
    const client = getWebClient();
    await client.chat.postMessage({
      channel: channelId,
      text,
    });
  });
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
