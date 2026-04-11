import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mergeBranchToMain } from '../../src/preview/merge.js';

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('mergeBranchToMain', () => {
  const REPO = 'PassCraft';
  const BRANCH = 'feature/dashboard-filter';

  beforeEach(() => {
    process.env.GITHUB_PAT = 'ghp_test_token';
    process.env.GITHUB_ORG = 'JCNApps';
    mockFetch.mockReset();

    // First call in every test: repo info to detect default branch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ default_branch: 'master' }),
    });
  });

  afterEach(() => {
    delete process.env.GITHUB_PAT;
    delete process.env.GITHUB_ORG;
  });

  it('should return false when GITHUB_PAT is not set', async () => {
    delete process.env.GITHUB_PAT;

    const result = await mergeBranchToMain(REPO, BRANCH);
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return false when GITHUB_ORG is not set', async () => {
    delete process.env.GITHUB_ORG;

    const result = await mergeBranchToMain(REPO, BRANCH);
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should create a PR and merge it on success', async () => {
    // Mock: PR creation succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 42 }),
    });
    // Mock: PR merge succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ merged: true }),
    });

    const result = await mergeBranchToMain(REPO, BRANCH);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify PR creation call (index 1, after repo info at 0)
    const createCall = mockFetch.mock.calls[1];
    expect(createCall[0]).toContain('/pulls');
    expect(createCall[1].method).toBe('POST');

    // Verify PR merge call (index 2)
    const mergeCall = mockFetch.mock.calls[2];
    expect(mergeCall[0]).toContain('/pulls/42/merge');
    expect(mergeCall[1].method).toBe('PUT');
  });

  it('should find and merge an existing PR when creation fails', async () => {
    // Mock: PR creation fails (already exists)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ message: 'Validation Failed' }),
    });
    // Mock: Search for existing PR succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ number: 99 }],
    });
    // Mock: PR merge succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ merged: true }),
    });

    const result = await mergeBranchToMain(REPO, BRANCH);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(4);

    // Verify the merge used the found PR number (index 3)
    const mergeCall = mockFetch.mock.calls[3];
    expect(mergeCall[0]).toContain('/pulls/99/merge');
  });

  it('should fall back to direct merge when no PR exists', async () => {
    // Mock: PR creation fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
    });
    // Mock: Search returns no PRs
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    // Mock: Direct merge succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
    });

    const result = await mergeBranchToMain(REPO, BRANCH);

    expect(result).toBe(true);

    // Verify direct merge call (index 3)
    const mergeCall = mockFetch.mock.calls[3];
    expect(mergeCall[0]).toContain('/merges');
    expect(mergeCall[1].method).toBe('POST');
  });

  it('should return false when PR merge fails', async () => {
    // Mock: PR creation succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 42 }),
    });
    // Mock: PR merge fails (conflict)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
    });

    const result = await mergeBranchToMain(REPO, BRANCH);

    expect(result).toBe(false);
  });

  it('should return false when direct merge fails', async () => {
    // Mock: PR creation fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
    });
    // Mock: Search returns no PRs
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    // Mock: Direct merge fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
    });

    const result = await mergeBranchToMain(REPO, BRANCH);

    expect(result).toBe(false);
  });

  it('should return false on network error', async () => {
    // Reset the beforeEach repo-info mock since the error hits first
    mockFetch.mockReset();
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await mergeBranchToMain(REPO, BRANCH);

    expect(result).toBe(false);
  });

  it('should include correct auth headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 1 }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ merged: true }),
    });

    await mergeBranchToMain(REPO, BRANCH);

    // Check headers on PR creation call (index 1)
    const headers = mockFetch.mock.calls[1][1].headers;
    expect(headers.Authorization).toBe('token ghp_test_token');
    expect(headers.Accept).toBe('application/vnd.github.v3+json');
  });

  it('should use the correct repo URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 1 }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ merged: true }),
    });

    await mergeBranchToMain(REPO, BRANCH);

    // Check URL on PR creation call (index 1)
    const url = mockFetch.mock.calls[1][0] as string;
    expect(url).toContain('JCNApps/PassCraft/pulls');
  });
});
