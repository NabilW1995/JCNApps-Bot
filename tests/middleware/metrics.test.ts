import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { metricsMiddleware } from '../../src/middleware/metrics.js';
import {
  resetMetricsForTests,
  getMetricsSnapshot,
} from '../../src/observability/metrics.js';

describe('metricsMiddleware', () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  it('records a success when the handler returns 200', async () => {
    const app = new Hono();
    app.post('/x', metricsMiddleware('github'), (c) => c.json({ ok: true }));

    const res = await app.request('/x', { method: 'POST' });
    expect(res.status).toBe(200);

    const snap = getMetricsSnapshot();
    expect(snap.routes.github.successCount).toBe(1);
    expect(snap.routes.github.errorCount).toBe(0);
    expect(snap.routes.github.latency.count).toBe(1);
  });

  it('records a success for non-error 2xx statuses', async () => {
    const app = new Hono();
    app.post('/a', metricsMiddleware('coolify'), (c) => c.json({}, 200));
    app.post('/b', metricsMiddleware('coolify'), (c) => c.json({}, 201));

    await app.request('/a', { method: 'POST' });
    await app.request('/b', { method: 'POST' });

    const snap = getMetricsSnapshot();
    expect(snap.routes.coolify.successCount).toBe(2);
    expect(snap.routes.coolify.errorCount).toBe(0);
  });

  it('records an error when the handler returns 5xx', async () => {
    const app = new Hono();
    app.post('/x', metricsMiddleware('coolify'), (c) =>
      c.json({ error: 'boom' }, 500)
    );

    const res = await app.request('/x', { method: 'POST' });
    expect(res.status).toBe(500);

    const snap = getMetricsSnapshot();
    expect(snap.routes.coolify.errorCount).toBe(1);
    expect(snap.routes.coolify.successCount).toBe(0);
    expect(snap.routes.coolify.recentErrors[0].message).toContain('500');
  });

  it('records an error when the handler throws', async () => {
    const app = new Hono();
    // Hono's onError catches uncaught exceptions and converts them to
    // a 500 response BEFORE the middleware's own catch block sees them.
    // That's fine — the middleware still observes the 500 status and
    // records an error, just tagged "HTTP 500" rather than the original
    // message. The metric is honest either way.
    app.post('/x', metricsMiddleware('slack-interactive'), () => {
      throw new Error('synthetic crash');
    });

    const res = await app.request('/x', { method: 'POST' });
    expect(res.status).toBe(500);

    const snap = getMetricsSnapshot();
    expect(snap.routes['slack-interactive'].errorCount).toBe(1);
    expect(snap.routes['slack-interactive'].recentErrors[0].message).toContain(
      '500'
    );
  });

  it('records latency for successful requests', async () => {
    const app = new Hono();
    app.post('/x', metricsMiddleware('github'), async (c) => {
      await new Promise((r) => setTimeout(r, 10));
      return c.json({});
    });

    await app.request('/x', { method: 'POST' });

    const snap = getMetricsSnapshot();
    expect(snap.routes.github.latency.count).toBe(1);
    expect(snap.routes.github.latency.maxMs).toBeGreaterThanOrEqual(0);
  });

  it('does NOT record latency samples for error responses', async () => {
    const app = new Hono();
    app.post('/x', metricsMiddleware('github'), (c) => c.json({}, 500));

    await app.request('/x', { method: 'POST' });

    const snap = getMetricsSnapshot();
    // Errors increment errorCount but the latency ring buffer is success-only.
    expect(snap.routes.github.latency.count).toBe(0);
    expect(snap.routes.github.errorCount).toBe(1);
  });
});
