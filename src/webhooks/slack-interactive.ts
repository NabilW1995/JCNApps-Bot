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
      } else if (action.action_id === 'assign_pick_bug') {
        // Click-to-select: just toggle primary style, no advance
        await updateAssignStep1Type(payload, 'bug');
      } else if (action.action_id === 'assign_pick_feature') {
        await updateAssignStep1Type(payload, 'feature');
      } else if (action.action_id === 'assign_area_picked') {
        // User picked an area in Step 2 — show the tasks in that area
        const picked = action.selected_option?.value;
        if (picked) await updateAssignStep2WithArea(payload, picked);
      } else if (action.action_id === 'assign_back_to_step1') {
        // Back: re-render step 1 in place. Strip type from meta so the
        // user starts the picker fresh.
        const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
        const client = getWebClient();
        try {
          await client.views.update({
            view_id: payload.view.id,
            view: buildAssignStep1View({
              channelId: meta.channelId ?? '',
              repoName: meta.repoName ?? 'passcraft',
              userId: meta.userId ?? '',
              type: meta.type === 'feature' ? 'feature' : 'bug',
            }),
          });
        } catch (error) {
          logger.error('Assign Tasks: failed to go back to step 1', {
            error: (error as Error).message,
          });
        }
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
    const callbackId = payload.view?.callback_id;

    // Multi-step Assign Tasks: step 1 submit advances to step 2, step 2
    // submit advances to step 3. Both use response_action: 'update'
    // which must be returned synchronously.
    if (callbackId === 'assign_step1_modal') {
      try {
        const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
        const type: 'bug' | 'feature' = meta.type === 'feature' ? 'feature' : 'bug';
        const step2View = await buildAssignStep2ViewFromMeta({
          channelId: meta.channelId ?? '',
          repoName: meta.repoName ?? 'passcraft',
          userId: meta.userId ?? '',
          type,
        });
        return c.json({ response_action: 'update', view: step2View });
      } catch (error) {
        logger.error('Assign Tasks step 1 → 2 failed', {
          error: (error as Error).message,
        });
        return new Response('', { status: 200 });
      }
    }

    if (callbackId === 'assign_step2_modal') {
      try {
        const step3View = await buildAssignStep3FromStep2Payload(payload);
        if (!step3View) {
          // User picked nothing — show an error on the area_pick block
          return c.json({
            response_action: 'errors',
            errors: {
              area_pick: 'Pick at least one area or one task before continuing.',
            },
          });
        }
        return c.json({ response_action: 'update', view: step3View });
      } catch (error) {
        logger.error('Assign Tasks step 2 → 3 failed', {
          error: (error as Error).message,
        });
        return new Response('', { status: 200 });
      }
    }

    // All other modals: empty 200 + async processing
    const handleSubmission = async () => {
      if (callbackId === 'new_bug_modal') {
        await handleNewIssueSubmission(payload, 'bug');
      } else if (callbackId === 'new_feature_modal') {
        await handleNewIssueSubmission(payload, 'feature');
      } else if (callbackId === 'new_bug_or_feature_modal') {
        await handleCombinedNewIssueSubmission(payload);
      } else if (callbackId === 'assign_step3_modal') {
        await handleAssignTasksFinalSubmission(payload);
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
// Claim Registry — who is actively working on what
// ---------------------------------------------------------------------------
//
// When a user claims tasks via Assign Tasks, we store a ClaimInfo in memory
// with: the task numbers, the file list, and the ts/channel of the message
// posted in the active channel. The GitHub push webhook handler uses the
// GitHub-username lookup to find an active claim and update its files
// with the actual changed_files from the push, then edits the active
// channel message in place.
//
// Storage is in-memory: lost on container restart. That's OK because
// claims are short-lived (hours, not days) and the active channel message
// still exists in Slack history as a record. Persistent claims is a
// Phase A3 improvement if needed.

export interface ClaimInfo {
  slackUserId: string;
  githubUsername: string | null;
  repoName: string;
  type: 'bug' | 'feature';
  taskNumbers: number[];
  files: string[];
  startedAt: Date;
  activeChannel: string;
  activeMessageTs: string;
}

const claimsByUser = new Map<string, ClaimInfo>();

function claimKey(repoName: string, slackUserId: string): string {
  return `${repoName}:${slackUserId}`;
}

/**
 * Register or merge a claim. If the user already has an active claim in
 * this repo, we merge the new task numbers + files in and keep the
 * existing active-channel message so we can edit it in place.
 */
export function registerClaim(info: ClaimInfo): ClaimInfo {
  const key = claimKey(info.repoName, info.slackUserId);
  const existing = claimsByUser.get(key);
  if (existing) {
    const merged: ClaimInfo = {
      ...existing,
      taskNumbers: Array.from(new Set([...existing.taskNumbers, ...info.taskNumbers])),
      files: Array.from(new Set([...existing.files, ...info.files])),
    };
    claimsByUser.set(key, merged);
    return merged;
  }
  claimsByUser.set(key, info);
  return info;
}

export function getClaimByGithubUsername(
  repoName: string,
  githubUsername: string
): ClaimInfo | undefined {
  for (const c of claimsByUser.values()) {
    if (c.repoName === repoName && c.githubUsername === githubUsername) return c;
  }
  return undefined;
}

/**
 * Merge new files into an existing claim (from GitHub push webhook).
 * Returns the updated claim, or undefined if no matching claim exists.
 */
export function addFilesToClaim(
  repoName: string,
  githubUsername: string,
  newFiles: string[]
): ClaimInfo | undefined {
  const claim = getClaimByGithubUsername(repoName, githubUsername);
  if (!claim) return undefined;
  claim.files = Array.from(new Set([...claim.files, ...newFiles]));
  return claim;
}

/**
 * Build the Slack blocks for the active-channel claim notice. Same
 * function is used on initial post and on edit — keeps the format
 * consistent and allows the edit to replace the whole block list.
 */
export function buildActiveClaimBlocks(claim: ClaimInfo): any[] {
  const githubOrg = process.env.GITHUB_ORG ?? 'NabilW1995';
  const taskLinks = claim.taskNumbers
    .map((n) => `<https://github.com/${githubOrg}/${claim.repoName}/issues/${n}|#${n}>`)
    .join(', ');
  const filesBlock =
    claim.files.length > 0
      ? `\n:file_folder: Files: ${claim.files.map((f) => `\`${f}\``).join(', ')}`
      : '';
  const startedAt = claim.startedAt.toTimeString().slice(0, 5);
  const typeLabel = claim.type === 'bug' ? (claim.taskNumbers.length === 1 ? 'bug' : 'bugs') : (claim.taskNumbers.length === 1 ? 'feature' : 'features');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:hammer: <@${claim.slackUserId}> is working on ${claim.taskNumbers.length} ${typeLabel}\n${taskLinks}${filesBlock}\n:alarm_clock: Started ${startedAt}`,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// GitHub Code Search — find files matching issue-title keywords
// ---------------------------------------------------------------------------

const CODE_SEARCH_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'on', 'in', 'at', 'to', 'for', 'from', 'with', 'about', 'of',
  'and', 'or', 'but', 'not', 'no', 'can', 'will', 'should', 'would',
  'fix', 'bug', 'bugs', 'add', 'remove', 'update', 'create', 'issue',
  'broken', 'fails', 'failed', 'crash', 'crashes', 'error', 'errors',
  'new', 'old', 'this', 'that', 'these', 'those',
]);

