import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getChannelConfig, getRepoNameFromChannel } from '../../src/config/channels.js';

describe('Channel Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PASSCRAFT_MAIN_CHANNEL_ID: 'C_PASSCRAFT_MAIN',
      PASSCRAFT_BUGS_CHANNEL_ID: 'C_PASSCRAFT_BUGS',
      PASSCRAFT_ACTIVE_CHANNEL_ID: 'C_PASSCRAFT_ACTIVE',
      PASSCRAFT_BUGS_WEBHOOK_URL: 'https://hooks.slack.com/bugs',
      PASSCRAFT_ACTIVE_WEBHOOK_URL: 'https://hooks.slack.com/active',
      PASSCRAFT_PREVIEW_WEBHOOK_URL: 'https://hooks.slack.com/preview',
      PASSCRAFT_DEPLOY_WEBHOOK_URL: 'https://hooks.slack.com/deploy',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getChannelConfig', () => {
    it('should return config for known repos', () => {
      const config = getChannelConfig('passcraft');
      expect(config).not.toBeNull();
      expect(config!.displayName).toBe('PassCraft');
      expect(config!.mainChannelId).toBe('C_PASSCRAFT_MAIN');
    });

    it('should be case-insensitive', () => {
      const config = getChannelConfig('PassCraft');
      expect(config).not.toBeNull();
    });

    it('should return null for unknown repos', () => {
      const config = getChannelConfig('unknown-repo');
      expect(config).toBeNull();
    });
  });

  describe('getRepoNameFromChannel', () => {
    it('should match the main channel ID', () => {
      const repo = getRepoNameFromChannel('C_PASSCRAFT_MAIN');
      expect(repo).toBe('PassCraft');
    });

    it('should match the bugs channel ID', () => {
      const repo = getRepoNameFromChannel('C_PASSCRAFT_BUGS');
      expect(repo).toBe('PassCraft');
    });

    it('should match the active channel ID', () => {
      const repo = getRepoNameFromChannel('C_PASSCRAFT_ACTIVE');
      expect(repo).toBe('PassCraft');
    });

    it('should return null for unknown channels', () => {
      const repo = getRepoNameFromChannel('C_UNKNOWN');
      expect(repo).toBeNull();
    });

    it('should return null for empty channel ID', () => {
      const repo = getRepoNameFromChannel('');
      expect(repo).toBeNull();
    });
  });
});
