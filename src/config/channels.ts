import type { ChannelConfig } from '../types.js';

/**
 * Mapping of GitHub repository names to their Slack channel configuration.
 *
 * Each app has its own set of Slack channels (bugs, active work, previews,
 * deploys). The webhook URLs and channel IDs are read from environment
 * variables so secrets never appear in code.
 */
const REPO_CHANNEL_MAP: Record<string, () => ChannelConfig> = {
  passcraft: () => ({
    displayName: 'PassCraft',
    bugsWebhookUrl: process.env.PASSCRAFT_BUGS_WEBHOOK_URL ?? '',
    activeChannelId: process.env.PASSCRAFT_ACTIVE_CHANNEL_ID ?? '',
    previewWebhookUrl: process.env.PASSCRAFT_PREVIEW_WEBHOOK_URL ?? '',
    deployWebhookUrl: process.env.PASSCRAFT_DEPLOY_WEBHOOK_URL ?? '',
  }),
};

/**
 * Look up the Slack channel config for a given GitHub repository name.
 *
 * Returns null if the repo is not configured — the bot will silently
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
