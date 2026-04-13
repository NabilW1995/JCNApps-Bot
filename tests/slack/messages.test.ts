import { describe, it, expect } from 'vitest';
import {
  buildNewIssueMessage,
  buildMergeConflictMessage,
  buildPreviewReadyMessage,
  buildProductionDeployedMessage,
  buildDeployFailedMessage,
  buildTaskClaimedMessage,
  buildHotfixStartedMessage,
  formatDeployDurationLine,
} from '../../src/slack/messages.js';
import type {
  NewIssueMessageData,
  MergeConflictMessageData,
  PreviewReadyMessageData,
  ProductionDeployedMessageData,
  DeployFailedMessageData,
  TaskClaimedMessageData,
  HotfixMessageData,
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

  it('should include reporter name', () => {
    const blocks = buildNewIssueMessage(customerBugData);
    const allText = blocks
      .filter((b): b is { type: 'section'; text: { text: string; type: string } } => b.type === 'section')
      .map((b) => b.text.text)
      .join(' ');
    expect(allText).toContain('customer');
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
      expect(actionsBlock.elements[1].text.text).toBe('Create Prompt to Fix');
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

// ---------------------------------------------------------------------------
// Phase 5e: Task Claimed + Hotfix + dual deploy duration
// ---------------------------------------------------------------------------

function flattenSectionText(blocks: any[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'section' && b.text?.text) return b.text.text;
      if (b.type === 'context' && Array.isArray(b.elements)) {
        return b.elements.map((e: any) => e.text ?? '').join(' ');
      }
      return '';
    })
    .join('\n');
}

describe('buildTaskClaimedMessage', () => {
  const baseData: TaskClaimedMessageData = {
    title: 'Filter crash',
    issueNumber: 23,
    issueUrl: '/issues/23',
    repoName: 'PassCraft',
    claimedBy: 'NabilW1995',
    claimedBySlackId: 'U_NABIL',
    area: 'dashboard',
    files: ['src/dashboard/Filter.tsx', 'src/dashboard/util.ts'],
    startedAt: '09:34',
  };

  it('renders the title, issue number, and started time', () => {
    const text = flattenSectionText(buildTaskClaimedMessage(baseData));
    expect(text).toContain('#23');
    expect(text).toContain('Filter crash');
    expect(text).toContain('09:34');
  });

  it('uses a Slack mention when claimedBySlackId is set', () => {
    const text = flattenSectionText(buildTaskClaimedMessage(baseData));
    expect(text).toContain('<@U_NABIL>');
  });

  it('falls back to the GitHub login when no Slack id is known', () => {
    const text = flattenSectionText(
      buildTaskClaimedMessage({ ...baseData, claimedBySlackId: null })
    );
    expect(text).toContain('NabilW1995');
    expect(text).not.toContain('<@');
  });

  it('renders the file list when files are present', () => {
    const text = flattenSectionText(buildTaskClaimedMessage(baseData));
    expect(text).toContain('Filter.tsx');
    expect(text).toContain('util.ts');
  });

  it('omits the files section when files is empty', () => {
    const text = flattenSectionText(
      buildTaskClaimedMessage({ ...baseData, files: [] })
    );
    expect(text).not.toContain('Filter.tsx');
  });

  it('renders the area label when present', () => {
    const text = flattenSectionText(buildTaskClaimedMessage(baseData));
    expect(text).toContain('dashboard');
  });

  it('omits the area label when null', () => {
    const text = flattenSectionText(
      buildTaskClaimedMessage({ ...baseData, area: null })
    );
    expect(text).not.toContain('\u{1F3F7}');
  });
});

describe('buildHotfixStartedMessage', () => {
  const baseData: HotfixMessageData = {
    title: 'Production checkout broken',
    issueNumber: 99,
    issueUrl: '/issues/99',
    repoName: 'PassCraft',
    fixedBy: 'NabilW1995',
    fixedBySlackId: 'U_NABIL',
    relatedIssueNumber: null,
    relatedIssueTitle: null,
    files: [],
    startedAt: '14:02',
  };

  it('renders the issue number, title, and start time', () => {
    const text = flattenSectionText(buildHotfixStartedMessage(baseData));
    expect(text).toContain('#99');
    expect(text).toContain('Production checkout broken');
    expect(text).toContain('14:02');
  });

  it('renders a related issue when one is provided', () => {
    const text = flattenSectionText(
      buildHotfixStartedMessage({
        ...baseData,
        relatedIssueNumber: 50,
        relatedIssueTitle: 'Original payment bug',
      })
    );
    expect(text).toContain('#50');
    expect(text).toContain('Original payment bug');
  });

  it('omits the related-issue line when related fields are null', () => {
    const text = flattenSectionText(buildHotfixStartedMessage(baseData));
    expect(text).not.toMatch(/Related/);
  });

  it('renders the file list when files are present', () => {
    const text = flattenSectionText(
      buildHotfixStartedMessage({
        ...baseData,
        files: ['src/checkout/PaymentForm.tsx'],
      })
    );
    expect(text).toContain('PaymentForm.tsx');
  });
});

describe('formatDeployDurationLine', () => {
  it('returns an empty string when both inputs are null', () => {
    expect(formatDeployDurationLine(null, null)).toBe('');
  });

  it('returns just the deploy duration when work duration is null', () => {
    const out = formatDeployDurationLine('12min', null);
    expect(out).toContain('deployed in 12min');
  });

  it('returns just the work duration when deploy duration is null', () => {
    const out = formatDeployDurationLine(null, '4h 5min');
    expect(out).toContain('4h 5min from claim to deploy');
  });

  it('renders both side-by-side when both are present', () => {
    const out = formatDeployDurationLine('12min', '4h 5min');
    expect(out).toContain('12min build');
    expect(out).toContain('4h 5min work');
  });
});

describe('buildProductionDeployedMessage with workDuration', () => {
  const baseData: ProductionDeployedMessageData = {
    repoName: 'PassCraft',
    productionUrl: '/passcraft',
    deployedBy: 'NabilW1995',
    deployedBySlackId: 'U_NABIL',
    issueNumbers: [23],
    duration: null,
    commitMessages: [],
    commits: [],
    deployDuration: '12min',
    workDuration: '4h 5min',
  };

  it('renders both durations in the footer when both are set', () => {
    const text = flattenSectionText(buildProductionDeployedMessage(baseData));
    expect(text).toContain('12min build');
    expect(text).toContain('4h 5min work');
  });

  it('falls back to deployDuration only when workDuration is null', () => {
    const text = flattenSectionText(
      buildProductionDeployedMessage({ ...baseData, workDuration: null })
    );
    expect(text).toContain('deployed in 12min');
  });

  it('renders work duration only when deployDuration is null', () => {
    const text = flattenSectionText(
      buildProductionDeployedMessage({ ...baseData, deployDuration: null })
    );
    expect(text).toContain('from claim to deploy');
  });

  it('omits both durations cleanly when neither is set', () => {
    const text = flattenSectionText(
      buildProductionDeployedMessage({
        ...baseData,
        deployDuration: null,
        workDuration: null,
      })
    );
    expect(text).not.toContain('build');
    expect(text).not.toContain('from claim to deploy');
    expect(text).toContain('Live now');
  });
});
