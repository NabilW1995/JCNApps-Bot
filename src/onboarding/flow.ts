import { openDM, sendDM, postChannelMessage } from './dm.js';
import {
  inviteToGitHub,
  inviteToCoolify,
  createPreviewDNS,
  saveTeamMember,
} from './provision.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Onboarding Flow — manages the DM conversation state machine
// ---------------------------------------------------------------------------

/**
 * Each onboarding session tracks where the user is in the
 * question flow and what they've answered so far.
 */
export interface OnboardingState {
  userId: string;
  step: 'awaiting_name' | 'awaiting_github' | 'awaiting_email' | 'processing' | 'complete';
  name?: string;
  githubUsername?: string;
  email?: string;
  dmChannelId?: string;
}

// In-memory map of active onboarding sessions keyed by Slack user ID
const onboardingSessions = new Map<string, OnboardingState>();

/**
 * Get a user's current onboarding session, if one exists.
 */
export function getSession(userId: string): OnboardingState | undefined {
  return onboardingSessions.get(userId);
}

/**
 * Check whether a user has an active onboarding session.
 */
export function hasActiveSession(userId: string): boolean {
  const session = onboardingSessions.get(userId);
  if (!session) return false;
  // A session is active if it hasn't completed yet
  return session.step !== 'complete';
}

/**
 * Remove a user's onboarding session.
 * Called after completion or for cleanup.
 */
export function clearSession(userId: string): void {
  onboardingSessions.delete(userId);
}

/**
 * Get the count of active sessions (for monitoring).
 */
export function getActiveSessionCount(): number {
  return onboardingSessions.size;
}

/**
 * Start the onboarding flow for a new user.
 *
 * Opens a DM channel and sends the first question.
 * If the user already has an active session, this is a no-op
 * to prevent duplicate flows from multiple reactions.
 */
export async function startOnboarding(userId: string): Promise<void> {
  // Guard against duplicate sessions
  if (hasActiveSession(userId)) {
    logger.info('Onboarding already in progress, skipping', { userId });
    return;
  }

  try {
    const dmChannelId = await openDM(userId);

    const state: OnboardingState = {
      userId,
      step: 'awaiting_name',
      dmChannelId,
    };
    onboardingSessions.set(userId, state);

    await sendDM(
      dmChannelId,
      "Hey! :wave: Let's get you set up. What's your first name?"
    );

    logger.info('Onboarding started', { userId, dmChannelId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to start onboarding', { userId, error: message });
    // Clean up partial state so the user can try again
    onboardingSessions.delete(userId);
  }
}

// Simple email format validation
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GitHub username: 1-39 alphanumeric characters or hyphens, no leading/trailing hyphen
const GITHUB_USERNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/**
 * Handle a DM reply from a user who is in an onboarding flow.
 *
 * Advances through the question steps:
 *   awaiting_name   -> save name, ask for GitHub username
 *   awaiting_github  -> save github, ask for email
 *   awaiting_email   -> save email, run provisioning
 *
 * Ignores messages from users who are not in an active session.
 */
export async function handleDMReply(
  userId: string,
  text: string
): Promise<void> {
  const session = onboardingSessions.get(userId);
  if (!session || !session.dmChannelId) return;

  // Don't process messages while provisioning is running
  if (session.step === 'processing' || session.step === 'complete') return;

  const trimmedText = text.trim();
  if (!trimmedText) return;

  switch (session.step) {
    case 'awaiting_name': {
      // Validate name length
      if (trimmedText.length > 64) {
        await sendDM(session.dmChannelId, 'That name is too long. Please use 64 characters or fewer.');
        return;
      }
      session.name = trimmedText;
      session.step = 'awaiting_github';
      await sendDM(
        session.dmChannelId,
        `Nice to meet you, ${session.name}! What's your GitHub username?`
      );
      break;
    }

    case 'awaiting_github': {
      // Validate GitHub username format
      if (!GITHUB_USERNAME_PATTERN.test(trimmedText)) {
        await sendDM(
          session.dmChannelId,
          'That doesn\'t look like a valid GitHub username. It should be 1-39 characters, using letters, numbers, or hyphens. Please try again.'
        );
        return;
      }
      session.githubUsername = trimmedText;
      session.step = 'awaiting_email';
      await sendDM(
        session.dmChannelId,
        'What email should we use for your Coolify account?'
      );
      break;
    }

    case 'awaiting_email': {
      // Validate email format
      if (!EMAIL_PATTERN.test(trimmedText)) {
        await sendDM(
          session.dmChannelId,
          'That doesn\'t look like a valid email address. Please try again.'
        );
        return;
      }
      session.email = trimmedText;
      session.step = 'processing';
      await sendDM(
        session.dmChannelId,
        'Got it! Setting everything up... :hourglass_flowing_sand:'
      );
      await provisionUser(session);
      break;
    }
  }
}

/**
 * Run all the automated provisioning steps for a new team member.
 *
 * Called after all three questions have been answered.
 * Each step is independent — if one fails, the others still run.
 * The user gets a summary of what succeeded and what failed.
 */
export async function provisionUser(state: OnboardingState): Promise<void> {
  if (!state.name || !state.githubUsername || !state.email || !state.dmChannelId) {
    logger.error('Cannot provision user — incomplete state', { state });
    return;
  }

  const results = {
    github: false,
    coolify: false,
    dns: false,
    database: false,
  };

  // Run all provisioning steps — each one is independent
  try {
    results.github = await inviteToGitHub(state.githubUsername);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('GitHub provisioning failed', { error: message });
  }

  try {
    results.coolify = await inviteToCoolify(state.email);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Coolify provisioning failed', { error: message });
  }

  // Use lowercase first name for the subdomain
  const previewName = state.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
  try {
    results.dns = await createPreviewDNS(previewName);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('DNS provisioning failed', { error: message });
  }

  try {
    await saveTeamMember(state.name, state.githubUsername, state.userId);
    results.database = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Database save failed', { error: message });
  }

  // Post announcement in #team-general
  const teamGeneralChannelId = process.env.TEAM_GENERAL_CHANNEL_ID;
  if (teamGeneralChannelId) {
    try {
      await postChannelMessage(
        teamGeneralChannelId,
        `${state.name} just joined the team! :tada:`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to post team announcement', { error: message });
    }
  }

  // Build a summary of what was set up
  const summaryLines = [
    "You're all set! Here's what was created:",
    '',
    results.github
      ? `- *GitHub:* Invitation sent to ${state.githubUsername} (check your email)`
      : `- *GitHub:* :warning: Invitation failed — ask an admin to invite ${state.githubUsername} manually`,
    results.coolify
      ? `- *Coolify:* Invitation sent to ${state.email} (check your email)`
      : `- *Coolify:* :warning: Invitation failed — ask an admin to add ${state.email} manually`,
    results.dns
      ? `- *Preview URL:* preview-${previewName}.passcraft.pro`
      : `- *Preview URL:* :warning: DNS setup failed — ask an admin to create it manually`,
    '',
    'Next steps:',
    '1. Read the Canvas tabs in #team-general',
    '2. Set up your Slack sidebar sections',
    '3. Clone the repo and open Claude Code',
    '4. Pick your first task and deploy!',
  ];

  await sendDM(state.dmChannelId, summaryLines.join('\n'));

  state.step = 'complete';

  logger.info('Onboarding provisioning completed', {
    userId: state.userId,
    name: state.name,
    results,
  });
}
