import type { Context } from 'hono';
import { getWebClient, setChannelTopic, openModal, postEphemeral } from '../slack/client.js';
import { markBotCreatedIssue } from './github.js';
import { getDb } from '../db/client.js';
import { getOpenIssuesForRepo } from '../db/queries.js';
import { refreshBugsTable } from '../slack/table-manager.js';
import { getRepoNameFromChannel } from '../config/channels.js';
import { buildNewIssueMessage } from '../slack/messages.js';
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
      if (action.action_id === 'new_bug_or_feature') {
        await openNewBugOrFeatureModal(payload);
      } else if (action.action_id === 'new_bug') {
        await openNewBugModal(payload);
      } else if (action.action_id === 'new_feature') {
        await openNewFeatureModal(payload);
      } else if (action.action_id === 'assign_tasks') {
        await openAssignTasksModal(payload);
      } else if (action.action_id === 'bug_details') {
        await openBugDetailsModal(payload);
      } else if (action.action_id === 'edit_tasks') {
        await openEditTasksModal(payload);
      } else if (action.action_id === 'task_selected_for_edit') {
        const picked = parseInt(action.selected_option?.value ?? '0', 10);
        if (picked > 0) await updateEditTasksWithSelection(payload, picked);
      } else if (action.action_id === 'edit_type_bug') {
        await updateEditTasksType(payload, 'bug');
      } else if (action.action_id === 'edit_type_feature') {
        await updateEditTasksType(payload, 'feature');
      } else if (action.action_id === 'choose_type_bug') {
        // Toggle inside the combined New Bug/Feature modal — swap the view
        await updateTypeChooserView(payload, 'bug');
      } else if (action.action_id === 'choose_type_feature') {
        await updateTypeChooserView(payload, 'feature');
      } else if (action.action_id === 'bug_selected') {
        // User picked a bug in the Bug Details modal — show live preview
        const picked = parseInt(action.selected_option?.value ?? '0', 10);
        if (picked > 0) await updateBugDetailsWithSelection(payload, picked);
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
          } else if (action.action_id === 'fix_with_claude') {
            await handleFixWithClaudeButton(payload);
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
      } else if (callbackId === 'new_bug_or_feature_modal') {
        await handleCombinedNewIssueSubmission(payload);
      } else if (callbackId === 'assign_tasks_modal') {
        await handleAssignTasksSubmission(payload);
      } else if (callbackId === 'bug_details_modal') {
        await handleBugDetailsSubmission(payload);
      } else if (callbackId === 'edit_tasks_modal') {
        await handleEditTasksSubmission(payload);
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
// Bug Message Registry — maps Slack messages to GitHub issues for sync
// ---------------------------------------------------------------------------

export interface BugMessageInfo {
  channel: string;
  messageTs: string;
  repoName: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
}

/** channel:messageTs → bug info */
const bugMessages = new Map<string, BugMessageInfo>();
/** repo:issueNumber → bug info (reverse lookup for GitHub comment webhook) */
const bugMessagesByIssue = new Map<string, BugMessageInfo>();

export function registerBugMessage(info: BugMessageInfo): void {
  bugMessages.set(`${info.channel}:${info.messageTs}`, info);
  bugMessagesByIssue.set(`${info.repoName}:${info.issueNumber}`, info);
  logger.info('Bug message registered for sync', {
    channel: info.channel,
    issueNumber: info.issueNumber,
  });
}

export function getBugMessage(channel: string, messageTs: string): BugMessageInfo | undefined {
  return bugMessages.get(`${channel}:${messageTs}`);
}

export function getBugMessageByIssue(repoName: string, issueNumber: number): BugMessageInfo | undefined {
  return bugMessagesByIssue.get(`${repoName}:${issueNumber}`);
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

/**
 * Build the view object for the combined New Bug/Feature modal.
 *
 * Slack's radio_buttons are always vertical, so we use two buttons in an
 * actions block at the top to get horizontal side-by-side selection.
 * The active type's button is styled `primary` (blue), the other is default.
 * When the user clicks the other button, we call views.update to swap the
 * whole view in place — Feature view hides Priority + Source, Bug view
 * shows them.
 */
function buildTypeChooserView(
  type: 'bug' | 'feature',
  meta: { channelId: string; repoName: string }
): any {
  const isBug = type === 'bug';

  const fieldBlocks: any[] = [
    {
      type: 'input',
      block_id: 'title',
      label: { type: 'plain_text', text: 'Title' },
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        placeholder: { type: 'plain_text', text: isBug ? 'What is broken?' : 'What feature do you want?' },
      },
    },
    {
      type: 'input',
      block_id: 'description',
      label: { type: 'plain_text', text: 'Description' },
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        multiline: true,
        placeholder: {
          type: 'plain_text',
          text: isBug
            ? 'Steps to reproduce, what you expected, what happened instead...'
            : 'Describe the feature, why it is needed...',
        },
      },
    },
    {
      type: 'input',
      block_id: 'area',
      label: { type: 'plain_text', text: 'Area' },
      element: {
        type: 'static_select',
        action_id: 'value',
        options: AREA_OPTIONS,
        placeholder: { type: 'plain_text', text: 'Where in the app?' },
      },
    },
  ];

  // Only bugs get priority + source — features skip these
  if (isBug) {
    fieldBlocks.push(
      {
        type: 'input',
        block_id: 'priority',
        label: { type: 'plain_text', text: 'Priority' },
        element: {
          type: 'static_select',
          action_id: 'value',
          options: PRIORITY_OPTIONS,
          initial_option: PRIORITY_OPTIONS[2], // medium
        },
      },
      {
        type: 'input',
        block_id: 'source',
        label: { type: 'plain_text', text: 'Source' },
        element: {
          type: 'static_select',
          action_id: 'value',
          initial_option: { text: { type: 'plain_text', text: 'Internal (found by team)' }, value: 'internal' },
          options: [
            { text: { type: 'plain_text', text: 'External (customer reported)' }, value: 'customer' },
            { text: { type: 'plain_text', text: 'Internal (found by team)' }, value: 'internal' },
          ],
        },
      }
    );
  }

  return {
    type: 'modal',
    callback_id: 'new_bug_or_feature_modal',
    private_metadata: JSON.stringify({ ...meta, type }),
    title: { type: 'plain_text', text: isBug ? 'New Bug' : 'New Feature' },
    submit: { type: 'plain_text', text: 'Create' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'actions',
        block_id: 'type_chooser',
        elements: [
          {
            type: 'button',
            action_id: 'choose_type_bug',
            text: { type: 'plain_text', text: ':bug: Bug', emoji: true },
            ...(isBug ? { style: 'primary' } : {}),
          },
          {
            type: 'button',
            action_id: 'choose_type_feature',
            text: { type: 'plain_text', text: ':bulb: Feature', emoji: true },
            ...(!isBug ? { style: 'primary' } : {}),
          },
        ],
      },
      { type: 'divider' },
      ...fieldBlocks,
    ],
  };
}

