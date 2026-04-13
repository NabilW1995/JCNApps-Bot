import { describe, it, expect } from 'vitest';
import { extractIssueRefs } from '../../src/utils/issue-refs.js';

describe('extractIssueRefs', () => {
  it('returns empty for null or empty input', () => {
    expect(extractIssueRefs(null)).toEqual([]);
    expect(extractIssueRefs(undefined)).toEqual([]);
    expect(extractIssueRefs('')).toEqual([]);
  });

  it('returns empty when no issue references exist', () => {
    expect(extractIssueRefs('fix: filter bug in dashboard')).toEqual([]);
    expect(extractIssueRefs('initial commit')).toEqual([]);
  });

  it('finds a single #N reference', () => {
    expect(extractIssueRefs('fix: #23 filter crash')).toEqual([23]);
    expect(extractIssueRefs('resolves #99')).toEqual([99]);
  });

  it('finds multiple references in one line', () => {
    expect(extractIssueRefs('fix: #23 and #45')).toEqual([23, 45]);
    expect(extractIssueRefs('closes #99, resolves #100')).toEqual([99, 100]);
  });

  it('finds references across multiple lines', () => {
    expect(extractIssueRefs('multi line\n#10\n#20')).toEqual([10, 20]);
  });

  it('deduplicates references to the same issue', () => {
    expect(extractIssueRefs('fix: #23 and more on #23')).toEqual([23]);
    expect(extractIssueRefs('#5 #5 #5')).toEqual([5]);
  });

  it('preserves order of first occurrence', () => {
    expect(extractIssueRefs('#3 then #1 then #2 then #1')).toEqual([3, 1, 2]);
  });

  it('ignores non-numeric tags', () => {
    expect(extractIssueRefs('#abc not a number')).toEqual([]);
    expect(extractIssueRefs('##not')).toEqual([]);
  });

  it('ignores zero as a reference', () => {
    expect(extractIssueRefs('#0 is not real')).toEqual([]);
  });

  it('handles large issue numbers', () => {
    expect(extractIssueRefs('#1234567')).toEqual([1234567]);
  });

  it('handles mixed valid + invalid tokens', () => {
    expect(extractIssueRefs('#23 #abc #45 ##x #0 #78')).toEqual([23, 45, 78]);
  });
});
