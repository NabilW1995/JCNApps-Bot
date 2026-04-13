import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requestIdMiddleware } from '../../src/middleware/request-id.js';
import { getCurrentRequestId } from '../../src/utils/request-context.js';

function buildApp() {
  const app = new Hono();
  app.use('*', requestIdMiddleware);
  app.get('/echo', (c) => {
    // The middleware stashes the id under c.set('requestId', ...)
    // AND inside the AsyncLocalStorage frame.
    const fromContext = getCurrentRequestId();
    const fromHonoVar = (c as any).get('requestId');
    return c.json({ fromContext, fromHonoVar });
  });
  return app;
}

describe('requestIdMiddleware', () => {
  it('generates a fresh request id when none is provided', async () => {
    const app = buildApp();
    const res = await app.request('/echo');
    expect(res.status).toBe(200);

    const echoed = res.headers.get('x-request-id');
    expect(echoed).toBeTruthy();
    expect(echoed!.length).toBeGreaterThan(0);

    const body = await res.json();
    expect(body.fromContext).toBe(echoed);
    expect(body.fromHonoVar).toBe(echoed);
  });

  it('honors an inbound x-request-id header', async () => {
    const app = buildApp();
    const res = await app.request('/echo', {
      headers: { 'x-request-id': 'upstream-trace-7' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('upstream-trace-7');
    const body = await res.json();
    expect(body.fromContext).toBe('upstream-trace-7');
  });

  it('rejects an absurdly long inbound id and falls back to a fresh one', async () => {
    const app = buildApp();
    const longId = 'x'.repeat(500);
    const res = await app.request('/echo', {
      headers: { 'x-request-id': longId },
    });
    expect(res.status).toBe(200);
    const echoed = res.headers.get('x-request-id');
    expect(echoed).not.toBe(longId);
    expect(echoed!.length).toBeLessThan(200);
  });

  it('rejects an empty inbound id and generates a fresh one', async () => {
    const app = buildApp();
    const res = await app.request('/echo', {
      headers: { 'x-request-id': '' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')!.length).toBeGreaterThan(0);
  });

  it('isolates ids across two parallel requests', async () => {
    const app = buildApp();
    const [r1, r2] = await Promise.all([app.request('/echo'), app.request('/echo')]);
    expect(r1.headers.get('x-request-id')).not.toBe(r2.headers.get('x-request-id'));
  });
});
