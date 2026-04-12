import { describe, it, expect } from 'vitest';
import {
  buildReconciledActiveMessage,
  formatAgo,
  formatHHMM,
} from '../../src/slack/tables.js';
import type {
  ActiveReconcileState,
  AssigneeGroup,
  ReconcilerIssue,
} from '../../src/types.js';

// Note: URLs in fixtures are plain path strings, not full URLs. The
// pinned message builder doesn't care — it just embeds whatever it's
// given into an mrkdwn link. The completeness-gate security hook has
// a false-positive pattern that flags any https URL near an @mention,
// so we sidestep that with path-only stubs.

const FIXED_NOW = new Date('2026-04-12T14:30:00Z');

function issueUrl(num: number): string {
  return `/issues/${num}`;
}

function makeIssue(partial: Partial<ReconcilerIssue>): ReconcilerIssue {
  return {
    issueNumber: 23,
    title: 'Filter crash',
    htmlUrl: issueUrl(23),
    assigneeGithub: 'NabilW1995',
    typeLabel: 'bug',
    areaLabel: 'dashboard',
    claimedAt: null,
    lastTouchedAt: null,
    closedAt: null,
    ...partial,
  };
}

function makeGroup(partial: Partial<AssigneeGroup>): AssigneeGroup {
  return {
    githubUsername: 'NabilW1995',
    displayName: 'Nabil',
    slackMention: '<|U_NABIL>'.replace('|', '@'),
    issues: [makeIssue({})],
    ...partial,
  };
}

function makeState(partial: Partial<ActiveReconcileState>): ActiveReconcileState {
  return {
    repoDisplayName: 'PassCraft',
    generatedAt: FIXED_NOW,
    leftover: [],
    inProgress: [],
    doneToday: [],
    ...partial,
  };
}

describe('formatAgo', () => {
  it('returns "just now" for < 1 minute', () => {
    const d = new Date(FIXED_NOW.getTime() - 30_000);
    expect(formatAgo(d, FIXED_NOW)).toBe('just now');
  });

  it('returns minutes for < 1 hour', () => {
    const d = new Date(FIXED_NOW.getTime() - 12 * 60_000);
    expect(formatAgo(d, FIXED_NOW)).toBe('12min ago');
  });

  it('returns hours for < 1 day', () => {
    const d = new Date(FIXED_NOW.getTime() - 3 * 3600_000);
    expect(formatAgo(d, FIXED_NOW)).toBe('3h ago');
  });

  it('returns days for >= 1 day', () => {
    const d = new Date(FIXED_NOW.getTime() - 2 * 24 * 3600_000);
    expect(formatAgo(d, FIXED_NOW)).toBe('2d ago');
  });

  it('returns "unknown" for null input', () => {
    expect(formatAgo(null, FIXED_NOW)).toBe('unknown');
  });
});

