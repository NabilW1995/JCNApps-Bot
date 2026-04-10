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
  activeWebhookUrl: string;
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

// ---------------------------------------------------------------------------
// Coolify Webhook Types
// ---------------------------------------------------------------------------

export interface CoolifyWebhookPayload {
  status?: string;
  preview_url?: string;
  url?: string;
  deployment_url?: string;
  pull_request_number?: number;
  pr_number?: number;
  branch?: string;
  commit_message?: string;
  commit_sha?: string;
  type?: string;
}

// ---------------------------------------------------------------------------
// Database Data Types
// ---------------------------------------------------------------------------

export interface UpsertIssueData {
  repoName: string;
  issueNumber: number;
  title: string;
  state: 'open' | 'closed';
  assigneeGithub: string | null;
  areaLabel: string | null;
  typeLabel: string | null;
  priorityLabel: string | null;
  sourceLabel: string | null;
  isHotfix: boolean;
  htmlUrl: string;
  createdAt: Date;
  closedAt: Date | null;
}

export interface DeployEventData {
  repoName: string;
  environment: string;
  status: string;
  branch: string | null;
  triggeredBy: string | null;
  issueNumbers: number[];
  startedAt: Date;
  completedAt: Date | null;
}

export interface WebhookLogData {
  source: 'github' | 'coolify';
  eventType: string;
  repoName: string | null;
  payloadSummary: string | null;
  slackChannel: string | null;
}

// ---------------------------------------------------------------------------
// Deploy Message Data Types
// ---------------------------------------------------------------------------

export interface PreviewReadyMessageData {
  repoName: string;
  previewUrl: string;
  branch: string;
  deployedBy: string;
  deployedBySlackId: string | null;
  issueNumbers: number[];
  commitMessage: string | null;
}

export interface ProductionDeployedMessageData {
  repoName: string;
  productionUrl: string;
  deployedBy: string;
  deployedBySlackId: string | null;
  issueNumbers: number[];
  duration: string | null;
}

export interface DeployFailedMessageData {
  repoName: string;
  branch: string;
  deployedBy: string;
  deployedBySlackId: string | null;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Phase 5 — Task Claimed + Hotfix Message Data Types
// ---------------------------------------------------------------------------

export interface TaskClaimedMessageData {
  title: string;
  issueNumber: number;
  issueUrl: string;
  repoName: string;
  claimedBy: string;
  claimedBySlackId: string | null;
  area: string | null;
  files: string[];
  startedAt: string; // Formatted time like "09:34"
}

export interface HotfixMessageData {
  title: string;
  issueNumber: number;
  issueUrl: string;
  repoName: string;
  fixedBy: string;
  fixedBySlackId: string | null;
  relatedIssueNumber: number | null;
  relatedIssueTitle: string | null;
  files: string[];
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Phase 4 — Live Tables + Canvas Dashboard Types
// ---------------------------------------------------------------------------

export interface TeamMemberStatus {
  name: string;
  slackUserId: string;
  status: string;
  currentRepo: string | null;
  activeIssues: string; // e.g. "#52, #78"
  statusSince: string | null; // formatted time
}

export interface AppSummary {
  repoName: string;
  displayName: string;
  total: number;
  critical: number;
  activeMembers: Array<{ name: string; issues: string }>;
}

export interface CanvasMemberData {
  name: string;
  status: string;
  activeIssues: string;
  files: string[];
  previewUrl: string | null;
  statusSince: string | null;
  completedToday: string[];
}
