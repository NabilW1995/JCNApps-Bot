import { describe, it, expect } from 'vitest';
import {
  buildTaskClaimedMessage,
  buildHotfixStartedMessage,
} from '../../src/slack/messages.js';
import type {
  TaskClaimedMessageData,
  HotfixMessageData,
} from '../../src/types.js';

describe('buildTaskClaimedMessage', () => {
  const claimedData: TaskClaimedMessageData = {
    title: 'Add Dashboard Filter',
    issueNumber: 52,
    issueUrl: 'https://github.com/JCNApps/PassCraft/issues/52',
    repoName: 'PassCraft',
    claimedBy: 'NabilW1995',
    claimedBySlackId: 'U_NABIL',
    area: 'dashboard',
    files: ['filters.tsx', 'useFilters.ts'],
    startedAt: '09:34',
  };

  it('should include hammer emoji and working text', () => {
    const blocks = buildTaskClaimedMessage(claimedData);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('working on');
  });

  it('should show issue title and number', () => {
    const blocks = buildTaskClaimedMessage(claimedData);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('#52');
    expect(allText).toContain('Add Dashboard Filter');
  });

  it('should mention user via Slack ID', () => {
    const blocks = buildTaskClaimedMessage(claimedData);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('<@U_NABIL>');
  });

  it('should show files when present', () => {
    const blocks = buildTaskClaimedMessage(claimedData);
    const allText = blocks.map((b) => {
      if (b.type === 'section') return (b as any).text.text;
      if (b.type === 'context') return (b as any).elements.map((e: any) => e.text).join(' ');
      return '';
    }).join(' ');
    expect(allText).toContain('filters.tsx');
  });

  it('should not show files section when empty', () => {
    const noFiles: TaskClaimedMessageData = { ...claimedData, files: [] };
    const blocks = buildTaskClaimedMessage(noFiles);
    const allText = blocks.map((b) => {
      if (b.type === 'section') return (b as any).text.text;
      if (b.type === 'context') return (b as any).elements.map((e: any) => e.text).join(' ');
      return '';
    }).join(' ');
    expect(allText).not.toContain('filters.tsx');
  });

  it('should show area label', () => {
    const blocks = buildTaskClaimedMessage(claimedData);
    const allText = blocks.map((b) => {
      if (b.type === 'section') return (b as any).text.text;
      if (b.type === 'context') return (b as any).elements.map((e: any) => e.text).join(' ');
      return '';
    }).join(' ');
    expect(allText).toContain('dashboard');
  });

  it('should fall back to username when no Slack ID', () => {
    const noSlack: TaskClaimedMessageData = { ...claimedData, claimedBySlackId: null };
    const blocks = buildTaskClaimedMessage(noSlack);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('NabilW1995');
    expect(allText).not.toContain('<@');
  });
});

describe('buildHotfixStartedMessage', () => {
  const hotfixData: HotfixMessageData = {
    title: 'Dashboard Filter crashes on Mobile',
    issueNumber: 89,
    issueUrl: 'https://github.com/JCNApps/PassCraft/issues/89',
    repoName: 'PassCraft',
    fixedBy: 'NabilW1995',
    fixedBySlackId: 'U_NABIL',
    relatedIssueNumber: 52,
    relatedIssueTitle: 'Dashboard Filter',
    files: ['filters.tsx'],
    startedAt: '14:22',
  };

  it('should include ambulance emoji', () => {
    const blocks = buildHotfixStartedMessage(hotfixData);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toMatch(/Hotfix/);
  });

  it('should show issue title and number', () => {
    const blocks = buildHotfixStartedMessage(hotfixData);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('#89');
    expect(allText).toContain('crashes on Mobile');
  });

  it('should show related issue when present', () => {
    const blocks = buildHotfixStartedMessage(hotfixData);
    const allText = blocks.map((b) => {
      if (b.type === 'section') return (b as any).text.text;
      if (b.type === 'context') return (b as any).elements.map((e: any) => e.text).join(' ');
      return '';
    }).join(' ');
    expect(allText).toContain('#52');
    expect(allText).toContain('Dashboard Filter');
  });

  it('should work without related issue', () => {
    const noRelated: HotfixMessageData = {
      ...hotfixData,
      relatedIssueNumber: null,
      relatedIssueTitle: null,
    };
    const blocks = buildHotfixStartedMessage(noRelated);
    expect(blocks.length).toBeGreaterThan(0);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).not.toContain('#52');
  });

  it('should mention fixer via Slack ID', () => {
    const blocks = buildHotfixStartedMessage(hotfixData);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('<@U_NABIL>');
  });

  it('should show files', () => {
    const blocks = buildHotfixStartedMessage(hotfixData);
    const allText = blocks.map((b) => {
      if (b.type === 'section') return (b as any).text.text;
      if (b.type === 'context') return (b as any).elements.map((e: any) => e.text).join(' ');
      return '';
    }).join(' ');
    expect(allText).toContain('filters.tsx');
  });
});