async function openNewBugOrFeatureModal(payload: any): Promise<void> {
  const channelId = payload.channel?.id ?? '';
  const repoName = getRepoFromPayload(payload) ?? 'passcraft';
  await openModal(payload.trigger_id, buildTypeChooserView('bug', { channelId, repoName }));
}

/**
 * Swap the modal view in place when the user toggles Bug <-> Feature.
 * Uses views.update with the view_id from the block_actions payload.
 */
async function updateTypeChooserView(payload: any, type: 'bug' | 'feature'): Promise<void> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const channelId = meta.channelId ?? '';
  const repoName = meta.repoName ?? 'passcraft';
  const client = getWebClient();
  try {
    await client.views.update({
      view_id: payload.view.id,
      view: buildTypeChooserView(type, { channelId, repoName }),
    });
  } catch (error) {
    logger.error('Failed to update type chooser view', {
      error: (error as Error).message,
    });
  }
}

async function handleCombinedNewIssueSubmission(payload: any): Promise<void> {
  // Type lives in private_metadata now, not in a form field
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const type: 'bug' | 'feature' = meta.type === 'feature' ? 'feature' : 'bug';
  await handleNewIssueSubmission(payload, type);
}

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
      const emoji = type === 'bug' ? ':bug:' : ':bulb:';
      const source = (values.source?.value?.selected_option?.value ?? 'internal');
      const sourceTag = source === 'customer' ? '[EXT]' : '[INT]';

      // Extract user who opened the modal
      const reporterName = payload.user?.name ?? payload.user?.username ?? 'team';
      const areaTitle = area
        ? area.charAt(0).toUpperCase() + area.slice(1).replace(/-/g, ' ')
        : 'No area';
      const bodyText = description
        ? `\n>>> ${description.length > 300 ? description.slice(0, 300) + '...' : description}`
        : '';

      const blocks = [
        {
          type: 'section' as const,
          text: {
            type: 'mrkdwn' as const,
            text: `${emoji} *New ${typeLabel}*\nReported by *${reporterName}*\n\n*${areaTitle}*\n${sourceTag} <${issue.html_url}|#${issue.number}: ${title}>${bodyText}`,
          },
        },
        {
          type: 'actions' as const,
          elements: [
            {
              type: 'button' as const,
              text: { type: 'plain_text' as const, text: 'View on GitHub', emoji: true },
              url: issue.html_url,
              action_id: 'view_issue_github',
            },
            {
              type: 'button' as const,
              text: { type: 'plain_text' as const, text: 'Create Prompt to Fix', emoji: true },
              action_id: 'fix_with_claude',
              style: 'primary' as const,
            },
          ],
        },
        {
          type: 'context' as const,
          elements: [
            {
              type: 'mrkdwn' as const,
              text: ':speech_balloon: Reply in thread to discuss \u2014 all messages sync to GitHub',
            },
          ],
        },
        {
          type: 'context' as const,
          elements: [
            {
              type: 'mrkdwn' as const,
              text: ':hammer: claim this bug  \u2022  :white_check_mark: mark as fixed  \u2022  :eyes: investigating',
            },
          ],
        },
      ];

      const result = await client.chat.postMessage({
        channel: channelId,
        blocks,
        text: `New ${typeLabel}: ${title}`,
      });

      // Register message ↔ issue mapping for bidirectional sync
      if (result.ts) {
        registerBugMessage({
          channel: channelId,
          messageTs: result.ts,
          repoName,
          issueNumber: issue.number,
          issueUrl: issue.html_url,
          title,
        });

        // Bot auto-reacts so users can just click to claim/fix/investigate
        await Promise.all([
          client.reactions.add({ channel: channelId, timestamp: result.ts, name: 'hammer' }).catch(() => {}),
          client.reactions.add({ channel: channelId, timestamp: result.ts, name: 'white_check_mark' }).catch(() => {}),
          client.reactions.add({ channel: channelId, timestamp: result.ts, name: 'eyes' }).catch(() => {}),
        ]);
      }

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

