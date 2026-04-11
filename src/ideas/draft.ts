import { WebClient } from '@slack/web-api';
import { withRetry } from '../slack/client.js';
import { logger } from '../utils/logger.js';
import {
  getMessageText,
  postThreadReply,
  postToChannel,
  getReactions,
  APPROVAL_THRESHOLD,
} from './voting.js';

// ---------------------------------------------------------------------------
// Draft Channel Creation + Draft Approval -> App Channels
//
// Flow:
// 1. Idea approved in #team-ideas -> bot asks for app name in thread
// 2. Someone replies with name -> bot creates #appname channel (draft)
// 3. Team designs in draft channel, reacts :white_check_mark: on pinned msg
// 4. 3 approvals -> bot asks for app URL, then creates 5 app channels
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// State Tracking — waiting for user replies
// ---------------------------------------------------------------------------

/**
 * Tracks threads where the bot asked for an app name.
 * Key: "channel:thread_ts" of the original idea message.
 */
const awaitingAppName = new Map<
  string,
  { ideasChannel: string; ideaMessageTs: string }
>();

/**
 * Tracks threads where the bot asked for an app URL after draft approval.
 * Key: "channel:thread_ts" of the draft pinned message.
 */
const awaitingAppUrl = new Map<
  string,
  { appName: string; draftChannel: string }
>();

/**
 * Tracks which draft channel pinned messages we monitor for :white_check_mark:.
 * Key: "channel:messageTs" of the pinned draft instruction message.
 */
const draftPinnedMessages = new Map<
  string,
  { appName: string; draftChannel: string }
>();

/**
 * Track which draft messages have already been approved to avoid
 * triggering app channel creation twice.
 */
const processedDraftApprovals = new Set<string>();

// Expose for testing
export function clearDraftState(): void {
  awaitingAppName.clear();
  awaitingAppUrl.clear();
  draftPinnedMessages.clear();
  processedDraftApprovals.clear();
}

export function getAwaitingAppName(): Map<
  string,
  { ideasChannel: string; ideaMessageTs: string }
> {
  return awaitingAppName;
}

export function getAwaitingAppUrl(): Map<
  string,
  { appName: string; draftChannel: string }
> {
  return awaitingAppUrl;
}

export function getDraftPinnedMessages(): Map<
  string,
  { appName: string; draftChannel: string }
