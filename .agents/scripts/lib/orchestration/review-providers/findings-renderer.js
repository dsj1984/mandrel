/**
 * review-providers/findings-renderer.js — the sole renderer of the
 * `code-review` comment body (adapters never post). Deterministic: input
 * order is kept within each tier, tiers in canonical order.
 *
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').Severity} Severity
 */

import {
  normalizeDegradations,
  renderDegradedGatesSection,
  renderDegradedHeaderLines,
  renderNoFindingsBlock,
} from './degraded-gates.js';

/**
 * @type {ReadonlyArray<Severity>}
 */
const SEVERITY_ORDER = Object.freeze([
  'critical',
  'high',
  'medium',
  'suggestion',
]);

/**
 * @type {Readonly<Record<Severity, { emoji: string, label: string }>>}
 */
const SEVERITY_META = Object.freeze({
  critical: { emoji: '🔴', label: 'Critical Blocker' },
  high: { emoji: '🟠', label: 'High Risk' },
  medium: { emoji: '🟡', label: 'Medium Risk' },
  suggestion: { emoji: '🟢', label: 'Suggestion' },
});

/**
 * Unknown severities are ignored, so a buggy adapter still renders.
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
 * The body is emitted verbatim; adapters own its markdown.
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
 * @param {ReadonlyArray<string>} messages
 * @returns {string[]}  lines to append (empty when no messages)
 */
function renderManualPromptsSection(messages) {
  const filtered = Array.isArray(messages)
    ? messages.filter((m) => typeof m === 'string' && m.trim().length > 0)
    : [];
  if (filtered.length === 0) return [];
  const lines = ['### 💬 Manual Review Suggestions', ''];
  for (const message of filtered) {
    lines.push(`- ${message}`);
  }
  lines.push('');
  return lines;
}

/**
 * `degradations` are never findings: they render as their own section and
 * suppress the unqualified "no findings" claim.
 *
 * @param {{
 *   ticketId: number,
 *   baseRef: string,
 *   headRef: string,
 *   findings: ReadonlyArray<Finding>,
 *   provider?: string,
 *   promptMessages?: ReadonlyArray<string>,
 *   degradations?: ReadonlyArray<object>,
 * }} input
 * @returns {string}
 */
export function renderFindings(input) {
  const { ticketId, baseRef, headRef, findings, provider, promptMessages } =
    input;
  const counts = countBySeverity(findings);
  const totalKnown =
    counts.critical + counts.high + counts.medium + counts.suggestion;
  const degraded = normalizeDegradations(input.degradations);

  const providerLine = provider
    ? `**Provider**: \`${provider}\``
    : '**Provider**: _(unspecified)_';

  const lines = [
    `## 🔬 Code Review — Story #${ticketId}`,
    '',
    `**Comparison**: \`${baseRef}\` … \`${headRef}\``,
    providerLine,
    `**Findings**: ${totalKnown}`,
    ...renderDegradedHeaderLines(degraded),
    '',
    '### 📦 Severity Tier Counts',
    '',
    ...SEVERITY_ORDER.map((sev) => {
      const meta = SEVERITY_META[sev];
      return `- ${meta.emoji} ${meta.label}: ${counts[sev]}`;
    }),
    '',
    ...renderDegradedGatesSection(degraded),
  ];

  if (totalKnown === 0) {
    lines.push(...renderNoFindingsBlock(degraded));
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

  const promptLines = renderManualPromptsSection(promptMessages ?? []);
  if (promptLines.length > 0) {
    lines.push('');
    lines.push(...promptLines);
  }

  return lines.join('\n');
}

/**
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
