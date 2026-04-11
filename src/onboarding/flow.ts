import { openDM, sendDM, postChannelMessage, startNewDMThread } from './dm.js';
import {
  inviteToGitHub,
  inviteToCoolify,
  createPreviewDNS,
  saveTeamMember,
} from './provision.js';
import { getTeamMemberBySlackId } from '../db/queries.js';
import { getDb } from '../db/client.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Onboarding Flow -- two-flow state machine
//
// Flow 1: Team Registration (from #team-general)
//   Collects name, GitHub username, email. Saves to DB.
//
// Flow 2: App Provisioning (from app channels like #passcraft-pro)
//   Looks up existing registration, confirms details, then provisions
//   GitHub repo access, Coolify invite, and preview DNS.
// ---------------------------------------------------------------------------

/**
 * Each onboarding session tracks where the user is in the
 * question flow and what they've answered so far.
 */
export interface OnboardingState {
  userId: string;
  dmChannelId?: string;
  /** Thread timestamp — all messages stay in this thread */
  threadTs?: string;
  flow: 'team' | 'app';
  step:
    | 'awaiting_name'
    | 'awaiting_github'
    | 'awaiting_email'
    | 'awaiting_confirm'
    | 'processing'
    | 'complete';
  name?: string;
  githubUsername?: string;
  email?: string;
  /** For app flow: which repository to provision access for */
  appRepoName?: string;
  /** For app flow: which Slack channel the reaction came from */
  appChannelId?: string;
}

// In-memory map of active onboarding sessions keyed by Slack user ID
const onboardingSessions = new Map<string, OnboardingState>();

/**
 * Send a DM reply within the onboarding thread.
 * All onboarding messages stay in the same thread for a clean chat history.
 */
async function reply(session: OnboardingState, text: string): Promise<void> {
  if (!session.dmChannelId) return;
  await sendDM(session.dmChannelId, text, session.threadTs);
}

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

// ---------------------------------------------------------------------------
// Flow 1: Team Registration -- triggered from #team-general
// ---------------------------------------------------------------------------

/**
 * Start the team registration flow for a new user.
 *
 * Opens a DM channel and sends the first question (name).
 * If the user already has an active session, this is a no-op
 * to prevent duplicate flows from multiple reactions.
 */
