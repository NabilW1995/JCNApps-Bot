import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { handleGitHubWebhook } from './webhooks/github.js';
import { handleCoolifyWebhook } from './webhooks/coolify.js';

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
});

export { app };
