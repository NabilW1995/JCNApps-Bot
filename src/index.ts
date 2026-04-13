import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { requestIdMiddleware } from './middleware/request-id.js';
import { metricsMiddleware } from './middleware/metrics.js';
import { handleGitHubWebhook } from './webhooks/github.js';
import { handleCoolifyWebhook } from './webhooks/coolify.js';
import { handleSlackEvents } from './webhooks/slack-events.js';
import { handleSlackInteractive } from './webhooks/slack-interactive.js';
import { initializeTables } from './slack/table-manager.js';
import { runMigrations } from './db/migrate.js';
import { getDb } from './db/client.js';
import { serveDashboard } from './dashboard/page.js';
import { getDashboardData } from './dashboard/data.js';
import { serveWorkflow } from './dashboard/workflow.js';
import { detectBotUserId } from './overview/bot-identity.js';
import { refreshOverviewDashboard } from './overview/dashboard.js';
import { startMorningCron } from './overview/cron.js';

const app = new Hono();

// Request-ID middleware — must be the first middleware so every
// downstream handler + log line can attach the same id. Echoes the
// id back on the response as `x-request-id` for client-side tracing.
app.use('*', requestIdMiddleware);

// Build info — lets us verify which version is actually running.
// The BUILD_ID is set at image build time from the Dockerfile CACHE_BUST_TS.
const BUILD_ID = process.env.BUILD_ID ?? 'unknown';
const BOT_STARTED_AT = new Date().toISOString();

// Health check — used by Docker HEALTHCHECK and Coolify.
// Also probes the database to surface connectivity issues.
app.get('/health', async (c) => {
  let dbStatus = 'unknown';
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    dbStatus = 'connected';
  } catch {
    dbStatus = 'disconnected';
  }
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: dbStatus,
    buildId: BUILD_ID,
    startedAt: BOT_STARTED_AT,
  });
});

// Deep health probe — checks every external dependency in parallel
// (DB, Slack, GitHub). Slower than /health (~100ms-4s) so it must NOT
// be used as the Docker liveness probe; it is meant for synthetic
// monitoring tools and on-call humans.
//
// Returns 200 when status is "ok", 503 when status is "down" so an
// uptime checker can alert. "degraded" still returns 200 so the bot
// keeps serving while raising visibility.
app.get('/health/deep', async (c) => {
  const { runDeepHealthCheck } = await import('./health/deep-check.js');
  const report = await runDeepHealthCheck();
  const statusCode = report.status === 'down' ? 503 : 200;
  return c.json(report, statusCode);
});

// In-memory metrics snapshot — webhook success/error counts and recent
// latency stats per route. Resets on process restart by design.
// Lives in the same process as the bot so it cannot lie about its own
// state the way a remote dashboard could during a network partition.
app.get('/metrics', async (c) => {
  const { getMetricsSnapshot } = await import('./observability/metrics.js');
  return c.json(getMetricsSnapshot());
});

// Build info — quick endpoint for debugging deploys
app.get('/build-info', (c) => {
  return c.json({
    buildId: BUILD_ID,
    startedAt: BOT_STARTED_AT,
    features: [
      'bug-details-modal',
      'assign-area-modal',
      'combined-new-bug-or-feature-modal',
      'auto-recreate-deleted-messages',
    ],
  });
});

// Force a refresh of a repo's pinned messages (manual recovery)
// Usage:
//   POST /admin/refresh?repo=PassCraft             → bugs table only
//   POST /admin/refresh?repo=PassCraft&target=active → active reconciler
//   POST /admin/refresh?repo=PassCraft&target=all    → both
app.post('/admin/refresh', async (c) => {
  const repo = c.req.query('repo') ?? 'PassCraft';
  const target = c.req.query('target') ?? 'bugs';
  const { refreshBugsTable, reconcileActiveState } = await import(
    './slack/table-manager.js'
  );
  try {
    const done: string[] = [];
    if (target === 'bugs' || target === 'all') {
      await refreshBugsTable(repo);
      done.push('bugs');
    }
    if (target === 'active' || target === 'all') {
      await reconcileActiveState(repo);
      done.push('active');
    }
    return c.json({ ok: true, repo, refreshed: done });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 500);
  }
});

// GitHub webhook receiver
app.post('/webhooks/github', metricsMiddleware('github'), handleGitHubWebhook);

// Coolify deployment webhook receiver
app.post('/webhooks/coolify', metricsMiddleware('coolify'), handleCoolifyWebhook);

// Debug: log any incoming webhook payload (temporary — remove after debugging)
app.post('/webhooks/debug', async (c) => {
  const body = await c.req.text();
  const headers = Object.fromEntries(c.req.raw.headers.entries());
  const query = c.req.query();
  console.log('=== DEBUG WEBHOOK ===');
  console.log('Query:', JSON.stringify(query));
  console.log('Headers:', JSON.stringify(headers, null, 2));
  console.log('Body:', body);
  console.log('=== END DEBUG ===');
  return c.json({ ok: true, logged: true });
});

// Slack Events API — handles reaction-based onboarding and DM replies
app.post('/webhooks/slack-events', metricsMiddleware('slack-events'), handleSlackEvents);

// Slack Interactive — handles button clicks (Create Issue, etc.)
app.post(
  '/webhooks/slack-interactive',
  metricsMiddleware('slack-interactive'),
  handleSlackInteractive
);

// Team dashboard — static HTML page with live data
app.get('/dashboard', serveDashboard);
app.get('/api/dashboard-data', getDashboardData);

// Workflow guide — compact reference for the team's daily process
app.get('/workflow', serveWorkflow);

const port = Number(process.env.PORT || 3000);

serve({ fetch: app.fetch, port }, async () => {
  console.log(`JCNApps-Bot v2 (new bug layout) listening on port ${port}`);

  // Run database migrations first, then initialize tables.
  // Both are wrapped so the bot starts even if the DB isn't ready yet.
  try {
    await runMigrations();
    await initializeTables();
    await detectBotUserId();
    await refreshOverviewDashboard();
    startMorningCron();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Startup initialization skipped: ${message}`);
  }
});

export { app };
// rebuild
