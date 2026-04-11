import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  inviteToGitHub,
  inviteToCoolify,
  createPreviewDNS,
  saveTeamMember,
} from '../../src/onboarding/provision.js';

// Mock the DB module -- saveTeamMember now uses .insert().values().onConflictDoUpdate()
vi.mock('../../src/db/client.js', () => ({
  getDb: vi.fn().mockReturnValue({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  }),
}));

// Test base URL for Coolify (not a real server)
const TEST_COOLIFY_BASE = 'https://coolify.test.local';

describe('Provisioning Functions', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GITHUB_PAT: 'test-github-pat',
      GITHUB_ORG: 'TestOrg',
      COOLIFY_API_TOKEN: 'test-coolify-token',
      COOLIFY_URL: TEST_COOLIFY_BASE,
      CLOUDFLARE_API_TOKEN: 'test-cf-token',
      CLOUDFLARE_ZONE_ID: 'test-zone-id',
      SERVER_IP: '1.2.3.4',
    };
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe('inviteToGitHub', () => {
    it('should look up user and send org invitation', async () => {
      const mockFetch = vi.mocked(fetch);

      // First call: user lookup
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 12345 }), { status: 200 })
      );
      // Second call: org invitation
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1 }), { status: 201 })
      );

      const result = await inviteToGitHub('chris-dev');

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify user lookup URL
      const lookupUrl = mockFetch.mock.calls[0][0] as string;
      expect(lookupUrl).toContain('/users/chris-dev');

      // Verify invitation URL contains org name
      const inviteUrl = mockFetch.mock.calls[1][0] as string;
      expect(inviteUrl).toContain('/orgs/TestOrg/invitations');
    });

    it('should return false when user lookup fails', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response('Not Found', { status: 404 })
      );

      const result = await inviteToGitHub('nonexistent-user');
      expect(result).toBe(false);
    });

    it('should return false when invitation fails', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 12345 }), { status: 200 })
      );
      mockFetch.mockResolvedValueOnce(
        new Response('Forbidden', { status: 403 })
      );

      const result = await inviteToGitHub('chris-dev');
      expect(result).toBe(false);
    });

    it('should return false when env vars are missing', async () => {
      delete process.env.GITHUB_PAT;
      const result = await inviteToGitHub('chris-dev');
      expect(result).toBe(false);
    });

    it('should return false on network error', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await inviteToGitHub('chris-dev');
      expect(result).toBe(false);
    });
  });

  describe('inviteToCoolify', () => {
    it('should send a Coolify team invitation', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

      const testEmail = ['chris', 'example.com'].join('@');
      const result = await inviteToCoolify(testEmail);

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_COOLIFY_BASE}/api/v1/teams/0/invitations`,
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should return false when the API returns an error', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response('Server Error', { status: 500 })
      );

      const testEmail = ['chris', 'example.com'].join('@');
      const result = await inviteToCoolify(testEmail);
      expect(result).toBe(false);
    });

    it('should return false when env vars are missing', async () => {
      delete process.env.COOLIFY_API_TOKEN;
      const testEmail = ['chris', 'example.com'].join('@');
      const result = await inviteToCoolify(testEmail);
      expect(result).toBe(false);
    });
  });

  describe('createPreviewDNS', () => {
    it('should create a Cloudflare DNS A record', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const result = await createPreviewDNS('chris');

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/zones/test-zone-id/dns_records'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            type: 'A',
            name: 'preview-chris.passcraft.pro',
            content: '1.2.3.4',
            proxied: true,
          }),
        })
      );
    });

    it('should return false when DNS creation fails', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response('Bad Request', { status: 400 })
      );

      const result = await createPreviewDNS('chris');
      expect(result).toBe(false);
    });

    it('should return false when env vars are missing', async () => {
      delete process.env.CLOUDFLARE_API_TOKEN;
      const result = await createPreviewDNS('chris');
      expect(result).toBe(false);
    });
  });

  describe('saveTeamMember', () => {
    it('should insert a team member into the database', async () => {
      const { getDb } = await import('../../src/db/client.js');
      const mockDb = vi.mocked(getDb)();

      await saveTeamMember('Chris', 'chris-dev', 'U_CHRIS');

      expect(mockDb.insert).toHaveBeenCalled();
    });
  });
});
