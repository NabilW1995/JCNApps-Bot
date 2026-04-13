import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Run `fn` inside a request-scoped AsyncLocalStorage frame.
 *
 * Anywhere downstream — DB queries, Slack API calls, the logger — can
 * call `getCurrentRequestId()` to read the same id. Cron jobs and other
 * non-request entry points run outside this frame and will see undefined.
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getCurrentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
