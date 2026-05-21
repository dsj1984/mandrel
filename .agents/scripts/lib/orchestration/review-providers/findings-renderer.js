/**
 * review-providers/findings-renderer.js — single renderer for the
 * structured `code-review` comment body.
 *
 * Story #2825 (Epic #2815) — adapters return `Finding[]`; the renderer
 * is the sole source of truth for the markdown body posted to the
 * Story/Epic ticket. Adapters MUST NOT post comments themselves.
 *
 * Output is deterministic for a given `Finding[]` input: the input
 * order is preserved within each severity tier, and the tier sections
 * always appear in the canonical order critical → high → medium →
 * suggestion. This is what makes the snapshot test stable.
 *
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').Severity} Severity
 * @typedef {import('./types.js').ReviewScope} ReviewScope
 */

/**
 * Canonical severity ordering. The render output always lists the
 * severity-tier counts in this order and emits the per-finding sections
 * in this order, so a stable input produces a byte-stable output.
 *
 * @type {ReadonlyArray<Severity>}
 */
const SEVERITY_ORDER = Object.freeze([
  'critical',
  'high',
  'medium',
  'suggestion',
]);

/**
 * Emoji + human label mapping. Mirrors the legacy
 * `epic-code-review.js` vocabulary so downstream operators see the
 * same tier names regardless of which adapter produced the findings.
 *
 * @type {Readonly<Record<Severity, { emoji: string, label: string }>>}
 */
const SEVERITY_META = Object.freeze({
  critical: { emoji: '🔴', label: 'Critical Blocker' },
  high: { emoji: '🟠', label: 'High Risk' },
  medium: { emoji: '🟡', label: 'Medium Risk' },
  suggestion: { emoji: '🟢', label: 'Suggestion' },
});

/**
 * Pure: tally findings by severity. Unknown severities are ignored to
 * keep the renderer forgiving of adapter bugs (a misbehaving adapter
 * still produces a readable, if incomplete, report).
 *
 * @param {ReadonlyArray<Finding>} findings
 * @returns {Record<Severity, number>}
 */
export function countBySeverity(findings) {
  /** @type {Record<Severity, number>} */
  const counts = { critical: 0, high: 0, medium: 0, suggestion: 0 };
  for (const f of findings) {
    if (f && Object.hasOwn(counts, f.severity)) {
      counts[/** @type {Severity} */ (f.severity)] += 1;
    }
  }
  return counts;
}

/**
 * Pure: render a single Finding as a markdown subsection. Exported for
 * testability.
 *
 * The `file`/`line` attribution lives on the same line as the title so
 * GitHub renders a compact, scannable header. The `body` follows
 * verbatim — adapters own its markdown shape (it may contain code
 * fences, lists, etc.).
 *
 * @param {Finding} finding
 * @returns {string}
 */
export function renderFinding(finding) {
  const meta = SEVERITY_META[finding.severity];
  const emoji = meta ? meta.emoji : '⚪';
  const attribution = buildAttribution(finding);
  const category = finding.category ? ` _[${finding.category}]_` : '';
  const header = `#### ${emoji} ${finding.title}${attribution}${category}`;
  return `${header}\n\n${finding.body}`;
}

/**
 * Pure: render the full markdown body for a code-review comment.
 *
 * @param {{
 *   scope: ReviewScope,
 *   ticketId: number,
 *   baseRef: string,
 *   headRef: string,
 *   findings: ReadonlyArray<Finding>,
 *   provider?: string,
 * }} input
 * @returns {string}
 */
export function renderFindings(input) {
  const { scope, ticketId, baseRef, headRef, findings, provider } = input;
  const counts = countBySeverity(findings);
  const totalKnown =
    counts.critical + counts.high + counts.medium + counts.suggestion;

  const scopeLabel = scope === 'epic' ? 'Epic' : 'Story';
  const providerLine = provider
    ? `**Provider**: \`${provider}\``
    : '**Provider**: _(unspecified)_';

  const lines = [
    `## 🔬 Code Review — ${scopeLabel} #${ticketId}`,
    '',
    `**Comparison**: \`${baseRef}\` … \`${headRef}\``,
    providerLine,
    `**Findings**: ${totalKnown}`,
    '',
    '### 📦 Severity Tier Counts',
    '',
    ...SEVERITY_ORDER.map((sev) => {
      const meta = SEVERITY_META[sev];
      return `- ${meta.emoji} ${meta.label}: ${counts[sev]}`;
    }),
    '',
  ];

  if (totalKnown === 0) {
    lines.push('### ✅ No findings');
    lines.push('');
    lines.push('No issues surfaced by the review provider.');
  } else {
    for (const sev of SEVERITY_ORDER) {
      const tierFindings = findings.filter((f) => f && f.severity === sev);
      if (tierFindings.length === 0) continue;
      const meta = SEVERITY_META[sev];
      lines.push(`### ${meta.emoji} ${meta.label} (${tierFindings.length})`);
      lines.push('');
      for (const finding of tierFindings) {
        lines.push(renderFinding(finding));
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

/**
 * Pure: build the `(file:line)` attribution suffix for a finding header.
 * Returns an empty string when no file is attributable.
 *
 * @param {Finding} finding
 * @returns {string}
 */
function buildAttribution(finding) {
  if (!finding.file) return '';
  if (Number.isInteger(finding.line) && finding.line > 0) {
    return ` — \`${finding.file}:${finding.line}\``;
  }
  return ` — \`${finding.file}\``;
}
