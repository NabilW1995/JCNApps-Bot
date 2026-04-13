import type { Context, Next } from 'hono';
import { recordSuccess, recordError, type WebhookRoute } from '../observability/metrics.js';
import { getCurrentRequestId } from '../utils/request-context.js';

/**
 * Build a Hono middleware that times the request, records a success
 * sample on completion, and records an error sample if the inner
 * handler throws OR returns a 5xx status.
 *
 * Why both throws AND 5xx: most of our webhook handlers catch errors
 * internally and return 200 to avoid retry storms, but a small number
 * fall through to a 500. We want both shapes to count as errors in
 * /metrics so the counter is honest.
 */
export function metricsMiddleware(route: WebhookRoute) {
  return async (c: Context, next: Next): Promise<void> => {
    const start = Date.now();
    try {
      await next();
      const latency = Date.now() - start;
      const status = c.res.status;
      if (status >= 500) {
        recordError(route, new Error(`HTTP ${status}`), getCurrentRequestId());
      } else {
        recordSuccess(route, latency);
      }
    } catch (error) {
      recordError(route, error, getCurrentRequestId());
      throw error;
    }
  };
}
