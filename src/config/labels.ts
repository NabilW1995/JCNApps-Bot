// Label prefixes used in GitHub issues for categorization.
// These match the label naming convention: "source/customer", "area/dashboard", etc.

const CUSTOMER_SOURCE_LABELS = ['source/customer', 'source/user-report'];
const AREA_PREFIX = 'area/';
const PRIORITY_PREFIX = 'priority/';

const PRIORITY_EMOJI_MAP: Record<string, string> = {
  critical: '\u{1F534}',  // Red circle
  high: '\u{1F7E0}',      // Orange circle
  medium: '\u{1F7E1}',    // Yellow circle
  low: '\u{1F7E2}',       // Green circle
};

/**
 * Check whether any of the issue labels indicate this came from a customer.
 */
export function isCustomerSource(labels: string[]): boolean {
  return labels.some((label) =>
    CUSTOMER_SOURCE_LABELS.includes(label.toLowerCase())
  );
}

/**
 * Extract the area label (e.g., "dashboard" from "area/dashboard").
 * Returns the first match or null if none found.
 */
export function getAreaLabel(labels: string[]): string | null {
  for (const label of labels) {
    if (label.toLowerCase().startsWith(AREA_PREFIX)) {
      return label.slice(AREA_PREFIX.length);
    }
  }
  return null;
}

/**
 * Extract the priority level (e.g., "high" from "priority/high").
 * Returns the first match or null if none found.
 */
export function getPriorityLabel(labels: string[]): string | null {
  for (const label of labels) {
    if (label.toLowerCase().startsWith(PRIORITY_PREFIX)) {
      return label.slice(PRIORITY_PREFIX.length);
    }
  }
  return null;
}

/**
 * Get the emoji for a priority level. Falls back to a white circle
 * for unknown priority values.
 */
export function getPriorityEmoji(priority: string): string {
  return PRIORITY_EMOJI_MAP[priority.toLowerCase()] ?? '\u26AA'; // White circle
}
