import { logger } from './logger.js';

/**
 * GitHub Code Search helpers — extracted from slack-interactive so
 * other webhooks (e.g. handleIssueAssigned) can reuse the same
 * tiered detection logic without duplicating it.
 *
 * All functions degrade gracefully: if GITHUB_PAT or GITHUB_ORG are
 * missing, or the API rate-limits us, we return an empty array
 * rather than throwing. Callers must handle the empty result.
 */

const CODE_SEARCH_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'on', 'in', 'at', 'to', 'for', 'from', 'with', 'about', 'of',
  'and', 'or', 'but', 'not', 'no', 'can', 'will', 'should', 'would',
  'fix', 'bug', 'bugs', 'add', 'remove', 'update', 'create', 'issue',
  'broken', 'fails', 'failed', 'crash', 'crashes', 'error', 'errors',
  'new', 'old', 'this', 'that', 'these', 'those',
]);

/**
 * Pull meaningful keywords from an issue title for a code search.
 * Drops stop words, very short tokens, and non-word characters. Caps
 * at 5 keywords to keep the query short and the rate limit happy.
 *
 * Pure function — testable without any network access.
 */
export function extractKeywordsFromTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !CODE_SEARCH_STOP_WORDS.has(w))
    .slice(0, 5);
}

/**
 * Execute a single GitHub code-search query and return file paths.
 * Logs the result so we can debug detection quality.
 */
async function runCodeSearch(
  query: string,
  maxResults: number,
  context: string
): Promise<string[]> {
  const githubPat = process.env.GITHUB_PAT;
  if (!githubPat) return [];
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
      logger.warn('Code search HTTP error', { context, query, status: res.status });
      return [];
    }
    const data = (await res.json()) as {
      items?: Array<{ path: string }>;
      total_count?: number;
    };
    const paths = (data.items ?? []).map((i) => i.path);
    logger.info('Code search result', {
      context,
      query,
      totalCount: data.total_count ?? 0,
      returned: paths.length,
    });
    return paths;
  } catch (error) {
    logger.warn('Code search threw', { context, error: (error as Error).message });
    return [];
  }
}

/**
 * Tiered file detection for an issue:
 *
 *   Tier 1: longest keyword in:path  — usually the best signal
 *   Tier 2: all keywords in:file     — broader content search
 *   Tier 3: area label in:path       — last-resort directory hint
 *
 * Stops at the first tier that returns results. Cheap on API: usually
 * one call, two at most. Returns up to maxResults file paths.
 */
export async function searchCodeForFiles(
  repoName: string,
  keywords: string[],
  area: string | null,
  maxResults: number = 3
): Promise<string[]> {
  const githubOrg = process.env.GITHUB_ORG;
  if (!githubOrg) return [];

  const repoScope = `repo:${githubOrg}/${repoName}`;
  const found = new Set<string>();

  if (keywords.length > 0) {
    const primary = [...keywords].sort((a, b) => b.length - a.length)[0];
    const tier1 = await runCodeSearch(
      `${primary} in:path ${repoScope}`,
      maxResults,
      'tier1-path'
    );
    for (const p of tier1) found.add(p);
  }

  if (found.size === 0 && keywords.length > 0) {
    const tier2 = await runCodeSearch(
      `${keywords.join(' ')} in:file ${repoScope}`,
      maxResults,
      'tier2-content'
    );
    for (const p of tier2) found.add(p);
  }

  if (found.size === 0 && area && area !== 'unassigned') {
    const tier3 = await runCodeSearch(
      `${area} in:path ${repoScope}`,
      maxResults,
      'tier3-area'
    );
    for (const p of tier3) found.add(p);
  }

  return Array.from(found);
}

/**
 * Convenience wrapper: take an issue title + optional area label and
 * return the detected files in one call. Handles keyword extraction
 * and the tiered search internally.
 */
export async function detectFilesForIssue(
  repoName: string,
  title: string,
  area: string | null,
  maxResults: number = 3
): Promise<string[]> {
  const keywords = extractKeywordsFromTitle(title);
  return searchCodeForFiles(repoName, keywords, area, maxResults);
}
