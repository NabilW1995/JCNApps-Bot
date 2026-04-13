import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractKeywordsFromTitle,
  searchCodeForFiles,
  detectFilesForIssue,
} from '../../src/utils/code-search.js';

describe('extractKeywordsFromTitle', () => {
  it('returns an empty array when nothing meaningful remains', () => {
    // Every token is either a stop word or under 4 characters.
    expect(extractKeywordsFromTitle('the bug is bad')).toEqual([]);
  });

  it('drops stop words and very short tokens', () => {
    // "fix", "bug", "is", "the" are stop words; "ui" is too short.
    const out = extractKeywordsFromTitle('fix the bug in ui');
    expect(out).toEqual([]);
  });

  it('preserves real keywords longer than 3 characters', () => {
    expect(extractKeywordsFromTitle('dashboard filter crashes')).toEqual([
      'dashboard',
      'filter',
    ]);
  });

  it('lowercases tokens', () => {
    expect(extractKeywordsFromTitle('Dashboard Filter')).toEqual([
      'dashboard',
      'filter',
    ]);
  });

  it('strips non-word punctuation', () => {
    expect(extractKeywordsFromTitle('payment-flow: broken!')).toEqual(['payment', 'flow']);
  });

  it('caps at 5 keywords even if more meaningful tokens exist', () => {
    const out = extractKeywordsFromTitle(
      'dashboard filter calendar scheduler exporter importer extras'
    );
    expect(out).toHaveLength(5);
  });

  it('handles an empty title', () => {
    expect(extractKeywordsFromTitle('')).toEqual([]);
  });
});

describe('searchCodeForFiles + detectFilesForIssue', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, GITHUB_PAT: 'ghp_test', GITHUB_ORG: 'TestOrg' };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('returns an empty array when GITHUB_PAT is missing', async () => {
    delete process.env.GITHUB_PAT;
    const out = await searchCodeForFiles('PassCraft', ['dashboard'], null);
    expect(out).toEqual([]);
  });

  it('returns an empty array when GITHUB_ORG is missing', async () => {
    delete process.env.GITHUB_ORG;
    const out = await searchCodeForFiles('PassCraft', ['dashboard'], null);
    expect(out).toEqual([]);
  });

  it('runs tier-1 path search and returns matched paths', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ path: 'src/dashboard/Filter.tsx' }, { path: 'src/dashboard/util.ts' }],
        total_count: 2,
      }),
    }) as any;

    const out = await searchCodeForFiles('PassCraft', ['dashboard'], null);
    expect(out).toContain('src/dashboard/Filter.tsx');
    expect(out).toContain('src/dashboard/util.ts');
  });

  it('falls back to tier-2 content search when tier-1 has no results', async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        return { ok: true, json: async () => ({ items: [], total_count: 0 }) };
      }
      return {
        ok: true,
        json: async () => ({ items: [{ path: 'src/util/match.ts' }], total_count: 1 }),
      };
    }) as any;

    const out = await searchCodeForFiles('PassCraft', ['filter', 'crash'], null);
    expect(out).toEqual(['src/util/match.ts']);
  });

  it('falls back to tier-3 area search when tiers 1 and 2 are empty', async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call <= 2) {
        return { ok: true, json: async () => ({ items: [], total_count: 0 }) };
      }
      return {
        ok: true,
        json: async () => ({ items: [{ path: 'src/dashboard/index.tsx' }], total_count: 1 }),
      };
    }) as any;

    const out = await searchCodeForFiles('PassCraft', ['filter'], 'dashboard');
    expect(out).toEqual(['src/dashboard/index.tsx']);
  });

  it('skips tier-3 when area is null or "unassigned"', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], total_count: 0 }),
    });
    global.fetch = fetchSpy as any;

    await searchCodeForFiles('PassCraft', ['x'], null);
    // Tier 1 + Tier 2 = 2 calls, no tier 3
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockClear();
    await searchCodeForFiles('PassCraft', ['x'], 'unassigned');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('handles a non-ok HTTP response by returning an empty result', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as any;
    const out = await searchCodeForFiles('PassCraft', ['filter'], null);
    expect(out).toEqual([]);
  });

  it('handles a thrown fetch by returning an empty result', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as any;
    const out = await searchCodeForFiles('PassCraft', ['filter'], null);
    expect(out).toEqual([]);
  });

  it('detectFilesForIssue extracts keywords then runs the search', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ path: 'src/dashboard/Filter.tsx' }],
        total_count: 1,
      }),
    });
    global.fetch = fetchSpy as any;

    const out = await detectFilesForIssue('PassCraft', 'Dashboard Filter crashes', null);
    expect(out).toEqual(['src/dashboard/Filter.tsx']);
    // The first call should have used the longest keyword from the title
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('dashboard');
  });

  it('detectFilesForIssue returns empty when the title has no meaningful tokens', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const out = await detectFilesForIssue('PassCraft', 'fix the bug', null);
    // No keywords -> no tier 1 / tier 2 calls; tier 3 only fires when area is set
    expect(out).toEqual([]);
  });
});
