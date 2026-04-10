import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGitHubSignature } from '../../src/utils/crypto.js';

const TEST_SECRET = 'test-webhook-secret-123';

/**
 * Helper: create a valid GitHub-style signature for a payload.
 */
function createValidSignature(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

describe('verifyGitHubSignature', () => {
  const payload = JSON.stringify({ action: 'opened', issue: { number: 1 } });

  it('should return true for a valid signature', () => {
    const signature = createValidSignature(payload, TEST_SECRET);
    expect(verifyGitHubSignature(payload, signature, TEST_SECRET)).toBe(true);
  });

  it('should return false for an invalid signature', () => {
    const wrongSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';
    expect(verifyGitHubSignature(payload, wrongSignature, TEST_SECRET)).toBe(false);
  });

  it('should return false for a signature with wrong secret', () => {
    const signature = createValidSignature(payload, 'wrong-secret');
    expect(verifyGitHubSignature(payload, signature, TEST_SECRET)).toBe(false);
  });

  it('should return false for an empty signature', () => {
    expect(verifyGitHubSignature(payload, '', TEST_SECRET)).toBe(false);
  });

  it('should return false for an empty payload', () => {
    const signature = createValidSignature(payload, TEST_SECRET);
    expect(verifyGitHubSignature('', signature, TEST_SECRET)).toBe(false);
  });

  it('should return false for an empty secret', () => {
    expect(verifyGitHubSignature(payload, 'sha256=abc', '')).toBe(false);
  });

  it('should return false when signature has different length', () => {
    expect(verifyGitHubSignature(payload, 'sha256=short', TEST_SECRET)).toBe(false);
  });
});
