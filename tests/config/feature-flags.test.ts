import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getFeatureFlags,
  isFeatureEnabled,
} from '../../src/config/feature-flags.js';

describe('feature-flags', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Start each test with a clean slate — clone the original env then
    // strip every FF_ var so prior tests cannot leak state.
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('FF_')) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('default behavior (fail open)', () => {
    it('every flag defaults to true when no env vars are set', () => {
      const flags = getFeatureFlags();
      expect(flags.reconciler).toBe(true);
      expect(flags.morningCron).toBe(true);
      expect(flags.bugDetailsModal).toBe(true);
      expect(flags.githubCommentSync).toBe(true);
      expect(flags.pushReconcile).toBe(true);
    });

    it('treats an unrecognized value as enabled', () => {
      process.env.FF_RECONCILER = 'totally-not-a-known-value';
      expect(getFeatureFlags().reconciler).toBe(true);
    });

    it('treats an empty string as enabled', () => {
      process.env.FF_RECONCILER = '';
      // Empty string is truthy under the fail-open model: only known
      // falsy tokens disable a flag.
      expect(getFeatureFlags().reconciler).toBe(true);
    });
  });

  describe('falsy tokens disable a flag', () => {
    it.each(['0', 'false', 'FALSE', 'False', 'off', 'OFF', 'no', 'NO'])(
      'treats %s as disabled',
      (value) => {
        process.env.FF_RECONCILER = value;
        expect(getFeatureFlags().reconciler).toBe(false);
      }
    );

    it('trims whitespace before comparing', () => {
      process.env.FF_RECONCILER = '  false  ';
      expect(getFeatureFlags().reconciler).toBe(false);
    });
  });

  describe('truthy tokens enable a flag', () => {
    it.each(['1', 'true', 'TRUE', 'on', 'yes', 'enabled'])(
      'treats %s as enabled',
      (value) => {
        process.env.FF_RECONCILER = value;
        expect(getFeatureFlags().reconciler).toBe(true);
      }
    );
  });

  describe('flags are independent', () => {
    it('disabling one flag does not affect the others', () => {
      process.env.FF_RECONCILER = 'false';
      const flags = getFeatureFlags();
      expect(flags.reconciler).toBe(false);
      expect(flags.morningCron).toBe(true);
      expect(flags.bugDetailsModal).toBe(true);
    });

    it('multiple flags can be disabled simultaneously', () => {
      process.env.FF_RECONCILER = '0';
      process.env.FF_MORNING_CRON = 'off';
      const flags = getFeatureFlags();
      expect(flags.reconciler).toBe(false);
      expect(flags.morningCron).toBe(false);
      expect(flags.bugDetailsModal).toBe(true);
    });
  });

  describe('isFeatureEnabled shorthand', () => {
    it('returns true by default for any known flag', () => {
      expect(isFeatureEnabled('reconciler')).toBe(true);
      expect(isFeatureEnabled('morningCron')).toBe(true);
    });

    it('returns false when the corresponding env var is falsy', () => {
      process.env.FF_BUG_DETAILS_MODAL = '0';
      expect(isFeatureEnabled('bugDetailsModal')).toBe(false);
    });

    it('reflects env changes between calls (no caching)', () => {
      expect(isFeatureEnabled('reconciler')).toBe(true);
      process.env.FF_RECONCILER = 'false';
      expect(isFeatureEnabled('reconciler')).toBe(false);
      process.env.FF_RECONCILER = 'true';
      expect(isFeatureEnabled('reconciler')).toBe(true);
    });
  });
});
