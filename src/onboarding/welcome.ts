import { postChannelMessage, pinChannelMessage } from './dm.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Welcome Message — posted and pinned in #team-general
// ---------------------------------------------------------------------------

const WELCOME_MESSAGE_TEXT = [
  'Welcome to JCN Apps! :wave:',
  '',
  'New here? React with :white_check_mark: below to start your onboarding.',
  'The bot will guide you through setting up all your accounts.',
].join('\n');

/**
 * Post the welcome message to #team-general and pin it.
 *
 * This message is the entry point for the onboarding flow —
 * new team members react with a checkmark to begin.
 *
 * Safe to call multiple times; each call posts a new message.
 * In practice, call this once during initial setup.
 */
export async function postWelcomeMessage(): Promise<void> {
  const channelId = process.env.TEAM_GENERAL_CHANNEL_ID;

  if (!channelId) {
    logger.warn('TEAM_GENERAL_CHANNEL_ID is not configured — skipping welcome message');
    return;
  }

  try {
    const messageTs = await postChannelMessage(channelId, WELCOME_MESSAGE_TEXT);
    await pinChannelMessage(channelId, messageTs);

    logger.info('Welcome message posted and pinned', { channelId, messageTs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to post welcome message', { channelId, error: message });
  }
}
