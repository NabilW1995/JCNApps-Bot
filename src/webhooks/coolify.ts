import type { Context } from 'hono';
import { getChannelConfig } from '../config/channels.js';
import { postToChannel } from '../slack/client.js';
import {
  buildPreviewReadyMessage,
  buildProductionDeployedMessage,
  buildDeployFailedMessage,
} from '../slack/messages.js';
import { scheduleTableUpdate } from '../slack/table-manager.js';
import { getDb } from '../db/client.js';
import { logDeployEvent, logWebhook, getLastDeployStartTime } from '../db/queries.js';
import { formatDuration } from '../utils/time.js';
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
 * Log a deploy event to the database. Wrapped in try/catch so
 * a database failure never prevents the Slack message from posting.
 */
async function persistDeployEvent(
  repoName: string,
  environment: string,
  status: string,
  branch: string | null,
  issueNumbers: number[]
): Promise<void> {
  try {
    const db = getDb();
    await logDeployEvent(db, {
      repoName,
      environment,
      status,
      branch,
      triggeredBy: null,
      issueNumbers,
      startedAt: new Date(),
      completedAt: status === 'success' || status === 'failed' || status === 'error'
        ? new Date()
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to log deploy event to DB: ${message}`);
  }
}

/**
 * Log a webhook event to the database for auditing.
 * Fails silently — logging should never block request handling.
 */
async function persistWebhookLog(
  eventType: string,
  repoName: string | null,
  summary: string
): Promise<void> {
  try {
    const db = getDb();
    await logWebhook(db, {
      source: 'coolify',
      eventType,
      repoName,
      payloadSummary: summary,
      slackChannel: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to log webhook to DB: ${message}`);
  }
}

/**
 * Calculate how long a production deploy took by comparing the
 * most recent prior deploy's start time against now.
 * Returns a formatted duration string or null if no prior deploy exists.
 */
async function calculateDeployDuration(repoName: string): Promise<string | null> {
  try {
    const db = getDb();
    const lastStartTime = await getLastDeployStartTime(db, repoName);
    if (!lastStartTime) return null;

    const durationMs = Date.now() - lastStartTime.getTime();
    if (durationMs <= 0) return null;

    return formatDuration(durationMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to calculate deploy duration: ${message}`);
    return null;
  }
}

/**
 * Fetch the most recent commit messages from GitHub for a repo.
 * Used to show "What changed" in the deploy notification.
 * Returns up to 5 commit messages from the last 24 hours.
 */
async function fetchRecentCommits(repoName: string): Promise<string[]> {
  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg) return [];

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const response = await fetch(
      `https://api.github.com/repos/${githubOrg}/${repoName}/commits?per_page=5&since=${since}`,
      {
        headers: {
          Authorization: `token ${githubPat}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) return [];

    const commits = (await response.json()) as Array<{
      commit: { message: string; author: { name: string } };
    }>;

    return commits.map((c) => c.commit.message);
  } catch {
    return [];
  }
}

/**
 * Handle incoming Coolify deployment webhooks.
 *
 * Coolify sends webhooks when deployments succeed or fail.
 * The payload shape varies between Coolify versions, so we
 * accept the URL from whichever field is present.
 *
 * Routes:
 *   - Feature branch success -> #app-preview (Preview Ready)
 *   - Main branch success -> #app-deploy (Production Deployed)
 *   - Any failure -> #app-deploy (Deploy Failed)
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
  const member = null; // Will be resolved from git push events in Phase 4

  try {
    // Handle failure status
    if (status === 'failed' || status === 'error') {
      await persistDeployEvent(repoName, 'production', status, branch, []);
      await persistWebhookLog('deploy.failed', repoName, `Branch: ${branch ?? 'unknown'}`);

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
      const uniqueIssueNumbers = [...new Set(issueNumbers)];

      if (isMainBranch(branch)) {
        // Production deploy
        await persistDeployEvent(repoName, 'production', 'success', branch, uniqueIssueNumbers);
        await persistWebhookLog('deploy.production', repoName, `URL: ${deployUrl ?? 'none'}`);

        // Calculate time-to-completion from the previous deploy event
        const duration = await calculateDeployDuration(repoName);

        // Fetch recent commit messages from GitHub for the "What changed" section
        const commitMessages = await fetchRecentCommits(repoName);

        const messageData: ProductionDeployedMessageData = {
          repoName,
          productionUrl: deployUrl ?? config.displayName,
          deployedBy,
          deployedBySlackId: member,
          issueNumbers: uniqueIssueNumbers,
          duration,
          commitMessages,
        };

        const blocks = buildProductionDeployedMessage(messageData);
        await postToChannel(config.deployWebhookUrl, blocks);

        // Production deploy may auto-close issues — refresh the overview table
        scheduleTableUpdate(config.activeChannelId, repoName);

        return c.json({ ok: true, action: 'production_deployed' });
      } else {
        // Preview deploy
        if (!deployUrl) {
          return c.json({ error: 'Missing deploy URL for preview' }, 400);
        }

        await persistDeployEvent(repoName, 'preview', 'success', branch, uniqueIssueNumbers);
        await persistWebhookLog('deploy.preview', repoName, `URL: ${deployUrl}`);

        const messageData: PreviewReadyMessageData = {
          repoName,
          previewUrl: deployUrl,
          branch: branch ?? 'unknown',
          deployedBy,
          deployedBySlackId: member,
          issueNumbers: uniqueIssueNumbers,
          commitMessage,
        };

        const blocks = buildPreviewReadyMessage(messageData);
        await postToChannel(config.previewWebhookUrl, blocks);
        return c.json({ ok: true, action: 'preview_ready' });
      }
    }

    // Unknown status — accept silently
    await persistWebhookLog(`deploy.${status}`, repoName, 'Unknown status — ignored');
    return c.json({ ok: true, action: 'ignored', status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Coolify webhook error: ${message}`);
    return c.json({ error: 'Internal processing error' }, 500);
  }
}
