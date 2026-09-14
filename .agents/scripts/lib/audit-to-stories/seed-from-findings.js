/**
 * lib/audit-to-stories/seed-from-findings.js
 *
 * Build the `/mandrel-plan --seed`-shaped one-pager markdown that the audit-to-
 * stories Single-plan grouping path emits for `/mandrel-plan` to consume.
 *
 * The seed renders the canonical one-pager sections so the authoring
 * pass can sharpen it without having to invent context:
 *   - Problem Statement (aggregated severity profile)
 *   - Recommended Direction (rollup of recommendations by dimension)
 *   - Key Assumptions (carries the source-report links forward)
 *   - MVP Scope (the findings themselves, flat — Story #5332)
 *   - Key Files (explicit file paths so `/mandrel-plan` authoring has concrete
 *     anchors)
 *   - Not Doing (out-of-scope items by convention)
 *
 * Pure: returns a string. The caller decides where to persist it.
 */

import { SEVERITIES } from '../findings/severity.js';
import { auditLabelFooterForFindings } from './audit-label-taxonomy.js';
import {
  renderFingerprintFooter,
  renderSemanticKeyFooter,
} from './finding-adapter.js';

const DIMENSION_LABEL = {
  security: 'Security',
  privacy: 'Privacy',
  quality: 'Quality',
  'clean-code': 'Clean code',
  dependencies: 'Dependencies',
  devops: 'DevOps',
  accessibility: 'Accessibility',
  performance: 'Performance',
  seo: 'SEO',
  sre: 'SRE',
  'ux-ui': 'UX / UI',
  architecture: 'Architecture',
};

/**
 * The severity profile in the seed's Problem Statement is ordered and bucketed
 * by the canonical scale (Story #4877) rather than by a fourth local copy of
 * it. The list this replaces omitted `info`, so an informational finding was
 * absent from the profile the planner reads even when it survived the filter.
 */
const SEVERITY_ORDER = SEVERITIES;

function tallySeverities(findings) {
  const tally = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) {
    if (Object.hasOwn(tally, f.severity)) tally[f.severity] += 1;
  }
  return tally;
}

function tallyDimensions(findings) {
  const tally = new Map();
  for (const f of findings) {
    tally.set(f.dimension, (tally.get(f.dimension) ?? 0) + 1);
  }
  return tally;
}

function formatProblemStatement(findings) {
  const sev = tallySeverities(findings);
  const dimensions = tallyDimensions(findings);
  const tallyParts = SEVERITY_ORDER.filter((k) => sev[k] > 0)
    .map((k) => `${sev[k]} ${k.charAt(0).toUpperCase() + k.slice(1)}`)
    .join(', ');
  const topDims = [...dimensions.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d]) => DIMENSION_LABEL[d] ?? d);
  const dimsPhrase = topDims.length > 0 ? topDims.join(', ') : 'multiple areas';
  return `An audit sweep surfaced ${findings.length} findings (${tallyParts}) concentrated in ${dimsPhrase}. These require remediation to restore release posture.`;
}

function formatRecommendedDirection(findings) {
  const byDim = new Map();
  for (const f of findings) {
    if (!byDim.has(f.dimension)) byDim.set(f.dimension, []);
    if (f.recommendation) byDim.get(f.dimension).push(f.recommendation);
  }
  const lines = [];
  for (const [dim, recs] of [...byDim.entries()].sort()) {
    const label = DIMENSION_LABEL[dim] ?? dim;
    const head = recs.slice(0, 2).join(' ');
    lines.push(`- **${label}** — ${head || 'See linked findings.'}`);
  }
  return lines.join('\n');
}

/**
 * The findings, flat (Story #5332).
 *
 * This section used to render one numbered bullet per `groupFindings` group
 * under a `## Grouping` directive — a partition the seed had already decided
 * before the planner read a word of it, and at a grain (`groupFindings`'s) the
 * planner's cohesion judgment never got to review. The measured result was a
 * sweep of 44 findings arriving as 18 Stories. The seed now states what was
 * found and lets N reach the planner undecided; container grouping is Gate
 * #3's call at persist, where N is known.
 *
 * @param {object[]} findings
 * @returns {string}
 */
