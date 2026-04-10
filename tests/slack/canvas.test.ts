import { describe, it, expect } from 'vitest';
import { buildTeamCanvasContent } from '../../src/slack/canvas.js';
import type { CanvasMemberData } from '../../src/types.js';

describe('buildTeamCanvasContent', () => {
  it('should show active and idle members correctly', () => {
    const members: CanvasMemberData[] = [
      {
        name: 'Nabil',
        status: 'active',
        activeIssues: 'Dashboard #52, #78',
        files: ['filters.tsx', 'useFilters.ts'],
        previewUrl: 'preview-nabil.passcraft.com',
        statusSince: '09:45',
        completedToday: ['#53 Chart Export (45min)'],
      },
      {
        name: 'Chris',
        status: 'idle',
        activeIssues: '',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: ['#50 Payment Bug (1h 20min)'],
      },
    ];

    const content = buildTeamCanvasContent(members);

    // Active member section
    expect(content).toContain('Nabil');
    expect(content).toContain('\u{1F528}');
    expect(content).toContain('Dashboard #52, #78');
    expect(content).toContain('filters.tsx');
    expect(content).toContain('useFilters.ts');
    expect(content).toContain('preview-nabil.passcraft.com');
    expect(content).toContain('09:45');
    expect(content).toContain('#53 Chart Export (45min)');

    // Idle member section
    expect(content).toContain('Chris');
    expect(content).toContain('\u{1F4A4}');
    expect(content).toContain('#50 Payment Bug (1h 20min)');
  });

  it('should handle empty member list', () => {
    const content = buildTeamCanvasContent([]);
    expect(content).toContain('No team members configured');
  });

  it('should separate members with horizontal rule', () => {
    const members: CanvasMemberData[] = [
      {
        name: 'Alice',
        status: 'active',
        activeIssues: '#10',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: [],
      },
      {
        name: 'Bob',
        status: 'idle',
        activeIssues: '',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: [],
      },
    ];

    const content = buildTeamCanvasContent(members);
    expect(content).toContain('---');
  });

  it('should not show files section when no files', () => {
    const members: CanvasMemberData[] = [
      {
        name: 'Alice',
        status: 'active',
        activeIssues: '#10',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: [],
      },
    ];

    const content = buildTeamCanvasContent(members);
    expect(content).not.toContain('\u{1F4C1}');
  });

  it('should not show preview URL when null', () => {
    const members: CanvasMemberData[] = [
      {
        name: 'Alice',
        status: 'active',
        activeIssues: '#10',
        files: [],
        previewUrl: null,
        statusSince: null,
        completedToday: [],
      },
    ];

    const content = buildTeamCanvasContent(members);
    expect(content).not.toContain('\u{1F4CD}');
  });
});