/**
 * Handle the "Fix with Claude" button click on a bug message.
 * Generates a Claude Code prompt and sends it as an ephemeral message.
 */
async function handleFixWithClaudeButton(payload: any): Promise<void> {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const userId = payload.user?.id;

  if (!channel || !messageTs || !userId) return;

  const info = getBugMessage(channel, messageTs);
  if (!info) {
    await postEphemeral(channel, userId, 'Could not find bug info — this message may be too old.');
    return;
  }

  // Look up user's name for preview URL
  const client = getWebClient();
  let userName = 'user';
  try {
    const userInfo = await client.users.info({ user: userId });
    userName = (userInfo.user as any)?.real_name?.split(' ')[0]?.toLowerCase() ?? 'user';
  } catch { /* use default */ }

  const prompt = `Fix this bug in ${info.repoName}:

#${info.issueNumber}: ${info.title}
${info.issueUrl}

Read the full issue (including all comments), create a new branch, fix the bug, and push to preview-${userName}.${info.repoName.toLowerCase()}.pro`;

  await postEphemeral(
    channel,
    userId,
    `:clipboard: *Your Claude Code prompt:*\n\n\`\`\`\n${prompt}\n\`\`\`\n\nCopy this and paste it into your Claude Code session.`
  );
}

// ---------------------------------------------------------------------------
// Bug Details Modal — add a comment to an existing bug, with auto-recreate
// ---------------------------------------------------------------------------

/**
 * Open the Bug Details modal.
 *
 * Shows a dropdown of all open bugs + a multiline comment field.
 * When the user submits, we post the comment to the GitHub issue AND
 * to the Slack thread. If the original Slack message was deleted, we
 * rebuild it first so the comment has a thread to live in.
 */
/**
 * Shape of the live preview shown when a user picks a bug in the Bug Details modal.
 * All fields come from fresh GitHub data + Slack thread history — never from the
 * local DB cache, so the user sees the true current state.
 */
interface BugPreview {
  issueNumber: number;
  title: string;
  body: string;
  area: string;
  priority: string;
  source: string;
  state: string;
  issueUrl: string;
  threadMessages: string[]; // last 5 thread replies, formatted
}

/**
 * Build the Bug Details modal view.
 *
 * If `preview` is provided, renders the current GitHub data + latest thread
 * messages as read-only context blocks above the comment field. The issue
 * dropdown uses `dispatch_action: true` so a new selection triggers a
 * block_actions event, which the handler uses to views.update the modal
 * with a fresh preview.
 */
