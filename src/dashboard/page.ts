import type { Context } from 'hono';

/**
 * Serve the self-contained dashboard HTML page.
 *
 * The page uses inline CSS and JS — no external dependencies besides
 * Google Fonts. It fetches live data from /api/dashboard-data on load
 * and auto-refreshes every 30 seconds.
 */
export async function serveDashboard(c: Context): Promise<Response> {
  return c.html(DASHBOARD_HTML);
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>JCN Apps Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    /* ------------------------------------------------------------------ */
    /* Reset & Base                                                        */
    /* ------------------------------------------------------------------ */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      min-height: 100vh;
      line-height: 1.6;
    }

    /* ------------------------------------------------------------------ */
    /* Layout                                                              */
    /* ------------------------------------------------------------------ */
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }

    /* ------------------------------------------------------------------ */
    /* Header                                                              */
    /* ------------------------------------------------------------------ */
    .header {
      text-align: center;
      margin-bottom: 2.5rem;
    }

    .header h1 {
      font-size: 2.5rem;
      font-weight: 700;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6, #ec4899);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.25rem;
    }

    .header .subtitle {
      font-size: 1.1rem;
      color: #94a3b8;
      font-weight: 500;
    }

    .header .last-updated {
      font-size: 0.8rem;
      color: #64748b;
      margin-top: 0.5rem;
    }

    /* ------------------------------------------------------------------ */
    /* Section Titles                                                      */
    /* ------------------------------------------------------------------ */
    .section-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: #e2e8f0;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .section-title .icon {
      font-size: 1.1rem;
    }

    /* ------------------------------------------------------------------ */
    /* Cards                                                               */
    /* ------------------------------------------------------------------ */
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 1.25rem;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
    }

    /* ------------------------------------------------------------------ */
    /* Team Cards                                                          */
    /* ------------------------------------------------------------------ */
    .team-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 1rem;
      margin-bottom: 2.5rem;
    }

    .team-card {
      position: relative;
      overflow: hidden;
    }

    .team-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #3b82f6, #8b5cf6);
    }

    .team-card .member-name {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }

    .team-card .member-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: #94a3b8;
      margin-bottom: 0.25rem;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .status-dot.active {
      background: #22c55e;
      box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
    }

    .status-dot.idle { background: #64748b; }

    .team-card .member-focus {
      font-size: 0.8rem;
      color: #64748b;
      margin-top: 0.25rem;
    }

    /* ------------------------------------------------------------------ */
    /* Apps Grid                                                           */
    /* ------------------------------------------------------------------ */
    .apps-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 1rem;
      margin-bottom: 2.5rem;
    }

    .app-card .app-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 0.75rem;
    }

    .app-card .app-name {
      font-size: 1.1rem;
      font-weight: 600;
    }

    .app-card .issue-count {
      font-size: 1.5rem;
      font-weight: 700;
      color: #e2e8f0;
    }

    .app-card .issue-label {
      font-size: 0.75rem;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .critical-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      margin-top: 0.5rem;
    }

    .critical-badge.none {
      background: rgba(34, 197, 94, 0.1);
      color: #22c55e;
    }

    /* ------------------------------------------------------------------ */
    /* Issues Section                                                      */
    /* ------------------------------------------------------------------ */
    .issues-section { margin-bottom: 2.5rem; }

    .repo-group { margin-bottom: 1.5rem; }

    .repo-group-title {
      font-size: 1rem;
      font-weight: 600;
      color: #cbd5e1;
      margin-bottom: 0.75rem;
      padding-left: 0.25rem;
    }

    .area-group {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      margin-bottom: 0.75rem;
      overflow: hidden;
    }

    .area-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s ease;
    }

    .area-header:hover { background: rgba(255, 255, 255, 0.03); }

    .area-header-left {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-weight: 600;
      font-size: 0.95rem;
    }

    .area-count {
      font-size: 0.75rem;
      color: #94a3b8;
      background: rgba(148, 163, 184, 0.15);
      padding: 0.1rem 0.5rem;
      border-radius: 10px;
    }

    .area-chevron {
      font-size: 0.8rem;
      color: #64748b;
      transition: transform 0.2s ease;
    }

    .area-group.open .area-chevron { transform: rotate(90deg); }

    .area-body {
      display: none;
      border-top: 1px solid #334155;
    }

    .area-group.open .area-body { display: block; }

    /* ------------------------------------------------------------------ */
    /* Issue Rows                                                          */
    /* ------------------------------------------------------------------ */
    .issue-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.6rem 1rem;
      border-bottom: 1px solid rgba(51, 65, 85, 0.5);
      font-size: 0.85rem;
      transition: background 0.1s ease;
    }

    .issue-row:last-child { border-bottom: none; }
    .issue-row:hover { background: rgba(255, 255, 255, 0.02); }

    .issue-number {
      color: #64748b;
      font-weight: 500;
      min-width: 3rem;
      flex-shrink: 0;
    }

    .issue-number a {
      color: #64748b;
      text-decoration: none;
    }

    .issue-number a:hover {
      color: #93c5fd;
      text-decoration: underline;
    }

    .issue-title {
      flex: 1;
      color: #e2e8f0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 0.15rem 0.5rem;
      border-radius: 6px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: capitalize;
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* Priority badges */
    .badge.priority-critical { background: rgba(239, 68, 68, 0.2); color: #fca5a5; }
    .badge.priority-high     { background: rgba(245, 158, 11, 0.2); color: #fcd34d; }
    .badge.priority-medium   { background: rgba(234, 179, 8, 0.15); color: #fde047; }
    .badge.priority-low      { background: rgba(34, 197, 94, 0.15); color: #86efac; }

    /* Source badges */
    .badge.source-customer  { background: rgba(239, 68, 68, 0.2); color: #fca5a5; }
    .badge.source-internal  { background: rgba(59, 130, 246, 0.2); color: #93c5fd; }

    /* Type badges */
    .badge.type-bug     { background: rgba(239, 68, 68, 0.12); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.2); }
    .badge.type-feature { background: rgba(139, 92, 246, 0.12); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.2); }
    .badge.type-default { background: rgba(148, 163, 184, 0.12); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.2); }

    /* ------------------------------------------------------------------ */
    /* Footer                                                              */
    /* ------------------------------------------------------------------ */
    .footer {
      text-align: center;
      padding: 2rem 0 1rem;
      border-top: 1px solid #1e293b;
    }

    .footer-links {
      display: flex;
      justify-content: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .footer-link {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.5rem 1rem;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #94a3b8;
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 500;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }

    .footer-link:hover {
      background: #334155;
      color: #f8fafc;
      border-color: #475569;
    }

    .footer-powered {
      margin-top: 1rem;
      font-size: 0.7rem;
      color: #475569;
    }

    /* ------------------------------------------------------------------ */
    /* Loading & Error States                                              */
    /* ------------------------------------------------------------------ */
    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 60vh;
      gap: 1rem;
    }

    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #334155;
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .loading-text {
      color: #64748b;
      font-size: 0.9rem;
    }

    .error-state {
      text-align: center;
      padding: 3rem;
      color: #ef4444;
    }

    /* ------------------------------------------------------------------ */
    /* Fade-in Animation                                                   */
    /* ------------------------------------------------------------------ */
    .fade-in {
      animation: fadeIn 0.4s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* Stagger children */
    .stagger > * {
      animation: fadeIn 0.4s ease-out both;
    }

    .stagger > *:nth-child(1) { animation-delay: 0.05s; }
    .stagger > *:nth-child(2) { animation-delay: 0.1s; }
    .stagger > *:nth-child(3) { animation-delay: 0.15s; }
    .stagger > *:nth-child(4) { animation-delay: 0.2s; }
    .stagger > *:nth-child(5) { animation-delay: 0.25s; }
    .stagger > *:nth-child(6) { animation-delay: 0.3s; }

    /* ------------------------------------------------------------------ */
    /* Empty State                                                         */
    /* ------------------------------------------------------------------ */
    .empty-state {
      text-align: center;
      padding: 2rem;
      color: #64748b;
      font-size: 0.9rem;
    }

    /* ------------------------------------------------------------------ */
    /* Responsive                                                          */
    /* ------------------------------------------------------------------ */
    @media (max-width: 640px) {
      .container { padding: 1rem; }

      .header h1 { font-size: 1.75rem; }

      .team-grid,
      .apps-grid {
        grid-template-columns: 1fr;
      }

      .issue-row {
        flex-wrap: wrap;
        gap: 0.4rem;
      }

      .issue-title {
        width: 100%;
        order: -1;
        white-space: normal;
      }
    }
  </style>
</head>
<body>
  <div class="container" id="app">
    <div class="loading">
      <div class="spinner"></div>
      <div class="loading-text">Loading dashboard...</div>
    </div>
  </div>

  <script>
    // ------------------------------------------------------------------ //
    // Dashboard Client                                                     //
    // ------------------------------------------------------------------ //

    const REFRESH_INTERVAL_MS = 30000;
    let refreshTimer = null;

    async function fetchData() {
      const response = await fetch('/api/dashboard-data');
      if (!response.ok) throw new Error('Failed to fetch dashboard data');
      return response.json();
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatTime(isoString) {
      if (!isoString) return '';
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatTimestamp(isoString) {
      const date = new Date(isoString);
      return date.toLocaleDateString([], {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    }

    // ------------------------------------------------------------------ //
    // Area Colors                                                          //
    // ------------------------------------------------------------------ //

    const AREA_COLORS = {
      dashboard: '#3b82f6',
      settings: '#8b5cf6',
      onboarding: '#ec4899',
      profile: '#06b6d4',
      api: '#f59e0b',
      payments: '#22c55e',
      admin: '#ef4444',
      'landing-page': '#14b8a6',
      integrations: '#6366f1',
      navigation: '#a855f7',
      auth: '#f97316',
      search: '#0ea5e9',
      editor: '#84cc16',
      templates: '#e879f9',
      ui: '#2dd4bf',
      wallet: '#fbbf24',
      unassigned: '#64748b',
    };

    function getAreaColor(area) {
      return AREA_COLORS[area.toLowerCase()] || '#64748b';
    }

    // ------------------------------------------------------------------ //
    // Renderers                                                            //
    // ------------------------------------------------------------------ //

    function renderTeamCards(team) {
      if (!team || team.length === 0) {
        return '<div class="empty-state">No team members configured</div>';
      }

      return team.map(function(member) {
        var isActive = member.status === 'active';
        var dotClass = isActive ? 'active' : 'idle';
        var statusText = isActive ? 'Active' : 'Idle';
        var focus = isActive && member.currentRepo
          ? 'Working on ' + escapeHtml(member.currentRepo)
          : 'No active tasks';
        var since = member.statusSince
          ? ' since ' + formatTime(member.statusSince)
          : '';

        return '<div class="card team-card">' +
          '<div class="member-name">' + escapeHtml(member.name) + '</div>' +
          '<div class="member-status">' +
            '<span class="status-dot ' + dotClass + '"></span>' +
            '<span>' + statusText + since + '</span>' +
          '</div>' +
          '<div class="member-focus">' + focus + '</div>' +
        '</div>';
      }).join('');
    }

    function renderAppCards(apps) {
      if (!apps || apps.length === 0) {
        return '<div class="empty-state">No apps tracked yet</div>';
      }

      return apps.map(function(app) {
        var criticalClass = app.critical > 0 ? '' : ' none';
        var criticalText = app.critical > 0
          ? app.critical + ' critical'
          : '0 critical';

        return '<div class="card app-card">' +
          '<div class="app-header">' +
            '<div class="app-name">' + escapeHtml(app.displayName) + '</div>' +
          '</div>' +
          '<div class="issue-count">' + app.total + '</div>' +
          '<div class="issue-label">Open Issues</div>' +
          '<div class="critical-badge' + criticalClass + '">' + criticalText + '</div>' +
        '</div>';
      }).join('');
    }

    function renderIssuesByRepo(apps, issues) {
      if (!apps || apps.length === 0 || !issues) {
        return '<div class="empty-state">No open issues</div>';
      }

      var html = '';

      for (var i = 0; i < apps.length; i++) {
        var app = apps[i];
        var repoIssues = issues[app.repoName];
        if (!repoIssues) continue;

        var areas = Object.keys(repoIssues);
        if (areas.length === 0) continue;

        html += '<div class="repo-group">';
        html += '<div class="repo-group-title">' + escapeHtml(app.displayName) + '</div>';

        for (var j = 0; j < areas.length; j++) {
          var area = areas[j];
          var areaIssues = repoIssues[area];
          var color = getAreaColor(area);
          var areaTitle = area.charAt(0).toUpperCase() + area.slice(1);
          // Start all areas expanded
          var openClass = ' open';

          html += '<div class="area-group' + openClass + '">';
          html += '<div class="area-header" onclick="toggleArea(this)" ' +
            'style="border-left: 3px solid ' + color + ';">' +
            '<div class="area-header-left">' +
              '<span>' + escapeHtml(areaTitle) + '</span>' +
              '<span class="area-count">' + areaIssues.length + '</span>' +
            '</div>' +
            '<span class="area-chevron">&#9654;</span>' +
          '</div>';
          html += '<div class="area-body">';

          for (var k = 0; k < areaIssues.length; k++) {
            html += renderIssueRow(areaIssues[k]);
          }

          html += '</div></div>';
        }

        html += '</div>';
      }

      return html || '<div class="empty-state">No open issues</div>';
    }

    function renderIssueRow(issue) {
      var priority = issue.priority || 'medium';
      var priorityClass = 'badge priority-' + priority;

      var sourceLabel = '';
      var sourceClass = '';
      if (issue.source === 'customer' || issue.source === 'user-report') {
        sourceLabel = 'Customer';
        sourceClass = 'badge source-customer';
      } else {
        sourceLabel = 'Internal';
        sourceClass = 'badge source-internal';
      }

      var typeLabel = issue.type || '';
      var typeClass = 'badge type-default';
      if (issue.type === 'bug') typeClass = 'badge type-bug';
      else if (issue.type === 'feature') typeClass = 'badge type-feature';

      return '<div class="issue-row">' +
        '<span class="issue-number"><a href="' + escapeHtml(issue.htmlUrl) + '" target="_blank" rel="noopener">#' + issue.issueNumber + '</a></span>' +
        '<span class="issue-title">' + escapeHtml(issue.title) + '</span>' +
        '<span class="' + priorityClass + '">' + priority + '</span>' +
        '<span class="' + sourceClass + '">' + sourceLabel + '</span>' +
        (typeLabel ? '<span class="' + typeClass + '">' + escapeHtml(typeLabel) + '</span>' : '') +
      '</div>';
    }

    // ------------------------------------------------------------------ //
    // Area Toggle                                                          //
    // ------------------------------------------------------------------ //

    function toggleArea(headerEl) {
      var group = headerEl.parentElement;
      group.classList.toggle('open');
    }

    // ------------------------------------------------------------------ //
    // Main Render                                                          //
    // ------------------------------------------------------------------ //

    function render(data) {
      var container = document.getElementById('app');

      container.innerHTML =
        '<div class="fade-in">' +
          '<header class="header">' +
            '<h1>JCN Apps</h1>' +
            '<div class="subtitle">Team Dashboard</div>' +
            '<div class="last-updated">Last updated: ' + formatTimestamp(data.lastUpdated) + '</div>' +
          '</header>' +

          '<div class="section-title"><span class="icon">&#128101;</span> Team</div>' +
          '<div class="team-grid stagger">' + renderTeamCards(data.team) + '</div>' +

          '<div class="section-title"><span class="icon">&#128241;</span> Apps</div>' +
          '<div class="apps-grid stagger">' + renderAppCards(data.apps) + '</div>' +

          '<div class="section-title"><span class="icon">&#128196;</span> Open Issues</div>' +
          '<div class="issues-section">' + renderIssuesByRepo(data.apps, data.issues) + '</div>' +

          '<footer class="footer">' +
            '<div class="footer-links">' +
              '<a class="footer-link" href="https://github.com/JCNApps" target="_blank" rel="noopener">' +
                '&#128736; GitHub' +
              '</a>' +
            '</div>' +
            '<div class="footer-powered">Powered by JCNApps-Bot</div>' +
          '</footer>' +
        '</div>';
    }

    function renderError(message) {
      var container = document.getElementById('app');
      container.innerHTML =
        '<div class="error-state">' +
          '<p>Failed to load dashboard</p>' +
          '<p style="font-size:0.8rem;color:#94a3b8;margin-top:0.5rem;">' + escapeHtml(message) + '</p>' +
        '</div>';
    }

    // ------------------------------------------------------------------ //
    // Init & Refresh Loop                                                  //
    // ------------------------------------------------------------------ //

    async function loadDashboard() {
      try {
        var data = await fetchData();
        render(data);
      } catch (err) {
        renderError(err.message || 'Unknown error');
      }
    }

    // Initial load
    loadDashboard();

    // Auto-refresh every 30 seconds
    refreshTimer = setInterval(loadDashboard, REFRESH_INTERVAL_MS);
  </script>
</body>
</html>`;
