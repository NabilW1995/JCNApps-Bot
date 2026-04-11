import type { Context } from 'hono';

/**
 * Serve the self-contained workflow guide HTML page.
 *
 * A compact, static reference for the team's daily development workflow.
 * Uses inline CSS and JS with Google Fonts Inter — no external dependencies.
 */
export async function serveWorkflow(c: Context): Promise<Response> {
  return c.html(WORKFLOW_HTML);
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export const WORKFLOW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>JCN Apps — Workflow Guide</title>
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
      max-width: 1100px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }

    /* ------------------------------------------------------------------ */
    /* Header                                                              */
    /* ------------------------------------------------------------------ */
    .header {
      text-align: center;
      margin-bottom: 2rem;
    }

    .header h1 {
      font-size: 2.25rem;
      font-weight: 700;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6, #ec4899);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.25rem;
    }

    .header .subtitle {
      font-size: 1rem;
      color: #94a3b8;
      font-weight: 500;
    }

    /* ------------------------------------------------------------------ */
    /* Phase Cards — 3-column grid                                         */
    /* ------------------------------------------------------------------ */
    .phases {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .phase-card {
      position: relative;
      background: #1e293b;
      border-radius: 12px;
      padding: 1.25rem;
      overflow: hidden;
    }

    /* Gradient border effect (top edge) */
    .phase-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
    }

    .phase-card.morning::before {
      background: linear-gradient(90deg, #f59e0b, #f97316);
    }

    .phase-card.working::before {
      background: linear-gradient(90deg, #3b82f6, #8b5cf6);
    }

    .phase-card.evening::before {
      background: linear-gradient(90deg, #6366f1, #8b5cf6);
    }

    /* Subtle gradient border on sides */
    .phase-card::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 12px;
      padding: 1px;
      background: linear-gradient(180deg, rgba(148,163,184,0.15) 0%, rgba(148,163,184,0.03) 100%);
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      pointer-events: none;
    }

    .phase-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }

    .phase-icon {
      font-size: 1.25rem;
      line-height: 1;
    }

    .phase-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: #e2e8f0;
    }

    /* ------------------------------------------------------------------ */
    /* Steps                                                               */
    /* ------------------------------------------------------------------ */
    .steps {
      list-style: none;
      counter-reset: step;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }

    .steps li {
      display: flex;
      align-items: flex-start;
      gap: 0.6rem;
      font-size: 0.85rem;
      color: #cbd5e1;
      line-height: 1.45;
      counter-increment: step;
    }

    .steps li::before {
      content: counter(step);
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      border-radius: 50%;
      font-size: 0.7rem;
      font-weight: 700;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .morning .steps li::before {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
    }

    .working .steps li::before {
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
    }

    .evening .steps li::before {
      background: rgba(99, 102, 241, 0.2);
      color: #a5b4fc;
    }

    .step-code {
      background: rgba(148, 163, 184, 0.1);
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.8rem;
      color: #93c5fd;
      white-space: nowrap;
    }

    /* ------------------------------------------------------------------ */
    /* Preview URLs sub-list                                               */
    /* ------------------------------------------------------------------ */
    .preview-list {
      list-style: none;
      margin-top: 0.35rem;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    .preview-list li {
      font-size: 0.8rem;
      color: #94a3b8;
      padding-left: 0.25rem;
    }

    .preview-list li::before {
      content: none;
    }

    .preview-url {
      color: #60a5fa;
      font-family: monospace;
      font-size: 0.75rem;
    }

    /* ------------------------------------------------------------------ */
    /* Warning Box                                                         */
    /* ------------------------------------------------------------------ */
    .warning-box {
      margin-top: 0.75rem;
      padding: 0.6rem 0.75rem;
      background: rgba(245, 158, 11, 0.08);
      border-left: 3px solid #f59e0b;
      border-radius: 0 6px 6px 0;
      font-size: 0.8rem;
      color: #fcd34d;
      line-height: 1.45;
    }

    .warning-icon {
      margin-right: 0.25rem;
    }

    /* ------------------------------------------------------------------ */
    /* Rules Grid                                                          */
    /* ------------------------------------------------------------------ */
    .rules-section {
      margin-bottom: 2rem;
    }

    .section-title {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: #e2e8f0;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .rules-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      gap: 0.6rem;
    }

    .rule-item {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 0.65rem 0.75rem;
      font-size: 0.8rem;
      color: #cbd5e1;
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      line-height: 1.4;
    }

    .rule-icon {
      flex-shrink: 0;
      font-size: 0.85rem;
      margin-top: 1px;
    }

    /* ------------------------------------------------------------------ */
    /* Footer                                                              */
    /* ------------------------------------------------------------------ */
    .footer {
      text-align: center;
      padding: 1.5rem 0 1rem;
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
      padding: 0.45rem 0.9rem;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #94a3b8;
      text-decoration: none;
      font-size: 0.8rem;
      font-weight: 500;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }

    .footer-link:hover {
      background: #334155;
      color: #f8fafc;
      border-color: #475569;
    }

    .footer-powered {
      margin-top: 0.75rem;
      font-size: 0.7rem;
      color: #475569;
    }

    /* ------------------------------------------------------------------ */
    /* Fade-in Animation                                                   */
    /* ------------------------------------------------------------------ */
    .fade-in > * {
      animation: fadeIn 0.4s ease-out both;
    }

    .fade-in > *:nth-child(1) { animation-delay: 0s; }
    .fade-in > *:nth-child(2) { animation-delay: 0.08s; }
    .fade-in > *:nth-child(3) { animation-delay: 0.16s; }
    .fade-in > *:nth-child(4) { animation-delay: 0.24s; }
    .fade-in > *:nth-child(5) { animation-delay: 0.32s; }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* ------------------------------------------------------------------ */
    /* Responsive                                                          */
    /* ------------------------------------------------------------------ */
    @media (max-width: 768px) {
      .container { padding: 1.25rem 1rem; }
      .header h1 { font-size: 1.75rem; }

      .phases {
        grid-template-columns: 1fr;
      }

      .rules-grid {
        grid-template-columns: 1fr 1fr;
      }
    }

    @media (max-width: 480px) {
      .rules-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container fade-in">

    <!-- Header -->
    <header class="header">
      <h1>Workflow Guide</h1>
      <div class="subtitle">Daily development process for the JCN Apps team</div>
    </header>

    <!-- Phase Cards -->
    <div class="phases">

      <!-- Morning -->
      <div class="phase-card morning">
        <div class="phase-header">
          <span class="phase-icon" role="img" aria-label="Sunrise">&#127749;</span>
          <span class="phase-title">Morning</span>
        </div>
        <ol class="steps">
          <li>Open Slack &mdash; check <span class="step-code">#company-dashboard</span></li>
          <li>Check <span class="step-code">#passcraft-pro-active</span> for open tasks</li>
          <li>Open Claude Code</li>
          <li>&ldquo;Show me all open issues for PassCraft&rdquo;</li>
          <li>Pick tasks from <strong>one</strong> category (e.g. all Dashboard tasks)</li>
        </ol>
        <div class="warning-box">
          <span class="warning-icon" role="img" aria-label="Warning">&#9888;&#65039;</span>
          Always take tasks from the same category. This prevents file conflicts with teammates.
        </div>
      </div>

      <!-- Working -->
      <div class="phase-card working">
        <div class="phase-header">
          <span class="phase-icon" role="img" aria-label="Computer">&#128187;</span>
          <span class="phase-title">Working</span>
        </div>
        <ol class="steps">
          <li>Tell Claude: <span class="step-code">Create a feature branch</span></li>
          <li>Code your feature</li>
          <li>
            Deploy to personal preview:
            <ul class="preview-list">
              <li>Nabil &rarr; <span class="preview-url">preview-nabil.passcraft.com</span></li>
              <li>Jannem &rarr; <span class="preview-url">preview-jannem.passcraft.com</span></li>
              <li>Chris &rarr; <span class="preview-url">preview-chris.passcraft.com</span></li>
            </ul>
          </li>
          <li>Test desktop + mobile</li>
          <li>Push to team preview &rarr; <span class="preview-url">preview.passcraft.com</span></li>
          <li>Team tests &rarr; Deploy to Live</li>
        </ol>
      </div>

      <!-- End of Day -->
      <div class="phase-card evening">
        <div class="phase-header">
          <span class="phase-icon" role="img" aria-label="Moon">&#127769;</span>
          <span class="phase-title">End of Day</span>
        </div>
        <ol class="steps">
          <li>Check all tasks deployed</li>
          <li>Check <span class="step-code">#passcraft-pro-bugs</span> for new reports</li>
          <li>Done!</li>
        </ol>
      </div>

    </div>

    <!-- Rules -->
    <div class="rules-section">
      <div class="section-title">
        <span role="img" aria-label="Rules">&#128220;</span> Rules
      </div>
      <div class="rules-grid">
        <div class="rule-item">
          <span class="rule-icon" role="img" aria-label="Ticket">&#127915;</span>
          <span>No code without an issue</span>
        </div>
        <div class="rule-item">
          <span class="rule-icon" role="img" aria-label="Branch">&#128268;</span>
          <span>One branch = one person</span>
        </div>
        <div class="rule-item">
          <span class="rule-icon" role="img" aria-label="Folder">&#128194;</span>
          <span>Take whole categories</span>
        </div>
        <div class="rule-item">
          <span class="rule-icon" role="img" aria-label="Fire">&#128293;</span>
          <span>Hotfix: say &ldquo;Hotfix for #52&rdquo;</span>
        </div>
        <div class="rule-item">
          <span class="rule-icon" role="img" aria-label="Art">&#127912;</span>
          <span>Design tasks are blockers</span>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <footer class="footer">
      <div class="footer-links">
        <a class="footer-link" href="https://passcraft.com" target="_blank" rel="noopener">
          &#127760; passcraft.com
        </a>
        <a class="footer-link" href="https://preview.passcraft.com" target="_blank" rel="noopener">
          &#128065; preview.passcraft.com
        </a>
        <a class="footer-link" href="https://github.com/NabilW1995" target="_blank" rel="noopener">
          &#128736; GitHub
        </a>
      </div>
      <div class="footer-powered">Powered by JCNApps-Bot</div>
    </footer>

  </div>
</body>
</html>`;
