// ---------------------------------------------------------------------------
// GitHub Webhook Payload Types
// ---------------------------------------------------------------------------

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
}

export interface GitHubLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  user: GitHubUser;
  assignee: GitHubUser | null;
  assignees: GitHubUser[];
  labels: GitHubLabel[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  user: GitHubUser;
  head: {
    ref: string;
    sha: string;
    label: string;
  };
  base: {
    ref: string;
    sha: string;
    label: string;
  };
  assignee: GitHubUser | null;
  assignees: GitHubUser[];
  labels: GitHubLabel[];
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  owner: GitHubUser;
}

export interface IssueEvent {
  action: 'opened' | 'closed' | 'assigned' | 'unassigned' | 'labeled' | 'unlabeled' | 'edited';
  issue: GitHubIssue;
  repository: GitHubRepository;
  sender: GitHubUser;
  assignee?: GitHubUser;
}

export interface PullRequestEvent {
  action: 'opened' | 'closed' | 'synchronize' | 'reopened' | 'edited' | 'labeled';
  pull_request: GitHubPullRequest;
  repository: GitHubRepository;
  sender: GitHubUser;
}

export interface PushEvent {
  ref: string;
  before: string;
  after: string;
  repository: GitHubRepository;
  sender: GitHubUser;
  commits: Array<{
    id: string;
    message: string;
    author: { name: string; email: string; username: string };
    url: string;
    added: string[];
    removed: string[];
    modified: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Slack Block Kit Types
// ---------------------------------------------------------------------------

export interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

export interface SlackSectionBlock {
  type: 'section';
  text: SlackTextObject;
  accessory?: SlackButtonElement;
  fields?: SlackTextObject[];
}

export interface SlackContextBlock {
  type: 'context';
  elements: SlackTextObject[];
}

export interface SlackDividerBlock {
  type: 'divider';
}

export interface SlackActionsBlock {
  type: 'actions';
  elements: SlackButtonElement[];
}

export interface SlackButtonElement {
  type: 'button';
  text: SlackTextObject;
  url?: string;
  action_id?: string;
  style?: 'primary' | 'danger';
}

export type SlackBlock =
  | SlackSectionBlock
  | SlackContextBlock
  | SlackDividerBlock
  | SlackActionsBlock;

// ---------------------------------------------------------------------------
// Config Types
// ---------------------------------------------------------------------------

export interface ChannelConfig {
  displayName: string;
  bugsWebhookUrl: string;
  activeChannelId: string;
  previewWebhookUrl: string;
  deployWebhookUrl: string;
}

export interface TeamMember {
  name: string;
  githubUsername: string;
  slackUserId: string;
}

// ---------------------------------------------------------------------------
// Bot Internal Types
// ---------------------------------------------------------------------------

export interface WebhookResponse {
  success: boolean;
  message: string;
}

export interface NewIssueMessageData {
  title: string;
  issueUrl: string;
  issueNumber: number;
  repoName: string;
  reportedBy: string;
  labels: string[];
  body: string | null;
  isCustomerSource: boolean;
  area: string | null;
  priority: string | null;
  screenshotCount: number;
}

export interface MergeConflictMessageData {
  prTitle: string;
  prUrl: string;
  prNumber: number;
  repoName: string;
  headBranch: string;
  baseBranch: string;
  author: string;
  affectedUserSlackIds: string[];
}
