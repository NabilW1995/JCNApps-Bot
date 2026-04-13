import { describe, it, expect } from 'vitest';
import {
  sanitizeUrl,
  isPublicUrl,
  extractIssueNumbers,
  isMainBranch,
  extractFeatureBranch,
} from '../../src/webhooks/coolify-helpers.js';

describe('sanitizeUrl', () => {
  it('accepts http URLs', () => {
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('accepts https URLs', () => {
    expect(sanitizeUrl('https://example.com')).toBe('https://example.com');
  });

  it('is case-insensitive on the scheme', () => {
    expect(sanitizeUrl('HTTPS://Example.Com')).toBe('HTTPS://Example.Com');
  });

  it('rejects javascript: URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects data: URLs', () => {
    expect(sanitizeUrl('data:text/html,<script>')).toBeNull();
  });

  it('rejects schemeless strings', () => {
    expect(sanitizeUrl('example.com/path')).toBeNull();
    expect(sanitizeUrl('//example.com')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(sanitizeUrl('')).toBeNull();
  });
});

describe('isPublicUrl', () => {
  it('returns true for a public domain', () => {
    expect(isPublicUrl('https://passcraft.pro')).toBe(true);
    expect(isPublicUrl('https://app.passcraft.com/dashboard')).toBe(true);
  });

  it('rejects URLs containing "coolify" anywhere in the host', () => {
    expect(isPublicUrl('https://coolify.example.com')).toBe(false);
    expect(isPublicUrl('https://my-coolify-instance.io')).toBe(false);
  });

  it('rejects .internal hosts', () => {
    expect(isPublicUrl('https://service.internal/x')).toBe(false);
  });

  it('rejects .local hosts', () => {
    expect(isPublicUrl('https://my-machine.local')).toBe(false);
  });

  it('rejects localhost in any form', () => {
    expect(isPublicUrl('http://localhost:3000')).toBe(false);
    expect(isPublicUrl('https://localhost')).toBe(false);
  });

  it('rejects raw IP addresses', () => {
    expect(isPublicUrl('http://192.168.1.5')).toBe(false);
    expect(isPublicUrl('https://10.0.0.1:8080')).toBe(false);
  });

  it('rejects Kubernetes service hostnames', () => {
    expect(isPublicUrl('http://api.svc.cluster.local')).toBe(false);
  });
});

describe('extractIssueNumbers', () => {
  it('returns an empty array for null and undefined input', () => {
    expect(extractIssueNumbers(null)).toEqual([]);
    expect(extractIssueNumbers(undefined)).toEqual([]);
    expect(extractIssueNumbers('')).toEqual([]);
  });

  it('returns a single issue number', () => {
    expect(extractIssueNumbers('fix #23')).toEqual([23]);
  });

  it('returns multiple issue numbers in order', () => {
    expect(extractIssueNumbers('fix #23 and #45')).toEqual([23, 45]);
  });

  it('preserves duplicates (callers can dedup)', () => {
    expect(extractIssueNumbers('#5 and #5 again')).toEqual([5, 5]);
  });

  it('returns nothing when no #N pattern is present', () => {
    expect(extractIssueNumbers('initial commit')).toEqual([]);
    expect(extractIssueNumbers('refactor authentication module')).toEqual([]);
  });

  it('handles large issue numbers', () => {
    expect(extractIssueNumbers('closes #1234567')).toEqual([1234567]);
  });
});

describe('isMainBranch', () => {
  it('returns true for "main"', () => {
    expect(isMainBranch('main')).toBe(true);
  });

  it('returns true for "master"', () => {
    expect(isMainBranch('master')).toBe(true);
  });

  it('returns false for any feature branch', () => {
    expect(isMainBranch('feature/login')).toBe(false);
    expect(isMainBranch('fix/bug-123')).toBe(false);
    expect(isMainBranch('preview')).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isMainBranch(null)).toBe(false);
    expect(isMainBranch(undefined)).toBe(false);
    expect(isMainBranch('')).toBe(false);
  });

  it('is exact-match — does not match substrings', () => {
    expect(isMainBranch('mainline')).toBe(false);
    expect(isMainBranch('feature/main')).toBe(false);
  });
});

describe('extractFeatureBranch', () => {
  it('returns null for an empty commit list', () => {
    expect(extractFeatureBranch([])).toBeNull();
  });

  it('returns null when no merge pattern matches', () => {
    expect(
      extractFeatureBranch(['initial commit', 'fix typo', 'refactor module'])
    ).toBeNull();
  });

  it('extracts a branch from "Merge branch \'name\'"', () => {
    expect(extractFeatureBranch(["Merge branch 'feature/dashboard-filter'"])).toBe(
      'feature/dashboard-filter'
    );
  });

  it('extracts a branch from "Merge feature/x into preview"', () => {
    expect(extractFeatureBranch(['Merge feature/login-redo into preview'])).toBe(
      'feature/login-redo'
    );
  });

  it('returns the first match when multiple commits qualify', () => {
    expect(
      extractFeatureBranch([
        "Merge branch 'feature/first'",
        "Merge branch 'feature/second'",
      ])
    ).toBe('feature/first');
  });

  it('skips non-merge commits to find a merge commit', () => {
    expect(
      extractFeatureBranch([
        'fix typo',
        'add tests',
        "Merge branch 'feature/late-merge'",
      ])
    ).toBe('feature/late-merge');
  });
});
