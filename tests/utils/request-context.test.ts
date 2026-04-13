import { describe, it, expect } from 'vitest';
import {
  generateRequestId,
  runWithRequestContext,
  getCurrentRequestId,
} from '../../src/utils/request-context.js';

describe('request-context', () => {
  describe('generateRequestId', () => {
    it('returns a non-empty string', () => {
      const id = generateRequestId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('returns a different id on each call', () => {
      const a = generateRequestId();
      const b = generateRequestId();
      expect(a).not.toBe(b);
    });

    it('returns a uuid-like string (8-4-4-4-12 hex format)', () => {
      const id = generateRequestId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });
  });

  describe('runWithRequestContext', () => {
    it('makes the request id visible inside the callback', () => {
      runWithRequestContext({ requestId: 'abc-123' }, () => {
        expect(getCurrentRequestId()).toBe('abc-123');
      });
    });

    it('returns undefined outside any context frame', () => {
      // Important: this test must NOT be wrapped in runWithRequestContext.
      expect(getCurrentRequestId()).toBeUndefined();
    });

    it('isolates concurrent contexts', async () => {
      const results: string[] = [];
      await Promise.all([
        runWithRequestContext({ requestId: 'req-a' }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          results.push(getCurrentRequestId() ?? 'none');
        }),
        runWithRequestContext({ requestId: 'req-b' }, async () => {
          await new Promise((r) => setTimeout(r, 1));
          results.push(getCurrentRequestId() ?? 'none');
        }),
      ]);
      // Both contexts should be preserved across awaits, regardless of order
      expect(results.sort()).toEqual(['req-a', 'req-b']);
    });

    it('propagates the context across an async boundary', async () => {
      let observed: string | undefined;
      await runWithRequestContext({ requestId: 'across-await' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        observed = getCurrentRequestId();
      });
      expect(observed).toBe('across-await');
    });

    it('returns the value the callback returns', () => {
      const out = runWithRequestContext({ requestId: 'r1' }, () => 42);
      expect(out).toBe(42);
    });
  });
});
