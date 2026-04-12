import type { Context } from 'hono';
import { getWebClient, setChannelTopic, openModal, postEphemeral } from '../slack/client.js';
import { markBotCreatedIssue } from './github.js';
import { getDb } from '../db/client.js';
import { getOpenIssuesForRepo } from '../db/queries.js';
import { refreshBugsTable } from '../slack/table-manager.js';
import { getRepoNameFromChannel } from '../config/channels.js';
import { logger } from '../utils/logger.js';

// Track which threads are awaiting issue descriptions
// Key: channel:thread_ts, Value: { repoName, branch }
const awaitingIssueDescription = new Map<string, { repoName: string; branch: string }>();

/**
 * Check if a message in a thread is an issue description we're waiting for.
 */
export function getAwaitingIssue(channel: string, threadTs: string): { repoName: string; branch: string } | undefined {
  return awaitingIssueDescription.get(`${channel}:${threadTs}`);
}

/**
 * Remove a tracked issue thread after the issue is created.
 */
export function clearAwaitingIssue(channel: string, threadTs: string): void {
  awaitingIssueDescription.delete(`${channel}:${threadTs}`);
}

/**
 * Handle Slack interactive payloads (button clicks, etc.).
 *
 * Slack sends these as application/x-www-form-urlencoded with a `payload` field
 * containing JSON.
 */
export async function handleSlackInteractive(c: Context): Promise<Response> {
  let payload: any;
  try {
    const body = await c.req.parseBody();
    payload = JSON.parse(body.payload as string);
  } catch {
    return c.json({ error: 'Invalid payload' }, 400);
  }

  if (payload.type === 'block_actions') {
    for (const action of payload.actions ?? []) {
      // Modal actions — MUST be awaited because trigger_id expires in 3 seconds
      if (action.action_id === 'new_bug') {
        await openNewBugModal(payload);
      } else if (action.action_id === 'new_feature') {
        await openNewFeatureModal(payload);
      } else if (action.action_id === 'assign_tasks') {
        await openAssignTasksModal(payload);
      } else {
        // Non-modal actions — fire-and-forget
        const bg = async () => {
          if (action.action_id === 'create_issue') {
            await handleCreateIssueButton(payload);
          } else if (action.action_id === 'preview_done') {
            await handlePreviewDoneButton(payload);
          } else if (action.action_id === 'deploy_hotfix') {
            await handleHotfixButton(payload);
          } else if (action.action_id === 'deploy_rollback') {
            await handleRollbackButton(payload);
          } else if (action.action_id === 'refresh_bugs') {
            const repo = getRepoFromPayload(payload);
            if (repo) await refreshBugsTable(repo);
          }
        };
        bg().catch((e) => logger.error('Button handler failed', { error: (e as Error).message }));
      }
    }
  } else if (payload.type === 'view_submission') {
    // Modal submissions — fire-and-forget (Slack closes the modal on empty 200)
    const handleSubmission = async () => {
      const callbackId = payload.view?.callback_id;
      if (callbackId === 'new_bug_modal') {
        await handleNewIssueSubmission(payload, 'bug');
      } else if (callbackId === 'new_feature_modal') {
        await handleNewIssueSubmission(payload, 'feature');
      } else if (callbackId === 'assign_tasks_modal') {
        await handleAssignTasksSubmission(payload);
      }
    };
    handleSubmission().catch((e) => logger.error('Modal submission failed', { error: (e as Error).message }));

    // Slack requires empty 200 for view_submission — NOT {"ok":true}
    return new Response('', { status: 200 });
  }

  return c.json({ ok: true });
}

/** Extract repo name from a button payload's message blocks. */
function getRepoFromPayload(payload: any): string | null {
  const channelId = payload.channel?.id;
  if (channelId) {
    return getRepoNameFromChannel(channelId);
  }
  return 'passcraft';
}

/**
 * Handle the "Create Issue" button click.
 *
 * Opens a thread under the preview message and asks the user
 * to describe the issue. The next message in that thread will
 * be used to create a GitHub issue.
 */
