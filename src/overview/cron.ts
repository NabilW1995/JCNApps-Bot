import { refreshOverviewDashboard } from './dashboard.js';
import { postMorningDigest } from './digest.js';
import { isFeatureEnabled } from '../config/feature-flags.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Morning Cron — checks every minute if it's time for the daily digest
// ---------------------------------------------------------------------------

/**
 * The UTC hour and minute when the morning digest should fire.
 * 6:00 UTC is a reasonable default; adjust for timezone if needed.
 */
const MORNING_HOUR = 6;
const MORNING_MINUTE = 0;

/** How often (in ms) we check whether it's time to run. */
const CHECK_INTERVAL_MS = 60_000;

/** Prevents running the digest more than once per day. */
let lastMorningRun = '';

/** Reference to the interval timer so it can be stopped in tests. */
let cronTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the morning cron loop.
 *
 * Uses setInterval rather than a full cron library to avoid adding
 * another dependency. Checks every minute whether the current time
 * matches the configured morning slot.
 */
export function startMorningCron(): void {
  cronTimer = setInterval(async () => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    if (hour === MORNING_HOUR && minute === MORNING_MINUTE && lastMorningRun !== today) {
      lastMorningRun = today;

      if (!isFeatureEnabled('morningCron')) {
        logger.info('Morning cron skipped (FF_MORNING_CRON disabled)');
        return;
      }

      try {
        await refreshOverviewDashboard();
        await postMorningDigest();
        logger.info('Morning cron completed');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Morning cron failed', { error: message });
      }
    }
  }, CHECK_INTERVAL_MS);

  logger.info('Morning cron started', {
    utcHour: MORNING_HOUR,
    utcMinute: MORNING_MINUTE,
  });
}

/**
 * Stop the morning cron loop. Used in tests and graceful shutdown.
 */
export function stopMorningCron(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
  }
}

/**
 * Reset the last-run date. Used in tests to allow re-triggering.
 */
export function resetMorningCron(): void {
  lastMorningRun = '';
}