function buildBugDetailsView(
  issueOptions: any[],
  preview: BugPreview | null,
  meta: { channelId: string; repoName: string; userId: string }
): any {
  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Pick a bug to see its current details + thread, then add a comment. Everything syncs to GitHub.',
      },
    },
    {
      type: 'input',
      block_id: 'issue',
      dispatch_action: true,
      label: { type: 'plain_text', text: 'Which bug?' },
      element: {
        type: 'static_select',
        action_id: 'bug_selected',
        options: issueOptions,
        placeholder: { type: 'plain_text', text: 'Pick a bug' },
        ...(preview
          ? {
              initial_option: issueOptions.find(
                (o) => o.value === String(preview.issueNumber)
              ),
            }
          : {}),
      },
    },
  ];

  if (preview) {
    const bodySnippet = preview.body
      ? preview.body.length > 400
        ? preview.body.slice(0, 400) + '...'
        : preview.body
      : '_(no description)_';

    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*<${preview.issueUrl}|#${preview.issueNumber} ${preview.title}>*\n` +
            `Area: \`${preview.area}\` • Priority: \`${preview.priority}\` • Source: \`${preview.source}\` • State: \`${preview.state}\`\n\n` +
            bodySnippet,
        },
      }
    );

    if (preview.threadMessages.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Recent thread messages:*\n${preview.threadMessages.join('\n')}`,
        },
      });
    } else {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_No thread messages yet_' }],
      });
    }

    blocks.push({ type: 'divider' });
  }

  blocks.push({
    type: 'input',
    block_id: 'comment',
    label: { type: 'plain_text', text: 'Your comment' },
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      multiline: true,
      placeholder: { type: 'plain_text', text: 'What do you want to add?' },
    },
  });

  return {
    type: 'modal',
    callback_id: 'bug_details_modal',
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Details' },
    submit: { type: 'plain_text', text: 'Add Comment' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

async function buildIssueDropdownOptions(repoName: string): Promise<any[]> {
  const db = getDb();
  const openIssues = await getOpenIssuesForRepo(db, repoName);
  // Slack static_select caps at 100 options
  return openIssues.slice(0, 100).map((i) => {
    const label = `#${i.issueNumber} ${i.title}`.slice(0, 75);
    return {
      text: { type: 'plain_text' as const, text: label },
      value: String(i.issueNumber),
    };
  });
}

async function openBugDetailsModal(payload: any): Promise<void> {
  const channelId = payload.channel?.id ?? '';
  const userId = payload.user?.id ?? '';
  const repoName = getRepoFromPayload(payload) ?? 'passcraft';

  const issueOptions = await buildIssueDropdownOptions(repoName);

  if (issueOptions.length === 0) {
    await postEphemeral(channelId, userId, 'No open issues found for this repo.');
    return;
  }

  await openModal(
    payload.trigger_id,
    buildBugDetailsView(issueOptions, null, { channelId, repoName, userId })
  );
}

/**
 * Fetch the fresh state of an issue from GitHub (labels, title, body).
 * Returns null on any failure — callers should degrade gracefully.
 */
