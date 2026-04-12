import type { Context } from 'hono';
import { verifyGitHubSignature } from '../utils/crypto.js';
import { getChannelConfig } from '../config/channels.js';
import { getTeamMemberByGitHub } from '../config/team.js';
import {
  isCustomerSource,
  getAreaLabel,
  getPriorityLabel,
  getTypeLabel,
  getSourceLabel,
} from '../config/labels.js';
import { postToChannel, postMessage } from '../slack/client.js';
import { registerBugMessage } from './slack-interactive.js';
import {
  buildNewIssueMessage,
  buildMergeConflictMessage,
  buildTaskClaimedMessage,
  buildHotfixStartedMessage,
} from '../slack/messages.js';
import { handleExternalMerge } from '../preview/approval.js';
import { scheduleTableUpdate } from '../slack/table-manager.js';
import { getDb } from '../db/client.js';
import { upsertIssue, updateTeamMemberStatus, logWebhook } from '../db/queries.js';
import { formatTimestamp } from '../utils/time.js';
import { logger } from '../utils/logger.js';
import type {
  IssueEvent,
  PullRequestEvent,
  NewIssueMessageData,
  MergeConflictMessageData,
  TaskClaimedMessageData,
  HotfixMessageData,
  UpsertIssueData,
} from '../types.js';

// ---------------------------------------------------------------------------
// Idempotency — prevent duplicate processing of the same webhook delivery
// ---------------------------------------------------------------------------

const processedDeliveries = new Set<string>();
const MAX_DELIVERY_CACHE = 1000;

/**
 * Check whether a GitHub delivery ID has already been processed.
 * Adds the ID to the cache if it hasn't been seen yet. Evicts
 * the oldest entry when the cache reaches MAX_DELIVERY_CACHE to
 * prevent unbounded memory growth.
 */
export function isAlreadyProcessed(deliveryId: string): boolean {
  if (processedDeliveries.has(deliveryId)) return true;

  processedDeliveries.add(deliveryId);

  if (processedDeliveries.size > MAX_DELIVERY_CACHE) {
    const first = processedDeliveries.values().next().value;
    if (first) processedDeliveries.delete(first);
  }

  return false;
}

/**
 * Clear the delivery cache. Used in tests to reset state between runs.
 */
export function clearDeliveryCache(): void {
  processedDeliveries.clear();
}

// Image file extensions commonly attached as screenshots in GitHub issues
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

/**
 * Count how many image links appear in the issue body.
 * GitHub embeds images as `![alt](url)` in markdown.
 */
function countScreenshots(body: string | null): number {
  if (!body) return 0;
  const imagePattern = /!\[.*?\]\(.*?\)/g;
  const matches = body.match(imagePattern) ?? [];
  return matches.filter((match) =>
    IMAGE_EXTENSIONS.some((ext) => match.toLowerCase().includes(ext))
  ).length;
}

/**
 * Build the data object needed to upsert an issue in the database.
 * Extracts structured label info from the raw GitHub label array.
 */
function buildIssueData(event: IssueEvent): UpsertIssueData {
  const labelNames = event.issue.labels.map((l) => l.name);

  return {
    repoName: event.repository.name,
    issueNumber: event.issue.number,
    title: event.issue.title,
    state: event.issue.state,
    assigneeGithub: event.issue.assignee?.login ?? null,
    areaLabel: getAreaLabel(labelNames),
    typeLabel: getTypeLabel(labelNames),
    priorityLabel: getPriorityLabel(labelNames),
    sourceLabel: getSourceLabel(labelNames),
    isHotfix: labelNames.some((l) => l.toLowerCase() === 'hotfix'),
    htmlUrl: event.issue.html_url,
    createdAt: new Date(event.issue.created_at),
    closedAt: event.issue.closed_at ? new Date(event.issue.closed_at) : null,
  };
}

/**
 * Persist issue data to the database. Wrapped in try/catch so
 * a database failure never prevents the Slack message from posting.
 */
