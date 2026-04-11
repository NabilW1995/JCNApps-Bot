import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { handleGitHubWebhook } from './webhooks/github.js';
import { handleCoolifyWebhook } from './webhooks/coolify.js';
import { handleSlackEvents } from './webhooks/slack-events.js';
import { initializeTables } from './slack/table-manager.js';
import { runMigrations } from './db/migrate.js';
import { getDb } from './db/client.js';
import { serveDashboard } from './dashboard/page.js';
import { getDashboardData } from './dashboard/data.js';
import { serveWorkflow } from './dashboard/workflow.js';

const app = new Hono();

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
  });
});

// GitHub webhook receiver
app.post('/webhooks/github', handleGitHubWebhook);

// Coolify deployment webhook receiver
app.post('/webhooks/coolify', handleCoolifyWebhook);

// Slack Events API — handles reaction-based onboarding and DM replies
app.post('/webhooks/slack-events', handleSlackEvents);

// Team dashboard — static HTML page with live data
app.get('/dashboard', serveDashboard);
app.get('/api/dashboard-data', getDashboardData);

// Workflow guide — compact reference for the team's daily process
app.get('/workflow', serveWorkflow);

const port = Number(process.env.PORT || 3000);

serve({ fetch: app.fetch, port }, async () => {
  console.log(`JCNApps-Bot listening on port ${port}`);

  // Run database migrations first, then initialize tables.
  // Both are wrapped so the bot starts even if the DB isn't ready yet.
  try {
    await runMigrations();
    await initializeTables();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Startup initialization skipped: ${message}`);
  }
});

export { app };
