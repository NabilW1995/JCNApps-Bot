import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { handleGitHubWebhook } from './webhooks/github.js';
import { handleCoolifyWebhook } from './webhooks/coolify.js';
import { initializeTables } from './slack/table-manager.js';

const app = new Hono();

// Health check — used by Docker HEALTHCHECK and Coolify
app.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// GitHub webhook receiver
app.post('/webhooks/github', handleGitHubWebhook);

// Coolify deployment webhook receiver
app.post('/webhooks/coolify', handleCoolifyWebhook);

const port = Number(process.env.PORT || 3000);

serve({ fetch: app.fetch, port }, () => {
  console.log(`JCNApps-Bot listening on port ${port}`);

  // Initialize live tables after server is ready.
  // Wrapped in try/catch so the bot starts even if the DB isn't ready yet.
  initializeTables().catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Table initialization skipped: ${message}`);
  });
});

export { app };
