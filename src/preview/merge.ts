import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// GitHub Merge API
//
// Merges a feature branch into main via the GitHub API. First attempts
// to create or find an existing pull request, then merges it. Falls back
// to a direct merge if no PR can be created.
// ---------------------------------------------------------------------------

interface GitHubPR {
  number: number;
}

/**
 * Merge a branch into main for a given repository.
 *
 * Strategy:
 *   1. Try to create a new PR (branch -> main)
 *   2. If PR already exists, find it by head/base
 *   3. If no PR exists and creation failed, attempt a direct merge
 *   4. Merge the PR via the GitHub merge endpoint
 *
 * Returns true on success, false on any failure.
 */
export async function mergeBranchToMain(
  repoName: string,
  branch: string
): Promise<boolean> {
  const githubPat = process.env.GITHUB_PAT;
  const githubOrg = process.env.GITHUB_ORG;

  if (!githubPat || !githubOrg) {
    logger.error('GitHub merge failed: GITHUB_PAT or GITHUB_ORG not configured');
    return false;
  }

  const headers = {
    Authorization: `token ${githubPat}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  const baseUrl = `https://api.github.com/repos/${githubOrg}/${repoName}`;

  try {
    // Step 1: Try to create a new pull request
    const prResponse = await fetch(`${baseUrl}/pulls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: `Merge ${branch} to main (approved via Slack)`,
        head: branch,
        base: 'main',
      }),
    });

    let prNumber: number | null = null;

    if (prResponse.ok) {
      const pr = (await prResponse.json()) as GitHubPR;
      prNumber = pr.number;
    } else {
      // PR might already exist — search for it
      const searchResponse = await fetch(
        `${baseUrl}/pulls?head=${encodeURIComponent(`${githubOrg}:${branch}`)}&base=main&state=open`,
        { headers }
      );

      if (searchResponse.ok) {
        const prs = (await searchResponse.json()) as GitHubPR[];
        if (prs.length > 0) {
          prNumber = prs[0].number;
        }
      }

      // If no open PR exists, try a direct merge as fallback
      if (prNumber === null) {
        logger.info('No PR found, attempting direct merge', { repoName, branch });

        const mergeResponse = await fetch(`${baseUrl}/merges`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            base: 'main',
            head: branch,
            commit_message: `Merge ${branch} (approved via Slack by all team members)`,
          }),
        });

        const directSuccess =
          mergeResponse.ok || mergeResponse.status === 201 || mergeResponse.status === 204;

        if (directSuccess) {
          logger.info('Direct merge succeeded', { repoName, branch });
        } else {
          logger.error('Direct merge failed', {
            repoName,
            branch,
            status: mergeResponse.status,
          });
        }

        return directSuccess;
      }
    }

    // Step 2: Merge the PR
    const mergeResponse = await fetch(`${baseUrl}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        merge_method: 'merge',
        commit_message: `Merge ${branch} (approved via Slack by all team members)`,
      }),
    });

    if (mergeResponse.ok) {
      logger.info('PR merge succeeded', { repoName, branch, prNumber });
      return true;
    }

    logger.error('PR merge failed', {
      repoName,
      branch,
      prNumber,
      status: mergeResponse.status,
    });
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('GitHub merge failed', { repoName, branch, error: message });
    return false;
  }
}
