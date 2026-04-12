import type { ChannelConfig } from '../types.js';

/**
 * Mapping of GitHub repository names to their Slack channel configuration.
 *
 * Each app has its own set of Slack channels (bugs, active work, previews,
 * deploys, and a main channel for onboarding). The webhook URLs and channel
 * IDs are read from environment variables so secrets never appear in code.
 */
const REPO_CHANNEL_MAP: Record<string, () => ChannelConfig> = {
  passcraft: () => ({
    displayName: 'PassCraft',
    mainChannelId: process.env.PASSCRAFT_MAIN_CHANNEL_ID ?? '',
    bugsWebhookUrl: process.env.PASSCRAFT_BUGS_WEBHOOK_URL ?? '',
    bugsChannelId: process.env.PASSCRAFT_BUGS_CHANNEL_ID ?? '',
    activeChannelId: process.env.PASSCRAFT_ACTIVE_CHANNEL_ID ?? '',
    activeWebhookUrl: process.env.PASSCRAFT_ACTIVE_WEBHOOK_URL ?? '',
    previewWebhookUrl: process.env.PASSCRAFT_PREVIEW_WEBHOOK_URL ?? '',
    previewChannelId: process.env.PASSCRAFT_PREVIEW_CHANNEL_ID ?? '',
    deployWebhookUrl: process.env.PASSCRAFT_DEPLOY_WEBHOOK_URL ?? '',
    deployChannelId: process.env.PASSCRAFT_DEPLOY_CHANNEL_ID ?? '',
  }),
};

/**
 * Look up the Slack channel config for a given GitHub repository name.
 *
 * Returns null if the repo is not configured -- the bot will silently
 * ignore webhooks from unknown repos rather than crashing.
 */
export function getChannelConfig(repoName: string): ChannelConfig | null {
  const key = repoName.toLowerCase();
  const factory = REPO_CHANNEL_MAP[key];

  if (!factory) {
    return null;
  }

  return factory();
}

/**
 * Determine which repo a Slack channel belongs to.
 *
 * Checks all configured repos and returns the repo name if the
 * given channel ID matches any of that repo's channel IDs (main,
 * bugs, active, etc.). Used to route app onboarding reactions
 * to the correct repository.
 *
 * Returns null if the channel is not associated with any repo.
 */
export function getRepoNameFromChannel(channelId: string): string | null {
  for (const [, factory] of Object.entries(REPO_CHANNEL_MAP)) {
    const config = factory();
    const channelIds = [
      config.mainChannelId,
      config.bugsChannelId,
      config.activeChannelId,
      config.previewChannelId,
      config.deployChannelId,
    ].filter(Boolean);

    if (channelIds.includes(channelId)) {
      return config.displayName;
    }
  }

  return null;
}
