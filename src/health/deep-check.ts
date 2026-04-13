import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { getWebClient } from '../slack/client.js';
import { logger } from '../utils/logger.js';

export type ProbeStatus = 'ok' | 'degraded' | 'down';

export interface ProbeResult {
  status: ProbeStatus;
  /** Latency in milliseconds, omitted on hard failure. */
  latencyMs?: number;
  /** Human-readable failure reason, omitted on success. */
  error?: string;
}

export interface DeepHealthReport {
  status: ProbeStatus;
  timestamp: string;
  checks: {
    database: ProbeResult;
    slack: ProbeResult;
    github: ProbeResult;
  };
}

/**
 * Run a single probe with a hard timeout so a hung dependency cannot
 * block the entire health endpoint forever. Returns ProbeResult.
 */
async function runProbe(
  name: string,
  fn: () => Promise<void>,
  timeoutMs: number
): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('probe timeout')), timeoutMs)
      ),
    ]);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    logger.warn('Deep health probe failed', { probe: name, error: message });
    return { status: 'down', error: message };
  }
}

/**
 * Probe the database with a trivial SELECT 1.
 */
async function probeDatabase(): Promise<void> {
  const db = getDb();
  await db.execute(sql`SELECT 1`);
}

/**
 * Probe Slack via auth.test — the cheapest authenticated call that
 * verifies the bot token is still valid.
 */
async function probeSlack(): Promise<void> {
  const client = getWebClient();
  const result = await client.auth.test();
  if (!result.ok) throw new Error(`auth.test returned not_ok: ${result.error ?? '?'}`);
}

/**
 * Probe GitHub via /rate_limit — anonymous, no PAT required, but if a
 * PAT is configured we use it so we observe the bot's actual rate
 * window instead of the global anonymous one.
 */
async function probeGitHub(): Promise<void> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'JCNApps-Bot-Health-Probe',
  };
  const pat = process.env.GITHUB_PAT;
  if (pat) headers.Authorization = `Bearer ${pat}`;
  const res = await fetch('https://api.github.com/rate_limit', { headers });
  if (!res.ok) throw new Error(`github rate_limit returned ${res.status}`);
}

/**
 * Run all dependency probes in parallel and aggregate to an overall
 * status. The endpoint stays under ~5s even if every probe times out.
 *
 * Aggregation rules:
 *   - all ok           -> ok
 *   - any down          -> down (prevents Coolify from auto-promoting)
 *   - none down, any   -> degraded (visible in dashboards but still serving)
 *     non-ok response
 */
export async function runDeepHealthCheck(timeoutMs = 4000): Promise<DeepHealthReport> {
  const [database, slack, github] = await Promise.all([
    runProbe('database', probeDatabase, timeoutMs),
    runProbe('slack', probeSlack, timeoutMs),
    runProbe('github', probeGitHub, timeoutMs),
  ]);

  const checks = { database, slack, github };
  const statuses = Object.values(checks).map((c) => c.status);
  let overall: ProbeStatus;
  if (statuses.every((s) => s === 'ok')) {
    overall = 'ok';
  } else if (statuses.some((s) => s === 'down')) {
    overall = 'down';
  } else {
    overall = 'degraded';
  }

  return {
    status: overall,
    timestamp: new Date().toISOString(),
    checks,
  };
}
