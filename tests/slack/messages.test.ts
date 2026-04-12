import { describe, it, expect } from 'vitest';
import {
  buildNewIssueMessage,
  buildMergeConflictMessage,
  buildPreviewReadyMessage,
  buildProductionDeployedMessage,
  buildDeployFailedMessage,
} from '../../src/slack/messages.js';
import type {
  NewIssueMessageData,
  MergeConflictMessageData,
  PreviewReadyMessageData,
  ProductionDeployedMessageData,
  DeployFailedMessageData,
} from '../../src/types.js';

describe('buildNewIssueMessage', () => {
  const customerBugData: NewIssueMessageData = {
    title: 'Dashboard shows wrong revenue numbers',
    issueUrl: 'https://github.com/JCNApps/PassCraft/issues/42',
    issueNumber: 42,
    repoName: 'PassCraft',
    reportedBy: 'customer-jane',
    labels: ['bug', 'source/customer', 'area/dashboard', 'priority/high'],
    body: 'The monthly revenue is wrong.',
    isCustomerSource: true,
    area: 'dashboard',
    priority: 'high',
    screenshotCount: 1,
  };

  const internalFeatureData: NewIssueMessageData = {
    title: 'Add dark mode support',
    issueUrl: 'https://github.com/JCNApps/PassCraft/issues/43',
    issueNumber: 43,
    repoName: 'PassCraft',
    reportedBy: 'NabilW1995',
    labels: ['enhancement', 'source/internal'],
    body: 'We should add dark mode.',
    isCustomerSource: false,
    area: null,
    priority: null,
    screenshotCount: 0,
  };

  it('should include [EXT] indicator for customer-reported bugs', () => {
    const blocks = buildNewIssueMessage(customerBugData);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join(' ');
    expect(allText).toContain('[EXT]');
  });

  it('should include [INT] indicator for internal issues', () => {
    const blocks = buildNewIssueMessage(internalFeatureData);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join(' ');
    expect(allText).toContain('[INT]');
  });

  it('should include issue title and number as a link', () => {
    const blocks = buildNewIssueMessage(customerBugData);
    const firstBlock = blocks[0];
    if (firstBlock.type === 'section') {
      expect(firstBlock.text.text).toContain('#42');
      expect(firstBlock.text.text).toContain('Dashboard shows wrong revenue numbers');
      expect(firstBlock.text.text).toContain(customerBugData.issueUrl);
    }
  });

  it('should show priority and area when present', () => {
    const blocks = buildNewIssueMessage(customerBugData);
    const repoBlock = blocks[1];
    if (repoBlock.type === 'section') {
      expect(repoBlock.text.text).toContain('dashboard');
      expect(repoBlock.text.text).toContain('high');
    }
  });

  it('should show screenshot count when present', () => {
    const blocks = buildNewIssueMessage(customerBugData);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join(' ');
    // New format uses a camera emoji followed by the count
    expect(allText).toContain('\u{1F4F7} 1');
  });

  it('should not show screenshot info when count is zero', () => {
    const blocks = buildNewIssueMessage(internalFeatureData);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join(' ');
    // No camera emoji should be present when there are no screenshots
    expect(allText).not.toContain('\u{1F4F7}');
  });

  it('should include action buttons', () => {
    const blocks = buildNewIssueMessage(customerBugData);
    const actionsBlock = blocks.find((b) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    if (actionsBlock && actionsBlock.type === 'actions') {
      expect(actionsBlock.elements).toHaveLength(2);
      expect(actionsBlock.elements[0].text.text).toBe('View on GitHub');
      expect(actionsBlock.elements[1].text.text).toBe('Fix with Claude');
    }
  });

  it('should truncate long body text', () => {
    const longBodyData: NewIssueMessageData = {
      ...customerBugData,
      body: 'A'.repeat(500),
    };
    const blocks = buildNewIssueMessage(longBodyData);
    // Body is now embedded in the section block that contains the ">>> " quote
    const bodyBlock = blocks.find(
      (b) => b.type === 'section' && b.text.text.includes('>>>')
    );
    expect(bodyBlock).toBeDefined();
    if (bodyBlock && bodyBlock.type === 'section') {
      // Pull out just the quoted body portion after ">>> "
      const quoted = bodyBlock.text.text.split('>>> ')[1] ?? '';
      // Body should be truncated to 300 chars + "..." (303), not the full 500
      expect(quoted.length).toBeLessThan(310);
      expect(quoted.endsWith('...')).toBe(true);
    }
  });
});

describe('buildMergeConflictMessage', () => {
  const conflictData: MergeConflictMessageData = {
    prTitle: 'feat: add user settings page',
    prUrl: 'https://github.com/JCNApps/PassCraft/pull/15',
    prNumber: 15,
    repoName: 'PassCraft',
    headBranch: 'feature/user-settings',
    baseBranch: 'main',
    author: 'NabilW1995',
    affectedUserSlackIds: ['U_NABIL'],
  };

  it('should include warning emoji', () => {
    const blocks = buildMergeConflictMessage(conflictData);
    const firstBlock = blocks[0];
    if (firstBlock.type === 'section') {
      expect(firstBlock.text.text).toContain('\u26A0\uFE0F');
    }
  });

  it('should mention affected users via Slack @mention syntax', () => {
    const blocks = buildMergeConflictMessage(conflictData);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join(' ');
    expect(allText).toContain('<@U_NABIL>');
  });

  it('should show branch names', () => {
    const blocks = buildMergeConflictMessage(conflictData);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join(' ');
    expect(allText).toContain('feature/user-settings');
    expect(allText).toContain('main');
  });

  it('should include PR link', () => {
    const blocks = buildMergeConflictMessage(conflictData);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join(' ');
    expect(allText).toContain(conflictData.prUrl);
    expect(allText).toContain('#15');
  });

  it('should fall back to author name when no Slack IDs', () => {
    const noSlackData: MergeConflictMessageData = {
      ...conflictData,
      affectedUserSlackIds: [],
    };
    const blocks = buildMergeConflictMessage(noSlackData);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join(' ');
    expect(allText).toContain('NabilW1995');
    expect(allText).not.toContain('<@');
  });
});