async function fetchGitHubIssue(
  repoName: string,
  issueNumber: number
): Promise<null | {
  title: string;
  body: string;
  state: string;
  html_url: string;
  labels: Array<{ name: string }>;
}> {
  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg) return null;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${githubOrg}/${repoName}/issues/${issueNumber}`,
      {
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: 'application/vnd.github+json',
        },
      }
    );
    if (!response.ok) return null;
    return (await response.json()) as any;
  } catch {
    return null;
  }
}

/**
 * Fetch the last few replies in a Slack thread, formatted as bulleted
 * strings ready for rendering in a section block. Truncates long messages.
 */
async function fetchThreadPreview(channel: string, threadTs: string): Promise<string[]> {
  try {
    const client = getWebClient();
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20,
    });
    const messages = result.messages ?? [];
    // Skip the first message (the parent post itself) and take the last 5 replies
    const replies = messages.slice(1).slice(-5);
    return replies.map((msg: any) => {
      const user = msg.user ? `<@${msg.user}>` : 'bot';
      let text = (msg.text ?? '').replace(/\s+/g, ' ').trim();
      if (text.length > 150) text = text.slice(0, 150) + '...';
      return `• ${user}: ${text || '_(no text)_'}`;
    });
  } catch {
    return [];
  }
}

/**
 * Handle the bug dropdown change — called when the user picks a bug in
 * the Bug Details modal. Fetches fresh GitHub data + Slack thread, then
 * uses views.update to re-render the modal with the preview block.
 */
async function updateBugDetailsWithSelection(payload: any, issueNumber: number): Promise<void> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const channelId = meta.channelId ?? '';
  const repoName = meta.repoName ?? 'passcraft';
  const userId = meta.userId ?? '';

  const [issue, dropdownOptions] = await Promise.all([
    fetchGitHubIssue(repoName, issueNumber),
    buildIssueDropdownOptions(repoName),
  ]);

  if (!issue) {
    logger.error('Bug Details: failed to fetch issue from GitHub', { repoName, issueNumber });
    return;
  }

  // Parse area / priority / source from label names
  const labelNames = issue.labels.map((l) => l.name);
  const area = labelNames.find((n) => n.startsWith('area/'))?.slice(5) ?? 'unassigned';
  const priority = labelNames.find((n) => n.startsWith('priority/'))?.slice(9) ?? 'medium';
  const source = labelNames.find((n) => n.startsWith('source/'))?.slice(7) ?? 'internal';

  // If we have a registered Slack message for this bug, fetch the thread replies
  const registered = getBugMessageByIssue(repoName, issueNumber);
  const threadMessages = registered
    ? await fetchThreadPreview(registered.channel, registered.messageTs)
    : [];

  const preview: BugPreview = {
    issueNumber,
    title: issue.title,
    body: issue.body ?? '',
    area,
    priority,
    source,
    state: issue.state,
    issueUrl: issue.html_url,
    threadMessages,
  };

  try {
    const client = getWebClient();
    await client.views.update({
      view_id: payload.view.id,
      view: buildBugDetailsView(dropdownOptions, preview, { channelId, repoName, userId }),
    });
  } catch (error) {
    logger.error('Bug Details: failed to update view with preview', {
      error: (error as Error).message,
    });
  }
}

/**
 * Handle Bug Details modal submission.
 *
 * - Post comment to GitHub (marked "(via Slack)" for loop prevention)
 * - If the Slack bug message still exists: post comment as thread reply
 * - If not: rebuild the bug message from DB, post it, register the new ts,
 *   then post the comment as a thread reply
 */
async function handleBugDetailsSubmission(payload: any): Promise<void> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const { channelId, repoName, userId } = meta;
  const values = payload.view?.state?.values ?? {};

  // The action_id for the issue picker is now `bug_selected` (was `value`)
  const issueNumber = parseInt(
    values.issue?.bug_selected?.selected_option?.value ?? '0',
    10
  );
  const comment: string = values.comment?.value?.value ?? '';

  if (!issueNumber || !comment || !channelId || !repoName) return;

  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg) {
    logger.error('Bug Details: GitHub credentials missing');
    return;
  }

  const client = getWebClient();

  // Look up the commenter's name for GitHub attribution
  let userName = 'Slack user';
  try {
    const userInfo = await client.users.info({ user: userId });
    userName = (userInfo.user as any)?.real_name ?? 'Slack user';
  } catch { /* use default */ }

  // 1. Post comment to GitHub with "(via Slack)" marker for loop prevention
  try {
    const body = `**${userName}** (via Slack):\n\n${comment}`;
    await fetch(
      `https://api.github.com/repos/${githubOrg}/${repoName}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
      }
    );
    logger.info('Bug Details: comment posted to GitHub', { repoName, issueNumber });
  } catch (error) {
    logger.error('Bug Details: failed to post GitHub comment', {
      error: (error as Error).message,
    });
  }

  // 2. Look up the existing Slack message
  let bug = getBugMessageByIssue(repoName, issueNumber);

  // 3. If message was deleted/missing, rebuild it from DB
  if (!bug) {
    logger.info('Bug Details: Slack message missing, recreating', { repoName, issueNumber });

    const db = getDb();
    const openIssues = await getOpenIssuesForRepo(db, repoName);
    const issueRow = openIssues.find((i) => i.issueNumber === issueNumber);

    if (!issueRow) {
      logger.error('Bug Details: issue not found in DB for recreate', {
        repoName,
        issueNumber,
      });
      return;
    }

    const labels: string[] = [];
    if (issueRow.typeLabel) labels.push(`type/${issueRow.typeLabel}`);
    if (issueRow.areaLabel) labels.push(`area/${issueRow.areaLabel}`);
    if (issueRow.priorityLabel) labels.push(`priority/${issueRow.priorityLabel}`);
    if (issueRow.sourceLabel) labels.push(`source/${issueRow.sourceLabel}`);

    const blocks = buildNewIssueMessage({
      title: issueRow.title,
      issueUrl: issueRow.htmlUrl,
      issueNumber: issueRow.issueNumber,
      repoName,
      reportedBy: issueRow.assigneeGithub ?? 'team',
      labels,
      body: null,
      isCustomerSource: issueRow.sourceLabel === 'customer' || issueRow.sourceLabel === 'user-report',
      area: issueRow.areaLabel,
      priority: issueRow.priorityLabel,
      screenshotCount: 0,
    });

    try {
      const posted = await client.chat.postMessage({
        channel: channelId,
        blocks,
        text: `Bug #${issueRow.issueNumber}: ${issueRow.title}`,
      });

      if (posted.ts) {
        registerBugMessage({
          channel: channelId,
          messageTs: posted.ts,
          repoName,
          issueNumber: issueRow.issueNumber,
          issueUrl: issueRow.htmlUrl,
          title: issueRow.title,
        });
        bug = getBugMessageByIssue(repoName, issueNumber);

        // Restore the claim/fix/investigate reactions on the new message
        await Promise.all([
          client.reactions.add({ channel: channelId, timestamp: posted.ts, name: 'hammer' }).catch(() => {}),
          client.reactions.add({ channel: channelId, timestamp: posted.ts, name: 'white_check_mark' }).catch(() => {}),
          client.reactions.add({ channel: channelId, timestamp: posted.ts, name: 'eyes' }).catch(() => {}),
        ]);
      }
    } catch (error) {
      logger.error('Bug Details: failed to recreate Slack message', {
        error: (error as Error).message,
      });
      return;
    }
  }

  if (!bug) return;

  // 4. Post the comment as a thread reply in Slack
  try {
    await client.chat.postMessage({
      channel: bug.channel,
      thread_ts: bug.messageTs,
      text: `<@${userId}>: ${comment}`,
    });
    logger.info('Bug Details: comment posted to Slack thread', {
      channel: bug.channel,
      issueNumber,
    });
  } catch (error) {
    logger.error('Bug Details: failed to post Slack thread reply', {
      error: (error as Error).message,
    });
  }
}

