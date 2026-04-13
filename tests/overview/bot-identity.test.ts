import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAuthTest = vi.fn();
const mockWithRetry = vi.fn(async (fn: () => Promise<unknown>) => fn());

vi.mock('../../src/slack/client.js', () => ({
  getWebClient: vi.fn().mockReturnValue({
    auth: { test: (...a: unknown[]) => mockAuthTest(...a) },
  }),
  withRetry: (fn: () => Promise<unknown>) => mockWithRetry(fn),
}));

import { detectBotUserId } from '../../src/overview/bot-identity.js';

describe('detectBotUserId', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.BOT_USER_ID;
    mockWithRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('stores the user_id in process.env on success', async () => {
    mockAuthTest.mockResolvedValueOnce({ ok: true, user_id: 'U_BOT_123' });

    await detectBotUserId();

    expect(process.env.BOT_USER_ID).toBe('U_BOT_123');
  });

  it('does NOT crash when auth.test omits the user_id', async () => {
    mockAuthTest.mockResolvedValueOnce({ ok: true });

    await expect(detectBotUserId()).resolves.toBeUndefined();
    expect(process.env.BOT_USER_ID).toBeUndefined();
  });

  it('does NOT crash when the slack call throws', async () => {
    mockAuthTest.mockRejectedValueOnce(new Error('invalid_auth'));

    await expect(detectBotUserId()).resolves.toBeUndefined();
    expect(process.env.BOT_USER_ID).toBeUndefined();
  });

  it('routes the slack call through withRetry', async () => {
    mockAuthTest.mockResolvedValueOnce({ ok: true, user_id: 'U_BOT_456' });

    await detectBotUserId();

    expect(mockWithRetry).toHaveBeenCalled();
  });
});