/**
 * Pull meaningful keywords from an issue title for a code search query.
 * Drops stop words, very short tokens, and non-word characters. Caps
 * at 5 keywords to keep the search query short + the rate limit happy.
 */
function extractKeywordsFromTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !CODE_SEARCH_STOP_WORDS.has(w))
    .slice(0, 5);
}

/**
 * Search the repo for files that match the given keywords via the
 * GitHub Code Search API. Returns the top matching file paths.
 *
 * Silent fallback on any error — this is a best-effort suggestion,
 * never a hard dependency. Rate limited to 30 req/min for authenticated
 * users, so we cap at a few keywords and a few results per call.
 */
async function searchCodeForFiles(
  repoName: string,
  keywords: string[],
  maxResults: number = 3
): Promise<string[]> {
  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg || keywords.length === 0) return [];

  const query = `${keywords.join(' ')} repo:${githubOrg}/${repoName}`;
  const encoded = encodeURIComponent(query);

  try {
    const res = await fetch(
      `https://api.github.com/search/code?q=${encoded}&per_page=${maxResults}`,
      {
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: 'application/vnd.github+json',
        },
      }
    );
    if (!res.ok) {
      logger.warn('Code search failed', { repoName, status: res.status });
      return [];
    }
    const data = (await res.json()) as { items?: Array<{ path: string }> };
    return (data.items ?? []).map((i) => i.path);
  } catch (error) {
    logger.warn('Code search threw', { error: (error as Error).message });
    return [];
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

// ---------------------------------------------------------------------------
// Assign Tasks Modal — 3-step flow:
//   Step 1: pick type (Bug / Feature)
//   Step 2: pick by area OR pick individual tasks (multi-select)
//   Step 3: confirm + edit auto-detected file list, then save
// On save: GitHub assignee set, message posted in active channel,
// Claude prompt sent as ephemeral.
// ---------------------------------------------------------------------------

async function openAssignTasksModal(payload: any): Promise<void> {
  const channelId = payload.channel?.id ?? '';
  const repoName = getRepoFromPayload(payload) ?? 'passcraft';
  const userId = payload.user?.id ?? '';

  await openModal(
    payload.trigger_id,
    buildAssignStep1View({ channelId, repoName, userId, type: 'bug' })
  );
}

/**
 * Step 1: ask whether the user wants to pick up a bug or a feature.
 * Click-to-select pattern: Bug/Feature buttons toggle primary style via
 * views.update (no auto-advance). A real Slack 'Continue' submit button
 * at the bottom advances to step 2 via response_action: 'update'.
 * Selected type is stored in private_metadata so it survives the swap.
 */
function buildAssignStep1View(meta: {
  channelId: string;
  repoName: string;
  userId: string;
  type: 'bug' | 'feature';
}): any {
  const isBug = meta.type === 'bug';
  const currentLabel = isBug ? ':bug: Bug' : ':bulb: Feature Request';

  return {
    type: 'modal',
    callback_id: 'assign_step1_modal',
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Assign Tasks' },
    submit: { type: 'plain_text', text: 'Continue' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'What kind of work do you want to pick up?',
        },
      },
      {
        type: 'actions',
        block_id: 'assign_type_picker',
        elements: [
          {
            type: 'button',
            action_id: 'assign_pick_bug',
            text: { type: 'plain_text', text: ':bug: Bug', emoji: true },
            ...(isBug ? { style: 'primary' } : {}),
          },
          {
            type: 'button',
            action_id: 'assign_pick_feature',
            text: { type: 'plain_text', text: ':bulb: Feature Request', emoji: true },
            ...(!isBug ? { style: 'primary' } : {}),
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Selected: *${currentLabel}* — click *Continue* to pick tasks.`,
          },
        ],
      },
    ],
  };
}

/**
 * Update Step 1's selected type in place (views.update). No advance.
 */
async function updateAssignStep1Type(payload: any, type: 'bug' | 'feature'): Promise<void> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const client = getWebClient();
  try {
    await client.views.update({
      view_id: payload.view.id,
      view: buildAssignStep1View({
        channelId: meta.channelId ?? '',
        repoName: meta.repoName ?? 'passcraft',
        userId: meta.userId ?? '',
        type,
      }),
    });
  } catch (error) {
    logger.error('Assign Tasks: failed to update step 1 selection', {
      error: (error as Error).message,
    });
  }
}

/**
 * Build Step 2 view from step 1 payload (on Continue submit) OR from
 * any existing step 2 payload (on area-pick dispatch). Returns the
 * view object; caller decides how to use it (response_action update,
 * or client.views.update).
 *
 * pickedArea: area the user just picked — if set, the view will show
 * a context block listing the tasks in that area below the picker.
 */
async function buildAssignStep2ViewFromMeta(
  meta: { channelId: string; repoName: string; userId: string; type: 'bug' | 'feature' },
  pickedArea?: string
): Promise<any> {
  const repoName = meta.repoName;
  const type = meta.type;

  const db = getDb();
  const allIssues = await getOpenIssuesForRepo(db, repoName);
  const filtered = allIssues.filter((i) => i.typeLabel === type);

  if (filtered.length === 0) {
    return {
      type: 'modal',
      callback_id: 'assign_step1_modal',
      private_metadata: JSON.stringify(meta),
      title: { type: 'plain_text', text: 'Assign Tasks' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `_No open ${type === 'bug' ? 'bugs' : 'feature requests'} to assign. :tada:_`,
          },
        },
      ],
    };
  }

  // Group by area for the area-pick dropdown
  const areas = new Map<string, typeof filtered>();
  for (const issue of filtered) {
    const a = issue.areaLabel ?? 'unassigned';
    const list = areas.get(a) ?? [];
    list.push(issue);
    areas.set(a, list);
  }

  const areaOptions = Array.from(areas.entries()).map(([area, list]) => ({
    text: {
      type: 'plain_text' as const,
      text: `${area.charAt(0).toUpperCase() + area.slice(1)} (${list.length})`.slice(0, 75),
    },
    value: area,
  }));

  const taskOptions = filtered.slice(0, 100).map((i) => ({
    text: {
      type: 'plain_text' as const,
      text: `#${i.issueNumber} ${i.title}`.slice(0, 75),
    },
    value: String(i.issueNumber),
  }));

  // If an area is picked, list the tasks in that area so the user sees
  // exactly what they are about to claim. This block is added right below
  // the area picker.
  const pickedAreaTasks = pickedArea
    ? filtered.filter((i) => (i.areaLabel ?? 'unassigned') === pickedArea)
    : [];

  return buildAssignStep2View(meta, areaOptions, taskOptions, pickedArea, pickedAreaTasks);
}

