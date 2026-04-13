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
  buildHotfixStartedMessage,
  buildTaskClaimedMessage,
} from '../slack/messages.js';
import { handleExternalMerge } from '../preview/approval.js';
import { getDb } from '../db/client.js';
import { upsertIssue, updateTeamMemberStatus, logWebhook } from '../db/queries.js';
import { formatTimestamp } from '../utils/time.js';
import { detectFilesForIssue } from '../utils/code-search.js';
import { logger } from '../utils/logger.js';
import type {
  IssueEvent,
  PullRequestEvent,
  NewIssueMessageData,
  MergeConflictMessageData,
  HotfixMessageData,
  TaskClaimedMessageData,
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

      // Bot auto-reacts so users can just click to claim/fix/investigate
      const { addReaction } = await import('../slack/client.js');
      await Promise.all([
        addReaction(config.bugsChannelId, messageTs, 'hammer'),
        addReaction(config.bugsChannelId, messageTs, 'white_check_mark'),
        addReaction(config.bugsChannelId, messageTs, 'eyes'),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Web API issue post failed, falling back to webhook', { error: msg });
      await postToChannel(config.bugsWebhookUrl, blocks);
    }
  } else {
    await postToChannel(config.bugsWebhookUrl, blocks);
  }

  // Trigger a reconcile so the new issue shows up in the pinned tables
  await reconcileActive(event.repository.name, config.displayName);
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

  const repoName = event.repository.name;

  // Update team member status to active on this repo
  await updateMemberStatus(assignee.login, 'active', repoName);

  // ── Reconciler Step 1: mark the claim in the DB ──
  // setIssueClaim sets assigneeGithub + claimedAt. This is the SAME
  // DB state the Slack modal flow produces, so the downstream
  // reconciler doesn't need to care where the assign came from.
  try {
    const { getDb } = await import('../db/client.js');
    const { setIssueClaim } = await import('../db/queries.js');
    const db = getDb();
    await setIssueClaim(db, repoName, event.issue.number, assignee.login);
    // Double-write under display-name casing to match legacy rows
    if (config.displayName && config.displayName !== repoName) {
      await setIssueClaim(db, config.displayName, event.issue.number, assignee.login);
    }
  } catch (error) {
    logger.warn('setIssueClaim failed', { error: (error as Error).message });
  }

  // ── File detection ──
  // GitHub Code Search by area-label, gracefully empty if API fails.
  // Both the Task Claimed and Hotfix messages share the same files.
  const labelNames = event.issue.labels.map((l) => l.name);
  const area = getAreaLabel(labelNames);
  let files: string[] = [];
  try {
    files = await detectFilesForIssue(repoName, event.issue.title, area, 3);
  } catch (error) {
    logger.warn('detectFilesForIssue failed', { error: (error as Error).message });
  }

  const member = getTeamMemberByGitHub(assignee.login);
  const startedAt = formatTimestamp(new Date());

  // ── Task Claimed message ──
  // Posted to #app-active so the team sees who picked up what in
  // real time — this is in addition to the pinned table reconcile.
  // The pinned table is the persistent state; this message is the
  // ephemeral feed entry.
  if (config.activeWebhookUrl) {
    const claimedData: TaskClaimedMessageData = {
      title: event.issue.title,
      issueNumber: event.issue.number,
      issueUrl: event.issue.html_url,
      repoName,
      claimedBy: assignee.login,
      claimedBySlackId: member?.slackUserId ?? null,
      area,
      files,
      startedAt,
    };
    try {
      await postToChannel(config.activeWebhookUrl, buildTaskClaimedMessage(claimedData));
    } catch (error) {
      logger.warn('Task Claimed message post failed', {
        error: (error as Error).message,
      });
    }
  }

  // ── Hotfix path ──
  // Identified by `priority/critical` label (Phase 5 user choice).
  // Posts a separate urgent notice to the bugs channel so the alert
  // is visible regardless of the active-feed scroll state.
  const priority = getPriorityLabel(labelNames);
  const isHotfix = priority?.toLowerCase() === 'critical';
  if (isHotfix && config.bugsWebhookUrl) {
    const messageData: HotfixMessageData = {
      title: event.issue.title,
      issueNumber: event.issue.number,
      issueUrl: event.issue.html_url,
      repoName,
      fixedBy: assignee.login,
      fixedBySlackId: member?.slackUserId ?? null,
      relatedIssueNumber: null,
      relatedIssueTitle: null,
      files,
      startedAt,
    };
    try {
      await postToChannel(config.bugsWebhookUrl, buildHotfixStartedMessage(messageData));
    } catch (error) {
      logger.warn('Hotfix message post failed', { error: (error as Error).message });
    }
  }

  // ── Reconciler Step 2: rebuild #active pinned from DB ──
  // The pinned table is the persistent state; the messages above are
  // the ephemeral feed entries. Both surfaces stay in sync.
  await reconcileActive(repoName, config.displayName);
}

