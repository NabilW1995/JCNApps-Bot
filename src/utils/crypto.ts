import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify that a GitHub webhook payload was signed with the expected secret.
 *
 * Uses Node.js crypto HMAC-SHA256 and timing-safe comparison to prevent
 * timing attacks. The signature header from GitHub looks like:
 * "sha256=<hex-digest>"
 */
export function verifyGitHubSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  if (!signature || !payload || !secret) {
    return false;
  }

  const expected =
    'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');

  // Both strings must have the same length for timingSafeEqual
  if (expected.length !== signature.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(expected, 'utf-8'),
    Buffer.from(signature, 'utf-8')
  );
}
