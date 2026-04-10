import type { IssueEvent, PullRequestEvent } from '../../src/types.js';

/**
 * Realistic GitHub webhook payloads for testing.
 * Based on actual GitHub webhook structure.
 */

const mockUser = {
  login: 'customer-jane',
  id: 12345,
  avatar_url: 'https://github.com/avatars/12345',
  html_url: 'https://github.com/customer-jane',
};

const mockAssignee = {
  login: 'NabilW1995',
  id: 99999,
  avatar_url: 'https://github.com/avatars/99999',
  html_url: 'https://github.com/NabilW1995',
};

const mockRepo = {
  id: 1,
  name: 'PassCraft',
  full_name: 'JCNApps/PassCraft',
  html_url: 'https://github.com/JCNApps/PassCraft',
  private: true,
  owner: {
    login: 'JCNApps',
    id: 100,
    avatar_url: 'https://github.com/avatars/100',
    html_url: 'https://github.com/JCNApps',
  },
};

// A customer-reported bug with area/dashboard label and a screenshot
export const issueOpenedPayload: IssueEvent = {
  action: 'opened',
  issue: {
    number: 42,
    title: 'Dashboard shows wrong revenue numbers',
    body: 'The monthly revenue on the dashboard is showing last month\'s data.\n\nScreenshot:\n![dashboard-bug](https://user-images.githubusercontent.com/12345/screenshot.png)',
    html_url: 'https://github.com/JCNApps/PassCraft/issues/42',
    state: 'open',
    user: mockUser,
    assignee: null,
    assignees: [],
    labels: [
      { id: 1, name: 'bug', color: 'd73a4a', description: 'Something isn\'t working' },
      { id: 2, name: 'source/customer', color: 'ff0000', description: 'Reported by a customer' },
      { id: 3, name: 'area/dashboard', color: '0075ca', description: 'Dashboard related' },
      { id: 4, name: 'priority/high', color: 'ff6600', description: 'High priority' },
    ],
    created_at: '2026-04-10T09:00:00Z',
    updated_at: '2026-04-10T09:00:00Z',
    closed_at: null,
  },
  repository: mockRepo,
  sender: mockUser,
};

// Issue assigned to a team member
export const issueAssignedPayload: IssueEvent = {
  action: 'assigned',
  issue: {
    ...issueOpenedPayload.issue,
    assignee: mockAssignee,
    assignees: [mockAssignee],
  },
  assignee: mockAssignee,
  repository: mockRepo,
  sender: mockAssignee,
};

// Issue closed
export const issueClosedPayload: IssueEvent = {
  action: 'closed',
  issue: {
    ...issueOpenedPayload.issue,
    state: 'closed',
    closed_at: '2026-04-10T14:30:00Z',
    assignee: mockAssignee,
    assignees: [mockAssignee],
  },
  repository: mockRepo,
  sender: mockAssignee,
};

// An internal feature request (no customer source label)
export const issueOpenedInternalPayload: IssueEvent = {
  action: 'opened',
  issue: {
    number: 43,
    title: 'Add dark mode support',
    body: 'We should add dark mode to improve the UX for users who prefer it.',
    html_url: 'https://github.com/JCNApps/PassCraft/issues/43',
    state: 'open',
    user: mockAssignee,
    assignee: null,
    assignees: [],
    labels: [
      { id: 5, name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
      { id: 6, name: 'source/internal', color: '0000ff', description: 'Internal request' },
      { id: 7, name: 'area/settings', color: '0075ca', description: 'Settings page' },
    ],
    created_at: '2026-04-10T10:00:00Z',
    updated_at: '2026-04-10T10:00:00Z',
    closed_at: null,
  },
  repository: mockRepo,
  sender: mockAssignee,
};

// Pull request with merge conflict
export const pullRequestConflictPayload: PullRequestEvent = {
  action: 'synchronize',
  pull_request: {
    number: 15,
    title: 'feat: add user settings page',
    body: 'Adds a new settings page where users can configure their preferences.',
    html_url: 'https://github.com/JCNApps/PassCraft/pull/15',
    state: 'open',
    merged: false,
    mergeable: false,
    mergeable_state: 'dirty',
    user: mockAssignee,
    head: {
      ref: 'feature/user-settings',
      sha: 'abc123',
      label: 'JCNApps:feature/user-settings',
    },
    base: {
      ref: 'main',
      sha: 'def456',
      label: 'JCNApps:main',
    },
    assignee: mockAssignee,
    assignees: [mockAssignee],
    labels: [],
    created_at: '2026-04-09T16:00:00Z',
    updated_at: '2026-04-10T11:00:00Z',
    merged_at: null,
  },
  repository: mockRepo,
  sender: mockAssignee,
};
