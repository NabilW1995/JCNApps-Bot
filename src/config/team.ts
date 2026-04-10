import type { TeamMember } from '../types.js';

/**
 * Team member mapping — GitHub usernames to Slack user IDs.
 *
 * For MVP this is hardcoded. Will move to a database table later
 * so team changes don't require a redeploy.
 */
const TEAM_MEMBERS: TeamMember[] = [
  {
    name: 'Nabil',
    githubUsername: 'NabilW1995',
    slackUserId: 'U_NABIL', // Replace with real Slack user ID
  },
];

/**
 * Find a team member by their GitHub username.
 * Returns null if the user is not in the team roster.
 */
export function getTeamMemberByGitHub(username: string): TeamMember | null {
  return (
    TEAM_MEMBERS.find(
      (m) => m.githubUsername.toLowerCase() === username.toLowerCase()
    ) ?? null
  );
}
