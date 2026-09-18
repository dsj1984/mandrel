/**
 * Render the `/mandrel-plan --seed` one-pager for the single-plan audit path.
 * Pure: returns a string.
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
 * Flat, not grouped: the seed must not pre-decide the Story partition; that
 * is the planner's cohesion call.
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
 * Per-group dedup footers (fingerprint, semantic key, `audit::*` labels) as
 * HTML comments: invisible to the planner, byte-identical to the standalone
 * path. Without the labels an indexed sweep never sees the Story.
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
