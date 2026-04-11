import { getWebClient, withRetry, setChannelTopic } from '../slack/client.js';
import { mergeBranchToMain } from './merge.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Preview Approval Flow
//
// Tracks checkmark reactions on preview deployment messages. When 3 unique
// team members react with :white_check_mark:, the bot signals readiness
// to merge. A subsequent :rocket: reaction triggers the actual GitHub merge.
// ---------------------------------------------------------------------------

/** Number of :white_check_mark: reactions required to approve.
 * The bot adds its own reaction, so threshold = 2 means bot + 1 user.
 * Change to 4 for bot + all 3 team members. */
const APPROVAL_THRESHOLD = 2;

export { APPROVAL_THRESHOLD };

/**
 * Tracks which preview messages have already been approved or merged,
 * preventing duplicate processing when additional reactions arrive.
 */
const processedPreviewApprovals = new Set<string>();

/**
 * Clear the processed approvals set. Used in tests to reset state.
 */
export function clearProcessedApprovals(): void {
  processedPreviewApprovals.clear();
}

/**
 * Check whether a preview message has been approved.
 * Exposed for testing.
 */
export function isPreviewApproved(channel: string, messageTs: string): boolean {
  return processedPreviewApprovals.has(`preview_approved:${channel}:${messageTs}`);
}

/**
 * Check whether a preview message has been merged.
 * Exposed for testing.
 */
export function isPreviewMerged(channel: string, messageTs: string): boolean {
  return processedPreviewApprovals.has(`preview_merged:${channel}:${messageTs}`);
}

// ---------------------------------------------------------------------------
// Preview Message Registry
// ---------------------------------------------------------------------------

export interface PreviewMessageInfo {
  channel: string;
  messageTs: string;
  repoName: string;
  branch: string;
  previewUrl: string;
}

/** Map of "channel:messageTs" -> preview message metadata */
const previewMessages = new Map<string, PreviewMessageInfo>();

/**
 * Register a preview message so we can match reactions to branches.
 * Called after posting a preview notification in the Coolify webhook handler.
 */
export function registerPreviewMessage(info: PreviewMessageInfo): void {
  const key = `${info.channel}:${info.messageTs}`;
  previewMessages.set(key, info);

  logger.info('Preview message registered', {
    channel: info.channel,
    messageTs: info.messageTs,
    repoName: info.repoName,
    branch: info.branch,
  });
}

/**
 * Look up a registered preview message by channel and timestamp.
 * Returns undefined if no preview message is registered for that location.
 */
export function getPreviewMessage(
  channel: string,
  messageTs: string
): PreviewMessageInfo | undefined {
  return previewMessages.get(`${channel}:${messageTs}`);
}

/**
 * Find a registered preview message by its branch name.
 * Used to match GitHub merge events back to the Slack preview message.
 */
export function findPreviewMessageByBranch(
  repoName: string,
  branch: string
): PreviewMessageInfo | undefined {
  for (const info of previewMessages.values()) {
    if (info.repoName === repoName && info.branch === branch) {
      return info;
    }
  }
  return undefined;
}

/**
 * Remove a preview message from the registry.
 * Called after a branch is merged to avoid stale entries.
 */
export function removePreviewMessage(channel: string, messageTs: string): void {
  previewMessages.delete(`${channel}:${messageTs}`);
}

// ---------------------------------------------------------------------------
// Slack API Helpers
// ---------------------------------------------------------------------------

interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

/**
 * Fetch all reactions on a specific message.
 * Returns an empty array if the API call fails or no reactions exist.
 */
