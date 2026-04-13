import type { Context } from 'hono';
import { getChannelConfig } from '../config/channels.js';
import { postToChannel, postMessage, addReaction, setChannelTopic } from '../slack/client.js';
import {
  buildPreviewReadyMessage,
  buildProductionDeployedMessage,
  buildDeployFailedMessage,
} from '../slack/messages.js';
import { registerPreviewMessage } from '../preview/approval.js';
import { scheduleTableUpdate } from '../slack/table-manager.js';
import { getDb } from '../db/client.js';
import { logDeployEvent, logWebhook, getLastDeployStartTime } from '../db/queries.js';
import { formatDuration } from '../utils/time.js';
import { logger } from '../utils/logger.js';
import {
  sanitizeUrl,
  isPublicUrl,
  extractIssueNumbers,
  isMainBranch,
  extractFeatureBranch,
} from './coolify-helpers.js';
import type {
  CoolifyWebhookPayload,
  PreviewReadyMessageData,
  ProductionDeployedMessageData,
  DeployFailedMessageData,
} from '../types.js';

// URL sanitization, branch detection, and #N extraction helpers live
// in ./coolify-helpers.ts so they can be unit-tested directly.

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

interface CommitDetail {
  message: string;
  sha: string;
  url: string;
  date: string;
}

interface CommitInfo {
  messages: string[];
  commits: CommitDetail[];
  author: string | null;
  /** Timestamp of the most recent commit (for deploy duration calculation) */
  lastCommitDate: string | null;
}

/**
 * Fetch the most recent commits from GitHub for a repo.
 * Returns commit messages, SHAs, URLs, and the author of the most recent commit.
 */
async function fetchRecentCommits(repoName: string, branch?: string): Promise<CommitInfo> {
  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg) return { messages: [], commits: [], author: null, lastCommitDate: null };

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const branchParam = branch ? `&sha=${encodeURIComponent(branch)}` : '';
    const response = await fetch(
      `https://api.github.com/repos/${githubOrg}/${repoName}/commits?per_page=5&since=${since}${branchParam}`,
      {
        headers: {
          Authorization: `token ${githubPat}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) return { messages: [], commits: [], author: null, lastCommitDate: null };

    const rawCommits = (await response.json()) as Array<{
      sha: string;
      html_url: string;
      commit: { message: string; author: { name: string; date: string } };
    }>;

    return {
      messages: rawCommits.map((c) => c.commit.message),
      commits: rawCommits.map((c) => ({
        message: c.commit.message,
        sha: c.sha,
        url: c.html_url,
        date: c.commit.author.date,
      })),
      author: rawCommits.length > 0 ? rawCommits[0].commit.author.name : null,
      lastCommitDate: rawCommits.length > 0 ? rawCommits[0].commit.author.date : null,
    };
  } catch {
    return { messages: [], commits: [], author: null, lastCommitDate: null };
  }
}

/**
 * Extract the original feature branch name from recent commit messages.
 * Looks for merge commit patterns like "Merge branch 'feature/xyz'" or
 * commit messages containing branch-like patterns (feature/, fix/, etc.).
 */
// extractFeatureBranch lives in ./coolify-helpers.ts

/**
 * Fetch open issues from GitHub that mention a branch name.
 * Returns formatted test items showing issue title + area (where to find it in the app).
 */
async function fetchBranchIssues(repoName: string, branch: string): Promise<string[]> {
  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg) return [];

  try {
    const response = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${githubOrg}/${repoName} is:issue is:open ${branch}`)}&per_page=5`,
      {
        headers: {
          Authorization: `token ${githubPat}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) return [];

    const data = (await response.json()) as {
      items: Array<{
        title: string;
        number: number;
        labels: Array<{ name: string }>;
      }>;
    };

    return data.items.map((issue) => {
      // Extract area label (e.g., "area/dashboard" → "Dashboard page")
      const areaLabel = issue.labels.find((l) => l.name.startsWith('area/'));
      const area = areaLabel
        ? ` \u2014 _${areaLabel.name.replace('area/', '').replace(/-/g, ' ')}_`
        : '';
      return `#${issue.number}: ${issue.title}${area}`;
    });
  } catch {
    return [];
  }
}

/** Prevents duplicate deploy notifications within 60 seconds. */
const recentDeploys = new Map<string, number>();

/** Clear dedup cache. Used in tests. */
export function clearRecentDeploys(): void {
  recentDeploys.clear();
}