function formatFindingsList(findings) {
  return findings
    .map((f) => {
      const label = DIMENSION_LABEL[f.dimension] ?? f.dimension;
      const file = f.files?.[0] ? ` (\`${f.files[0]}\`)` : '';
      const severity = f.severity ? `${f.severity} · ` : '';
      return `- **${f.title}** — ${severity}${label}${file}`;
    })
    .join('\n');
}

/**
 * The machine-readable dedup identity, one footer set per group.
 *
 * Deliberately **not** folded into one footer over the whole sweep, and
 * deliberately not attached to a visible bullet. Each group's fingerprint and
 * location-based semantic-key footers are the identity the next sweep matches
 * on (Story #4626), and the `audit::*` labels are the reason it ever looks at
 * the issue at all — an indexed sweep answers exact lookups from the labelled
 * pool without reaching the provider, so a Story missing the labels is
 * invisible however good its fingerprints (Story #5307). They are HTML
 * comments, so they carry no partition to the planner's eye while staying
 * byte-identical to what the standalone-Stories path emits.
 *
 * @param {object[]} groups
 * @returns {string}
 */
function formatDedupFooters(groups) {
  return groups
    .map((g) => {
      const findings = Array.isArray(g.findings) ? g.findings : [];
      return [
        renderFingerprintFooter(findings),
        renderSemanticKeyFooter(findings),
        auditLabelFooterForFindings(findings),
      ].join('\n');
    })
    .join('\n');
}

function formatKeyFiles(groups) {
  const files = new Set();
  for (const g of groups) for (const f of g.files) files.add(f);
  if (files.size === 0) return '_(no concrete file paths surfaced)_';
  return [...files]
    .sort()
    .map((f) => `- \`${f}\``)
    .join('\n');
}

function formatKeyAssumptions(sourceReports) {
  const unique = [...new Set(sourceReports)].sort();
  if (unique.length === 0) return '- _(no source audit reports)_';
  return unique.map((r) => `- Findings sourced from \`${r}\``).join('\n');
}

/**
 * @param {object} params
 * @param {Array<object>} params.groups — output of `groupFindings`, after dedupe filter.
 * @param {Array<object>} params.findings — full filtered finding list.
 * @param {string[]} params.sourceReports — list of source report paths.
 * @returns {string}
 */
/**
 * @param {{ groups: object[], findings: object[], sourceReports: object[] }} opts
 * @returns {string} The `/mandrel-plan` seed one-pager.
 */
export function buildPlanSeedMarkdown({ groups, findings, sourceReports }) {
  if (
    !Array.isArray(groups) ||
    !Array.isArray(findings) ||
    !Array.isArray(sourceReports)
  ) {
    throw new Error(
      'buildPlanSeedMarkdown: groups, findings, sourceReports must all be arrays',
    );
  }
  const problem = formatProblemStatement(findings);
  const direction = formatRecommendedDirection(findings);
  const scope = formatFindingsList(findings);
  const files = formatKeyFiles(groups);
  const assumptions = formatKeyAssumptions(sourceReports);
  const dedupFooters = formatDedupFooters(groups);

  return [
    '# Idea Seed: Audit Remediation',
    '',
    '## Problem Statement',
    '',
    problem,
    '',
    '## Recommended Direction',
    '',
    direction || '_(no recommendations captured)_',
    '',
    '## Key Assumptions',
    '',
    assumptions,
    '',
    '## MVP Scope',
    '',
    scope || '_(no findings)_',
    '',
    dedupFooters,
    '',
    '## Key Files',
    '',
    files,
    '',
    '## Not Doing',
    '',
    '- Findings with severity below the operator-selected threshold.',
    '- Re-occurring findings already tracked in closed issues (re-open manually if needed).',
    '',
  ].join('\n');
}