/**
 * Handle an issue being closed.
 *
 * Clears claim state from the DB + idles the assignee + reconciles
 * the active pinned so the closed issue disappears.
 */
async function handleIssueClosed(event: IssueEvent): Promise<void> {
  await persistIssue(event);

  const repoName = event.repository.name;
  const config = getChannelConfig(repoName);

  const assignee = event.issue.assignee;
  if (assignee) {
    await updateMemberStatus(assignee.login, 'idle', null);
  }

  // Clear claim tracking — the issue is no longer in flight
  try {
    const { getDb } = await import('../db/client.js');
    const { clearIssueClaim } = await import('../db/queries.js');
    const db = getDb();
    await clearIssueClaim(db, repoName, event.issue.number);
    if (config?.displayName && config.displayName !== repoName) {
      await clearIssueClaim(db, config.displayName, event.issue.number);
    }
  } catch (error) {
    logger.warn('clearIssueClaim failed', { error: (error as Error).message });
  }

  if (config) {
    await reconcileActive(repoName, config.displayName);
  }
}

async function handleIssueUpdated(event: IssueEvent): Promise<void> {
  await persistIssue(event);

  const repoName = event.repository.name;
  const config = getChannelConfig(repoName);
  if (!config) return;

  // If this was an unassign (no assignee left on the issue), clear the
  // claim tracking so the issue moves back to #bugs.
  if (event.action === 'unassigned' && !event.issue.assignee) {
    try {
      const { getDb } = await import('../db/client.js');
      const { clearIssueClaim } = await import('../db/queries.js');
      const db = getDb();
      await clearIssueClaim(db, repoName, event.issue.number);
      if (config.displayName && config.displayName !== repoName) {
        await clearIssueClaim(db, config.displayName, event.issue.number);
      }
    } catch (error) {
      logger.warn('clearIssueClaim on unassign failed', {
        error: (error as Error).message,
      });
    }
  }

  await reconcileActive(repoName, config.displayName);
}

/**
 * Small helper to reconcile the active channel under both the raw
 * repo name and the display-name casing (legacy data compat).
 */
