import type { Context } from 'hono';
import { startTeamOnboarding, startAppOnboarding, handleDMReply } from '../onboarding/flow.js';
import { getRepoNameFromChannel } from '../config/channels.js';
import { checkIdeaApproval, setOnIdeaApproved } from '../ideas/voting.js';
import { handleIdeaApproved, checkDraftApproval, handleThreadReply } from '../ideas/draft.js';
import { checkPreviewApproval } from '../preview/approval.js';
import { handleIssueThreadReply, getPendingRollback, clearPendingRollback, getAwaitingHotfix, clearAwaitingHotfix, getBugMessage } from './slack-interactive.js';
import { enforceReadOnly } from '../overview/readonly.js';
import { refreshOverviewDashboard } from '../overview/dashboard.js';
import { getWebClient, setChannelTopic } from '../slack/client.js';
import { markBotCreatedIssue } from './github.js';
import { logger } from '../utils/logger.js';

// Wire the voting -> draft approval callback once at module load
setOnIdeaApproved(handleIdeaApproved);

// ---------------------------------------------------------------------------
// Slack Events API Types
// ---------------------------------------------------------------------------

interface SlackUrlVerification {
  type: 'url_verification';
  challenge: string;
}

interface SlackReactionAddedEvent {
  type: 'reaction_added';
  user: string;
  reaction: string;
  item: {
    type: string;
    channel: string;
    ts: string;
  };
  event_ts: string;
}

