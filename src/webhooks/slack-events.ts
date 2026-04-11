import type { Context } from 'hono';
import { startTeamOnboarding, startAppOnboarding, handleDMReply } from '../onboarding/flow.js';
import { getRepoNameFromChannel } from '../config/channels.js';
import { logger } from '../utils/logger.js';

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

  logger.info('Onboarding reaction detected', {
    userId: event.user,
    channel: event.item.channel,
    isTeamGeneral: event.item.channel === teamGeneralId,
  });

  if (event.item.channel === teamGeneralId) {
    // Team-level onboarding: collect name, GitHub, email
    await startTeamOnboarding(event.user);
  } else {
    // App-level onboarding: provision repo access for a specific app
    const repoName = getRepoNameFromChannel(event.item.channel);
    if (repoName) {
      await startAppOnboarding(event.user, repoName, event.item.channel);
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
        await handleOnboardingReaction(event as SlackReactionAddedEvent);
      }

      if (event.type === 'message') {
        await handleOnboardingDMReply(event as SlackMessageEvent);
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
