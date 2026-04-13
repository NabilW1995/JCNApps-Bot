/**
 * Extract GitHub-style issue references (#123) from a commit message.
 *
 * Only matches `#<digits>` where the digits form a positive integer.
 * Returns a de-duplicated, ordered list so callers can safely loop
 * without worrying about double work when a commit mentions the same
 * issue twice (`fix: #23 and more on #23`).
 *
 * Examples:
 *   extractIssueRefs('fix: #23 filter crash')         → [23]
 *   extractIssueRefs('fix: #23 and #45')              → [23, 45]
 *   extractIssueRefs('multi-line\\n#10\\n#20')        → [10, 20]
 *   extractIssueRefs('closes #99, resolves #100')     → [99, 100]
 *   extractIssueRefs('no issue ref here')             → []
 *   extractIssueRefs('#abc not a number')             → []
 *   extractIssueRefs('#0 is not a real issue')        → []
 *   extractIssueRefs('#23 and #23 again')             → [23]
 */
export function extractIssueRefs(message: string | null | undefined): number[] {
  if (!message) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  const re = /#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}
