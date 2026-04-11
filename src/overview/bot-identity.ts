import { getWebClient, withRetry } from '../slack/client.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Bot Identity — detect our own user ID so we don't delete our messages
// ---------------------------------------------------------------------------

/**
 * Fetch the bot's own Slack user ID using the auth.test API.
 *
 * Called once on startup. Stores the result in process.env.BOT_USER_ID
 * so the read-only enforcement can skip the bot's own messages.
 */
export async function detectBotUserId(): Promise<void> {
  try {
    const client = getWebClient();
    const result = await withRetry(async () => client.auth.test());

    if (result.user_id) {
      process.env.BOT_USER_ID = result.user_id;
      logger.info('Bot user ID detected', { botUserId: result.user_id });
    } else {
      logger.warn('auth.test did not return a user_id');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to detect bot user ID', { error: message });
  }
}
