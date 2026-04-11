import { logger } from '../utils/logger.js';
import { getDb } from '../db/client.js';
import { teamMembers } from '../db/schema.js';

// ---------------------------------------------------------------------------
// External API Integrations — GitHub, Coolify, Cloudflare, Database
// ---------------------------------------------------------------------------

/**
 * Invite a user to the GitHub organization.
 *
 * Two-step process:
 *   1. Look up the GitHub user ID from their username
 *   2. Send an org invitation using that user ID
 *
 * Returns true on success, false on any failure.
 */
export async function inviteToGitHub(githubUsername: string): Promise<boolean> {
  const pat = process.env.GITHUB_PAT;
  const org = process.env.GITHUB_ORG;

  if (!pat || !org) {
    logger.error('GitHub integration not configured', {
      hasPAT: !!pat,
      hasOrg: !!org,
    });
    return false;
  }

  try {
    // Step 1: Resolve username to numeric user ID
    const userResponse = await fetch(
      `https://api.github.com/users/${encodeURIComponent(githubUsername)}`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!userResponse.ok) {
      logger.error('Failed to look up GitHub user', {
        username: githubUsername,
        status: userResponse.status,
      });
      return false;
    }

    const userData = (await userResponse.json()) as { id: number };

    // Step 2: Send org invitation
    const inviteResponse = await fetch(
      `https://api.github.com/orgs/${encodeURIComponent(org)}/invitations`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ invitee_id: userData.id }),
      }
    );

    if (!inviteResponse.ok) {
      const errorBody = await inviteResponse.text();
      logger.error('Failed to invite user to GitHub org', {
        username: githubUsername,
        status: inviteResponse.status,
        body: errorBody,
      });
      return false;
    }

    logger.info('GitHub org invitation sent', { username: githubUsername });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('GitHub invitation failed', { username: githubUsername, error: message });
    return false;
  }
}

/**
 * Invite a user to Coolify by email.
 *
 * Sends a team invitation via the Coolify API so the
 * new member can access deployment dashboards.
 *
 * Returns true on success, false on any failure.
 */
export async function inviteToCoolify(email: string): Promise<boolean> {
  const apiToken = process.env.COOLIFY_API_TOKEN;
  const coolifyUrl = process.env.COOLIFY_URL;

  if (!apiToken || !coolifyUrl) {
    logger.error('Coolify integration not configured', {
      hasToken: !!apiToken,
      hasUrl: !!coolifyUrl,
    });
    return false;
  }

  try {
    const response = await fetch(`${coolifyUrl}/api/v1/teams/0/invitations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, role: 'member' }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error('Failed to invite user to Coolify', {
        email,
        status: response.status,
        body: errorBody,
      });
      return false;
    }

    logger.info('Coolify invitation sent', { email });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Coolify invitation failed', { email, error: message });
    return false;
  }
}

/**
 * Create a DNS A record in Cloudflare for the user's preview subdomain.
 *
 * Creates: preview-{name}.passcraft.pro -> SERVER_IP
 * The record is proxied through Cloudflare for SSL and caching.
 *
 * Returns true on success, false on any failure.
 */
export async function createPreviewDNS(previewName: string): Promise<boolean> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const serverIp = process.env.SERVER_IP;

  if (!apiToken || !zoneId || !serverIp) {
    logger.error('Cloudflare integration not configured', {
      hasToken: !!apiToken,
      hasZoneId: !!zoneId,
      hasServerIp: !!serverIp,
    });
    return false;
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'A',
          name: `preview-${previewName}.passcraft.pro`,
          content: serverIp,
          proxied: true,
        }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error('Failed to create Cloudflare DNS record', {
        previewName,
        status: response.status,
        body: errorBody,
      });
      return false;
    }

    logger.info('Cloudflare DNS record created', {
      subdomain: `preview-${previewName}.passcraft.pro`,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Cloudflare DNS creation failed', { previewName, error: message });
    return false;
  }
}

/**
 * Save a new team member to the database.
 *
 * Inserts into the existing team_members table that the bot
 * already uses for GitHub-to-Slack user mapping and status tracking.
 * Uses upsert on GitHub username so re-registration updates instead of failing.
 */
export async function saveTeamMember(
  name: string,
  githubUsername: string,
  slackUserId: string,
  email?: string
): Promise<void> {
  try {
    const db = getDb();
    await db
      .insert(teamMembers)
      .values({
        name,
        githubUsername,
        slackUserId,
        email: email ?? null,
        status: 'idle',
      })
      .onConflictDoUpdate({
        target: teamMembers.githubUsername,
        set: {
          name,
          slackUserId,
          email: email ?? null,
        },
      });
    logger.info('Team member saved to database', { name, githubUsername });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to save team member to DB', {
      name,
      githubUsername,
      error: message,
    });
    throw error;
  }
}
