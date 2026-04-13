import { describe, it, expect } from 'vitest';
import { formatDuration, formatTimestamp } from '../../src/utils/time.js';

describe('formatDuration', () => {
  it('returns "< 1min" for sub-minute durations', () => {
    expect(formatDuration(0)).toBe('< 1min');
    expect(formatDuration(500)).toBe('< 1min');
    expect(formatDuration(59_999)).toBe('< 1min');
  });

  it('formats whole-minute durations under one hour', () => {
    expect(formatDuration(60_000)).toBe('1min');
    expect(formatDuration(5 * 60_000)).toBe('5min');
    expect(formatDuration(59 * 60_000)).toBe('59min');
  });

  it('formats whole-hour durations with no minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(2 * 3_600_000)).toBe('2h');
  });

  it('formats hours-and-minutes durations', () => {
    expect(formatDuration(3_600_000 + 34 * 60_000)).toBe('1h 34min');
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5min');
  });

  it('handles very large durations correctly', () => {
    expect(formatDuration(25 * 3_600_000)).toBe('25h');
    expect(formatDuration(100 * 3_600_000 + 7 * 60_000)).toBe('100h 7min');
  });

  it('rounds down sub-minute remainders inside hour buckets', () => {
    // 1h + 59s should still report just "1h", not "1h 0min"
    expect(formatDuration(3_600_000 + 59_000)).toBe('1h');
  });
});

describe('formatTimestamp', () => {
  it('formats hours and minutes with leading zeros', () => {
    const date = new Date();
    date.setHours(9, 5, 0, 0);
    expect(formatTimestamp(date)).toBe('09:05');
  });

  it('uses 24-hour clock (no AM/PM)', () => {
    const date = new Date();
    date.setHours(23, 59, 0, 0);
    expect(formatTimestamp(date)).toBe('23:59');
  });

  it('formats midnight as 00:00', () => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    expect(formatTimestamp(date)).toBe('00:00');
  });

  it('produces an exactly 5-character string for valid times', () => {
    const date = new Date();
    date.setHours(14, 30, 45, 123);
    const out = formatTimestamp(date);
    expect(out.length).toBe(5);
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });
});