async function reconcileActive(repoName: string, displayName: string | undefined): Promise<void> {
  try {
    const { reconcileActiveState } = await import('../slack/table-manager.js');
    const { refreshBugsTable } = await import('../slack/table-manager.js');
    await reconcileActiveState(repoName);
    if (displayName && displayName !== repoName) {
      await reconcileActiveState(displayName);
    }
    // Also refresh #bugs so assigned issues disappear from it
    await refreshBugsTable(repoName);
    if (displayName && displayName !== repoName) {
      await refreshBugsTable(displayName);
    }
  } catch (error) {
    logger.error('reconcileActive helper failed', {
      error: (error as Error).message,
    });
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
      case 'push': {
        const pushEvent = payload as {
          ref?: string;
          repository: { name: string };
          sender?: { login: string };
          pusher?: { name: string };
          commits?: Array<{
            added?: string[];
            modified?: string[];
            removed?: string[];
          }>;
        };
        await handlePushEvent(pushEvent);
        await persistWebhookLog(
          'push',
          pushEvent.repository.name,
          `${pushEvent.ref ?? ''} by ${pushEvent.sender?.login ?? pushEvent.pusher?.name ?? '?'}`
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

/**
 * Handle a GitHub push event. Three things happen on every push:
 *
 * 1. COMMIT-REF DETECTION (Commit 3 of the reconciler rollout):
 *    Parse every commit message for `#N` issue references. For each
 *    referenced issue, update `last_touched_at` in the DB. This is
 *    branch-agnostic — works on feature branches, main, anything.
 *    The active pinned message's LEFTOVER detection uses this field
 *    so issues with recent commits stay out of the Leftover section.
 *
 * 2. FILE-LIST REFINEMENT (Option E):
 *    If the sender has an active claim in this repo, merge the
 *    actually-changed files from the commits into the claim's file
 *    list. Seeded file list (from Assign Tasks code search) gets
 *    refined with ground-truth from real commits.
 *
 * 3. RECONCILE:
 *    Call reconcileActiveState so the Slack pinned message reflects
 *    the new DB state (new last_touched_at values move issues from
 *    Leftover → In Progress). One code path for every state change.
 */
async function handlePushEvent(event: {
  ref?: string;
  repository: { name: string };
  sender?: { login: string };
  pusher?: { name: string };
  commits?: Array<{
    message?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}): Promise<void> {
  const repoName = event.repository.name;
  const githubUsername = event.sender?.login ?? event.pusher?.name;

  const commits = event.commits ?? [];

  // ── 1. Collect changed files + referenced issue numbers in one pass ──
  const { extractIssueRefs } = await import('../utils/issue-refs.js');
  const changedFiles = new Set<string>();
  const referencedIssues = new Set<number>();
  for (const c of commits) {
    for (const f of c.added ?? []) changedFiles.add(f);
    for (const f of c.modified ?? []) changedFiles.add(f);
    // Intentionally skip `removed` — removed files aren't "currently touching"
    for (const n of extractIssueRefs(c.message ?? '')) {
      referencedIssues.add(n);
    }
  }

  // ── 2. Touch every referenced issue's last_touched_at ──
  // This runs even without a claim registry entry — if someone commits
  // #23 directly on a branch without clicking Assign Tasks first, we
  // still want the active pinned table to reflect that.
  if (referencedIssues.size > 0) {
    try {
      const { getDb } = await import('../db/client.js');
      const { touchIssue } = await import('../db/queries.js');
      const db = getDb();

      // Try both the raw repo name and the channel-config display name,
      // in case issues were stored under a different casing.
      const { getChannelConfig } = await import('../config/channels.js');
      const cfg = getChannelConfig(repoName);
      const displayName = cfg?.displayName;

      for (const num of referencedIssues) {
        try {
          await touchIssue(db, repoName, num);
          if (displayName && displayName !== repoName) {
            await touchIssue(db, displayName, num);
          }
        } catch (e) {
          logger.warn('Push: touchIssue failed', {
            repoName,
            num,
            error: (e as Error).message,
          });
        }
      }
      logger.info('Push: touched referenced issues', {
        repoName,
        count: referencedIssues.size,
      });
    } catch (error) {
      logger.error('Push: touch batch failed', { error: (error as Error).message });
    }
  }

  // ── 3. Merge changed files into the sender's active claim ──
  if (githubUsername && changedFiles.size > 0) {
    try {
      const { addFilesToClaim, buildActiveClaimBlocks, getClaimByGithubUsername } = await import(
        './slack-interactive.js'
      );
      let claim = getClaimByGithubUsername(repoName, githubUsername);
      if (!claim) {
        const { getChannelConfig } = await import('../config/channels.js');
        const config = getChannelConfig(repoName);
        if (config?.displayName && config.displayName !== repoName) {
          claim = getClaimByGithubUsername(config.displayName, githubUsername);
        }
      }
      if (claim) {
        const updated = addFilesToClaim(
          claim.repoName,
          githubUsername,
          Array.from(changedFiles)
        );
        if (updated) {
          const { getWebClient } = await import('../slack/client.js');
          const client = getWebClient();
          const blocks = buildActiveClaimBlocks(updated);
          await client.chat.update({
            channel: updated.activeChannel,
            ts: updated.activeMessageTs,
            blocks,
            text: `<@${updated.slackUserId}> is working on ${updated.taskNumbers.length} ${updated.type === 'bug' ? 'bug' : 'feature'}(s)`,
          });
          logger.info('Push: active claim files updated', {
            repoName,
            githubUsername,
            totalFileCount: updated.files.length,
          });
        }
      }
    } catch (error) {
      logger.error('Push: claim merge failed', {
        error: (error as Error).message,
      });
    }
  }

  // ── 4. Reconcile the active pinned message ──
  // Idempotent: picks up the new last_touched_at values from step 2 and
  // re-groups issues across leftover vs in-progress sections.
  try {
    const { reconcileActiveState } = await import('../slack/table-manager.js');
    const { getChannelConfig } = await import('../config/channels.js');
    await reconcileActiveState(repoName);
    const cfg = getChannelConfig(repoName);
    if (cfg?.displayName && cfg.displayName !== repoName) {
      await reconcileActiveState(cfg.displayName);
    }
  } catch (error) {
    logger.error('Push: reconcile failed', {
      error: (error as Error).message,
    });
  }
}
