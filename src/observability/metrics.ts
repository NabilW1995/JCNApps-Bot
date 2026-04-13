/**
 * In-memory metrics counter for webhook traffic.
 *
 * Resets to zero on process restart — that's intentional. The metrics
 * are meant to answer "is the bot processing webhooks RIGHT NOW?" and
 * "what blew up in the last hour?", not to be a long-term timeseries.
 * Persistence to a real timeseries DB belongs in a later phase.
 *
 * Memory bounds:
 *   - Counters are scalar, so they grow O(1).
 *   - Recent latencies are kept as a ring buffer of LATENCY_SAMPLES per
 *     route (default 100), so total memory is bounded regardless of how
 *     long the bot runs.
 *   - Recent errors are kept as a ring buffer of LAST_ERROR_SAMPLES per
 *     route (default 5), each storing message + timestamp + requestId.
 */

const LATENCY_SAMPLES = 100;
const LAST_ERROR_SAMPLES = 5;

export type WebhookRoute =
  | 'github'
  | 'coolify'
  | 'slack-events'
  | 'slack-interactive'
  | 'admin-refresh'
  | 'health-deep';

export interface RouteMetrics {
  successCount: number;
  errorCount: number;
  /** Ring buffer of the most recent latency samples in ms. */
  recentLatencyMs: number[];
  /** Ring buffer of the most recent error events. */
  recentErrors: Array<{
    timestamp: string;
    message: string;
    requestId?: string;
  }>;
  /** ISO timestamp of the last successful event, or null if none yet. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the last error event, or null if none yet. */
  lastErrorAt: string | null;
}

const ROUTES: WebhookRoute[] = [
  'github',
  'coolify',
  'slack-events',
  'slack-interactive',
  'admin-refresh',
  'health-deep',
];

function emptyRouteMetrics(): RouteMetrics {
  return {
    successCount: 0,
    errorCount: 0,
    recentLatencyMs: [],
    recentErrors: [],
    lastSuccessAt: null,
    lastErrorAt: null,
  };
}

const routes = new Map<WebhookRoute, RouteMetrics>(
  ROUTES.map((r) => [r, emptyRouteMetrics()])
);

const startedAt = new Date().toISOString();

/**
 * Record a successful webhook event.
 *
 * `latencyMs` is the wall-clock duration the handler took. Pass 0 if
 * you don't have a measurement; the success counter still increments.
 */
export function recordSuccess(route: WebhookRoute, latencyMs: number): void {
  const m = routes.get(route);
  if (!m) return;
  m.successCount += 1;
  m.lastSuccessAt = new Date().toISOString();
  pushLatency(m, latencyMs);
}

/**
 * Record a failed webhook event. Stores the error message and optional
 * requestId so a later /metrics call can show the most recent failures
 * without needing a log search.
 */
export function recordError(
  route: WebhookRoute,
  error: unknown,
  requestId?: string
): void {
  const m = routes.get(route);
  if (!m) return;
  m.errorCount += 1;
  m.lastErrorAt = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  m.recentErrors.push({
    timestamp: m.lastErrorAt,
    message: message.slice(0, 500),
    requestId,
  });
  if (m.recentErrors.length > LAST_ERROR_SAMPLES) {
    m.recentErrors.splice(0, m.recentErrors.length - LAST_ERROR_SAMPLES);
  }
}

function pushLatency(m: RouteMetrics, ms: number): void {
  m.recentLatencyMs.push(ms);
  if (m.recentLatencyMs.length > LATENCY_SAMPLES) {
    m.recentLatencyMs.splice(0, m.recentLatencyMs.length - LATENCY_SAMPLES);
  }
}

/**
 * Compute simple stats (count, mean, p95, max) from the ring buffer.
 * Returns zeros when the buffer is empty so the JSON shape stays stable.
 */
function summarizeLatency(samples: number[]): {
  count: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
} {
  if (samples.length === 0) {
    return { count: 0, meanMs: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    count: sorted.length,
    meanMs: Math.round(sum / sorted.length),
    p95Ms: sorted[p95Idx],
    maxMs: sorted[sorted.length - 1],
  };
}

export interface MetricsSnapshot {
  startedAt: string;
  generatedAt: string;
  routes: Record<
    WebhookRoute,
    {
      successCount: number;
      errorCount: number;
      lastSuccessAt: string | null;
      lastErrorAt: string | null;
      latency: { count: number; meanMs: number; p95Ms: number; maxMs: number };
      recentErrors: Array<{ timestamp: string; message: string; requestId?: string }>;
    }
  >;
  totals: {
    successCount: number;
    errorCount: number;
  };
}

/**
 * Build a JSON-friendly snapshot of every route's metrics. Safe to call
 * from a request handler — the underlying state is plain objects so
 * there is no race during the read.
 */
export function getMetricsSnapshot(): MetricsSnapshot {
  const out: MetricsSnapshot['routes'] = {} as MetricsSnapshot['routes'];
  let totalSuccess = 0;
  let totalError = 0;

  for (const route of ROUTES) {
    const m = routes.get(route);
    if (!m) continue;
    out[route] = {
      successCount: m.successCount,
      errorCount: m.errorCount,
      lastSuccessAt: m.lastSuccessAt,
      lastErrorAt: m.lastErrorAt,
      latency: summarizeLatency(m.recentLatencyMs),
      recentErrors: [...m.recentErrors],
    };
    totalSuccess += m.successCount;
    totalError += m.errorCount;
  }

  return {
    startedAt,
    generatedAt: new Date().toISOString(),
    routes: out,
    totals: { successCount: totalSuccess, errorCount: totalError },
  };
}

/**
 * Reset all counters back to zero. Only intended for tests — calling
 * this in production wipes observability data.
 */
export function resetMetricsForTests(): void {
  for (const route of ROUTES) {
    routes.set(route, emptyRouteMetrics());
  }
}