function buildAssignStep2View(
  meta: { channelId: string; repoName: string; userId: string; type: 'bug' | 'feature' },
  areaOptions: any[],
  taskOptions: any[],
  pickedArea: string | undefined,
  pickedAreaTasks: Array<{ issueNumber: number; title: string }>
): any {
  const typeLabel = meta.type === 'bug' ? 'Bug' : 'Feature Request';

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Picking *${typeLabel}* work. Choose a whole area, or pick individual tasks. You can use both at once \u2014 they get unioned.`,
      },
    },
    {
      type: 'input',
      block_id: 'area_pick',
      optional: true,
      dispatch_action: true,
      label: { type: 'plain_text', text: 'Pick a whole area' },
      element: {
        type: 'static_select',
        action_id: 'assign_area_picked',
        options: areaOptions,
        placeholder: { type: 'plain_text', text: 'Claim every task in one area' },
        ...(pickedArea
          ? {
              initial_option: areaOptions.find((o) => o.value === pickedArea),
            }
          : {}),
      },
    },
  ];

  // Inline preview of the tasks in the picked area — user sees exactly
  // what claiming this area will do.
  if (pickedArea && pickedAreaTasks.length > 0) {
    const lines = pickedAreaTasks
      .map((t) => `\u2022 *#${t.issueNumber}* ${t.title}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Tasks you'll claim from ${pickedArea}:*\n${lines}`,
      },
    });
  }

  blocks.push({
    type: 'input',
    block_id: 'task_pick',
    optional: true,
    label: { type: 'plain_text', text: 'Or pick individual tasks' },
    element: {
      type: 'multi_static_select',
      action_id: 'value',
      options: taskOptions,
      placeholder: { type: 'plain_text', text: 'Cherry-pick specific tasks' },
    },
  });

  blocks.push({
    type: 'actions',
    block_id: 'assign_step2_nav',
    elements: [
      {
        type: 'button',
        action_id: 'assign_back_to_step1',
        text: { type: 'plain_text', text: ':arrow_left: Back' },
      },
    ],
  });

  return {
    type: 'modal',
    callback_id: 'assign_step2_modal',
    private_metadata: JSON.stringify({ ...meta, pickedArea }),
    title: { type: 'plain_text', text: 'Pick Tasks' },
    submit: { type: 'plain_text', text: 'Next' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

/**
 * Called when user picks an area in Step 2's static_select (dispatch_action).
 * Re-renders the view to show the tasks in that area below the picker.
 */
async function updateAssignStep2WithArea(payload: any, pickedArea: string): Promise<void> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const client = getWebClient();
  try {
    const view = await buildAssignStep2ViewFromMeta(
      {
        channelId: meta.channelId ?? '',
        repoName: meta.repoName ?? 'passcraft',
        userId: meta.userId ?? '',
        type: meta.type === 'feature' ? 'feature' : 'bug',
      },
      pickedArea
    );
    await client.views.update({
      view_id: payload.view.id,
      view,
    });
  } catch (error) {
    logger.error('Assign Tasks: failed to update step 2 with area preview', {
      error: (error as Error).message,
    });
  }
}

/**
 * Naive file extractor — pulls anything that looks like a path from
 * the issue body. Catches src/foo/bar.tsx, app/Foo.ts, etc. Good
 * enough as a starting point; user can edit in step 3.
 */
function extractFilePaths(body: string): string[] {
  if (!body) return [];
  const re = /(?:^|\s|`)((?:src|app|lib|components|pages|api|utils|hooks)\/[\w./_-]+\.[a-zA-Z0-9]{1,5})/g;
  const found = new Set<string>();
  let match;
  while ((match = re.exec(body)) !== null) {
    found.add(match[1]);
  }
  return Array.from(found);
}

/**
 * Build the Step 3 view from a Step 2 view_submission payload.
 * Returns the view object so the caller can use it as the body of
 * a `response_action: 'update'` reply (Slack's multi-step modal pattern).
 *
 * Returns null if nothing was picked — in which case the caller should
 * keep the user on step 2 with an error.
 */
async function buildAssignStep3FromStep2Payload(payload: any): Promise<any | null> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const repoName: string = meta.repoName ?? 'passcraft';
  const type: 'bug' | 'feature' = meta.type === 'feature' ? 'feature' : 'bug';

  const values = payload.view?.state?.values ?? {};
  const pickedArea: string | undefined = values.area_pick?.assign_area_picked?.selected_option?.value;
  const pickedTaskNumbers: number[] = (values.task_pick?.value?.selected_options ?? [])
    .map((o: any) => parseInt(o.value, 10))
    .filter((n: number) => !isNaN(n));

  const db = getDb();
  const allIssues = await getOpenIssuesForRepo(db, repoName);
  const filtered = allIssues.filter((i) => i.typeLabel === type);

  // Union: all tasks from picked area + individually picked
  const fromArea = pickedArea
    ? filtered.filter((i) => (i.areaLabel ?? 'unassigned') === pickedArea).map((i) => i.issueNumber)
    : [];
  const allPicked = Array.from(new Set([...fromArea, ...pickedTaskNumbers]));

  if (allPicked.length === 0) {
    return null;
  }

  const pickedTasks = filtered.filter((i) => allPicked.includes(i.issueNumber));

  // For each picked task, combine two sources of file suggestions:
  //  1. Regex-extracted paths mentioned directly in the issue body
  //  2. GitHub Code Search API hits for the issue title's keywords
  // Union deduped into a single Set. Code search is best-effort:
  // failures just reduce the suggestion quality, never break the flow.
  const allFiles = new Set<string>();
  await Promise.all(
    pickedTasks.map(async (t) => {
      const issue = await fetchGitHubIssue(repoName, t.issueNumber);
      const body = (issue as any)?.body ?? '';
      for (const f of extractFilePaths(body)) allFiles.add(f);

      const keywords = extractKeywordsFromTitle(t.title);
      const searched = await searchCodeForFiles(repoName, keywords, 3);
      for (const f of searched) allFiles.add(f);
    })
  );

  return buildAssignStep3View(
    { ...meta, taskNumbers: allPicked },
    pickedTasks,
    Array.from(allFiles)
  );
}

function buildAssignStep3View(
  meta: {
    channelId: string;
    repoName: string;
    userId: string;
    type: 'bug' | 'feature';
    taskNumbers: number[];
  },
  tasks: Array<{ issueNumber: number; title: string }>,
  autoFiles: string[]
): any {
  const typeLabel = meta.type === 'bug' ? 'Bug' : 'Feature Request';
  const taskList = tasks.map((t) => `\u2022 *#${t.issueNumber}* ${t.title}`).join('\n');

  return {
    type: 'modal',
    callback_id: 'assign_step3_modal',
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Confirm & Claim' },
    submit: { type: 'plain_text', text: 'Claim & Get Prompt' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*You're claiming ${tasks.length} ${typeLabel}${tasks.length > 1 ? 's' : ''}:*\n${taskList}`,
        },
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'files',
        optional: true,
        label: { type: 'plain_text', text: 'Files this work will touch' },
        hint: {
          type: 'plain_text',
          text: 'One file path per line. Auto-detected from issue bodies — edit if needed.',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          initial_value: autoFiles.join('\n'),
          placeholder: {
            type: 'plain_text',
            text: 'src/dashboard/Filter.tsx\nsrc/utils/safari-fix.ts',
          },
        },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Claiming will: assign issues to you on GitHub, post a notice in the active channel, and DM you a Claude Code prompt.',
          },
        ],
      },
    ],
  };
}

