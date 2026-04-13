import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks for the three external dependencies the probe touches:
//   - Drizzle DB execute
//   - Slack auth.test
//   - GitHub /rate_limit (via global fetch)
// ---------------------------------------------------------------------------

const mockDbExecute = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockReturnValue({
    execute: (...a: unknown[]) => mockDbExecute(...a),
  }),
}));

const mockAuthTest = vi.fn().mockResolvedValue({ ok: true });
vi.mock('../../src/slack/client.js', () => ({
  getWebClient: vi.fn().mockReturnValue({
    auth: { test: (...a: unknown[]) => mockAuthTest(...a) },
  }),
}));

import { runDeepHealthCheck } from '../../src/health/deep-check.js';

describe('runDeepHealthCheck', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbExecute.mockResolvedValue(undefined);
    mockAuthTest.mockResolvedValue({ ok: true });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as any;
    process.env = { ...originalEnv };
    delete process.env.GITHUB_PAT;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  describe('all healthy', () => {
    it('returns status: ok when every probe succeeds', async () => {
      const report = await runDeepHealthCheck();
      expect(report.status).toBe('ok');
      expect(report.checks.database.status).toBe('ok');
      expect(report.checks.slack.status).toBe('ok');
      expect(report.checks.github.status).toBe('ok');
    });

    it('records latency for every probe', async () => {
      const report = await runDeepHealthCheck();
      expect(report.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
      expect(report.checks.slack.latencyMs).toBeGreaterThanOrEqual(0);
      expect(report.checks.github.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('includes an ISO timestamp', async () => {
      const report = await runDeepHealthCheck();
      expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('partial failures', () => {
    it('returns down when the database probe throws', async () => {
      mockDbExecute.mockRejectedValueOnce(new Error('connection refused'));
      const report = await runDeepHealthCheck();
      expect(report.status).toBe('down');
      expect(report.checks.database.status).toBe('down');
      expect(report.checks.database.error).toContain('connection refused');
      // Other probes still report independently
      expect(report.checks.slack.status).toBe('ok');
      expect(report.checks.github.status).toBe('ok');
    });

    it('returns down when the slack probe throws', async () => {
      mockAuthTest.mockRejectedValueOnce(new Error('invalid_auth'));
      const report = await runDeepHealthCheck();
      expect(report.status).toBe('down');
      expect(report.checks.slack.status).toBe('down');
      expect(report.checks.slack.error).toContain('invalid_auth');
    });

    it('returns down when slack returns ok:false', async () => {
      mockAuthTest.mockResolvedValueOnce({ ok: false, error: 'token_revoked' });
      const report = await runDeepHealthCheck();
      expect(report.status).toBe('down');
      expect(report.checks.slack.error).toContain('token_revoked');
    });

    it('returns down when github returns a 5xx', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as any;
      const report = await runDeepHealthCheck();
      expect(report.status).toBe('down');
      expect(report.checks.github.status).toBe('down');
      expect(report.checks.github.error).toContain('503');
    });

    it('returns down when github fetch throws', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as any;
      const report = await runDeepHealthCheck();
      expect(report.status).toBe('down');
      expect(report.checks.github.error).toContain('ENOTFOUND');
    });
  });

  describe('timeouts', () => {
    it('marks a hung probe as down within the timeout window', async () => {
      // Simulate a hung DB call that never resolves
      mockDbExecute.mockImplementationOnce(() => new Promise(() => {}));
      const report = await runDeepHealthCheck(50);
      expect(report.checks.database.status).toBe('down');
      expect(report.checks.database.error).toMatch(/timeout/i);
      expect(report.status).toBe('down');
    }, 10000);
  });

  describe('GitHub PAT usage', () => {
    it('sends Authorization header when GITHUB_PAT is set', async () => {
      process.env.GITHUB_PAT = 'ghp_test_token';
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchSpy as any;

      await runDeepHealthCheck();

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.github.com/rate_limit',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer ghp_test_token',
          }),
        })
      );
    });

    it('omits Authorization header when GITHUB_PAT is unset', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchSpy as any;

      await runDeepHealthCheck();

      const callHeaders = fetchSpy.mock.calls[0][1].headers;
      expect(callHeaders.Authorization).toBeUndefined();
    });
  });
});
