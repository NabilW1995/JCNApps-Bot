import type { CoolifyWebhookPayload } from '../../src/types.js';

/** Successful preview deployment on a feature branch */
export const previewSuccessPayload: CoolifyWebhookPayload = {
  status: 'success',
  preview_url: 'https://preview-nabil.passcraft.com',
  branch: 'feature/dashboard-filters',
  commit_message: 'feat: add date filter to dashboard #52',
  commit_sha: 'abc123def',
};

/** Successful production deployment on main */
export const productionSuccessPayload: CoolifyWebhookPayload = {
  status: 'success',
  url: 'https://passcraft.com',
  branch: 'main',
  commit_message: 'Merge pull request #52 from feature/dashboard-filters',
  commit_sha: 'def456abc',
};

/** Failed deployment */
export const deployFailedPayload: CoolifyWebhookPayload = {
  status: 'failed',
  branch: 'feature/broken-build',
  commit_message: 'fix: attempt to fix login page',
};

/** Alternative Coolify payload shape using deployment_url instead of preview_url */
export const alternativeUrlPayload: CoolifyWebhookPayload = {
  status: 'ready',
  deployment_url: 'https://preview.passcraft.com',
  branch: 'feature/settings-redesign',
  pr_number: 78,
};

/** Payload with no URL (e.g. building status) */
export const noUrlPayload: CoolifyWebhookPayload = {
  status: 'building',
  branch: 'feature/something',
};

/** Payload with error status */
export const errorPayload: CoolifyWebhookPayload = {
  status: 'error',
  branch: 'main',
  commit_message: 'Build failed: module not found',
};