interface SlackMessageEvent {
  type: 'message';
  subtype?: string;
  user?: string;
  text?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

interface SlackEventCallback {
  type: 'event_callback';
  event: SlackReactionAddedEvent | SlackMessageEvent;
  event_id: string;
}

type SlackEventPayload = SlackUrlVerification | SlackEventCallback;

// ---------------------------------------------------------------------------
// Idempotency -- prevent duplicate processing of the same event
// ---------------------------------------------------------------------------

const processedEvents = new Set<string>();
const MAX_EVENT_CACHE = 1000;

/**
 * Check whether a Slack event ID has already been processed.
 * Slack retries events if it doesn't get a 200 within 3 seconds,
 * so we need to deduplicate.
 */
function isAlreadyProcessed(eventId: string): boolean {
  if (processedEvents.has(eventId)) return true;

  processedEvents.add(eventId);

  if (processedEvents.size > MAX_EVENT_CACHE) {
    const first = processedEvents.values().next().value;
    if (first) processedEvents.delete(first);
  }

  return false;
}

/**
 * Clear the event cache. Used in tests to reset state between runs.
 */
export function clearEventCache(): void {
  processedEvents.clear();
}

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

/**
 * Handle a reaction_added event.
 *
 * Routes reactions to the correct onboarding flow based on which
 * channel the reaction occurred in:
 *   - #team-general -> team registration flow
 *   - App channels  -> per-app provisioning flow
 */
async function handleOnboardingReaction(
  event: SlackReactionAddedEvent
): Promise<void> {
  if (event.reaction !== 'white_check_mark') return;

  const teamGeneralId = process.env.TEAM_GENERAL_CHANNEL_ID;
  const channelId = event.item.channel;

  // Skip onboarding entirely if the reaction is on a registered bug message
  // (those checkmarks are for closing issues, not onboarding)
  const bug = getBugMessage(channelId, event.item.ts);
  if (bug) return;

  // Skip if already in team (don't re-onboard existing members)
  try {
    const { getDb } = await import('../db/client.js');
    const { getTeamMemberBySlackId } = await import('../db/queries.js');
    const db = getDb();
    const existingMember = await getTeamMemberBySlackId(db, event.user);
    if (existingMember) return;
  } catch { /* if DB check fails, continue with onboarding */ }

  logger.info('Onboarding reaction detected', {
    userId: event.user,
    channel: channelId,
    isTeamGeneral: channelId === teamGeneralId,
  });

  if (channelId === teamGeneralId) {
    await startTeamOnboarding(event.user);
  } else {
    const repoName = getRepoNameFromChannel(channelId);
    if (repoName) {
      await startAppOnboarding(event.user, repoName, channelId);
    }
  }
}

/**
 * Handle a message event in a DM channel.
 *
 * Forwards the message text to the onboarding flow manager
 * which decides what to do based on the user's current step.
 *
 * Detects DMs using both channel_type and channel ID prefix
 * because Slack sends DM channel IDs starting with "D".
 */
async function handleOnboardingDMReply(
  event: SlackMessageEvent
): Promise<void> {
  // Ignore bot messages to prevent infinite loops
  if (event.bot_id || event.subtype === 'bot_message') return;

  // Detect DMs: Slack sends channel_type 'im' for direct messages,
  // but as a fallback also check if channel ID starts with 'D'
  const isDM = event.channel_type === 'im' || event.channel?.startsWith('D');
  if (!isDM) return;

  if (!event.user || !event.text) return;

  logger.info('DM reply received', {
    userId: event.user,
    channelType: event.channel_type,
    channel: event.channel,
    textPreview: event.text.substring(0, 50),
  });

  await handleDMReply(event.user, event.text);
}

// ---------------------------------------------------------------------------
// Main Webhook Entry Point
// ---------------------------------------------------------------------------

/**
 * Handle incoming Slack Events API requests.
 *
 * Two types of requests:
 *   1. url_verification -- Slack challenge during app setup
 *   2. event_callback -- actual events (reactions, messages)
 *
 * Must respond with 200 within 3 seconds or Slack will retry.
 * Heavy processing (provisioning) happens asynchronously after
 * the response is sent.
 */
export async function handleSlackEvents(c: Context): Promise<Response> {
  let body: SlackEventPayload;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  // URL verification -- Slack sends this when you configure the Events URL
  if (body.type === 'url_verification') {
    return c.json({ challenge: (body as SlackUrlVerification).challenge });
  }

  // Event callback -- actual Slack events
  if (body.type === 'event_callback') {
    const callback = body as SlackEventCallback;

    const event = callback.event;

    // Log every incoming event for debugging DM delivery issues
    logger.info('Slack event received', {
      eventType: event?.type,
      channelType: (event as SlackMessageEvent)?.channel_type,
      user: (event as SlackMessageEvent)?.user ?? (event as SlackReactionAddedEvent)?.user,
      botId: (event as SlackMessageEvent)?.bot_id,
      subtype: (event as SlackMessageEvent)?.subtype,
      textPreview: (event as SlackMessageEvent)?.text?.substring(0, 50),
    });

    // Deduplicate retried events
    if (isAlreadyProcessed(callback.event_id)) {
      return c.json({ ok: true, duplicate: true });
    }

    try {
      if (event.type === 'reaction_added') {
        const reactionEvent = event as SlackReactionAddedEvent;
        await handleOnboardingReaction(reactionEvent);

        // Overview dashboard refresh: :arrows_counterclockwise: in #team-overview
        if (reactionEvent.reaction === 'arrows_counterclockwise') {
          const overviewChannelId = process.env.OVERVIEW_CHANNEL_ID;
          if (overviewChannelId && reactionEvent.item.channel === overviewChannelId) {
            await refreshOverviewDashboard();
            logger.info('Overview dashboard refreshed by user', { userId: reactionEvent.user });
          }
        }

        // Ideas voting: :+1: reactions in #team-ideas
        await checkIdeaApproval(
          reactionEvent.item.channel,
          reactionEvent.item.ts,
          reactionEvent.reaction,
          reactionEvent.user
        );

        // Draft approval: :white_check_mark: reactions on draft pinned messages
        if (reactionEvent.reaction === 'white_check_mark') {
          await checkDraftApproval(
            reactionEvent.item.channel,
            reactionEvent.item.ts
          );
        }

        // Preview approval flow: :white_check_mark: and :rocket: on preview messages
        if (
          reactionEvent.reaction === 'white_check_mark' ||
          reactionEvent.reaction === 'rocket'
        ) {
          await checkPreviewApproval(
            reactionEvent.item.channel,
            reactionEvent.item.ts,
            reactionEvent.reaction,
            reactionEvent.user
          );
        }

        // Bug message reactions: claim/fix/investigate
        if (['hammer', 'white_check_mark', 'eyes'].includes(reactionEvent.reaction)) {
          const bug = getBugMessage(reactionEvent.item.channel, reactionEvent.item.ts);
          if (bug && reactionEvent.user !== process.env.BOT_USER_ID) {
            await handleBugReaction(bug, reactionEvent.reaction, reactionEvent.user);
          }
        }

        // Rollback confirmation: :warning: on the confirmation message
        if (reactionEvent.reaction === 'warning') {
          const pending = getPendingRollback(reactionEvent.item.channel, reactionEvent.item.ts);
          if (pending && reactionEvent.user !== process.env.BOT_USER_ID) {
            await handleRollbackConfirmed(
              reactionEvent.item.channel,
              pending.messageTs,
              pending.repoName,
              reactionEvent.user
            );
            clearPendingRollback(reactionEvent.item.channel, reactionEvent.item.ts);
          }
        }
      }

      if (event.type === 'message') {
        const messageEvent = event as SlackMessageEvent;

        // Read-only enforcement: delete non-bot messages in #team-overview
        const overviewChannelId = process.env.OVERVIEW_CHANNEL_ID;
        if (
          overviewChannelId &&
          messageEvent.channel === overviewChannelId &&
          !messageEvent.bot_id &&
          !messageEvent.subtype &&
          messageEvent.user
        ) {
          await enforceReadOnly(messageEvent.channel, messageEvent.user, messageEvent.ts);
          // Don't process further — the message was removed
        } else {
          await handleOnboardingDMReply(messageEvent);

          // Ideas flow: thread replies for app name / URL input
          if (
            messageEvent.thread_ts &&
            !messageEvent.bot_id &&
            messageEvent.subtype !== 'bot_message' &&
            messageEvent.user &&
            messageEvent.text
          ) {
            // Try hotfix thread first
            const hotfix = getAwaitingHotfix(messageEvent.channel, messageEvent.thread_ts);
            if (hotfix) {
              await handleHotfixReply(
                messageEvent.channel,
                messageEvent.thread_ts,
                messageEvent.text,
                messageEvent.user,
                hotfix.repoName
              );
              clearAwaitingHotfix(messageEvent.channel, messageEvent.thread_ts);
            } else {
              // Check if this is a reply to a bug message — sync to GitHub
              const bug = getBugMessage(messageEvent.channel, messageEvent.thread_ts);
              if (bug) {
                await syncSlackReplyToGitHub(bug, messageEvent.text, messageEvent.user);
              }

              // Also try issue thread reply (Create Issue button flow)
              const wasIssue = await handleIssueThreadReply(
                messageEvent.channel,
                messageEvent.thread_ts,
                messageEvent.text,
                messageEvent.user
              );

              if (!wasIssue && !bug) {
                await handleThreadReply(
                  messageEvent.channel,
                  messageEvent.thread_ts,
                  messageEvent.text,
                  messageEvent.user
                );
              }
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error handling Slack event', {
        eventType: event.type,
        error: message,
      });
      // Return 200 even on error to prevent Slack retries for permanent failures
    }
  }

  return c.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Bug Discussion Sync — Slack thread → GitHub comments
// ---------------------------------------------------------------------------

import type { BugMessageInfo } from './slack-interactive.js';

/** Post a Slack thread reply as a comment on the linked GitHub issue. */
async function syncSlackReplyToGitHub(
  bug: BugMessageInfo,
  text: string,
  slackUserId: string
): Promise<void> {
  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg) return;

  try {
    const client = getWebClient();
    // Look up the Slack user's name for the comment attribution
    let userName = 'Slack user';
    try {
      const userInfo = await client.users.info({ user: slackUserId });
      userName = (userInfo.user as any)?.real_name ?? 'Slack user';
    } catch { /* use default */ }

    const body = `**${userName}** (via Slack):\n\n${text}`;

    await fetch(
      `https://api.github.com/repos/${githubOrg}/${bug.repoName}/issues/${bug.issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
      }
    );

    logger.info('Slack reply synced to GitHub', {
      issueNumber: bug.issueNumber,
      user: userName,
    });
  } catch (error) {
    logger.error('Failed to sync Slack reply to GitHub', { error: (error as Error).message });
  }
}

/**
 * Handle emoji reactions on bug messages:
 * - :hammer: → claim (assign GitHub issue to reactor)
 * - :white_check_mark: → mark as fixed (close GitHub issue)
 * - :eyes: → investigating (post soft claim in thread)
 */
async function handleBugReaction(
  bug: BugMessageInfo,
  reaction: string,
  slackUserId: string
): Promise<void> {
  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg) return;

  const client = getWebClient();

  try {
    if (reaction === 'eyes') {
      // Soft claim — post a comment saying the user is investigating
      await client.chat.postMessage({
        channel: bug.channel,
        thread_ts: bug.messageTs,
        text: `:eyes: <@${slackUserId}> is investigating this.`,
      });
      return;
    }

    if (reaction === 'hammer') {
      // Claim — assign the GitHub issue to the Slack user
      let githubUsername: string | null = null;
      try {
        const { getDb } = await import('../db/client.js');
        const { getTeamMemberBySlackId } = await import('../db/queries.js');
        const db = getDb();
        const member = await getTeamMemberBySlackId(db, slackUserId);
        githubUsername = member?.githubUsername ?? null;
      } catch { /* skip DB lookup */ }

      if (githubUsername) {
        await fetch(
          `https://api.github.com/repos/${githubOrg}/${bug.repoName}/issues/${bug.issueNumber}/assignees`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${githubPat}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ assignees: [githubUsername] }),
          }
        );
      }

      // Update the original message to show CLAIMED status banner
      try {
        const currentMsg = await client.conversations.history({
          channel: bug.channel,
          latest: bug.messageTs,
          oldest: bug.messageTs,
          inclusive: true,
          limit: 1,
        });
        const originalBlocks = (currentMsg.messages?.[0] as any)?.blocks ?? [];

        // Prepend a "CLAIMED" banner block, keep original content
        const claimedBlocks = [
          {
            type: 'section' as const,
            text: {
              type: 'mrkdwn' as const,
              text: `:hammer: *CLAIMED* \u2014 <@${slackUserId}> is working on this${githubUsername ? ` (assigned to *${githubUsername}* on GitHub)` : ''}`,
            },
          },
          { type: 'divider' as const },
          ...originalBlocks,
        ];

        await client.chat.update({
          channel: bug.channel,
          ts: bug.messageTs,
          blocks: claimedBlocks,
          text: `CLAIMED: ${bug.title}`,
        });
      } catch (error) {
        logger.warn('Could not update bug message to CLAIMED', { error: (error as Error).message });
      }

      await client.chat.postMessage({
        channel: bug.channel,
        thread_ts: bug.messageTs,
        text: `:hammer: <@${slackUserId}> claimed this bug.${githubUsername ? ` Assigned to *${githubUsername}* on GitHub.` : ''}`,
      });
      return;
    }

    if (reaction === 'white_check_mark') {
      // Mark as fixed — close the GitHub issue
      await fetch(
        `https://api.github.com/repos/${githubOrg}/${bug.repoName}/issues/${bug.issueNumber}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${githubPat}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
        }
      );

      // Update the original message to show FIXED status (no buttons, grayed out)
      try {
        const fixedBlocks = [
          {
            type: 'section' as const,
            text: {
              type: 'mrkdwn' as const,
              text: `:white_check_mark: *FIXED* \u2014 closed by <@${slackUserId}>\n\n~<${bug.issueUrl}|#${bug.issueNumber}: ${bug.title}>~`,
            },
          },
          {
            type: 'context' as const,
            elements: [
              {
                type: 'mrkdwn' as const,
                text: 'Issue closed on GitHub  \u2022  :thread: View original discussion in thread',
              },
            ],
          },
        ];