async function persistIssue(event: IssueEvent): Promise<void> {
  try {
    const db = getDb();
    const data = buildIssueData(event);
    await upsertIssue(db, data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to persist issue to DB', { error: message });
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
      source: 'github',
      eventType,
      repoName,
      payloadSummary: summary,
      slackChannel: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to log webhook to DB', { error: message });
  }
}

// ---------------------------------------------------------------------------
// Bot-Created Issues — skip webhook notification for issues the bot created
// ---------------------------------------------------------------------------

const botCreatedIssues = new Set<string>();

/** Mark an issue as bot-created so the webhook handler skips it. */
export function markBotCreatedIssue(repoName: string, issueNumber: number): void {
  const key = `${repoName}:${issueNumber}`;
  botCreatedIssues.add(key);
  // Auto-clean after 60 seconds
  setTimeout(() => botCreatedIssues.delete(key), 60_000);
}

function isBotCreated(repoName: string, issueNumber: number): boolean {
  return botCreatedIssues.has(`${repoName}:${issueNumber}`);
}

// ---------------------------------------------------------------------------
// Issue Handlers
// ---------------------------------------------------------------------------

async function handleIssueOpened(
  event: IssueEvent
): Promise<void> {
  // Persist to database first (non-blocking for Slack)
  await persistIssue(event);

  // Skip notification if the bot created this issue (via modal/button)
  if (isBotCreated(event.repository.name, event.issue.number)) return;

  const config = getChannelConfig(event.repository.name);
  if (!config) return;

  const labelNames = event.issue.labels.map((l) => l.name);

  const messageData: NewIssueMessageData = {
    title: event.issue.title,
    issueUrl: event.issue.html_url,
    issueNumber: event.issue.number,
    repoName: event.repository.name,
    reportedBy: event.issue.user.login,
    labels: labelNames,
    body: event.issue.body,
    isCustomerSource: isCustomerSource(labelNames),
    area: getAreaLabel(labelNames),
    priority: getPriorityLabel(labelNames),
    screenshotCount: countScreenshots(event.issue.body),
  };

  const blocks = buildNewIssueMessage(messageData);

  // Post via Web API to the bugs channel so we can register for bidirectional sync.
  // Falls back to webhook if bugs channel ID isn't set.
  if (config.bugsChannelId) {
    try {
      const messageTs = await postMessage(
        config.bugsChannelId,
        blocks,
        `New issue: ${event.issue.title}`
      );
      registerBugMessage({
        channel: config.bugsChannelId,
        messageTs,
        repoName: event.repository.name,
        issueNumber: event.issue.number,
        issueUrl: event.issue.html_url,
        title: event.issue.title,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Web API issue post failed, falling back to webhook', { error: msg });
      await postToChannel(config.bugsWebhookUrl, blocks);
    }
  } else {
    await postToChannel(config.bugsWebhookUrl, blocks);
  }

  // Trigger a debounced table refresh so the pinned table includes the new issue
  scheduleTableUpdate(config.activeChannelId, event.repository.name);
}

/**
 * Update a team member's status in the database.
 * Wrapped in try/catch so a DB failure never blocks the Slack message.
 */
async function updateMemberStatus(
  githubUsername: string,
  status: string,
  currentRepo: string | null
): Promise<void> {
  try {
    const db = getDb();
    await updateTeamMemberStatus(db, githubUsername, status, currentRepo ?? undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to update member status', { error: message });
  }
}

/**
 * Handle an issue being assigned to a team member.
 *
 * Posts a "Task Claimed" message (or "Hotfix Started" if the issue
 * has a hotfix label) and updates the assignee's status to active.
 */
async function handleIssueAssigned(event: IssueEvent): Promise<void> {
  await persistIssue(event);

  const config = getChannelConfig(event.repository.name);
  if (!config) return;

  const assignee = event.issue.assignee;
  if (!assignee) return;

  // Update team member status to active on this repo
  await updateMemberStatus(assignee.login, 'active', event.repository.name);

  const labelNames = event.issue.labels.map((l) => l.name);
  const isHotfix = labelNames.some((l) => l.toLowerCase() === 'hotfix');
  const member = getTeamMemberByGitHub(assignee.login);
  const startedAt = formatTimestamp(new Date());

  if (isHotfix) {
    const messageData: HotfixMessageData = {
      title: event.issue.title,
      issueNumber: event.issue.number,
      issueUrl: event.issue.html_url,
      repoName: event.repository.name,
      fixedBy: assignee.login,
      fixedBySlackId: member?.slackUserId ?? null,
      relatedIssueNumber: null,
      relatedIssueTitle: null,
      files: [],
      startedAt,
    };

    const blocks = buildHotfixStartedMessage(messageData);
    await postToChannel(config.bugsWebhookUrl, blocks);
  } else {
    const messageData: TaskClaimedMessageData = {
      title: event.issue.title,
      issueNumber: event.issue.number,
      issueUrl: event.issue.html_url,
      repoName: event.repository.name,
      claimedBy: assignee.login,
      claimedBySlackId: member?.slackUserId ?? null,
      area: getAreaLabel(labelNames),
      files: [],
      startedAt,
    };

    const blocks = buildTaskClaimedMessage(messageData);
    await postToChannel(config.activeWebhookUrl, blocks);
  }

  scheduleTableUpdate(config.activeChannelId, event.repository.name);
}

/**
 * Handle an issue being closed.
 *
 * Sets the assignee's status back to idle and refreshes the
 * pinned table so the closed issue disappears.
 */
async function handleIssueClosed(event: IssueEvent): Promise<void> {
  await persistIssue(event);

  const assignee = event.issue.assignee;
  if (assignee) {
    await updateMemberStatus(assignee.login, 'idle', null);
  }

  const config = getChannelConfig(event.repository.name);
  if (config) {
    scheduleTableUpdate(config.activeChannelId, event.repository.name);
  }
}

async function handleIssueUpdated(event: IssueEvent): Promise<void> {
  await persistIssue(event);

  // Trigger a debounced table refresh so the pinned table stays current
  const config = getChannelConfig(event.repository.name);
  if (config) {
    scheduleTableUpdate(config.activeChannelId, event.repository.name);
  }
}

// ---------------------------------------------------------------------------
// Pull Request Handlers
// ---------------------------------------------------------------------------

/**
 * Handle a pull request that was merged outside of Slack.
 *
 * When someone merges a PR via GitHub UI or Claude, we check if
 * there's a registered preview message for that branch and notify
 * the Slack channel so the team knows the merge already happened.
 */
async function handlePullRequestMerged(
  event: PullRequestEvent
): Promise<void> {
  const pr = event.pull_request;
  if (!pr.merged) return;

  await handleExternalMerge(event.repository.name, pr.head.ref);
}

async function handlePullRequestConflict(
  event: PullRequestEvent
): Promise<void> {
  const pr = event.pull_request;

  // Only alert when the PR has a merge conflict
  if (pr.mergeable !== false) return;

  const config = getChannelConfig(event.repository.name);
  if (!config) return;

  // Resolve Slack user IDs for affected users (PR author + assignees)
  const affectedGitHubUsers = [
    pr.user.login,
    ...pr.assignees.map((a) => a.login),
  ];
  const uniqueUsers = [...new Set(affectedGitHubUsers)];
  const slackIds = uniqueUsers
    .map((username) => getTeamMemberByGitHub(username))
    .filter((member): member is NonNullable<typeof member> => member !== null)
    .map((member) => member.slackUserId);

  const messageData: MergeConflictMessageData = {
    prTitle: pr.title,
    prUrl: pr.html_url,
    prNumber: pr.number,
    repoName: event.repository.name,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    author: pr.user.login,
    affectedUserSlackIds: slackIds,
  };

  const blocks = buildMergeConflictMessage(messageData);
  await postToChannel(config.deployWebhookUrl, blocks);
}

// ---------------------------------------------------------------------------
// GitHub Comment → Slack Thread Sync
// ---------------------------------------------------------------------------

/**
 * When a new comment is posted on a GitHub issue, check if we have a
 * registered Slack bug message for it. If yes, post the comment as a
 * thread reply so team can follow the discussion in Slack.
 *
 * Skips comments that came FROM Slack (to avoid infinite loops).
 */
async function handleIssueComment(event: {
  comment: { body: string; user: { login: string }; html_url: string };
  issue: { number: number };
  repository: { name: string };
}): Promise<void> {
  // Skip comments that originated from Slack sync (they have a marker)
  if (event.comment.body.includes('(via Slack)')) return;

  const { getBugMessageByIssue } = await import('./slack-interactive.js');
  const bug = getBugMessageByIssue(event.repository.name, event.issue.number);
  if (!bug) return;

  const { getWebClient } = await import('../slack/client.js');
  const client = getWebClient();

  try {
    await client.chat.postMessage({
      channel: bug.channel,
      thread_ts: bug.messageTs,
      text: `:octocat: *${event.comment.user.login}* commented on GitHub:\n\n>>> ${event.comment.body.substring(0, 500)}${event.comment.body.length > 500 ? '...' : ''}\n\n<${event.comment.html_url}|View on GitHub>`,
    });
    logger.info('GitHub comment synced to Slack thread', {
      repoName: event.repository.name,
      issueNumber: event.issue.number,
    });
  } catch (error) {
    logger.error('Failed to sync GitHub comment to Slack', { error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Main Webhook Entry Point
// ---------------------------------------------------------------------------

/**
 * Handle incoming GitHub webhook requests.
 *
 * 1. Reads the raw body for signature verification
 * 2. Verifies the HMAC-SHA256 signature
 * 3. Dispatches to the appropriate sub-handler based on X-GitHub-Event
 * 4. Logs the webhook to the database for auditing
 * 5. Returns 200 for handled/unknown events, 401 for bad signatures
 */
export async function handleGitHubWebhook(c: Context): Promise<Response> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error('GITHUB_WEBHOOK_SECRET is not configured');
    return c.json({ error: 'Server misconfiguration' }, 500);
  }

  // Read raw body for signature verification
  const rawBody = await c.req.text();

  // Verify webhook signature
  const signature = c.req.header('X-Hub-Signature-256') ?? '';
  if (!verifyGitHubSignature(rawBody, signature, secret)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Idempotency: reject duplicate deliveries from GitHub retries
  const deliveryId = c.req.header('X-GitHub-Delivery') ?? '';
  if (deliveryId && isAlreadyProcessed(deliveryId)) {
    return c.json({ ok: true, duplicate: true });
  }

  const event = c.req.header('X-GitHub-Event');
  if (!event) {
    return c.json({ error: 'Missing X-GitHub-Event header' }, 400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  try {
    switch (event) {
      case 'issues': {
        const issueEvent = payload as IssueEvent;
        const action = issueEvent.action;

        if (action === 'opened') {
          await handleIssueOpened(issueEvent);
        } else if (action === 'assigned') {
          await handleIssueAssigned(issueEvent);
        } else if (action === 'closed') {
          await handleIssueClosed(issueEvent);
        } else if (action === 'unassigned' || action === 'labeled') {
          await handleIssueUpdated(issueEvent);
        }

        await persistWebhookLog(
          `issues.${action}`,
          issueEvent.repository.name,
          `#${issueEvent.issue.number}: ${issueEvent.issue.title}`
        );
        break;
      }
      case 'issue_comment': {
        const commentEvent = payload as {
          action: string;
          comment: { body: string; user: { login: string }; html_url: string };
          issue: { number: number; pull_request?: unknown };
          repository: { name: string };
        };
        if (commentEvent.action === 'created' && !commentEvent.issue.pull_request) {
          await handleIssueComment(commentEvent);
        }
        await persistWebhookLog(
          `issue_comment.${commentEvent.action}`,
          commentEvent.repository.name,
          `#${commentEvent.issue.number}`
        );
        break;
      }
      case 'pull_request': {
        const prEvent = payload as PullRequestEvent;
        if (prEvent.action === 'synchronize' || prEvent.action === 'opened') {
          await handlePullRequestConflict(prEvent);
        }
        if (prEvent.action === 'closed' && prEvent.pull_request.merged) {
          await handlePullRequestMerged(prEvent);
        }

        await persistWebhookLog(
          `pull_request.${prEvent.action}`,
          prEvent.repository.name,
          `#${prEvent.pull_request.number}: ${prEvent.pull_request.title}`
        );
        break;
      }
      case 'ping':
        await persistWebhookLog('ping', null, 'Webhook ping received');
        break;
      default:
        await persistWebhookLog(event, null, 'Unhandled event type');
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error handling webhook', { event, error: message });
    return c.json({ error: 'Internal processing error' }, 500);
  }

  return c.json({ ok: true });
}
