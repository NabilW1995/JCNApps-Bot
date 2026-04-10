import type { Context } from 'hono';
import { getChannelConfig } from '../config/channels.js';
import { getTeamMemberByGitHub } from '../config/team.js';
import { postToChannel } from '../slack/client.js';
import {
  buildPreviewReadyMessage,
  buildProductionDeployedMessage,
  buildDeployFailedMessage,
} from '../slack/messages.js';
import type {
  CoolifyWebhookPayload,
  PreviewReadyMessageData,
  ProductionDeployedMessageData,
  DeployFailedMessageData,
} from '../types.js';

// Allowed URL schemes — reject anything that could be javascript: or data:
const SAFE_URL_PATTERN = /^https?:\/\//i;

/**
 * Sanitize a deploy URL to prevent injection.
 * Returns null if the URL scheme is not http(s).
 */
function sanitizeUrl(url: string): string | null {
  if (!SAFE_URL_PATTERN.test(url)) return null;
  return url;
}

/**
 * Extract issue numbers from a commit message or branch name.
 * Matches patterns like #52, #78, GH-123.
 */
function extractIssueNumbers(text: string | null | undefined): number[] {
  if (!text) return [];
  const matches = text.match(/#(\d+)/g) ?? [];
  return matches.map((m) => parseInt(m.slice(1), 10));
}

/**
 * Determine if a branch is the main/production branch.
 */
function isMainBranch(branch: string | null | undefined): boolean {
  if (!branch) return false;
  return branch === 'main' || branch === 'master';
}

/**
 * Handle incoming Coolify deployment webhooks.
 *
 * Coolify sends webhooks when deployments succeed or fail.
 * The payload shape varies between Coolify versions, so we
 * accept the URL from whichever field is present.
 *
 * Routes:
 *   - Feature branch success → #app-preview (Preview Ready)
 *   - Main branch success → #app-deploy (Production Deployed)
 *   - Any failure → #app-deploy (Deploy Failed)
 */
export async function handleCoolifyWebhook(c: Context): Promise<Response> {
  let payload: CoolifyWebhookPayload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  // Coolify webhooks include the repo name as a query parameter
  // e.g. /webhooks/coolify?repo=PassCraft
  const repoName = c.req.query('repo');
  if (!repoName) {
    return c.json({ error: 'Missing repo query parameter' }, 400);
  }

  const config = getChannelConfig(repoName);
  if (!config) {
    return c.json({ error: `Unknown repo: ${repoName}` }, 404);
  }

  // Extract the deploy URL from whichever field Coolify provides
  const rawUrl =
    payload.preview_url ||
    payload.deployment_url ||
    payload.url;

  const branch = payload.branch ?? null;
  const status = (payload.status ?? '').toLowerCase();
  const commitMessage = payload.commit_message ?? null;

  // Determine who triggered the deploy (from commit or payload)
  const deployedBy = 'Coolify';
  const member = null; // Will be resolved from git push events in Phase 3

  try {
    // Handle failure status
    if (status === 'failed' || status === 'error') {
      const messageData: DeployFailedMessageData = {
        repoName,
        branch: branch ?? 'unknown',
        deployedBy,
        deployedBySlackId: member,
        errorMessage: commitMessage,
      };

      const blocks = buildDeployFailedMessage(messageData);
      await postToChannel(config.deployWebhookUrl, blocks);
      return c.json({ ok: true, action: 'deploy_failed' });
    }

    // Handle success status
    if (
      status === 'success' ||
      status === 'ready' ||
      status === 'running' ||
      rawUrl // If we have a URL, treat it as a successful deploy
    ) {
      const deployUrl = rawUrl ? sanitizeUrl(rawUrl) : null;
      const issueNumbers = extractIssueNumbers(commitMessage)
        .concat(extractIssueNumbers(branch));

      if (isMainBranch(branch)) {
        // Production deploy
        const messageData: ProductionDeployedMessageData = {
          repoName,
          productionUrl: deployUrl ?? config.displayName,
          deployedBy,
          deployedBySlackId: member,
          issueNumbers: [...new Set(issueNumbers)],
          duration: null, // Will be calculated from deploy_events in Phase 3
        };

        const blocks = buildProductionDeployedMessage(messageData);
        await postToChannel(config.deployWebhookUrl, blocks);
        return c.json({ ok: true, action: 'production_deployed' });
      } else {
        // Preview deploy
        if (!deployUrl) {
          return c.json({ error: 'Missing deploy URL for preview' }, 400);
        }

        const messageData: PreviewReadyMessageData = {
          repoName,
          previewUrl: deployUrl,
          branch: branch ?? 'unknown',
          deployedBy,
          deployedBySlackId: member,
          issueNumbers: [...new Set(issueNumbers)],
          commitMessage,
        };

        const blocks = buildPreviewReadyMessage(messageData);
        await postToChannel(config.previewWebhookUrl, blocks);
        return c.json({ ok: true, action: 'preview_ready' });
      }
    }

    // Unknown status — accept silently
    return c.json({ ok: true, action: 'ignored', status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Coolify webhook error: ${message}`);
    return c.json({ error: 'Internal processing error' }, 500);
  }
}
