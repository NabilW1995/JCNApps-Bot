import { WebClient } from '@slack/web-api';
import { withRetry } from '../slack/client.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Idea Voting — tracks :+1: reactions in #team-ideas
//
// When a message in #team-ideas receives 3 thumbs-up reactions from
// 3 different users, the bot considers the idea approved and kicks
// off the draft channel creation flow.
// ---------------------------------------------------------------------------

/** Number of unique :+1: reactions required to approve an idea */
const APPROVAL_THRESHOLD = 3;

/**
 * Track which idea messages have already been approved to avoid
 * triggering the flow twice if additional reactions arrive.
 */
const processedApprovals = new Set<string>();

/**
 * Clear the approval tracking set. Used in tests to reset state.
 */
export function clearProcessedApprovals(): void {
  processedApprovals.clear();
}

/**
 * Check whether an idea message has already been processed.
 * Exposed for testing.
 */
export function isIdeaProcessed(channel: string, messageTs: string): boolean {
  return processedApprovals.has(`idea:${channel}:${messageTs}`);
}

// ---------------------------------------------------------------------------
// Slack API Helpers
// ---------------------------------------------------------------------------

let webClient: WebClient | null = null;

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
 * Reset the singleton Web API client. Used in tests.
 */
export function resetVotingClient(): void {
  webClient = null;
}

interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

/**
 * Fetch all reactions on a specific message.
 * Returns an empty array if the API call fails or the message has no reactions.
 */
export async function getReactions(
  channel: string,
  timestamp: string
): Promise<SlackReaction[]> {
  return withRetry(async () => {
    const client = getWebClient();
    const result = await client.reactions.get({
      channel,
      timestamp,
      full: true,
    });

    const message = result.message as Record<string, unknown> | undefined;
    return (message?.reactions as SlackReaction[] | undefined) ?? [];
  });
}

/**
 * Fetch the text content of a specific message by its timestamp.
 * Used to copy the original idea text into the draft channel.
 */
export async function getMessageText(
  channel: string,
  timestamp: string
): Promise<string> {
  return withRetry(async () => {
    const client = getWebClient();
    const result = await client.conversations.history({
      channel,
      latest: timestamp,
      inclusive: true,
      limit: 1,
    });

    return result.messages?.[0]?.text ?? '';
  });
}

/**
 * Post a threaded reply to a message in a channel.
 * Returns the timestamp of the new reply.
 */
export async function postThreadReply(
  channel: string,
  threadTs: string,
  text: string
): Promise<string> {
  return withRetry(async () => {
    const client = getWebClient();
    const result = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
    });

    return result.ts ?? '';
  });
}

/**
 * Post a message to a channel (not threaded).
 * Returns the timestamp.
 */
export async function postToChannel(
  channel: string,
  text: string
): Promise<string> {
  return withRetry(async () => {
    const client = getWebClient();
    const result = await client.chat.postMessage({
      channel,
      text,
    });

    return result.ts ?? '';
  });
}

// ---------------------------------------------------------------------------
// Core Voting Logic
// ---------------------------------------------------------------------------

/**
 * Callback invoked when an idea is fully approved.
 * Set by the ideas module wiring so voting doesn't depend on draft.
 */
let onIdeaApproved: ((channel: string, messageTs: string) => Promise<void>) | null = null;

/**
 * Register the callback that fires when an idea reaches the approval threshold.
 * Called once during module initialization to wire voting -> draft.
 */
export function setOnIdeaApproved(
  callback: (channel: string, messageTs: string) => Promise<void>
): void {
  onIdeaApproved = callback;
}

/**
 * Check whether an idea message has enough :+1: reactions to be approved.
 *
 * Called on every reaction_added event for +1/thumbsup. Performs these checks:
 *   1. Is this the #team-ideas channel?
 *   2. Have we already processed this message?
 *   3. Does the message have >= APPROVAL_THRESHOLD unique thumbs-up reactors?
 *
 * If all conditions pass, marks the idea as processed and fires the callback.
 */
export async function checkIdeaApproval(
  channel: string,
  messageTs: string,
  reaction: string,
  _reactingUser: string
): Promise<void> {
  // Only care about :+1: reactions
  if (reaction !== '+1' && reaction !== 'thumbsup') return;

  // Don't process same message twice
  const key = `idea:${channel}:${messageTs}`;
  if (processedApprovals.has(key)) return;

  // Check if this is in the team-ideas channel
  const ideasChannelId = process.env.TEAM_IDEAS_CHANNEL_ID;
  if (!ideasChannelId) {
    logger.warn('TEAM_IDEAS_CHANNEL_ID is not configured');
    return;
  }

  if (channel !== ideasChannelId) return;

  // Get actual reaction count from Slack to verify
  const reactions = await getReactions(channel, messageTs);
  const thumbsUp = reactions.find(
    (r) => r.name === '+1' || r.name === 'thumbsup'
  );

  if (!thumbsUp || thumbsUp.count < APPROVAL_THRESHOLD) return;

  // Ensure the reactions are from unique users (Slack guarantees this
  // in the users array, but we check length for safety)
  if (thumbsUp.users.length < APPROVAL_THRESHOLD) return;

  processedApprovals.add(key);

  logger.info('Idea approved', {
    channel,
    messageTs,
    reactionCount: thumbsUp.count,
    uniqueUsers: thumbsUp.users.length,
  });

  if (onIdeaApproved) {
    await onIdeaApproved(channel, messageTs);
  }
}

export { APPROVAL_THRESHOLD };
