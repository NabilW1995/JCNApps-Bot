import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  recordSuccess,
  recordError,
  resetMetricsForTests,
  getMetricsSnapshot,
} from '../../src/observability/metrics.js';

/**
 * The /metrics route in src/index.ts uses a dynamic import so we can't
 * cleanly import it without booting the whole bot. Instead, we mount
 * an equivalent route on a fresh Hono app — same handler shape — to
 * verify the JSON contract end-to-end through a real HTTP roundtrip.
 */
function buildApp() {
  const app = new Hono();
  app.get('/metrics', (c) => c.json(getMetricsSnapshot()));
  return app;
}

describe('/metrics endpoint', () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  it('returns 200 with a fresh snapshot', async () => {
    const app = buildApp();
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('routes');
    expect(body).toHaveProperty('totals');
    expect(body).toHaveProperty('startedAt');
  });

  it('reflects counts after recordSuccess / recordError calls', async () => {
    recordSuccess('github', 12);
    recordSuccess('coolify', 50);
    recordError('coolify', new Error('boom'), 'req-99');

    const app = buildApp();
    const res = await app.request('/metrics');
    const body = await res.json();

    expect(body.routes.github.successCount).toBe(1);
    expect(body.routes.github.latency.count).toBe(1);
    expect(body.routes.coolify.successCount).toBe(1);
    expect(body.routes.coolify.errorCount).toBe(1);
    expect(body.routes.coolify.recentErrors).toHaveLength(1);
    expect(body.routes.coolify.recentErrors[0].requestId).toBe('req-99');
    expect(body.totals.successCount).toBe(2);
    expect(body.totals.errorCount).toBe(1);
  });

  it('returns the same JSON shape even when no events have occurred', async () => {
    const app = buildApp();
    const res = await app.request('/metrics');
    const body = await res.json();
    // Every known route must be present in the output, even with zeros.
    const keys = Object.keys(body.routes).sort();
    expect(keys).toContain('github');
    expect(keys).toContain('coolify');
    expect(keys).toContain('slack-events');
    expect(keys).toContain('slack-interactive');
    expect(keys).toContain('admin-refresh');
    expect(keys).toContain('health-deep');
  });
});
