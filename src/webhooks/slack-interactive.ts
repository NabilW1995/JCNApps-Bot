import type { Context } from 'hono';
import { getWebClient, setChannelTopic } from '../slack/client.js';
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
      if (action.action_id === 'create_issue') {
        await handleCreateIssueButton(payload);
      } else if (action.action_id === 'preview_done') {
        await handlePreviewDoneButton(payload);
      }
    }
  }

  // Slack expects a 200 OK response within 3 seconds
  return c.json({ ok: true });
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