// ---------------------------------------------------------------------------
// Edit Tasks Modal — full task editing (title, area, priority, source)
// ---------------------------------------------------------------------------

/**
 * Build the Edit Tasks modal view.
 *
 * Initial state: only a task picker. Once the user picks a task, a
 * block_actions event fires → handler fetches current GitHub state →
 * views.update with a version that adds editable pre-filled fields
 * (title, area, priority, source). Only shows priority/source for bugs;
 * features get title + area only.
 */
function buildEditTasksView(
  issueOptions: any[],
  current: null | {
    issueNumber: number;
    title: string;
    type: 'bug' | 'feature';
    area: string;
    priority: string;
    source: string;
  },
  baseMeta: { channelId: string; repoName: string; userId: string }
): any {
  // private_metadata needs to carry the picked issueNumber + current type
  // so handlers (type toggle + submit) can work without re-parsing form state
  const privateMeta = current
    ? { ...baseMeta, issueNumber: current.issueNumber, type: current.type }
    : baseMeta;

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Pick a task to edit. Title, type, area, priority and source can all be changed.',
      },
    },
    {
      type: 'input',
      block_id: 'task',
      dispatch_action: true,
      label: { type: 'plain_text', text: 'Which task?' },
      element: {
        type: 'static_select',
        action_id: 'task_selected_for_edit',
        options: issueOptions,
        placeholder: { type: 'plain_text', text: 'Pick a task' },
        ...(current
          ? {
              initial_option: issueOptions.find(
                (o) => o.value === String(current.issueNumber)
              ),
            }
          : {}),
      },
    },
  ];

  if (current) {
    const isBug = current.type === 'bug';

    // Horizontal type chooser — two buttons, current type is primary (green)
    blocks.push(
      { type: 'divider' },
      {
        type: 'actions',
        block_id: 'edit_type_chooser',
        elements: [
          {
            type: 'button',
            action_id: 'edit_type_bug',
            text: { type: 'plain_text', text: ':bug: Bug', emoji: true },
            ...(isBug ? { style: 'primary' } : {}),
          },
          {
            type: 'button',
            action_id: 'edit_type_feature',
            text: { type: 'plain_text', text: ':bulb: Feature', emoji: true },
            ...(!isBug ? { style: 'primary' } : {}),
          },
        ],
      }
    );

    // Editable title
    blocks.push({
      type: 'input',
      block_id: 'title',
      label: { type: 'plain_text', text: 'Title' },
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        initial_value: current.title,
      },
    });

    // Editable area — preselect the current one
    const areaInitial = AREA_OPTIONS.find((o) => o.value === current.area);
    blocks.push({
      type: 'input',
      block_id: 'area',
      label: { type: 'plain_text', text: 'Area' },
      element: {
        type: 'static_select',
        action_id: 'value',
        options: AREA_OPTIONS,
        ...(areaInitial ? { initial_option: areaInitial } : {}),
      },
    });

    // Priority + source only apply to bugs; features don't get them
    if (isBug) {
      const priorityInitial = PRIORITY_OPTIONS.find((o) => o.value === current.priority);
      blocks.push({
        type: 'input',
        block_id: 'priority',
        label: { type: 'plain_text', text: 'Priority' },
        element: {
          type: 'static_select',
          action_id: 'value',
          options: PRIORITY_OPTIONS,
          ...(priorityInitial ? { initial_option: priorityInitial } : {}),
        },
      });

      const sourceOptions = [
        { text: { type: 'plain_text', text: 'External (customer reported)' }, value: 'customer' },
        { text: { type: 'plain_text', text: 'Internal (found by team)' }, value: 'internal' },
      ];
      const sourceInitial = sourceOptions.find((o) => o.value === current.source);
      blocks.push({
        type: 'input',
        block_id: 'source',
        label: { type: 'plain_text', text: 'Source' },
        element: {
          type: 'static_select',
          action_id: 'value',
          options: sourceOptions,
          ...(sourceInitial ? { initial_option: sourceInitial } : {}),
        },
      });
    }
  }

  return {
    type: 'modal',
    callback_id: 'edit_tasks_modal',
    private_metadata: JSON.stringify(privateMeta),
    title: { type: 'plain_text', text: 'Edit Tasks' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

/**
 * Swap the Edit Tasks view's type (bug ↔ feature) without losing in-flight edits.
 * Reads the current form state so title/area/priority/source stay where the
 * user left them, then re-renders with the new type (which hides or shows
 * priority + source).
 */
async function updateEditTasksType(payload: any, newType: 'bug' | 'feature'): Promise<void> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const channelId = meta.channelId ?? '';
  const repoName = meta.repoName ?? 'passcraft';
  const userId = meta.userId ?? '';
  const issueNumber: number = typeof meta.issueNumber === 'number' ? meta.issueNumber : 0;

  if (!issueNumber) return; // Type chooser only makes sense after a task is picked

  // Preserve in-flight edits — read form state values
  const values = payload.view?.state?.values ?? {};
  const currentTitle: string = values.title?.value?.value ?? '';
  const currentArea: string = values.area?.value?.selected_option?.value ?? 'unassigned';
  // Priority/source default to medium/internal when switching feature → bug
  const currentPriority: string = values.priority?.value?.selected_option?.value ?? 'medium';
  const currentSource: string = values.source?.value?.selected_option?.value ?? 'internal';

  const issueOptions = await buildTaskDropdownOptions(repoName);

  try {
    const client = getWebClient();
    await client.views.update({
      view_id: payload.view.id,
      view: buildEditTasksView(
        issueOptions,
        {
          issueNumber,
          title: currentTitle,
          type: newType,
          area: currentArea,
          priority: currentPriority,
          source: currentSource,
        },
        { channelId, repoName, userId }
      ),
    });
  } catch (error) {
    logger.error('Edit Tasks: failed to swap type', {
      error: (error as Error).message,
    });
  }
}

async function buildTaskDropdownOptions(repoName: string): Promise<any[]> {
  const db = getDb();
  const openIssues = await getOpenIssuesForRepo(db, repoName);
  // Surface unassigned issues first so the most common edit case is easy
  const sorted = [...openIssues].sort((a, b) => {
    if (!a.areaLabel && b.areaLabel) return -1;
    if (a.areaLabel && !b.areaLabel) return 1;
    return 0;
  });
  return sorted.slice(0, 100).map((i) => {
    const areaTag = i.areaLabel ? `[${i.areaLabel}]` : '[unassigned]';
    const label = `#${i.issueNumber} ${areaTag} ${i.title}`.slice(0, 75);
    return {
      text: { type: 'plain_text' as const, text: label },
      value: String(i.issueNumber),
    };
  });
}

async function openEditTasksModal(payload: any): Promise<void> {
  const channelId = payload.channel?.id ?? '';
  const userId = payload.user?.id ?? '';
  const repoName = getRepoFromPayload(payload) ?? 'passcraft';

  const issueOptions = await buildTaskDropdownOptions(repoName);

  if (issueOptions.length === 0) {
    await postEphemeral(channelId, userId, 'No open tasks to edit.');
    return;
  }

  await openModal(
    payload.trigger_id,
    buildEditTasksView(issueOptions, null, { channelId, repoName, userId })
  );
}

/**
 * Fill the Edit Tasks modal with the picked task's current values.
 * Fetches fresh labels + title from GitHub so edits always start from
 * the true current state.
 */
async function updateEditTasksWithSelection(payload: any, issueNumber: number): Promise<void> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const channelId = meta.channelId ?? '';
  const repoName = meta.repoName ?? 'passcraft';
  const userId = meta.userId ?? '';

  const [issue, issueOptions] = await Promise.all([
    fetchGitHubIssue(repoName, issueNumber),
    buildTaskDropdownOptions(repoName),
  ]);

  if (!issue) {
    logger.error('Edit Tasks: failed to fetch issue from GitHub', { repoName, issueNumber });
    return;
  }

  const labelNames = issue.labels.map((l) => l.name);
  const type: 'bug' | 'feature' = labelNames.some((n) => n === 'type/bug' || n === 'bug')
    ? 'bug'
    : 'feature';
  const area = labelNames.find((n) => n.startsWith('area/'))?.slice(5) ?? 'unassigned';
  const priority = labelNames.find((n) => n.startsWith('priority/'))?.slice(9) ?? 'medium';
  const source = labelNames.find((n) => n.startsWith('source/'))?.slice(7) ?? 'internal';

  try {
    const client = getWebClient();
    await client.views.update({
      view_id: payload.view.id,
      view: buildEditTasksView(
        issueOptions,
        {
          issueNumber,
          title: issue.title,
          type,
          area,
          priority,
          source,
        },
        { channelId, repoName, userId }
      ),
    });
  } catch (error) {
    logger.error('Edit Tasks: failed to update view with current values', {
      error: (error as Error).message,
    });
  }
}