async function getReactions(
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
 * Add an emoji reaction to a message. Silently ignores "already_reacted"
 * errors from the Slack API.
 */
async function addReaction(
  channel: string,
  timestamp: string,
  emoji: string
): Promise<void> {
  try {
    const client = getWebClient();
    await client.reactions.add({ channel, timestamp, name: emoji });
  } catch {
    // Reaction may already exist — safe to ignore
  }
}

/**
 * Post a threaded reply to a message.
 */
async function postThreadReply(
  channel: string,
  threadTs: string,
  text: string
): Promise<void> {
  const client = getWebClient();
  await client.chat.postMessage({ channel, text, thread_ts: threadTs });
}

// ---------------------------------------------------------------------------
// Core Approval Logic
// ---------------------------------------------------------------------------

/**
 * Process a reaction on a preview message.
 *
 * Handles two reaction types:
 *   - :white_check_mark: — counts approvals, triggers approval flow at threshold
 *   - :rocket: — triggers GitHub merge after approval is confirmed
 *
 * Idempotent: duplicate reactions on already-processed messages are ignored.
 */
export async function checkPreviewApproval(
  channel: string,
  messageTs: string,
  reaction: string,
  _user: string
): Promise<void> {
  const key = `${channel}:${messageTs}`;
  const info = previewMessages.get(key);
  if (!info) return;

  if (reaction === 'white_check_mark') {
    const approvalKey = `preview_approved:${key}`;
    if (processedPreviewApprovals.has(approvalKey)) return;

    // Fetch actual reaction data from Slack to verify count
    const reactions = await getReactions(channel, messageTs);
    const checkmarks = reactions.find((r) => r.name === 'white_check_mark');

    if (!checkmarks || checkmarks.count < APPROVAL_THRESHOLD) return;

    // Ensure reactions are from unique users
    if (checkmarks.users.length < APPROVAL_THRESHOLD) return;

    processedPreviewApprovals.add(approvalKey);

    logger.info('Preview approved by team', {
      channel,
      messageTs,
      repoName: info.repoName,
      branch: info.branch,
      approverCount: checkmarks.users.length,
    });

    // Signal readiness to merge
    await postThreadReply(
      channel,
      messageTs,
      ':tada: Preview approved!\n\nReact with :rocket: on this message to merge to master.'
    );

    // Update the original message to show APPROVED status
    try {
      const client = getWebClient();
      const approvedBlocks = [
        {
          type: 'section' as const,
          text: {
            type: 'mrkdwn' as const,
            text: `:white_check_mark: *APPROVED* — ${info.repoName}\n\n:link: ${info.previewUrl.replace(/^https?:\/\//, '')}\n:twisted_rightwards_arrows: Branch: \`${info.branch}\``,
          },
        },
        {
          type: 'context' as const,
          elements: [
            {
              type: 'mrkdwn' as const,
              text: `Approved by ${checkmarks.users.length} team members · React with :rocket: to merge to master`,
            },
          ],
        },
      ];
      await client.chat.update({
        channel,
        ts: messageTs,
        blocks: approvedBlocks,
        text: `APPROVED: ${info.repoName} — ${info.branch}`,
      });
    } catch (error) {
      logger.warn('Could not update preview message after approval', { error: (error as Error).message });
    }
  }

  if (reaction === 'rocket') {
    const mergeKey = `preview_merged:${key}`;
    if (processedPreviewApprovals.has(mergeKey)) return;

    // Only allow merge after the approval threshold was reached
    const approvalKey = `preview_approved:${key}`;
    if (!processedPreviewApprovals.has(approvalKey)) return;

    processedPreviewApprovals.add(mergeKey);

    logger.info('Preview merge triggered via Slack', {
      channel,
      messageTs,
      repoName: info.repoName,
      branch: info.branch,
    });

    const success = await mergeBranchToMain(info.repoName, info.branch);

    if (success) {
      await postThreadReply(
        channel,
        messageTs,
        `:white_check_mark: Merged \`${info.branch}\` to master! Coolify will deploy automatically.`
      );
      await addReaction(channel, messageTs, 'tada');

      // Reset channel topic — no active preview
      await setChannelTopic(channel, 'No active preview');

      // Update the original message to show MERGED status
      try {
        const client = getWebClient();
        const mergedBlocks = [
          {
            type: 'section' as const,
            text: {
              type: 'mrkdwn' as const,
              text: `:tada: *MERGED* — ${info.repoName}\n\n:twisted_rightwards_arrows: Branch \`${info.branch}\` merged to master\n:rocket: Coolify is deploying to production...`,
            },
          },
        ];
        await client.chat.update({
          channel,
          ts: messageTs,
          blocks: mergedBlocks,
          text: `MERGED: ${info.branch}`,
        });
      } catch (error) {
        logger.warn('Could not update preview message after merge', { error: (error as Error).message });
      }
    } else {
      await postThreadReply(
        channel,
        messageTs,
        ':x: Failed to merge. There might be conflicts \u2014 please merge manually in Claude or GitHub.'
      );
    }
  }
}

/**
 * Handle an external merge (e.g. via GitHub UI or Claude) for a branch
 * that has a registered preview message.
 *
 * Adds a :tada: reaction and posts a thread reply so the team knows
 * the merge already happened outside of Slack.
 */
export async function handleExternalMerge(
  repoName: string,
  branch: string
): Promise<void> {
  const info = findPreviewMessageByBranch(repoName, branch);
  if (!info) return;

  const key = `${info.channel}:${info.messageTs}`;
  const mergeKey = `preview_merged:${key}`;

  // Don't double-notify if we already handled this merge via Slack
  if (processedPreviewApprovals.has(mergeKey)) return;
  processedPreviewApprovals.add(mergeKey);

  logger.info('External merge detected for preview branch', {
    repoName,
    branch,
    channel: info.channel,
    messageTs: info.messageTs,
  });

  await addReaction(info.channel, info.messageTs, 'tada');
  await postThreadReply(
    info.channel,
    info.messageTs,
    ':white_check_mark: Already merged to master via GitHub.'
  );

  await setChannelTopic(info.channel, 'No active preview');
}
