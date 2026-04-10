const MINUTES_IN_MS = 60_000;
const HOURS_IN_MS = 3_600_000;

/**
 * Format a duration in milliseconds into a human-readable string.
 *
 * Examples: "2h 34min", "45min", "< 1min"
 */
export function formatDuration(ms: number): string {
  if (ms < MINUTES_IN_MS) {
    return '< 1min';
  }

  const hours = Math.floor(ms / HOURS_IN_MS);
  const minutes = Math.floor((ms % HOURS_IN_MS) / MINUTES_IN_MS);

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}min`;
  }

  if (hours > 0) {
    return `${hours}h`;
  }

  return `${minutes}min`;
}

/**
 * Format a Date into a short time string (HH:MM in 24h format).
 *
 * Example: "09:34"
 */
export function formatTimestamp(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}
