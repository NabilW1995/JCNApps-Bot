import { postChannelMessage, pinChannelMessage } from './dm.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Welcome Messages -- posted and pinned in channels
// ---------------------------------------------------------------------------

const TEAM_WELCOME_TEXT = [
  'Welcome to JCN Apps! :wave:',
  '',
  'New here? React with :white_check_mark: below to start your onboarding.',
  'The bot will guide you through setting up all your accounts.',
].join('\n');

/**
 * Build the welcome message text for an app channel.
 * Tells users to react with a checkmark to get access.
 */
function buildAppWelcomeText(appName: string): string {
  return [
    `Welcome to *${appName}*! :wave:`,
    '',
    'React with :white_check_mark: below to get access to:',
    `- GitHub repository for ${appName}`,
    '- Coolify deployment dashboard',
    '- Your personal preview URL',
    '',
    '_You must be registered in #team-general first._',
  ].join('\n');
}

/**
 * Post the welcome message to #team-general and pin it.
 *
 * This message is the entry point for the team registration flow --
 * new team members react with a checkmark to begin.
 *
 * Safe to call multiple times; each call posts a new message.
 * In practice, call this once during initial setup.
 */
export async function postWelcomeMessage(): Promise<void> {
  const channelId = process.env.TEAM_GENERAL_CHANNEL_ID;

  if (!channelId) {
    logger.warn('TEAM_GENERAL_CHANNEL_ID is not configured -- skipping welcome message');
    return;
  }

  try {
    const messageTs = await postChannelMessage(channelId, TEAM_WELCOME_TEXT);
    await pinChannelMessage(channelId, messageTs);

    logger.info('Welcome message posted and pinned', { channelId, messageTs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to post welcome message', { channelId, error: message });
  }
}

/**
 * Post a welcome message in an app channel and pin it.
 *
 * This message is the entry point for the app provisioning flow --
 * registered team members react with a checkmark to get repo access.
 */
export async function postAppWelcomeMessage(
  channelId: string,
  appName: string
): Promise<void> {
  if (!channelId) {
    logger.warn('No channel ID provided for app welcome message', { appName });
    return;
  }

  try {
    const text = buildAppWelcomeText(appName);
    const messageTs = await postChannelMessage(channelId, text);
    await pinChannelMessage(channelId, messageTs);

    logger.info('App welcome message posted and pinned', { channelId, appName, messageTs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to post app welcome message', { channelId, appName, error: message });
  }
}
