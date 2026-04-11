import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { serveDashboard, DASHBOARD_HTML } from '../../src/dashboard/page.js';

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

function createApp(): Hono {
  const app = new Hono();
  app.get('/dashboard', serveDashboard);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serveDashboard', () => {
  it('should return 200 with HTML content type', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('should return the full HTML document', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');
    const body = await res.text();

    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('</html>');
  });

  it('should include the page title', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');
    const body = await res.text();

    expect(body).toContain('<title>JCN Apps Dashboard</title>');
  });

  it('should include Inter font from Google Fonts', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');
    const body = await res.text();

    expect(body).toContain('fonts.googleapis.com');
    expect(body).toContain('Inter');
  });

  it('should include the dashboard data fetch script', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');
    const body = await res.text();

    expect(body).toContain('/api/dashboard-data');
    expect(body).toContain('fetchData');
  });

  it('should include auto-refresh logic', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');
    const body = await res.text();

    expect(body).toContain('REFRESH_INTERVAL_MS');
    expect(body).toContain('30000');
    expect(body).toContain('setInterval');
  });

  it('should include a loading state', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');
    const body = await res.text();

    expect(body).toContain('Loading dashboard');
    expect(body).toContain('spinner');
  });

  it('should use dark theme colors', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');
    const body = await res.text();

    // Dark background
    expect(body).toContain('#0f172a');
    // Card background
    expect(body).toContain('#1e293b');
  });

  it('should include responsive styles for mobile', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');
    const body = await res.text();

    expect(body).toContain('@media');
    expect(body).toContain('max-width: 640px');
  });

  it('should include priority badge styles', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');
    const body = await res.text();

    expect(body).toContain('priority-critical');
    expect(body).toContain('priority-high');
    expect(body).toContain('priority-medium');
    expect(body).toContain('priority-low');
  });

  it('should include source badge styles', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');
    const body = await res.text();

    expect(body).toContain('source-customer');
    expect(body).toContain('source-internal');
  });

  it('should use escapeHtml for XSS protection', async () => {
    const app = createApp();
    const res = await app.request('/dashboard');
    const body = await res.text();

    expect(body).toContain('escapeHtml');
    expect(body).toContain('textContent');
  });
});

describe('DASHBOARD_HTML', () => {
  it('should be a non-empty string', () => {
    expect(typeof DASHBOARD_HTML).toBe('string');
    expect(DASHBOARD_HTML.length).toBeGreaterThan(100);
  });

  it('should be a valid HTML5 document', () => {
    expect(DASHBOARD_HTML).toMatch(/^<!DOCTYPE html>/);
    expect(DASHBOARD_HTML).toContain('<html lang="en">');
    expect(DASHBOARD_HTML).toContain('<meta charset="UTF-8">');
    expect(DASHBOARD_HTML).toContain('<meta name="viewport"');
  });

  it('should include JCN Apps branding', () => {
    expect(DASHBOARD_HTML).toContain('JCN Apps');
    expect(DASHBOARD_HTML).toContain('Team Dashboard');
  });
});
