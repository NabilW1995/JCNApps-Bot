/**
 * Feature flags read from environment variables.
 *
 * The bot runs as a single instance — there is no remote config service.
 * Flags are simple env booleans that can be flipped in Coolify and
 * picked up after a process restart. They exist so risky paths
 * (reconciler, morning cron, bug details) can be killed without
 * reverting code.
 *
 * Naming convention: `FF_<DOMAIN>_<NAME>` so they sort together in
 * env files and are clearly distinguishable from credential vars.
 *
 * All flags default to ENABLED (true). A flag is only DISABLED when
 * the env var is one of: "0", "false", "off", "no" (case-insensitive).
 * Any other value — including unset — leaves the flag on. This is the
 * "fail open" model: a typo in env config can never accidentally
 * disable production behavior.
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

function readBool(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return true;
  return !FALSY.has(raw.trim().toLowerCase());
}

export interface FeatureFlags {
  /** Master switch for the active-channel reconciler (Phase 1). */
  reconciler: boolean;
  /** Morning digest cron job (sends a daily summary to overview channel). */
  morningCron: boolean;
  /** Bug Details modal (dropdown + comment-to-thread flow). */
  bugDetailsModal: boolean;
  /** Auto-create Slack thread comments from GitHub issue comments. */
  githubCommentSync: boolean;
  /** Push webhook -> touchIssue + reconcile pipeline. */
  pushReconcile: boolean;
}

/**
 * Read the current state of every feature flag from the environment.
 *
 * Called at the start of each handler that gates on a flag, so flag
 * changes are picked up at the next request without restart. Reading
 * env on every call is cheap (O(1) lookup) and keeps tests simple.
 */
export function getFeatureFlags(): FeatureFlags {
  return {
    reconciler: readBool('FF_RECONCILER'),
    morningCron: readBool('FF_MORNING_CRON'),
    bugDetailsModal: readBool('FF_BUG_DETAILS_MODAL'),
    githubCommentSync: readBool('FF_GITHUB_COMMENT_SYNC'),
    pushReconcile: readBool('FF_PUSH_RECONCILE'),
  };
}

/**
 * Convenience: check a single flag by name. Useful when only one flag
 * matters at the call site and you don't want to destructure the whole
 * object.
 */
export function isFeatureEnabled(name: keyof FeatureFlags): boolean {
  return getFeatureFlags()[name];
}