> {
  return draftPinnedMessages;
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

export function resetDraftClient(): void {
  webClient = null;
}

/**
 * Create a new public Slack channel.
 * Returns the channel ID or null if creation fails.
 */
async function createChannel(name: string): Promise<string | null> {
  return withRetry(async () => {
    const client = getWebClient();
    try {
      const result = await client.conversations.create({
        name,
        is_private: false,
      });
      return result.channel?.id ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to create channel', { name, error: message });
      return null;
    }
  });
}

/**
 * Pin a message in a channel.
 */
async function pinMessage(channel: string, messageTs: string): Promise<void> {
  await withRetry(async () => {
    const client = getWebClient();
    await client.pins.add({
      channel,
      timestamp: messageTs,
    });
  });
}

/**
 * Add a reaction to a message. Used to seed the :white_check_mark:
 * on the draft pinned message so people can see the emoji to click.
 */
async function addReaction(
  channel: string,
  messageTs: string,
  reaction: string
): Promise<void> {
  await withRetry(async () => {
    const client = getWebClient();
    await client.reactions.add({
      channel,
      timestamp: messageTs,
      name: reaction,
    });
  });
}

/**
 * Update the Ideas List (Slack List / bookmarks).
 * Uses the hardcoded list ID for now.
 */
async function updateIdeasList(
  appName: string,
  status: string
): Promise<void> {
  // The Slack Lists API is limited; log the intent for manual follow-up.
  // Full Lists API integration can be added when Slack stabilizes the API.
  logger.info('Ideas list update requested', { appName, status });
}

// ---------------------------------------------------------------------------
// Phase 1: Idea Approved -> Ask for App Name
// ---------------------------------------------------------------------------

/**
 * Called when an idea in #team-ideas receives 3 thumbs-up.
 * Posts a threaded reply asking for the app name.
 */
export async function handleIdeaApproved(
  ideasChannel: string,
  ideaMessageTs: string
): Promise<void> {
  const replyText = [
    ':fire: All 3 team members approved! This idea is moving forward.',
    '',
    'What should the app be called? (e.g. `banking`, `qrsearch`)',
  ].join('\n');

  await postThreadReply(ideasChannel, ideaMessageTs, replyText);

  // Track that we're waiting for the app name in this thread
  const key = `${ideasChannel}:${ideaMessageTs}`;
  awaitingAppName.set(key, { ideasChannel, ideaMessageTs });

  logger.info('Waiting for app name in thread', {
    ideasChannel,
    ideaMessageTs,
  });
}

// ---------------------------------------------------------------------------
// Phase 2: App Name Received -> Create Draft Channel
// ---------------------------------------------------------------------------

/**
 * Build the pinned instruction message for a draft channel.
 */
function buildDraftPinnedText(appName: string): string {
  return [
    `:art: *Draft Phase -- ${appName}*`,
    '',
    'This channel is for designing the app before building it.',
    '',
    '1. *Define:* What problem does it solve? Who is the target user?',
    '2. *User Flow:* How does the user navigate through the app?',
    '3. *Design:* Create screens (Stitch, Figma, or sketches)',
    '4. *Review:* Team reviews and gives feedback',
    '',
    'When the design is approved by the whole team:',
    '*REACT WITH :white_check_mark: ON THIS MESSAGE*',
    '',
    'When all 3 team members approve, the bot will automatically:',
    '- Create the 5 app channels',
    '- Create the GitHub repo',
    '- Set up Coolify deployment',
    '- Set up DNS and preview URLs',
  ].join('\n');
}

/**
 * Create a draft channel for a new app idea.
 *
 * Steps:
 *   1. Create #appname channel
 *   2. Copy the original idea as the first message
 *   3. Post and pin the instruction message
 *   4. Add a :white_check_mark: reaction so people see the emoji
 *   5. Announce in #team-ideas
 *   6. Update the Ideas List
 *
 * Note: Channel name is just the app name (no "-draft" suffix).
 * The user organizes draft channels into a "Drafts" sidebar section manually.
 */
export async function createDraftChannel(
  appName: string,
  originalMessage: string,
  ideasChannel: string
): Promise<string | null> {
  // Normalize the app name for channel naming (lowercase, hyphens only)
  const channelName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const channelId = await createChannel(channelName);
  if (!channelId) {
    logger.error('Failed to create draft channel', { channelName });
    await postToChannel(
      ideasChannel,
      `:warning: Could not create channel #${channelName}. It may already exist.`
    );
    return null;
  }

  // 1. Copy the original idea as the first message
  await postToChannel(
    channelId,
    `:bulb: *Original Idea:*\n\n${originalMessage}`
  );

  // 2. Post the draft instruction message
  const pinnedText = buildDraftPinnedText(appName);
  const pinnedTs = await postToChannel(channelId, pinnedText);

  // 3. Pin it
  if (pinnedTs) {
    await pinMessage(channelId, pinnedTs);

    // 4. Add the bot's own :white_check_mark: so people see the emoji
    await addReaction(channelId, pinnedTs, 'white_check_mark');

    // Track this pinned message for draft approval monitoring
    const draftKey = `${channelId}:${pinnedTs}`;
    draftPinnedMessages.set(draftKey, { appName, draftChannel: channelId });

    logger.info('Draft pinned message tracked', {
      channelId,
      pinnedTs,
      appName,
    });
  }

  // 5. Announce in #team-ideas
  await postToChannel(
    ideasChannel,
    `:rocket: *${appName}* moved to Draft! See <#${channelId}>`
  );

  // 6. Update Ideas List
  await updateIdeasList(appName, 'In Draft');

  logger.info('Draft channel created', { channelName, channelId, appName });

  return channelId;
}

// ---------------------------------------------------------------------------
// Phase 3: Draft Approval -> Create App Channels
// ---------------------------------------------------------------------------

/**
 * Check whether a draft pinned message has enough :white_check_mark: reactions.
 *
 * Called on every reaction_added event for white_check_mark.
 * If 3 unique users have reacted, the design is considered approved
 * and the bot asks for the app URL.
 */
export async function checkDraftApproval(
  channel: string,
  messageTs: string
): Promise<void> {
  const draftKey = `${channel}:${messageTs}`;

  // Only monitor messages we know are draft pinned messages
  if (!draftPinnedMessages.has(draftKey)) return;

  // Don't process twice
  if (processedDraftApprovals.has(draftKey)) return;

  const reactions = await getReactions(channel, messageTs);
  const checkmark = reactions.find((r) => r.name === 'white_check_mark');

  if (!checkmark || checkmark.count < APPROVAL_THRESHOLD) return;
  if (checkmark.users.length < APPROVAL_THRESHOLD) return;

  processedDraftApprovals.add(draftKey);

  const draftInfo = draftPinnedMessages.get(draftKey);
  if (!draftInfo) return;

  logger.info('Draft approved', {
    channel,
    messageTs,
    appName: draftInfo.appName,
    reactionCount: checkmark.count,
  });

  // Ask for the app URL in a thread on the pinned message
  const replyText = [
    ':tada: Design approved! Creating everything now...',
    '',
    'What is the app URL? (e.g. `qrsearch.pro`)',
  ].join('\n');

  await postThreadReply(channel, messageTs, replyText);

  // Track that we're waiting for the URL
  const urlKey = `${channel}:${messageTs}`;
  awaitingAppUrl.set(urlKey, {
    appName: draftInfo.appName,
    draftChannel: draftInfo.draftChannel,
  });
}

// ---------------------------------------------------------------------------
// App Channel Creation
// ---------------------------------------------------------------------------

/**
 * Build the welcome/pinned message for each of the 5 app channels.
 */
function buildChannelWelcome(
  appName: string,
  appUrl: string,
  channelType: 'main' | 'active' | 'bugs' | 'preview' | 'deploy'
): string {
  switch (channelType) {
    case 'main':
      return [
        `:wave: *Welcome to ${appName}!*`,
        '',
        `URL: ${appUrl}`,
        '',
        'This is the main discussion channel for the app.',
        'React with :white_check_mark: below to get access to the repo, Coolify, and your preview URL.',
      ].join('\n');

    case 'active':
      return [
        `:hammer_and_wrench: *${appName} -- Active Work*`,
        '',
        'This channel shows who is working on what.',
        'The bot updates this automatically when issues are claimed.',
      ].join('\n');

    case 'bugs':
      return [
        `:bug: *${appName} -- Bug Tracker*`,
        '',
        'All bugs and feature requests appear here.',
        'The bot syncs from GitHub Issues automatically.',
      ].join('\n');

    case 'preview':
      return [
        `:eyes: *${appName} -- Preview Deploys*`,
        '',
        'Preview deployments appear here when feature branches are deployed.',
        'Test and give feedback before merging to production.',
      ].join('\n');

    case 'deploy':
      return [
        `:rocket: *${appName} -- Production Deploys*`,
        '',
        'Production deployment notifications appear here.',
        'Green = success, Red = failure. The bot notifies the deployer on failures.',
      ].join('\n');
  }
}

/**
 * Create all 5 app channels with pinned welcome messages.
 *
 * Channels created:
 *   1. #appname        -- Main discussion
 *   2. #appname-active  -- Who works on what
 *   3. #appname-bugs    -- Bug tracker
 *   4. #appname-preview -- Preview deploys
 *   5. #appname-deploy  -- Production deploys
 *
 * Each channel gets a pinned welcome message following the same
 * pattern as passcraft-pro channels.
 */
export async function createAppChannels(
  appName: string,
  appUrl: string,
  ideasChannel: string
): Promise<void> {
  const baseName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const channelDefs: Array<{
    name: string;
    type: 'main' | 'active' | 'bugs' | 'preview' | 'deploy';
  }> = [
    { name: baseName, type: 'main' },
    { name: `${baseName}-active`, type: 'active' },
    { name: `${baseName}-bugs`, type: 'bugs' },
    { name: `${baseName}-preview`, type: 'preview' },
    { name: `${baseName}-deploy`, type: 'deploy' },
  ];

  const createdChannels: Array<{ name: string; id: string }> = [];
  const failedChannels: string[] = [];

  for (const def of channelDefs) {
    const channelId = await createChannel(def.name);
    if (channelId) {
      createdChannels.push({ name: def.name, id: channelId });

      // Post and pin the welcome message
      const welcomeText = buildChannelWelcome(appName, appUrl, def.type);
      const msgTs = await postToChannel(channelId, welcomeText);
      if (msgTs) {
        await pinMessage(channelId, msgTs);
      }
    } else {
      failedChannels.push(def.name);
    }
  }

  // Update Ideas List status
  await updateIdeasList(appName, 'Building');

  // Post summary in #team-ideas
  const channelLinks = createdChannels
    .map((c) => `- <#${c.id}>`)
    .join('\n');

  const failedText =
    failedChannels.length > 0
      ? `\n\n:warning: Could not create: ${failedChannels.join(', ')}`
      : '';

  const todoText = [
    '',
    '*Manual setup needed:*',
    `- Create GitHub repo: \`NabilW1995/${baseName}\``,
    `- Set up Coolify project for ${appUrl}`,
    `- Configure DNS for ${appUrl}`,
    `- Add channel IDs to bot environment variables`,
  ].join('\n');

  await postToChannel(
    ideasChannel,
    `:tada: *${appName}* is now in development! Channels ready.\n\n${channelLinks}${failedText}${todoText}`
  );

  logger.info('App channels created', {
    appName,
    appUrl,
    created: createdChannels.map((c) => c.name),
    failed: failedChannels,
  });
}

// ---------------------------------------------------------------------------
// Thread Reply Handler
// ---------------------------------------------------------------------------

/**
 * Handle a thread reply that might contain an app name or app URL.
 *
 * Checks the in-memory state maps to see if the bot is waiting for
 * a response in this particular thread, then routes accordingly.
 */
export async function handleThreadReply(
  channel: string,
  threadTs: string,
  text: string,
  user: string
): Promise<void> {
  const trimmedText = text.trim();
  if (!trimmedText) return;

  // Check if we're waiting for an app name in this thread
  const nameKey = `${channel}:${threadTs}`;
  const nameState = awaitingAppName.get(nameKey);
  if (nameState) {
    awaitingAppName.delete(nameKey);

    // Validate the app name: only allow lowercase letters, numbers, hyphens
    const appName = trimmedText.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!appName || appName.length < 2 || appName.length > 40) {
      await postThreadReply(
        channel,
        threadTs,
        ':warning: App name must be 2-40 characters, using only letters, numbers, and hyphens. Please try again.'
      );
      // Re-register so they can try again
      awaitingAppName.set(nameKey, nameState);
      return;
    }

    logger.info('App name received', { appName, user, channel });

    // Get the original idea text
    const originalMessage = await getMessageText(
      nameState.ideasChannel,
      nameState.ideaMessageTs
    );

    await createDraftChannel(appName, originalMessage, nameState.ideasChannel);
    return;
  }

  // Check if we're waiting for an app URL in this thread
  const urlKey = `${channel}:${threadTs}`;
  const urlState = awaitingAppUrl.get(urlKey);
  if (urlState) {
    awaitingAppUrl.delete(urlKey);

    // Basic URL validation
    const appUrl = trimmedText
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .trim();

    if (!appUrl || appUrl.length < 3) {
      await postThreadReply(
        channel,
        threadTs,
        ':warning: Please provide a valid URL (e.g. `qrsearch.pro`). Try again.'
      );
      // Re-register so they can try again
      awaitingAppUrl.set(urlKey, urlState);
      return;
    }

    logger.info('App URL received', {
      appUrl,
      appName: urlState.appName,
      user,
    });

    const ideasChannel = process.env.TEAM_IDEAS_CHANNEL_ID ?? '';
    await createAppChannels(urlState.appName, appUrl, ideasChannel);
    return;
  }
}