async function handleCreateIssueButton(payload: any): Promise<void> {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const userId = payload.user?.id;

  if (!channel || !messageTs) return;

  // Extract repo name and branch from the original message blocks
  const blocks = payload.message?.blocks ?? [];

  let repoName = 'PassCraft';
  let branch = 'unknown';

  // Try to extract from block text
  for (const block of blocks) {
    const text = block?.text?.text ?? '';
    const branchMatch = text.match(/Branch: `([^`]+)`/);
    if (branchMatch) branch = branchMatch[1];
    const repoMatch = text.match(/Preview Ready.*?\u2014\s*(\S+)/);
    if (repoMatch) repoName = repoMatch[1];
  }

  try {
    const client = getWebClient();

    // Post in thread asking for the issue description
    await client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `:lady_beetle: <@${userId}> wants to report an issue.\n\n*Describe the bug or problem you found:*\n(Just type your description in this thread and I will create a GitHub issue for you.)`,
    });

    // Track this thread so we can create the issue when they reply
    awaitingIssueDescription.set(`${channel}:${messageTs}`, { repoName, branch });

    logger.info('Create issue thread opened', { channel, messageTs, userId, repoName, branch });
  } catch (error) {
    logger.error('Failed to open create issue thread', { error: (error as Error).message });
  }
}

/**
 * Handle the "Done" button click on a preview message.
 *
 * Updates the message to show a "TESTED" status with green styling,
 * indicating this user has finished testing.
 */
async function handlePreviewDoneButton(payload: any): Promise<void> {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const userId = payload.user?.id;

  if (!channel || !messageTs) return;

  // Extract info from original message
  const blocks = payload.message?.blocks ?? [];
  let repoName = '';
  let branch = '';
  let previewUrl = '';

  for (const block of blocks) {
    const text = block?.text?.text ?? '';
    const branchMatch = text.match(/Branch: `([^`]+)`/);
    if (branchMatch) branch = branchMatch[1];
    const repoMatch = text.match(/Preview Ready.*?\u2014\s*(\S+)/);
    if (repoMatch) repoName = repoMatch[1];
    const urlMatch = text.match(/\n:link:\s*(\S+)/);
    if (urlMatch) previewUrl = urlMatch[1];
  }

  try {
    const client = getWebClient();

    // Update the original message to show TESTED status
    const testedBlocks = [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: `:white_check_mark: *TESTED* \u2014 ${repoName}`,
        },
      },
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: `:link: ${previewUrl}\n:twisted_rightwards_arrows: Branch: \`${branch}\`\n:bust_in_silhouette: Tested by: <@${userId}>`,
        },
      },
      {
        type: 'context' as const,
        elements: [
          {
            type: 'mrkdwn' as const,
            text: 'Testing complete \u2014 react with :rocket: to approve and merge to master.',
          },
        ],
      },
    ];

    await client.chat.update({
      channel,
      ts: messageTs,
      blocks: testedBlocks,
      text: `TESTED: ${repoName} \u2014 ${branch}`,
    });

    // Update channel topic to reflect tested status
    await setChannelTopic(channel, `${branch} — tested \u2714`);

    logger.info('Preview marked as tested', { channel, messageTs, userId, repoName, branch });
  } catch (error) {
    logger.error('Failed to update preview as tested', { error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Bug/Feature Modals
// ---------------------------------------------------------------------------

const AREA_OPTIONS = [
  'dashboard', 'settings', 'onboarding', 'profile', 'api',
  'payments', 'admin', 'templates', 'wallet', 'auth', 'ui', 'other',
].map((a) => ({ text: { type: 'plain_text' as const, text: a.charAt(0).toUpperCase() + a.slice(1) }, value: a }));

const PRIORITY_OPTIONS = [
  { label: 'Critical', value: 'critical' },
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
].map((p) => ({ text: { type: 'plain_text' as const, text: p.label }, value: p.value }));

async function openNewBugModal(payload: any): Promise<void> {
  const channelId = payload.channel?.id ?? '';
  const repoName = getRepoFromPayload(payload) ?? 'passcraft';

  await openModal(payload.trigger_id, {
    type: 'modal',
    callback_id: 'new_bug_modal',
    private_metadata: JSON.stringify({ channelId, repoName }),
    title: { type: 'plain_text', text: 'Report a Bug' },
    submit: { type: 'plain_text', text: 'Create Bug' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'input', block_id: 'title', label: { type: 'plain_text', text: 'Title' }, element: { type: 'plain_text_input', action_id: 'value', placeholder: { type: 'plain_text', text: 'What is broken?' } } },
      { type: 'input', block_id: 'description', label: { type: 'plain_text', text: 'Description' }, element: { type: 'plain_text_input', action_id: 'value', multiline: true, placeholder: { type: 'plain_text', text: 'Steps to reproduce, what you expected, what happened instead...' } }, optional: true },
      { type: 'input', block_id: 'area', label: { type: 'plain_text', text: 'Area' }, element: { type: 'static_select', action_id: 'value', options: AREA_OPTIONS, placeholder: { type: 'plain_text', text: 'Where in the app?' } } },
      { type: 'input', block_id: 'priority', label: { type: 'plain_text', text: 'Priority' }, element: { type: 'static_select', action_id: 'value', options: PRIORITY_OPTIONS, initial_option: PRIORITY_OPTIONS[1] } },
      { type: 'input', block_id: 'source', label: { type: 'plain_text', text: 'Source' }, element: { type: 'static_select', action_id: 'value', options: [
        { text: { type: 'plain_text', text: 'External (customer reported)' }, value: 'customer' },
        { text: { type: 'plain_text', text: 'Internal (found by team)' }, value: 'internal' },
      ] } },
    ],
  });
}

async function openNewFeatureModal(payload: any): Promise<void> {
  const channelId = payload.channel?.id ?? '';
  const repoName = getRepoFromPayload(payload) ?? 'passcraft';

  await openModal(payload.trigger_id, {
    type: 'modal',
    callback_id: 'new_feature_modal',
    private_metadata: JSON.stringify({ channelId, repoName }),
    title: { type: 'plain_text', text: 'Request a Feature' },
    submit: { type: 'plain_text', text: 'Create Feature' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'input', block_id: 'title', label: { type: 'plain_text', text: 'Title' }, element: { type: 'plain_text_input', action_id: 'value', placeholder: { type: 'plain_text', text: 'What feature do you want?' } } },
      { type: 'input', block_id: 'description', label: { type: 'plain_text', text: 'Description' }, element: { type: 'plain_text_input', action_id: 'value', multiline: true, placeholder: { type: 'plain_text', text: 'Describe the feature, why it is needed...' } }, optional: true },
      { type: 'input', block_id: 'area', label: { type: 'plain_text', text: 'Area' }, element: { type: 'static_select', action_id: 'value', options: AREA_OPTIONS, placeholder: { type: 'plain_text', text: 'Where in the app?' } } },
    ],
  });
}

async function openAssignTasksModal(payload: any): Promise<void> {
  const channelId = payload.channel?.id ?? '';
  const repoName = getRepoFromPayload(payload) ?? 'passcraft';
  const userId = payload.user?.id ?? '';

  // Fetch open bugs from DB
  const db = getDb();
  const issues = await getOpenIssuesForRepo(db, repoName);
  const bugs = issues.filter((i) => i.typeLabel === 'bug');

  if (bugs.length === 0) {
    await postEphemeral(channelId, userId, 'No open bugs to assign.');
    return;
  }

  const checkboxOptions = bugs.slice(0, 10).map((bug) => ({
    text: { type: 'mrkdwn' as const, text: `*#${bug.issueNumber}* ${bug.title}` },
    description: { type: 'plain_text' as const, text: `${bug.priorityLabel ?? 'medium'} | ${bug.areaLabel ?? 'no area'}` },
    value: `${bug.issueNumber}:${bug.title}`,
  }));

  await openModal(payload.trigger_id, {
    type: 'modal',
    callback_id: 'assign_tasks_modal',
    private_metadata: JSON.stringify({ channelId, repoName, userId }),
    title: { type: 'plain_text', text: 'Assign Tasks' },
    submit: { type: 'plain_text', text: 'Generate Prompt' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: 'Select the bugs you want to work on. A Claude Code prompt will be generated for you.' } },
      { type: 'input', block_id: 'selected_bugs', label: { type: 'plain_text', text: 'Bugs to fix' }, element: { type: 'checkboxes', action_id: 'value', options: checkboxOptions } },
    ],
  });
}