/**
 * Handle Edit Tasks submission.
 *
 * PATCHes the GitHub issue with the new title and rebuilds the labels
 * (keeping type/* and any other non-edited labels, swapping area/* +
 * priority/* + source/* for the picked values). Refreshes the pinned
 * table so the change appears immediately.
 */
async function handleEditTasksSubmission(payload: any): Promise<void> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const { repoName } = meta;
  const values = payload.view?.state?.values ?? {};

  // Issue number + type live in private_metadata now (they survive view updates
  // from the type chooser). Fall back to form state for the issue picker.
  const issueNumber: number =
    typeof meta.issueNumber === 'number'
      ? meta.issueNumber
      : parseInt(values.task?.task_selected_for_edit?.selected_option?.value ?? '0', 10);
  const newType: 'bug' | 'feature' = meta.type === 'feature' ? 'feature' : 'bug';

  const newTitle: string = values.title?.value?.value ?? '';
  const newArea: string = values.area?.value?.selected_option?.value ?? '';
  // Priority + source are only present when editing a bug
  const newPriority: string | undefined = values.priority?.value?.selected_option?.value;
  const newSource: string | undefined = values.source?.value?.selected_option?.value;

  if (!issueNumber || !newTitle || !newArea || !repoName) {
    logger.error('Edit Tasks: missing required fields', { issueNumber, newTitle, newArea });
    return;
  }

  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg) {
    logger.error('Edit Tasks: GitHub credentials missing');
    return;
  }

  try {
    // 1. Fetch current labels so we can keep the ones we don't edit
    const getResponse = await fetch(
      `https://api.github.com/repos/${githubOrg}/${repoName}/issues/${issueNumber}`,
      {
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: 'application/vnd.github+json',
        },
      }
    );
    if (!getResponse.ok) {
      logger.error('Edit Tasks: failed to fetch issue', { status: getResponse.status });
      return;
    }

    const issue = (await getResponse.json()) as { labels: Array<{ name: string }> };

    // 2. Build new label set — strip type/bug, type/feature, area/*, priority/*,
    // source/*, plus the bare legacy 'bug' / 'feature' labels, then add fresh ones.
    const kept = issue.labels
      .map((l) => l.name)
      .filter(
        (name) =>
          name !== 'type/bug' &&
          name !== 'type/feature' &&
          name !== 'bug' &&
          name !== 'feature' &&
          !name.startsWith('area/') &&
          !name.startsWith('priority/') &&
          !name.startsWith('source/')
      );
    const newLabels = [...kept, `type/${newType}`, `area/${newArea}`];
    // Priority + source only apply to bugs — features don't get them, even
    // if they were set earlier when the task was still a bug.
    if (newType === 'bug') {
      if (newPriority) newLabels.push(`priority/${newPriority}`);
      if (newSource) newLabels.push(`source/${newSource}`);
    }

    // 3. PATCH GitHub with new title + labels
    const patchResponse = await fetch(
      `https://api.github.com/repos/${githubOrg}/${repoName}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: newTitle, labels: newLabels }),
      }
    );
    if (!patchResponse.ok) {
      logger.error('Edit Tasks: failed to update issue', { status: patchResponse.status });
      return;
    }

    logger.info('Edit Tasks: updated', {
      repoName,
      issueNumber,
      newTitle,
      newArea,
      newType,
    });

    // Refresh the pinned bugs table so the edit is visible immediately.
    // No ephemeral confirmation — the user sees the result in the pinned
    // table and doesn't need a "task updated" message cluttering the
    // channel.
    await refreshBugsTable(repoName);
  } catch (error) {
    logger.error('Edit Tasks: unexpected error', { error: (error as Error).message });
  }
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
