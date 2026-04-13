import type { Context, Next } from 'hono';
import { generateRequestId, runWithRequestContext } from '../utils/request-context.js';

/**
 * Hono middleware that:
 *   1. Reads an inbound `x-request-id` header if the upstream proxy set
 *      one (Coolify, Cloudflare, etc.), otherwise generates a fresh uuid.
 *   2. Wraps the rest of the request lifecycle in an AsyncLocalStorage
 *      frame so logger.* calls automatically pick up the requestId.
 *   3. Echoes the requestId back to the client via response header so
 *      Slack/GitHub admins can grep logs for a specific webhook.
 */
export async function requestIdMiddleware(c: Context, next: Next): Promise<void> {
  const inbound = c.req.header('x-request-id');
  const requestId = inbound && inbound.length > 0 && inbound.length < 200
    ? inbound
    : generateRequestId();

  c.set('requestId', requestId);
  c.header('x-request-id', requestId);

  await runWithRequestContext({ requestId }, async () => {
    await next();
  });
}