/** Handle submission of New Bug or New Feature modal. */
async function handleNewIssueSubmission(payload: any, type: 'bug' | 'feature'): Promise<void> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const { channelId, repoName } = meta;
  const values = payload.view?.state?.values ?? {};

  const title = values.title?.value?.value ?? '';
  const description = values.description?.value?.value ?? '';
  const area = values.area?.value?.selected_option?.value ?? '';
  const priority = values.priority?.value?.selected_option?.value ?? 'medium';
  const source = values.source?.value?.selected_option?.value ?? 'internal';

  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg || !title) return;

  const labels = [`type/${type}`];
  if (area) labels.push(`area/${area}`);
  if (type === 'bug') {
    labels.push(`priority/${priority}`);
    labels.push(`source/${source}`);
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${githubOrg}/${repoName}/issues`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, body: description || undefined, labels }),
      }
    );

    if (response.ok && channelId) {
      const issue = (await response.json()) as { number: number; html_url: string };

      // Mark as bot-created so the GitHub webhook doesn't post a duplicate
      markBotCreatedIssue(repoName, issue.number);

      const client = getWebClient();
      const typeLabel = type === 'bug' ? 'Bug' : 'Feature';
      await client.chat.postMessage({
        channel: channelId,
        text: `${type === 'bug' ? ':lady_beetle:' : ':bulb:'} *New ${typeLabel}:* <${issue.html_url}|#${issue.number}: ${title}>`,
      });

      // Refresh the pinned table
      await refreshBugsTable(repoName);
    }

    logger.info('Issue created via modal', { type, repoName, title });
  } catch (error) {
    logger.error('Failed to create issue from modal', { error: (error as Error).message });
  }
}

