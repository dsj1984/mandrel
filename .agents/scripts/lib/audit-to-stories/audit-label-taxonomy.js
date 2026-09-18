/**
 * The closed set of labels an audit sweep may create or generate — the one
 * list both the bootstrap (creator) and the Story-body builder (generator)
 * read, so the creator cannot fall behind the generator.
 */

import { auditLabelFooter } from '../findings/route-finding.js';
import {
  AGENT_LABELS,
  LABEL_COLORS,
  RISK_LABELS,
  TYPE_LABELS,
} from '../label-constants.js';
import { AUDIT_LENSES, auditLabelsForFindings } from './audit-lenses.js';

/** A lens absent here falls back to {@link DEFAULT_LENS_META}. */
const LENS_META = Object.freeze({
  accessibility: {
    color: 'c5def5',
    description: 'Audit-sourced finding: WCAG accessibility conformance',
  },
  architecture: {
    color: '6f42c1',
    description: 'Audit-sourced finding: architectural concerns',
  },
  'clean-code': {
    color: '0e8a16',
    description: 'Audit-sourced finding: clean-code / maintainability',
  },
  dependencies: {
    color: 'd4c5f9',
    description: 'Audit-sourced finding: dependencies / supply chain',
  },
  devops: {
    color: 'fbca04',
    description: 'Audit-sourced finding: DevOps / CI / CD',
  },
  documentation: {
    color: '1d76db',
    description: 'Audit-sourced finding: documentation staleness / gaps',
  },
  navigability: {
    color: 'bfdadc',
    description: 'Audit-sourced finding: route / nav reachability',
  },
  performance: {
    color: 'b60205',
    description: 'Audit-sourced finding: performance / latency',
  },
  privacy: {
    color: 'fef2c0',
    description: 'Audit-sourced finding: privacy / data handling',
  },
  quality: {
    color: '0052cc',
    description: 'Audit-sourced finding: test quality / coverage gaps',
  },
  security: {
    color: 'b60205',
    description: 'Audit-sourced finding: security / OWASP',
  },
  seo: {
    color: 'fbca04',
    description: 'Audit-sourced finding: SEO / discoverability',
  },
  sre: {
    color: '0052cc',
    description: 'Audit-sourced finding: SRE / observability / reliability',
  },
  'ux-ui': {
    color: 'd4c5f9',
    description: 'Audit-sourced finding: UX / UI concerns',
  },
});

const DEFAULT_LENS_META = Object.freeze({
  color: 'ededed',
  description: 'Audit-sourced finding',
});

/** `gh label create --color` wants a bare hex triplet, not a CSS `#rrggbb`. */
function hex(color) {
  return String(color).replace('#', '');
}

/** Derived from the same `AUDIT_LENSES` SSOT the generator uses. */
const AUDIT_LENS_LABELS = Object.freeze(
  AUDIT_LENSES.map((name) => ({
    name: `audit::${name}`,
    ...(LENS_META[name] ?? DEFAULT_LENS_META),
  })),
);

/**
 * Overlaps the repo-wide taxonomy on purpose (re-creating is a no-op), so an
 * audit sweep does not depend on the repo-wide bootstrap having run.
 */
const AUDIT_STORY_AXIS_LABELS = Object.freeze([
  {
    name: TYPE_LABELS.STORY,
    color: hex(LABEL_COLORS.TYPE),
    description: 'Story work item',
  },
  // Created, never generated: `/mandrel-plan` applies it after enrichment.
  // A creator-only entry is safe; the guarded drift is generator-only names.
  {
    name: AGENT_LABELS.READY,
    color: hex(LABEL_COLORS.AGENT),
    description:
      'Parking state — frozen dispatch manifest exists; awaiting local /mandrel-deliver',
  },
  {
    name: RISK_LABELS.HIGH,
    color: hex(LABEL_COLORS.RISK_HIGH),
    description:
      'Planning/audit metadata: review this first (Critical finding present)',
  },
]);

export const AUDIT_LABEL_TAXONOMY = Object.freeze([
  ...AUDIT_LENS_LABELS,
  ...AUDIT_STORY_AXIS_LABELS,
]);

const DEFINED_NAMES = new Set(AUDIT_LABEL_TAXONOMY.map((l) => l.name));

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function definesAuditLabel(name) {
  return typeof name === 'string' && DEFINED_NAMES.has(name);
}

/**
 * The dedup corpus is listed by `audit::*` label, so a Story filed without one
 * is invisible to an indexed run; the seed carries the labels so the planning
 * path stamps them. Lives here (not in audit-lenses) to avoid an import cycle.
 *
 * @param {Array<object>} findings
 * @returns {string} the footer, or '' when no finding resolves to a label.
 */
export function auditLabelFooterForFindings(findings) {
  return auditLabelFooter(
    auditLabelsForFindings(findings).filter(definesAuditLabel),
  );
}
