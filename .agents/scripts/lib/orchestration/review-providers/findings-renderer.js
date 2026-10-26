/**
 * review-providers/findings-renderer.js — the sole renderer of the
 * `code-review` comment body (adapters never post). Deterministic: input
 * order is kept within each tier, tiers in canonical order.
 *
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').Severity} Severity
 */

import { groundingNotes } from './claim-grounding.js';
import {
  normalizeDegradations,
  renderDegradedGatesSection,
  renderDegradedHeaderLines,
  renderNoFindingsBlock,
} from './degraded-gates.js';
import { findingId, findingInstances } from './finding-identity.js';

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

/** @param {{ file: string, line?: number }} i */
const formatLocation = (i) => (i.line ? `${i.file}:${i.line}` : i.file);

/** An `Instances:` list when the finding has more than one location. */
function renderInstances(finding) {
  const instances = findingInstances(finding);
  if (instances.length < 2) return [];
  return [
    `Instances:\n${instances.map((i) => `- \`${formatLocation(i)}\``).join('\n')}`,
  ];
}

/**
 * The body is emitted verbatim; adapters own its markdown. The hidden marker
 * carries the finding's stable id.
 *
 * @param {Finding} finding
 * @returns {string}
 */
export function renderFinding(finding) {
  const meta = SEVERITY_META[finding.severity];
  const emoji = meta ? meta.emoji : '⚪';
  const attribution = buildAttribution(finding);
  const category = finding.category ? ` _[${finding.category}]_` : '';
  const cls = finding.class ? ` \`${finding.class}\`` : '';
  const header = `#### ${emoji} ${finding.title}${attribution}${category}${cls}`;
  return [
    `${header}\n\n${finding.body}`,
    ...renderInstances(finding),
    ...groundingNotes(finding),
    `<!-- finding:${findingId(finding)} -->`,
  ].join('\n\n');
}

/**
 * A repeat collapses to title, id and locations: it was posted in full before.
 *
 * @param {Finding} finding
 * @returns {string}
 */
function renderRepeat(finding) {
  const emoji = SEVERITY_META[finding.severity]?.emoji ?? '⚪';
  const where = findingInstances(finding)
    .map((i) => `\`${formatLocation(i)}\``)
    .join(', ');
  return (
    `- ${emoji} ${finding.title} — \`${findingId(finding)}\`` +
    `${where ? ` — ${where}` : ''} <!-- finding:${findingId(finding)} -->`
  );
}

/** @param {ReadonlyArray<Finding>} repeats */
function renderRepeatsSection(repeats) {
  if (repeats.length === 0) return [];
  return [
    `### ♻️ Previously raised (${repeats.length})`,
    '',
    ...repeats.map(renderRepeat),
    '',
  ];
}

/** Fresh findings render in full per tier; repeats render collapsed. */
function renderFindingSections(findings) {
  const lines = [];
  const fresh = findings.filter((f) => f && !f.repeat);
  for (const sev of SEVERITY_ORDER) {
    const tierFindings = fresh.filter((f) => f.severity === sev);
    if (tierFindings.length === 0) continue;
    const meta = SEVERITY_META[sev];
    lines.push(`### ${meta.emoji} ${meta.label} (${tierFindings.length})`, '');
    for (const finding of tierFindings) lines.push(renderFinding(finding), '');
  }
  return [...lines, ...renderRepeatsSection(findings.filter((f) => f?.repeat))];
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
 *   verification?: Record<string, number>,
 *   skipped?: number,
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
    ...renderVerificationLine(input.verification),
    ...(input.skipped > 0
      ? [`**Skipped by \`skipPaths\`**: ${input.skipped}`]
      : []),
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
    lines.push(...renderFindingSections(findings));
  }

  const promptLines = renderManualPromptsSection(promptMessages ?? []);
  if (promptLines.length > 0) {
    lines.push('');
    lines.push(...promptLines);
  }

  return lines.join('\n');
}

/**
 * The critical-verifier tally; nothing when no verifier ran.
 *
 * @param {Record<string, number>|undefined} v
 * @returns {string[]}
 */
function renderVerificationLine(v) {
  if (!(v?.attempted > 0)) return [];
  return [
    `**Critical verification**: ${v.attempted} attempted · ${v.confirmed} confirmed · ` +
      `${v.refuted} refuted · ${v.uncertain} uncertain · ${v.errored} errored`,
  ];
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
