/**
 * lib/audit-suite/findings.js — Findings histogram aggregation.
 *
 * Extracted from `.agents/scripts/run-audit-suite.js` (Story #963, Epic #946).
 * Pure module; the runner calls this once per invocation to populate the
 * `metadata.summary` block in the audit-suite envelope.
 */

const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);

/**
 * Pure: count findings into a {critical,high,medium,low} histogram. Findings
 * with severities outside that set are ignored, keeping the rendered summary
 * truthful even if upstream callers append non-standard severities.
 *
 * @param {Array<{ severity?: string }>|null|undefined} findings
 * @returns {{ critical: number, high: number, medium: number, low: number }}
 */
export function aggregateSummary(findings) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings ?? []) {
    if (Object.hasOwn(summary, finding.severity)) {
      summary[finding.severity] += 1;
    }
  }
  return summary;
}

export const KNOWN_SEVERITIES = SEVERITIES;