export async function startTeamOnboarding(userId: string): Promise<void> {
  if (hasActiveSession(userId)) {
    logger.info('Onboarding already in progress, skipping', { userId });
    return;
  }

  try {
    const dmChannelId = await openDM(userId);

    // Send the first message — this becomes the thread parent
    const threadTs = await sendDM(
      dmChannelId,
      ":wave: *Welcome to JCN Apps — Onboarding*\n\nLet's get you set up. What's your *first name*?"
    );

    const state: OnboardingState = {
      userId,
      dmChannelId,
      threadTs,
      flow: 'team',
      step: 'awaiting_name',
    };
    onboardingSessions.set(userId, state);

    logger.info('Team onboarding started', { userId, dmChannelId, threadTs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to start team onboarding', { userId, error: message });
    onboardingSessions.delete(userId);
  }
}

// ---------------------------------------------------------------------------
// Flow 2: App Provisioning -- triggered from app channels
// ---------------------------------------------------------------------------

/**
 * Start the app provisioning flow for an existing team member.
 *
 * Looks up the user in the database to check if they are registered.
 * If not, directs them to #team-general first.
 * If yes, confirms their details and provisions repo access.
 */
export async function startAppOnboarding(
  userId: string,
  repoName: string,
  channelId: string
): Promise<void> {
  if (hasActiveSession(userId)) {
    logger.info('Onboarding already in progress, skipping', { userId });
    return;
  }

  try {
    const dmChannelId = await openDM(userId);

    // Check if the user is already registered in the database
    let member: { name: string; githubUsername: string; email: string | null } | null = null;
    try {
      const db = getDb();
      member = await getTeamMemberBySlackId(db, userId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Could not look up team member in DB', { userId, error: msg });
    }

    if (!member) {
      // User not registered -- tell them to go to #team-general first
      startNewDMThread(dmChannelId);
      await sendDM(
        dmChannelId,
        "You need to register first! Go to `#team-general` and react with :white_check_mark: on the Welcome message."
      );
      logger.info('App onboarding blocked -- user not registered', { userId, repoName });
      return;
    }

    // Start a new thread for this app onboarding (separate from team thread)
    startNewDMThread(dmChannelId);

    // User exists -- confirm their details before provisioning
    const state: OnboardingState = {
      userId,
      dmChannelId,
      flow: 'app',
      step: 'awaiting_confirm',
      name: member.name,
      githubUsername: member.githubUsername,
      email: member.email ?? undefined,
      appRepoName: repoName,
      appChannelId: channelId,
    };
    onboardingSessions.set(userId, state);

    await sendDM(
      dmChannelId,
      `Setting you up for *${repoName}*! :rocket:\n\nI have your details:\n- *Name:* ${member.name}\n- *GitHub:* ${member.githubUsername}\n\nIs this correct? Reply *yes* to confirm, or *no* to update.`
    );

    logger.info('App onboarding started', { userId, repoName, channelId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to start app onboarding', { userId, repoName, error: message });
    onboardingSessions.delete(userId);
  }
}

// ---------------------------------------------------------------------------
// DM Reply Handler -- routes replies to the correct flow step
// ---------------------------------------------------------------------------

// Simple email format validation
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Slack auto-formats emails as <mailto:user@example.com|user@example.com>
// This extracts the actual email address from that format
function extractEmail(text: string): string {
  const mailtoMatch = text.match(/<mailto:([^|>]+)\|?[^>]*>/);
  if (mailtoMatch) return mailtoMatch[1];
  return text.trim();
}

// GitHub username: 1-39 alphanumeric or hyphens, no leading/trailing hyphen
const GITHUB_USERNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/**
 * Handle a DM reply from a user who is in an onboarding flow.
 *
 * Advances through the question steps based on the current flow:
 *
 * Team flow:
 *   awaiting_name    -> save name, ask for GitHub username
 *   awaiting_github  -> save github, ask for email
 *   awaiting_email   -> save email, run team registration
 *
 * App flow:
 *   awaiting_confirm -> YES: provision app access / NO: restart details
 *   awaiting_name    -> (if updating) save name, ask for GitHub
 *   awaiting_github  -> save github, ask for email
 *   awaiting_email   -> save email, provision app access
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

  logger.info('Onboarding DM reply', {
    userId,
    flow: session.flow,
    step: session.step,
    textPreview: trimmedText.substring(0, 50),
  });

  switch (session.step) {
    case 'awaiting_name': {
      if (trimmedText.length > 64) {
        await sendDM(session.dmChannelId, 'That name is too long. Please use 64 characters or fewer.');
        return;
      }
      session.name = trimmedText;
      session.step = 'awaiting_github';
      await sendDM(
        session.dmChannelId,
        `Nice to meet you, *${session.name}*! :tada:\n\nWhat's your *GitHub username*?`
      );
      break;
    }

    case 'awaiting_github': {
      if (!GITHUB_USERNAME_PATTERN.test(trimmedText)) {
        await sendDM(
          session.dmChannelId,
          "That doesn't look like a valid GitHub username. It should be 1-39 characters, using letters, numbers, or hyphens. Please try again."
        );
        return;
      }
      session.githubUsername = trimmedText;
      session.step = 'awaiting_email';
      await sendDM(
        session.dmChannelId,
        `Got it! GitHub: *${session.githubUsername}*\n\nWhat *email address* should we use for Coolify access?`
      );
      break;
    }

    case 'awaiting_email': {
      const email = extractEmail(trimmedText);
      if (!EMAIL_PATTERN.test(email)) {
        await sendDM(
          session.dmChannelId,
          "That doesn't look like a valid email address. Please try again."
        );
        return;
      }
      session.email = email;
      session.step = 'processing';

      if (session.flow === 'team') {
        await sendDM(
          session.dmChannelId,
          'Got it! Setting everything up... :hourglass_flowing_sand:'
        );
        await processTeamOnboarding(session);
      } else {
        await sendDM(
          session.dmChannelId,
          `Got it! Setting up your access for *${session.appRepoName}*... :hourglass_flowing_sand:`
        );
        await processAppOnboarding(session);
      }
      break;
    }

    case 'awaiting_confirm': {
      const answer = trimmedText.toLowerCase();
      if (answer === 'yes' || answer === 'y') {
        session.step = 'processing';
        await processAppOnboarding(session);
      } else {
        // Let them update their details
        session.step = 'awaiting_name';
        await sendDM(
          session.dmChannelId,
          "OK, let's update your details. What's your *first name*?"
        );
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Team Registration Processing
// ---------------------------------------------------------------------------

/**
 * Run the team registration steps after all questions are answered.
 *
 * Saves the user to the database and posts a welcome announcement
 * in #team-general. Does NOT provision GitHub/Coolify/DNS -- that
 * happens in the app flow when they join a specific app channel.
 */
export async function processTeamOnboarding(
  state: OnboardingState
): Promise<void> {
  if (!state.name || !state.githubUsername || !state.email || !state.dmChannelId) {
    logger.error('Cannot process team onboarding -- incomplete state', {
      userId: state.userId,
    });
    return;
  }

  // Save to database
  let dbSaved = false;
  try {
    await saveTeamMember(state.name, state.githubUsername, state.userId, state.email);
    dbSaved = true;
    logger.info('Team member saved', {
      name: state.name,
      github: state.githubUsername,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to save team member', { error: message });
  }

  // Post announcement in #team-general
  const teamGeneralChannelId = process.env.TEAM_GENERAL_CHANNEL_ID;
  if (teamGeneralChannelId) {
    try {
      await postChannelMessage(
        teamGeneralChannelId,
        `:tada: *${state.name}* just joined the team!\n\nGitHub: ${state.githubUsername}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to post team announcement', { error: message });
    }
  }

  state.step = 'complete';
  onboardingSessions.delete(state.userId);

  const statusLine = dbSaved
    ? ':white_check_mark: *Registration saved!*'
    : ':warning: Registration could not be saved -- please contact an admin.';

  await sendDM(
    state.dmChannelId,
    `${statusLine}\n\nYour details:\n- *Name:* ${state.name}\n- *GitHub:* ${state.githubUsername}\n- *Email:* ${state.email}\n\n*Next step:* Go to an app channel (e.g. \`#passcraft-pro\`) and react with :white_check_mark: on the Welcome message to get access to that app's repo, Coolify, and preview URL.`
  );

  logger.info('Team onboarding completed', {
    userId: state.userId,
    name: state.name,
    dbSaved,
  });
}

// ---------------------------------------------------------------------------
// App Provisioning Processing
// ---------------------------------------------------------------------------

/**
 * Run all automated provisioning steps for an app:
 *   1. GitHub repo invitation
 *   2. Coolify team invitation
 *   3. Cloudflare preview DNS record
 *   4. Announcement in the app channel
 *
 * Each step is independent -- if one fails, the others still run.
 */
export async function processAppOnboarding(
  state: OnboardingState
): Promise<void> {
  if (!state.name || !state.githubUsername || !state.dmChannelId || !state.appRepoName) {
    logger.error('Cannot process app onboarding -- incomplete state', {
      userId: state.userId,
    });
    return;
  }

  const repoName = state.appRepoName;
  const previewName = state.name.toLowerCase().replace(/[^a-z0-9-]/g, '');

  await sendDM(state.dmChannelId, `Setting up your access for *${repoName}*... :gear:`);

  const results: string[] = [];

  // 1. GitHub Repo Invite
  try {
    const success = await inviteToGitHub(state.githubUsername);
    results.push(
      success
        ? `:white_check_mark: GitHub: Invitation sent to *${state.githubUsername}*`
        : ':warning: GitHub: Could not send invitation -- ask an admin'
    );
  } catch (error) {
    results.push(`:x: GitHub: ${(error as Error).message}`);
  }

  // 2. Coolify Access (only if email is available)
  if (state.email) {
    try {
      const success = await inviteToCoolify(state.email);
      results.push(
        success
          ? `:white_check_mark: Coolify: Invitation sent to *${state.email}*`
          : ':warning: Coolify: Could not send invitation -- ask an admin'
      );
    } catch (error) {
      results.push(`:x: Coolify: ${(error as Error).message}`);
    }
  } else {
    results.push(':warning: Coolify: No email on file -- ask an admin to add you');
  }

  // 3. Cloudflare Preview DNS
  try {
    const success = await createPreviewDNS(previewName);
    results.push(
      success
        ? `:white_check_mark: Preview URL: *preview-${previewName}.passcraft.pro*`
        : ':warning: DNS: Could not create preview URL -- ask an admin'
    );
  } catch (error) {
    results.push(`:x: DNS: ${(error as Error).message}`);
  }

  // 4. Post announcement in the app channel
  if (state.appChannelId) {
    try {
      await postChannelMessage(
        state.appChannelId,
        `:tada: *${state.name}* joined ${repoName}!\nPreview: preview-${previewName}.passcraft.pro`
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to post app welcome', { error: msg });
    }
  }

  state.step = 'complete';
  onboardingSessions.delete(state.userId);

  await sendDM(
    state.dmChannelId,
    `:rocket: *All set for ${repoName}!*\n\n${results.join('\n')}\n\n*Next steps:*\n1. Accept the GitHub invitation (check your email)\n2. Accept the Coolify invitation (check your email)\n3. Clone the repo and open Claude Code\n4. Pick your first task!`
  );

  logger.info('App onboarding completed', {
    userId: state.userId,
    name: state.name,
    repoName,
  });
}
