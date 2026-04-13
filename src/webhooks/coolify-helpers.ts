/**
 * Pure helper functions extracted from coolify.ts so they can be unit-
 * tested without booting the full webhook handler.
 *
 * No I/O, no DB, no Slack — every function here takes plain values
 * and returns plain values. Adding a function here is allowed only
 * if it stays side-effect free.
 */

const SAFE_URL_PATTERN = /^https?:\/\//i;

const INTERNAL_URL_PATTERNS = [
  /coolify/i,
  /\.internal\b/i,
  /\.local\b/i,
  /localhost/i,
  /\d+\.\d+\.\d+\.\d+/, // Raw IP addresses
  /\.svc\.cluster/i, // Kubernetes service names
];

/**
 * Reject anything that does not start with http(s)://. Returns the URL
 * untouched on success or null on rejection so callers can fall back
 * to a safe placeholder.
 */
export function sanitizeUrl(url: string): string | null {
  if (!SAFE_URL_PATTERN.test(url)) return null;
  return url;
}

/**
 * Returns true when the URL looks like a real public domain.
 * Returns false for Coolify dashboards, .local / .internal hosts,
 * raw IP addresses, and Kubernetes service hostnames.
 */
export function isPublicUrl(url: string): boolean {
  return !INTERNAL_URL_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * Extract issue numbers from a commit message or branch name. Matches
 * `#123` style references and returns the numeric values in order.
 * Duplicates are preserved on purpose — callers that need uniqueness
 * should pass the result through a Set.
 */
export function extractIssueNumbers(text: string | null | undefined): number[] {
  if (!text) return [];
  const matches = text.match(/#(\d+)/g) ?? [];
  return matches.map((m) => parseInt(m.slice(1), 10));
}

/**
 * Returns true when the branch is the production/main branch. Treats
 * both `main` and `master` as production to support older repos.
 */
export function isMainBranch(branch: string | null | undefined): boolean {
  if (!branch) return false;
  return branch === 'main' || branch === 'master';
}

/**
 * Walk a list of commit messages looking for a "Merge branch '...'"
 * or "Merge feature/x into preview" pattern, returning the source
 * branch name. Used to figure out which feature branch a preview
 * deploy actually represents when Coolify omits the branch field.
 */
export function extractFeatureBranch(commitMessages: string[]): string | null {
  for (const msg of commitMessages) {
    const mergeMatch = msg.match(/Merge branch '([^']+)'/);
    if (mergeMatch) return mergeMatch[1];

    const mergeInto = msg.match(/Merge (\S+\/\S+) into/);
    if (mergeInto) return mergeInto[1];
  }
  return null;
}
