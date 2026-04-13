import { describe, it, expect } from 'vitest';
import {
  isCustomerSource,
  getAreaLabel,
  getPriorityLabel,
  getTypeLabel,
  getSourceLabel,
  getPriorityEmoji,
} from '../../src/config/labels.js';

describe('isCustomerSource', () => {
  it('returns false for an empty array', () => {
    expect(isCustomerSource([])).toBe(false);
  });

  it('returns true when source/customer is present', () => {
    expect(isCustomerSource(['source/customer'])).toBe(true);
  });

  it('returns true when source/user-report is present', () => {
    expect(isCustomerSource(['source/user-report'])).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isCustomerSource(['SOURCE/CUSTOMER'])).toBe(true);
    expect(isCustomerSource(['Source/User-Report'])).toBe(true);
  });

  it('returns false for non-customer source labels', () => {
    expect(isCustomerSource(['source/internal'])).toBe(false);
    expect(isCustomerSource(['source/team'])).toBe(false);
  });

  it('returns false when only unrelated labels are present', () => {
    expect(isCustomerSource(['type/bug', 'priority/high', 'area/dashboard'])).toBe(false);
  });

  it('returns true when a customer label is mixed with unrelated labels', () => {
    expect(isCustomerSource(['type/bug', 'source/customer', 'area/x'])).toBe(true);
  });
});

describe('getAreaLabel', () => {
  it('returns null when no area label is present', () => {
    expect(getAreaLabel([])).toBeNull();
    expect(getAreaLabel(['type/bug'])).toBeNull();
  });

  it('strips the area/ prefix and returns the remainder', () => {
    expect(getAreaLabel(['area/dashboard'])).toBe('dashboard');
  });

  it('returns the first area label when multiple are present', () => {
    expect(getAreaLabel(['area/dashboard', 'area/settings'])).toBe('dashboard');
  });

  it('matches case-insensitively but preserves the original casing', () => {
    expect(getAreaLabel(['AREA/Dashboard'])).toBe('Dashboard');
  });
});

describe('getPriorityLabel', () => {
  it('returns null when no priority label is present', () => {
    expect(getPriorityLabel([])).toBeNull();
    expect(getPriorityLabel(['type/bug'])).toBeNull();
  });

  it('strips priority/ prefix', () => {
    expect(getPriorityLabel(['priority/high'])).toBe('high');
    expect(getPriorityLabel(['priority/critical'])).toBe('critical');
  });

  it('returns the first priority when multiple are present', () => {
    expect(getPriorityLabel(['priority/low', 'priority/high'])).toBe('low');
  });
});

describe('getTypeLabel', () => {
  it('returns null when no type label is present', () => {
    expect(getTypeLabel([])).toBeNull();
  });

  it('strips type/ prefix', () => {
    expect(getTypeLabel(['type/bug'])).toBe('bug');
    expect(getTypeLabel(['type/feature'])).toBe('feature');
  });
});

describe('getSourceLabel', () => {
  it('returns null when no source label is present', () => {
    expect(getSourceLabel([])).toBeNull();
  });

  it('strips source/ prefix', () => {
    expect(getSourceLabel(['source/customer'])).toBe('customer');
    expect(getSourceLabel(['source/internal'])).toBe('internal');
  });
});

describe('getPriorityEmoji', () => {
  it('returns the red circle for critical', () => {
    expect(getPriorityEmoji('critical')).toBe('\u{1F534}');
  });

  it('returns the orange circle for high', () => {
    expect(getPriorityEmoji('high')).toBe('\u{1F7E0}');
  });

  it('returns the yellow circle for medium', () => {
    expect(getPriorityEmoji('medium')).toBe('\u{1F7E1}');
  });

  it('returns the green circle for low', () => {
    expect(getPriorityEmoji('low')).toBe('\u{1F7E2}');
  });

  it('is case-insensitive', () => {
    expect(getPriorityEmoji('CRITICAL')).toBe('\u{1F534}');
    expect(getPriorityEmoji('High')).toBe('\u{1F7E0}');
  });

  it('falls back to a white circle for unknown values', () => {
    expect(getPriorityEmoji('frobnicate')).toBe('\u26AA');
    expect(getPriorityEmoji('')).toBe('\u26AA');
  });
});