/** Handle Assign Tasks modal submission — generate Claude prompt. */
async function handleAssignTasksSubmission(payload: any): Promise<void> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const { channelId, repoName, userId } = meta;
  const values = payload.view?.state?.values ?? {};
  const selected = values.selected_bugs?.value?.selected_options ?? [];

  if (selected.length === 0 || !channelId || !userId) return;

  const githubOrg = process.env.GITHUB_ORG ?? 'NabilW1995';

  // Look up the user's name for the preview URL
  const client = getWebClient();
  let userName = 'user';
  try {
    const userInfo = await client.users.info({ user: userId });
    userName = (userInfo.user as any)?.real_name?.split(' ')[0]?.toLowerCase() ?? 'user';
  } catch { /* use default */ }

  const bugLines = selected.map((opt: any) => {
    const [num, ...titleParts] = (opt.value as string).split(':');
    const title = titleParts.join(':').trim();
    return `- #${num}: ${title} (see github.com/${githubOrg}/${repoName}/issues/${num})`;
  });

  const prompt = `Fix these bugs in ${repoName}:\n${bugLines.join('\n')}\n\nCreate a new branch, fix the issues, and push to preview-${userName}.${repoName.toLowerCase()}.pro`;

  await postEphemeral(channelId, userId, `:clipboard: *Your Claude Code prompt:*\n\n\`\`\`\n${prompt}\n\`\`\`\n\nCopy this and paste it into your Claude Code session.`);

  logger.info('Assign tasks prompt generated', { repoName, userId, bugCount: selected.length });
}

// Track hotfix threads: channel:thread_ts -> { repoName }
const awaitingHotfixDescription = new Map<string, { repoName: string }>();

/** Check if a thread is awaiting a hotfix description. */
export function getAwaitingHotfix(channel: string, threadTs: string): { repoName: string } | undefined {
  return awaitingHotfixDescription.get(`${channel}:${threadTs}`);
}

export function clearAwaitingHotfix(channel: string, threadTs: string): void {
  awaitingHotfixDescription.delete(`${channel}:${threadTs}`);
}

/**
 * Handle the "Hotfix" button on a deploy message.
 * Opens a thread asking what's broken, then creates a critical GitHub issue.
 */
async function handleHotfixButton(payload: any): Promise<void> {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const userId = payload.user?.id;

  if (!channel || !messageTs) return;

  // Extract repo name from message
  const blocks = payload.message?.blocks ?? [];
  let repoName = 'PassCraft';
  for (const block of blocks) {
    const text = block?.text?.text ?? '';
    const repoMatch = text.match(/Production Deployed.*?\u2014\s*(\S+)/);
    if (repoMatch) repoName = repoMatch[1];
  }

  try {
    const client = getWebClient();

    await client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `:ambulance: <@${userId}> is reporting a production issue.\n\n*Describe what is broken:*\n(Type your description in this thread — I will create a critical GitHub issue with hotfix priority.)`,
    });

    awaitingHotfixDescription.set(`${channel}:${messageTs}`, { repoName });
    logger.info('Hotfix thread opened', { channel, messageTs, userId, repoName });
  } catch (error) {
    logger.error('Failed to open hotfix thread', { error: (error as Error).message });
  }
}

