import { getWebClient, withRetry } from '../slack/client.js';
import { openDM, sendDM } from '../onboarding/dm.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Read-Only Enforcement for #team-overview
// ---------------------------------------------------------------------------

/**
 * Delete non-bot messages from the overview channel and notify the user.
 *
 * The overview channel is bot-managed: only the bot should post there.
 * When a human accidentally writes in it, we remove the message and
 * send them a friendly DM explaining where to chat instead.
 */
export async function enforceReadOnly(
  channel: string,
  user: string,
  messageTs: string
): Promise<void> {
  const overviewChannelId = process.env.OVERVIEW_CHANNEL_ID;
  if (!overviewChannelId || channel !== overviewChannelId) return;

  // Don't delete the bot's own messages
  const botUserId = process.env.BOT_USER_ID;
  if (botUserId && user === botUserId) return;

  const client = getWebClient();

  // Delete the message from the overview channel
  try {
    await withRetry(async () => {
      await client.chat.delete({ channel, ts: messageTs });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to delete message from overview channel', {
      channel,
      user,
      messageTs,
      error: message,
    });
    return;
  }

  // DM the user explaining why their message was removed
  try {
    const dmChannel = await openDM(user);
    await sendDM(
      dmChannel,
      ':no_entry: `#team-overview` is a read-only channel managed by the bot. ' +
        'Your message has been removed.\n\n' +
        'If you need to discuss something, please use `#team-general` instead.'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to DM user about read-only enforcement', {
      user,
      error: message,
    });
  }

  logger.info('Enforced read-only in overview channel', { user, messageTs });
}