        await client.chat.update({
          channel: bug.channel,
          ts: bug.messageTs,
          blocks: fixedBlocks,
          text: `FIXED: ${bug.title}`,
        });
      } catch (error) {
        logger.warn('Could not update bug message to FIXED', { error: (error as Error).message });
      }

      await client.chat.postMessage({
        channel: bug.channel,
        thread_ts: bug.messageTs,
        text: `:white_check_mark: <@${slackUserId}> marked this as fixed. Issue closed on GitHub.`,
      });
    }
  } catch (error) {
    logger.error('Failed to handle bug reaction', { reaction, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Hotfix Handler
// ---------------------------------------------------------------------------

/**
 * Create a critical GitHub issue from a hotfix thread reply.
 */
async function handleHotfixReply(
  channel: string,
  threadTs: string,
  description: string,
  userId: string,
  repoName: string
): Promise<void> {
  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;

  if (!githubPat || !githubOrg) {
    const client = getWebClient();
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: ':x: GitHub is not configured. Please create the issue manually.',
    });
    return;
  }

  try {
    // Create GitHub issue with hotfix labels
    const response = await fetch(
      `https://api.github.com/repos/${githubOrg}/${repoName}/issues`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: `[HOTFIX] ${description.split('\n')[0].substring(0, 80)}`,
          body: `**Reported via Slack by <@${userId}> after production deploy.**\n\n${description}`,
          labels: ['type/bug', 'priority/critical', 'hotfix', 'env/production'],
        }),
      }
    );

    const client = getWebClient();

    if (response.ok) {
      const issue = (await response.json()) as { number: number; html_url: string };
      markBotCreatedIssue(repoName, issue.number);

      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:ambulance: *Hotfix issue created:* <${issue.html_url}|#${issue.number}: ${description.split('\n')[0].substring(0, 60)}>\n\nLabels: \`hotfix\` \`priority/critical\` \`env/production\``,
      });

      logger.info('Hotfix issue created', { repoName, issueNumber: issue.number });
    } else {
      const errorBody = await response.text();
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:x: Failed to create issue: ${errorBody.substring(0, 100)}`,
      });
    }
  } catch (error) {
    logger.error('Failed to create hotfix issue', { error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Rollback Handler
// ---------------------------------------------------------------------------

/** App name → Coolify UUID mapping for rollback */
const COOLIFY_APP_UUIDS: Record<string, string> = {
  passcraft: 'kv5859p4ng76rxd10my35dwq',
};

/**
 * Execute a rollback after the user confirmed with :warning: reaction.
 * Triggers Coolify to redeploy the previous version and updates Slack.
 */
async function handleRollbackConfirmed(
  channel: string,
  deployMessageTs: string,
  repoName: string,
  confirmedBy: string
): Promise<void> {
  const client = getWebClient();

  try {
    // Post rollback-in-progress message
    await client.chat.postMessage({
      channel,
      thread_ts: deployMessageTs,
      text: `:arrows_counterclockwise: Rollback confirmed by <@${confirmedBy}>. Redeploying previous version...`,
    });

    // Trigger Coolify redeploy
    const coolifyToken = process.env.COOLIFY_API_TOKEN;
    const coolifyUrl = process.env.COOLIFY_URL;
    const appUuid = COOLIFY_APP_UUIDS[repoName.toLowerCase()];

    if (!coolifyToken || !coolifyUrl || !appUuid) {
      await client.chat.postMessage({
        channel,
        thread_ts: deployMessageTs,
        text: ':x: Rollback failed — Coolify configuration missing. Please rollback manually.',
      });
      return;
    }

    const response = await fetch(
      `${coolifyUrl}/api/v1/deploy?uuid=${appUuid}&force=true`,
      { headers: { Authorization: `Bearer ${coolifyToken}` } }
    );

    if (response.ok) {
      // Update the deploy message to show ROLLED BACK status
      const rolledBackBlocks = [
        {
          type: 'section' as const,
          text: {
            type: 'mrkdwn' as const,
            text: `:arrows_counterclockwise: *ROLLED BACK* \u2014 ${repoName}\n\nPrevious version is being redeployed by Coolify.`,
          },
        },
        {
          type: 'context' as const,
          elements: [
            {
              type: 'mrkdwn' as const,
              text: `Rolled back by <@${confirmedBy}>`,
            },
          ],
        },
      ];

      await client.chat.update({
        channel,
        ts: deployMessageTs,
        blocks: rolledBackBlocks,
        text: `ROLLED BACK: ${repoName}`,
      });

      // Update channel topic
      await setChannelTopic(channel, `${repoName} — rolling back...`);

      logger.info('Rollback triggered', { repoName, confirmedBy, appUuid });
    } else {
      await client.chat.postMessage({
        channel,
        thread_ts: deployMessageTs,
        text: `:x: Rollback failed — Coolify returned ${response.status}. Please rollback manually.`,
      });
    }
  } catch (error) {
    logger.error('Rollback failed', { repoName, error: (error as Error).message });
  }
}