// Track rollback confirmations: channel:ts -> { userId, repoName }
const pendingRollbacks = new Map<string, { userId: string; repoName: string; messageTs: string }>();

/** Exported so slack-events can check for rollback confirmations. */
export function getPendingRollback(channel: string, messageTs: string): { userId: string; repoName: string; messageTs: string } | undefined {
  return pendingRollbacks.get(`${channel}:${messageTs}`);
}

export function clearPendingRollback(channel: string, messageTs: string): void {
  pendingRollbacks.delete(`${channel}:${messageTs}`);
}

/**
 * Handle the "Rollback" button click on a deploy message.
 *
 * Posts a confirmation thread — user must react with :warning: to confirm.
 * This prevents accidental rollbacks.
 */
async function handleRollbackButton(payload: any): Promise<void> {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const userId = payload.user?.id;

  if (!channel || !messageTs) return;

  // Extract repo name from original message
  const blocks = payload.message?.blocks ?? [];
  let repoName = 'PassCraft';
  for (const block of blocks) {
    const text = block?.text?.text ?? '';
    const repoMatch = text.match(/Production Deployed.*?\u2014\s*(\S+)/);
    if (repoMatch) repoName = repoMatch[1];
  }

  try {
    const client = getWebClient();

    // Post confirmation thread
    const confirmResult = await client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `:warning: <@${userId}> wants to rollback *${repoName}* to the previous version.\n\n*This will redeploy the last working version.*\n\nReact with :warning: on this message to confirm the rollback.`,
    });

    if (confirmResult.ts) {
      // Add the warning emoji so user just needs to click it
      await client.reactions.add({
        channel,
        timestamp: confirmResult.ts,
        name: 'warning',
      });

      // Track this for confirmation
      pendingRollbacks.set(`${channel}:${confirmResult.ts}`, { userId, repoName, messageTs });
    }

    logger.info('Rollback confirmation requested', { channel, messageTs, userId, repoName });
  } catch (error) {
    logger.error('Failed to handle rollback button', { error: (error as Error).message });
  }
}

/**
 * Handle a thread reply that might be an issue description.
 * Called from the slack-events handler when a message arrives in a thread.
 */
export async function handleIssueThreadReply(
  channel: string,
  threadTs: string,
  text: string,
  userId: string
): Promise<boolean> {
  const info = awaitingIssueDescription.get(`${channel}:${threadTs}`);
  if (!info) return false;

  // Don't process bot messages
  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG ?? 'NabilW1995';

  if (!githubPat) {
    logger.error('GITHUB_PAT not set, cannot create issue');
    return false;
  }

  try {
    // Create GitHub Issue
    const response = await fetch(
      `https://api.github.com/repos/${githubOrg}/${info.repoName}/issues`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${githubPat}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: text.length > 100 ? text.substring(0, 100) + '...' : text,
          body: `**Found during preview testing**\n\nBranch: \`${info.branch}\`\nReported by: Slack user <@${userId}>\n\n---\n\n${text}`,
          labels: ['type/bug', 'env/preview'],
        }),
      }
    );

    if (response.ok) {
      const issue = (await response.json()) as { number: number; html_url: string };
      markBotCreatedIssue(info.repoName, issue.number);

      const client = getWebClient();
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:white_check_mark: Issue #${issue.number} created!\n\n<${issue.html_url}|View on GitHub>`,
      });

      // Clear the tracking
      awaitingIssueDescription.delete(`${channel}:${threadTs}`);

      logger.info('GitHub issue created from preview thread', {
        repoName: info.repoName,
        issueNumber: issue.number,
        branch: info.branch,
      });
    } else {
      const errorBody = await response.text();
      logger.error('Failed to create GitHub issue', { status: response.status, error: errorBody });

      const client = getWebClient();
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:x: Failed to create the issue. Please create it manually on GitHub.`,
      });
    }

    return true;
  } catch (error) {
    logger.error('Error creating issue from thread', { error: (error as Error).message });
    return false;
  }
}
