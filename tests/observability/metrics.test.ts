import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordSuccess,
  recordError,
  getMetricsSnapshot,
  resetMetricsForTests,
} from '../../src/observability/metrics.js';

describe('metrics counter', () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  describe('initial state', () => {
    it('returns zero counts for every known route', () => {
      const snap = getMetricsSnapshot();
      for (const route of Object.keys(snap.routes) as Array<keyof typeof snap.routes>) {
        expect(snap.routes[route].successCount).toBe(0);
        expect(snap.routes[route].errorCount).toBe(0);
        expect(snap.routes[route].lastSuccessAt).toBeNull();
        expect(snap.routes[route].lastErrorAt).toBeNull();
      }
      expect(snap.totals.successCount).toBe(0);
      expect(snap.totals.errorCount).toBe(0);
    });

    it('exposes startedAt as a stable ISO timestamp across calls', () => {
      const a = getMetricsSnapshot();
      const b = getMetricsSnapshot();
      expect(a.startedAt).toBe(b.startedAt);
      expect(a.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('recordSuccess', () => {
    it('increments the success counter for the right route only', () => {
      recordSuccess('github', 12);
      const snap = getMetricsSnapshot();
      expect(snap.routes.github.successCount).toBe(1);
      expect(snap.routes.coolify.successCount).toBe(0);
      expect(snap.totals.successCount).toBe(1);
    });

    it('updates lastSuccessAt to a fresh timestamp', () => {
      recordSuccess('github', 5);
      const snap = getMetricsSnapshot();
      expect(snap.routes.github.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('captures latency samples and computes mean / max', () => {
      recordSuccess('github', 10);
      recordSuccess('github', 20);
      recordSuccess('github', 30);
      const stats = getMetricsSnapshot().routes.github.latency;
      expect(stats.count).toBe(3);
      expect(stats.meanMs).toBe(20);
      expect(stats.maxMs).toBe(30);
    });

    it('caps the latency ring buffer at 100 samples', () => {
      for (let i = 0; i < 150; i++) recordSuccess('github', i);
      const stats = getMetricsSnapshot().routes.github.latency;
      expect(stats.count).toBe(100);
      // The first 50 samples (0..49) should have been dropped.
      // Mean of 50..149 = 99.5 -> rounded
      expect(stats.meanMs).toBe(100);
      expect(stats.maxMs).toBe(149);
    });

    it('computes a p95 that is a valid sample near the top of the range', () => {
      for (let i = 1; i <= 100; i++) recordSuccess('github', i);
      const stats = getMetricsSnapshot().routes.github.latency;
      // p95 of values 1..100 with floor(N * 0.95) indexing: index 95 -> value 96.
      expect(stats.p95Ms).toBe(96);
      expect(stats.p95Ms).toBeGreaterThanOrEqual(95);
      expect(stats.p95Ms).toBeLessThanOrEqual(100);
    });
  });

  describe('recordError', () => {
    it('increments the error counter and stores the error', () => {
      recordError('coolify', new Error('deploy failed'), 'req-1');
      const snap = getMetricsSnapshot();
      expect(snap.routes.coolify.errorCount).toBe(1);
      expect(snap.routes.coolify.recentErrors).toHaveLength(1);
      expect(snap.routes.coolify.recentErrors[0].message).toBe('deploy failed');
      expect(snap.routes.coolify.recentErrors[0].requestId).toBe('req-1');
    });

    it('tolerates non-Error throwables', () => {
      recordError('github', 'string error');
      const snap = getMetricsSnapshot();
      expect(snap.routes.github.recentErrors[0].message).toBe('string error');
    });

    it('truncates very long error messages to 500 chars', () => {
      const longMsg = 'x'.repeat(2000);
      recordError('github', new Error(longMsg));
      const snap = getMetricsSnapshot();
      expect(snap.routes.github.recentErrors[0].message.length).toBe(500);
    });

    it('caps recentErrors at the last 5 events', () => {
      for (let i = 0; i < 10; i++) {
        recordError('github', new Error(`err-${i}`));
      }
      const snap = getMetricsSnapshot();
      expect(snap.routes.github.recentErrors).toHaveLength(5);
      // Should keep the most recent 5 (err-5..err-9), drop the oldest.
      expect(snap.routes.github.recentErrors[0].message).toBe('err-5');
      expect(snap.routes.github.recentErrors[4].message).toBe('err-9');
    });

    it('updates totals across multiple routes', () => {
      recordError('github', new Error('a'));
      recordError('coolify', new Error('b'));
      recordError('coolify', new Error('c'));
      const snap = getMetricsSnapshot();
      expect(snap.totals.errorCount).toBe(3);
    });
  });

  describe('snapshot is a stable shape', () => {
    it('returns a fresh object on each call (snapshot, not live ref)', () => {
      recordSuccess('github', 10);
      const snapA = getMetricsSnapshot();
      recordSuccess('github', 20);
      const snapB = getMetricsSnapshot();
      // The previously-returned snapshot must NOT mutate when new data arrives.
      expect(snapA.routes.github.successCount).toBe(1);
      expect(snapB.routes.github.successCount).toBe(2);
    });

    it('always exposes every known route key', () => {
      const snap = getMetricsSnapshot();
      const keys = Object.keys(snap.routes).sort();
      expect(keys).toEqual([
        'admin-refresh',
        'coolify',
        'github',
        'health-deep',
        'slack-events',
        'slack-interactive',
      ]);
    });
  });
});
