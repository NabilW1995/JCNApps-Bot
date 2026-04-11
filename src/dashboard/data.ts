import type { Context } from 'hono';
import { getDb } from '../db/client.js';
import {
  getOpenIssuesByArea,
  getAllOpenIssuesCounts,
  getAllTeamMembers,
} from '../db/queries.js';
import { getChannelConfig } from '../config/channels.js';

// ---------------------------------------------------------------------------
// Dashboard Data Types
// ---------------------------------------------------------------------------

export interface DashboardIssue {
  issueNumber: number;
  title: string;
  priority: string | null;
  source: string | null;
  type: string | null;
  assignee: string | null;
  htmlUrl: string;
}

export interface DashboardApp {
  repoName: string;
  displayName: string;
  total: number;
  critical: number;
}

export interface DashboardTeamMember {
  name: string;
  status: string;
  currentRepo: string | null;
  statusSince: string | null;
}

export interface DashboardData {
  team: DashboardTeamMember[];
  apps: DashboardApp[];
  issues: Record<string, Record<string, DashboardIssue[]>>;
  lastUpdated: string;
}

// ---------------------------------------------------------------------------
// API Handler
// ---------------------------------------------------------------------------

/**
 * Serve aggregated dashboard data as JSON.
 *
 * Collects team members, per-app issue counts, and issues grouped
 * by area for every configured repo. The frontend polls this endpoint
 * to render the live dashboard.
 */
export async function getDashboardData(c: Context): Promise<Response> {
  try {
    const db = getDb();

    const [members, counts] = await Promise.all([
      getAllTeamMembers(db),
      getAllOpenIssuesCounts(db),
    ]);

    // Build team member list
    const team: DashboardTeamMember[] = members.map((m) => ({
      name: m.name,
      status: m.status ?? 'idle',
      currentRepo: m.currentRepo,
      statusSince: m.statusSince ? m.statusSince.toISOString() : null,
    }));

    // Build app list with display names from channel config
    const apps: DashboardApp[] = counts.map((row) => {
      const config = getChannelConfig(row.repoName);
      return {
        repoName: row.repoName,
        displayName: config?.displayName ?? row.repoName,
        total: row.total,
        critical: row.critical,
      };
    });

    // Fetch issues grouped by area for each repo that has open issues
    const issuesByRepo: Record<string, Record<string, DashboardIssue[]>> = {};

    for (const app of apps) {
      const areaMap = await getOpenIssuesByArea(db, app.repoName);
      const serialized: Record<string, DashboardIssue[]> = {};

      for (const [area, areaIssues] of areaMap) {
        serialized[area] = areaIssues.map((issue) => ({
          issueNumber: issue.issueNumber,
          title: issue.title,
          priority: issue.priorityLabel,
          source: issue.sourceLabel,
          type: issue.typeLabel,
          assignee: issue.assigneeGithub,
          htmlUrl: issue.htmlUrl,
        }));
      }

      issuesByRepo[app.repoName] = serialized;
    }

    const data: DashboardData = {
      team,
      apps,
      issues: issuesByRepo,
      lastUpdated: new Date().toISOString(),
    };

    return c.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Dashboard data error: ${message}`);
    return c.json({ error: 'Failed to load dashboard data' }, 500);
  }
}