const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function isRecentDuplicate(repoName: string, environment: string): boolean {
  const key = `${repoName}:${environment}`;
  const now = Date.now();
  const last = recentDeploys.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  recentDeploys.set(key, now);
  // Clean old entries
  for (const [k, t] of recentDeploys) {
    if (now - t > DEDUP_WINDOW_MS * 2) recentDeploys.delete(k);
  }
  return false;
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
    const rawBody = await c.req.text();
    logger.info('Coolify webhook received', { rawBody: rawBody.substring(0, 1000), query: c.req.query() });
    payload = JSON.parse(rawBody);
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

  // Extract the deploy URL from whichever field Coolify provides.
  // Filter out internal/Coolify dashboard URLs that aren't useful for the team.
  const candidateUrl =
    payload.preview_url ||
    payload.deployment_url ||
    payload.url;

  const rawUrl = candidateUrl && isPublicUrl(candidateUrl) ? candidateUrl : undefined;

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

      // Determine if this is a production or preview deploy:
      // 1. If URL contains "preview" → it's a preview deploy
      // 2. If branch is main/master → production
      // 3. If branch is specified and not main → preview
      // 4. If no branch and URL doesn't contain "preview" → production
      const urlLooksLikePreview = deployUrl ? deployUrl.toLowerCase().includes('preview') : false;
      const isProduction = !urlLooksLikePreview && (isMainBranch(branch) || !branch);

      if (isProduction) {
        if (isRecentDuplicate(repoName, 'production')) {
          return c.json({ ok: true, action: 'production_deployed', deduplicated: true });
        }

        // Production deploy
        await persistDeployEvent(repoName, 'production', 'success', branch, uniqueIssueNumbers);
        await persistWebhookLog('deploy.production', repoName, `URL: ${deployUrl ?? 'none'}`);

        // Calculate time-to-completion from the previous deploy event
        const duration = await calculateDeployDuration(repoName);

        // Fetch recent commit messages from GitHub for the "What changed" section
        const commitInfo = await fetchRecentCommits(repoName, branch ?? undefined);

        // Calculate deploy duration from last commit to now
        let deployDuration: string | null = null;
        if (commitInfo.lastCommitDate) {
          const commitTime = new Date(commitInfo.lastCommitDate).getTime();
          const durationMs = Date.now() - commitTime;
          if (durationMs > 0 && durationMs < 60 * 60 * 1000) {
            deployDuration = formatDuration(durationMs);
          }
        }

        const messageData: ProductionDeployedMessageData = {
          repoName,
          productionUrl: deployUrl ?? config.displayName,
          deployedBy: commitInfo.author ?? deployedBy,
          deployedBySlackId: member,
          issueNumbers: uniqueIssueNumbers,
          duration,
          commitMessages: commitInfo.messages,
          commits: commitInfo.commits,
          deployDuration,
        };

        const blocks = buildProductionDeployedMessage(messageData);

        // Use Web API (postMessage) for deploy notifications — same as preview.
        // Falls back to webhook if channel ID isn't set.
        const deployChannelId = config.deployChannelId;
        if (deployChannelId) {
          try {
            await postMessage(deployChannelId, blocks, `Deployed: ${repoName}`);

            // Update deploy channel topic
            const summary = commitInfo.messages.length > 0
              ? commitInfo.messages[0].split('\n')[0].replace(/^(feat|fix|refactor|chore):\s*/i, '').substring(0, 60)
              : 'latest changes';
            await setChannelTopic(deployChannelId, `Last deploy: ${summary}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            logger.warn('Web API deploy post failed, falling back to webhook', { error: msg });
            await postToChannel(config.deployWebhookUrl, blocks);
          }
        } else {
          await postToChannel(config.deployWebhookUrl, blocks);
        }

        // Production deploy may auto-close issues — refresh the overview table
        scheduleTableUpdate(config.activeChannelId, repoName);

        return c.json({ ok: true, action: 'production_deployed' });
      } else {
        // Preview deploy
        if (!deployUrl) {
          return c.json({ error: 'Missing deploy URL for preview' }, 400);
        }

        if (isRecentDuplicate(repoName, 'preview')) {
          return c.json({ ok: true, action: 'preview_ready', deduplicated: true });
        }

        await persistDeployEvent(repoName, 'preview', 'success', branch, uniqueIssueNumbers);
        await persistWebhookLog('deploy.preview', repoName, `URL: ${deployUrl}`);

        // Fetch recent commits to find the real feature branch and deployer
        const previewCommitInfo = await fetchRecentCommits(repoName, branch ?? undefined);
        const featureBranch = extractFeatureBranch(previewCommitInfo.messages) ?? branch ?? 'unknown';

        // Fetch open issues related to this branch for "What to test"
        const testItems = await fetchBranchIssues(repoName, featureBranch);

        const messageData: PreviewReadyMessageData = {
          repoName,
          previewUrl: deployUrl,
          branch: featureBranch,
          deployedBy: previewCommitInfo.author ?? deployedBy,
          deployedBySlackId: member,
          issueNumbers: uniqueIssueNumbers,
          commitMessage: null,
          testItems,
        };

        const blocks = buildPreviewReadyMessage(messageData);

        // Use Web API (postMessage) instead of webhook so we get
        // the message timestamp — needed for the approval reaction flow.
        const previewChannelId = config.previewChannelId;
        if (previewChannelId) {
          try {
            const previewTs = await postMessage(
              previewChannelId,
              blocks,
              `Preview Ready: ${repoName}`
            );
            registerPreviewMessage({
              channel: previewChannelId,
              messageTs: previewTs,
              repoName,
              branch: branch ?? 'unknown',
              previewUrl: deployUrl,
            });

            // Bot reacts with checkmark and rocket so users see the emojis
            // and only need to click (not search for the emoji)
            await addReaction(previewChannelId, previewTs, 'white_check_mark');
            await addReaction(previewChannelId, previewTs, 'rocket');

            // Update channel topic to show current preview status
            const deployer = previewCommitInfo.author ?? 'someone';
            await setChannelTopic(
              previewChannelId,
              `${featureBranch} by ${deployer} — waiting for testing`
            );
          } catch (error) {
            // Fall back to webhook if Web API fails (e.g. token not set)
            const msg = error instanceof Error ? error.message : 'Unknown error';
            logger.warn('Web API preview post failed, falling back to webhook', { error: msg });
            await postToChannel(config.previewWebhookUrl, blocks);
          }
        } else {
          // No channel ID configured — use the legacy webhook
          await postToChannel(config.previewWebhookUrl, blocks);
        }

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
