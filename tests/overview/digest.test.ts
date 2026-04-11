import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/channels.js', () => ({
  getChannelConfig: vi.fn().mockImplementation((repoName: string) => {
    const map: Record<string, { displayName: string }> = {
      passcraft: { displayName: 'PassCraft' },
      'wizard-crm': { displayName: 'Wizard CRM' },
    };
    return map[repoName] ?? null;
  }),
}));

import { buildMorningDigestBlocks } from '../../src/overview/digest.js';
import { getChannelConfig } from '../../src/config/channels.js';

type MemberInput = {
  name: string;
  githubUsername: string;
  status: string | null;
  currentRepo: string | null;
};

function extractAllText(blocks: ReturnType<typeof buildMorningDigestBlocks>): string {
  return blocks
    .map((b) => {
      if (b.type === 'section' && 'text' in b) return b.text.text;
      if (b.type === 'context' && 'elements' in b) {
        return b.elements.map((e) => e.text).join(' ');
      }
      return '';
    })
    .join('\n');
}

describe('buildMorningDigestBlocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should show greeting and overview stats', () => {
    const issueCounts = [
      { repoName: 'passcraft', total: 5, critical: 2 },
      { repoName: 'wizard-crm', total: 3, critical: 0 },
    ];
    const members: MemberInput[] = [
      { name: 'Nabil', githubUsername: 'NabilW1995', status: 'active', currentRepo: 'passcraft' },
      { name: 'Chris', githubUsername: 'ChrisGH', status: 'idle', currentRepo: null },
      { name: 'Jainem', githubUsername: 'JainemGH', status: 'idle', currentRepo: null },
    ];

    const blocks = buildMorningDigestBlocks(issueCounts, members);
    const text = extractAllText(blocks);

    expect(text).toContain('Good Morning JCN Team');
    expect(text).toContain('8 open tasks');
    expect(text).toContain('2 apps');
    expect(text).toContain('1/3 team members active');
  });

  it('should show critical warning when critical issues exist', () => {
    const issueCounts = [{ repoName: 'passcraft', total: 3, critical: 2 }];
    const members: MemberInput[] = [];

    const blocks = buildMorningDigestBlocks(issueCounts, members);
    const text = extractAllText(blocks);

    expect(text).toContain('2 critical');
    expect(text).toContain('need attention');
    expect(text).not.toContain('No critical issues');
  });

  it('should show all-clear when no critical issues', () => {
    const issueCounts = [{ repoName: 'passcraft', total: 3, critical: 0 }];
    const members: MemberInput[] = [];

    const blocks = buildMorningDigestBlocks(issueCounts, members);
    const text = extractAllText(blocks);

    expect(text).toContain('No critical issues');
    expect(text).not.toContain('need attention');
  });

  it('should show per-app summary lines with display names', () => {
    const issueCounts = [
      { repoName: 'passcraft', total: 5, critical: 1 },
      { repoName: 'wizard-crm', total: 3, critical: 0 },
    ];
    const members: MemberInput[] = [];

    const blocks = buildMorningDigestBlocks(issueCounts, members);
    const text = extractAllText(blocks);

    // Verify the mock is being called
    expect(getChannelConfig).toHaveBeenCalledWith('passcraft');
    expect(getChannelConfig).toHaveBeenCalledWith('wizard-crm');

    expect(text).toContain('PassCraft');
    expect(text).toContain('5 open');
    expect(text).toContain('1 critical');
    expect(text).toContain('Wizard CRM');
    expect(text).toContain('3 open');
  });

  it('should show team status with active and idle members', () => {
    const issueCounts = [{ repoName: 'passcraft', total: 3, critical: 0 }];
    const members: MemberInput[] = [
      { name: 'Nabil', githubUsername: 'NabilW1995', status: 'active', currentRepo: 'passcraft' },
      { name: 'Chris', githubUsername: 'ChrisGH', status: 'idle', currentRepo: null },
    ];

    const blocks = buildMorningDigestBlocks(issueCounts, members);
    const text = extractAllText(blocks);

    expect(text).toContain('Nabil');
    expect(text).toContain('Working on PassCraft');
    expect(text).toContain('Chris');
    expect(text).toContain('No active tasks');
  });

  it('should include morning digest footer with date', () => {
    const blocks = buildMorningDigestBlocks([], []);
    const text = extractAllText(blocks);

    expect(text).toContain('Morning digest');
  });

  it('should handle empty state correctly', () => {
    const blocks = buildMorningDigestBlocks([], []);
    const text = extractAllText(blocks);

    expect(text).toContain('0 open tasks');
    expect(text).toContain('0 apps');
    expect(text).toContain('0/0 team members active');
  });
});
