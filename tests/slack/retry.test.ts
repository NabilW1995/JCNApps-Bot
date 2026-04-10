import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../src/slack/client.js';

// We need to reset the web client module so withRetry is importable
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(),
}));

vi.mock('@slack/webhook', () => ({
  IncomingWebhook: vi.fn(),
}));

describe('withRetry', () => {
  it('should return result on first try when no error', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const result = await withRetry(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on rate limit error and eventually succeed', async () => {
    const rateLimitError = {
      code: 'slack_webapi_rate_limited',
      retryAfter: 0, // 0 seconds to keep test fast
    };

    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValue('success after retries');

    const result = await withRetry(fn, 3);

    expect(result).toBe('success after retries');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max retries exceeded', async () => {
    const rateLimitError = {
      code: 'slack_webapi_rate_limited',
      retryAfter: 0,
    };

    const fn = vi.fn().mockRejectedValue(rateLimitError);

    await expect(withRetry(fn, 2)).rejects.toEqual(rateLimitError);
    // 1 initial + 2 retries = 3 total calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw immediately for non-rate-limit errors', async () => {
    const otherError = new Error('Network failure');

    const fn = vi.fn().mockRejectedValue(otherError);

    await expect(withRetry(fn, 3)).rejects.toThrow('Network failure');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should use default retryAfter of 1 second when not provided', async () => {
    const rateLimitError = {
      code: 'slack_webapi_rate_limited',
      // No retryAfter field
    };

    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValue('ok');

    // Mock setTimeout to avoid actually waiting 1 second
    vi.useFakeTimers();
    const promise = withRetry(fn, 1);
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
