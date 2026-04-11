import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { serveWorkflow, WORKFLOW_HTML } from '../../src/dashboard/workflow.js';

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

function createApp(): Hono {
  const app = new Hono();
  app.get('/workflow', serveWorkflow);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serveWorkflow', () => {
  it('should return 200 with HTML content type', async () => {
    const app = createApp();
    const res = await app.request('/workflow');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('should return the full HTML document', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('</html>');
  });

  it('should include the page title', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('<title>JCN Apps');
    expect(body).toContain('Workflow Guide');
  });

  it('should include Inter font from Google Fonts', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('fonts.googleapis.com');
    expect(body).toContain('Inter');
  });

  it('should include all three phase sections', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('Morning');
    expect(body).toContain('Working');
    expect(body).toContain('End of Day');
  });

  it('should include Slack channel references', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('#company-dashboard');
    expect(body).toContain('#passcraft-pro-active');
    expect(body).toContain('#passcraft-pro-bugs');
  });

  it('should include team preview URLs', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('preview-nabil.passcraft.com');
    expect(body).toContain('preview-jannem.passcraft.com');
    expect(body).toContain('preview-chris.passcraft.com');
    expect(body).toContain('preview.passcraft.com');
  });

  it('should include the warning box about task categories', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('same category');
    expect(body).toContain('file conflicts');
  });

  it('should include all five rules', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('No code without an issue');
    expect(body).toContain('One branch = one person');
    expect(body).toContain('Take whole categories');
    expect(body).toContain('Hotfix');
    expect(body).toContain('Design tasks are blockers');
  });

  it('should use dark theme colors', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('#0f172a');
    expect(body).toContain('#1e293b');
  });

  it('should include responsive styles for mobile', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('@media');
    expect(body).toContain('max-width: 768px');
  });

  it('should include footer links', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('passcraft.com');
    expect(body).toContain('github.com/NabilW1995');
  });

  it('should include fade-in animation', async () => {
    const app = createApp();
    const res = await app.request('/workflow');
    const body = await res.text();

    expect(body).toContain('fadeIn');
    expect(body).toContain('fade-in');
  });
});

describe('WORKFLOW_HTML', () => {
  it('should be a non-empty string', () => {
    expect(typeof WORKFLOW_HTML).toBe('string');
    expect(WORKFLOW_HTML.length).toBeGreaterThan(100);
  });

  it('should be a valid HTML5 document', () => {
    expect(WORKFLOW_HTML).toMatch(/^<!DOCTYPE html>/);
    expect(WORKFLOW_HTML).toContain('<html lang="en">');
    expect(WORKFLOW_HTML).toContain('<meta charset="UTF-8">');
    expect(WORKFLOW_HTML).toContain('<meta name="viewport"');
  });

  it('should include accessibility attributes on emoji icons', () => {
    expect(WORKFLOW_HTML).toContain('role="img"');
    expect(WORKFLOW_HTML).toContain('aria-label');
  });
});