/**
 * Final save: assign GitHub issues to the user, post 'now working on…'
 * message in the active channel, and send the Claude prompt as ephemeral.
 */
async function handleAssignTasksFinalSubmission(payload: any): Promise<void> {
  const meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  const repoName: string = meta.repoName ?? 'passcraft';
  const userId: string = meta.userId ?? '';
  const type: 'bug' | 'feature' = meta.type === 'feature' ? 'feature' : 'bug';
  const taskNumbers: number[] = Array.isArray(meta.taskNumbers) ? meta.taskNumbers : [];

  const values = payload.view?.state?.values ?? {};
  const filesText: string = values.files?.value?.value ?? '';
  const files = filesText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (taskNumbers.length === 0 || !userId) return;

  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubPat || !githubOrg) {
    logger.error('Assign Tasks: GitHub credentials missing');
    return;
  }

  // Resolve the user's GitHub username from the team_members table
  let githubUsername: string | null = null;
  let userName = 'user';
  try {
    const db = getDb();
    const { getTeamMemberBySlackId } = await import('../db/queries.js');
    const member = await getTeamMemberBySlackId(db, userId);
    if (member) {
      githubUsername = member.githubUsername;
      userName = member.name?.split(' ')[0]?.toLowerCase() ?? 'user';
    }
  } catch (error) {
    logger.warn('Could not resolve GitHub username for assignee', {
      error: (error as Error).message,
    });
  }

  // 1. Assign each issue on GitHub (best-effort, parallel)
  if (githubUsername) {
    await Promise.all(
      taskNumbers.map(async (num) => {
        try {
          const res = await fetch(
            `https://api.github.com/repos/${githubOrg}/${repoName}/issues/${num}/assignees`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${githubPat}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ assignees: [githubUsername] }),
            }
          );
          if (!res.ok) {
            logger.warn('Assign Tasks: failed to assign issue', {
              num,
              status: res.status,
            });
          }
        } catch (error) {
          logger.error('Assign Tasks: assign call threw', {
            num,
            error: (error as Error).message,
          });
        }
      })
    );
  }

  // 2. Post (or update) the active-channel claim notice.
  //
  // If the user already has an active claim in this repo, we merge the new
  // task numbers + files into it and edit the existing message instead of
  // posting a new one. That way the Active channel stays clean even if the
  // user claims more work later.
  try {
    const { getChannelConfig } = await import('../config/channels.js');
    const config = getChannelConfig(repoName);
    if (config?.activeChannelId) {
      const client = getWebClient();

      const existingClaim = getClaimByGithubUsername(repoName, githubUsername ?? '');

      if (existingClaim && existingClaim.activeChannel && existingClaim.activeMessageTs) {
        // Merge: register updates the claim in-place, returns the merged one
        const merged = registerClaim({
          slackUserId: userId,
          githubUsername,
          repoName,
          type,
          taskNumbers,
          files,
          startedAt: existingClaim.startedAt,
          activeChannel: existingClaim.activeChannel,
          activeMessageTs: existingClaim.activeMessageTs,
        });
        const blocks = buildActiveClaimBlocks(merged);
        await client.chat.update({
          channel: merged.activeChannel,
          ts: merged.activeMessageTs,
          blocks,
          text: `<@${userId}> is working on ${buildTasksCountLabel(merged.taskNumbers, type)}`,
        });
      } else {
        // Fresh claim: post a new message, remember the ts
        const startedAt = new Date();
        const placeholder: ClaimInfo = {
          slackUserId: userId,
          githubUsername,
          repoName,
          type,
          taskNumbers,
          files,
          startedAt,
          activeChannel: config.activeChannelId,
          activeMessageTs: '',
        };
        const blocks = buildActiveClaimBlocks(placeholder);
        const result = await client.chat.postMessage({
          channel: config.activeChannelId,
          text: `<@${userId}> is working on ${buildTasksCountLabel(taskNumbers, type)}`,
          blocks,
        });
        if (result.ts) {
          placeholder.activeMessageTs = result.ts;
          registerClaim(placeholder);
        }
      }
    }
  } catch (error) {
    logger.error('Assign Tasks: failed to post in active channel', {
      error: (error as Error).message,
    });
  }

  // 3. Refresh the bugs table so it picks up the new assignee
  try {
    await refreshBugsTable(repoName);
  } catch { /* non-fatal */ }

  // 4. Send Claude Code prompt as ephemeral message in the originating channel
  const channelIdForEphemeral = meta.channelId ?? '';
  if (channelIdForEphemeral) {
    const issueLines = taskNumbers
      .map((n) => `- #${n} (see github.com/${githubOrg}/${repoName}/issues/${n})`)
      .join('\n');
    const filesNote =
      files.length > 0 ? `\n\nFiles you will touch:\n${files.map((f) => `- ${f}`).join('\n')}` : '';
    const prompt = `Work on these ${type === 'bug' ? 'bugs' : 'features'} in ${repoName}:\n${issueLines}${filesNote}\n\nCreate a new branch, fix the issues, and push to preview-${userName}.${repoName.toLowerCase()}.pro`;

    await postEphemeral(
      channelIdForEphemeral,
      userId,
      `:clipboard: *Your Claude Code prompt:*\n\n\`\`\`\n${prompt}\n\`\`\`\n\nCopy this and paste it into your Claude Code session.`
    );
  }

  logger.info('Assign Tasks: claimed', {
    repoName,
    userId,
    type,
    taskCount: taskNumbers.length,
    fileCount: files.length,
  });
}

/** Tiny helper for the active-channel message label. */
function buildTasksCountLabel(numbers: number[], type: 'bug' | 'feature'): string {
  const n = numbers.length;
  if (n === 1) return type === 'bug' ? '1 bug' : '1 feature';
  return `${n} ${type === 'bug' ? 'bugs' : 'features'}`;
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

// (Old single-step handleAssignTasksSubmission deleted — replaced by the
// 3-step Assign Tasks flow above with handleAssignTasksFinalSubmission.)

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