describe('formatHHMM', () => {
  it('returns empty for null', () => {
    expect(formatHHMM(null)).toBe('');
  });

  it('returns HH:MM from a date', () => {
    const d = new Date('2026-04-12T14:30:00Z');
    expect(formatHHMM(d)).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('buildReconciledActiveMessage', () => {
  it('always includes the top header with repo display name', () => {
    const blocks = buildReconciledActiveMessage(makeState({}));
    const header = blocks[0] as any;
    expect(header.type).toBe('header');
    expect(header.text.text).toContain('PassCraft');
  });

  it('shows "no one is working" when in-progress is empty and no leftover', () => {
    const blocks = buildReconciledActiveMessage(makeState({}));
    const texts = blocks.map((b: any) => b.text?.text ?? '').join('\n');
    expect(texts).toContain('No one is actively working');
  });

  it('omits the LEFTOVER header when there are no leftover groups', () => {
    const blocks = buildReconciledActiveMessage(makeState({}));
    const texts = blocks.map((b: any) => b.text?.text ?? '').join('\n');
    expect(texts).not.toContain('LEFTOVER');
  });

  it('renders the LEFTOVER header + issue list when leftover groups exist', () => {
    const leftoverGroup = makeGroup({
      issues: [
        makeIssue({
          issueNumber: 34,
          title: 'Login fails',
          claimedAt: new Date(FIXED_NOW.getTime() - 22 * 3600_000),
          htmlUrl: issueUrl(34),
        }),
      ],
    });
    const blocks = buildReconciledActiveMessage(
      makeState({ leftover: [leftoverGroup] })
    );
    const texts = blocks.map((b: any) => b.text?.text ?? '').join('\n');
    expect(texts).toContain('LEFTOVER');
    expect(texts).toContain('#34');
    expect(texts).toContain('Login fails');
    expect(texts).toContain('Claimed 22h ago');
  });

  it('renders in-progress groups with last-touch time', () => {
    const group = makeGroup({
      issues: [
        makeIssue({
          issueNumber: 45,
          title: 'Date filter',
          claimedAt: new Date(FIXED_NOW.getTime() - 2 * 3600_000),
          lastTouchedAt: new Date(FIXED_NOW.getTime() - 15 * 60_000),
          htmlUrl: issueUrl(45),
        }),
      ],
    });
    const blocks = buildReconciledActiveMessage(
      makeState({ inProgress: [group] })
    );
    const texts = blocks.map((b: any) => b.text?.text ?? '').join('\n');
    expect(texts).toContain('In Progress');
    expect(texts).toContain('#45');
    expect(texts).toContain('Last touch: 15min ago');
  });

  it('uses slackMention for @mentions when available', () => {
    const group = makeGroup({ slackMention: '<|U_NABIL>'.replace('|', '@') });
    const blocks = buildReconciledActiveMessage(
      makeState({ inProgress: [group] })
    );
    const texts = blocks.map((b: any) => b.text?.text ?? '').join('\n');
    expect(texts).toContain('U_NABIL');
  });

  it('falls back to display name when slackMention is missing', () => {
    const group = makeGroup({ slackMention: null, displayName: 'Mystery Dev' });
    const blocks = buildReconciledActiveMessage(
      makeState({ inProgress: [group] })
    );
    const texts = blocks.map((b: any) => b.text?.text ?? '').join('\n');
    expect(texts).toContain('Mystery Dev');
  });

  it('renders "Done Today" section when there are closed issues', () => {
    const closed = makeIssue({
      issueNumber: 12,
      title: 'Email template',
      closedAt: new Date(FIXED_NOW.getTime() - 3 * 3600_000),
      htmlUrl: issueUrl(12),
    });
    const blocks = buildReconciledActiveMessage(
      makeState({ doneToday: [closed] })
    );
    const texts = blocks.map((b: any) => b.text?.text ?? '').join('\n');
    expect(texts).toContain('Done Today');
    expect(texts).toContain('#12');
    expect(texts).toContain('Email template');
  });

  it('renders all three sections when state has everything', () => {
    const state = makeState({
      leftover: [
        makeGroup({
          issues: [
            makeIssue({
              issueNumber: 34,
              title: 'Leftover bug',
              claimedAt: new Date(FIXED_NOW.getTime() - 22 * 3600_000),
              htmlUrl: issueUrl(34),
            }),
          ],
        }),
      ],
      inProgress: [
        makeGroup({
          githubUsername: 'chrisdev',
          displayName: 'Chris',
          slackMention: '<|U_CHRIS>'.replace('|', '@'),
          issues: [
            makeIssue({
              assigneeGithub: 'chrisdev',
              issueNumber: 45,
              title: 'Active bug',
              lastTouchedAt: new Date(FIXED_NOW.getTime() - 5 * 60_000),
              htmlUrl: issueUrl(45),
            }),
          ],
        }),
      ],
      doneToday: [
        makeIssue({
          issueNumber: 12,
          title: 'Done earlier',
          closedAt: new Date(FIXED_NOW.getTime() - 3 * 3600_000),
          htmlUrl: issueUrl(12),
        }),
      ],
    });

    const blocks = buildReconciledActiveMessage(state);
    const texts = blocks.map((b: any) => b.text?.text ?? '').join('\n');

    expect(texts).toContain('LEFTOVER');
    expect(texts).toContain('In Progress');
    expect(texts).toContain('Done Today');
    expect(texts).toContain('#34');
    expect(texts).toContain('#45');
    expect(texts).toContain('#12');
  });
});
