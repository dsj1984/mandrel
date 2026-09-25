// scripts/lib/audit-report-contracts/security-report-contract.js
import { assertSectionsContract } from './report-contract-core.js';

/**
 * The `audit-security` report contract (Epic #3597, Story #3613).
 *
 * This is the **single source of truth** for the report shape the lens
 * (`.agents/workflows/audit-security.md` Step 3) MUST emit to
 * `{{auditOutputDir}}/audit-security-results.md`. Keeping it here lets the
 * contract-tier test assert report conformance against one definition rather
 * than re-deriving headings from prose.
 *
 * @module audit-report-contracts/security-report-contract
 */

/** The artifact filename the lens writes under `auditOutputDir`. */
export const REPORT_ARTIFACT_BASENAME = 'audit-security-results.md';

/**
 * The required top-level (`##`) section headings, in document order, that the
 * lens markdown's Step 3 template defines. A conformant report MUST contain
 * each of these headings.
 */
export const REQUIRED_SECTIONS = Object.freeze([
  'Executive Summary',
  'Detailed Findings',
  'Defensive Recommendations',
]);

/** The H1 title the report opens with. */
export const REPORT_TITLE = 'Security Audit Report';

/**
 * The required field labels inside each `### <finding>` block under
 * `## Detailed Findings`. Mirrors the strict per-finding structure in the
 * lens template.
 */
export const FINDING_FIELDS = Object.freeze([
  'Dimension',
  'Severity',
  'CWE ID',
  'Current State',
  'Recommendation & Rationale',
  'Agent Prompt',
]);

/**
 * The severity buckets the Executive Summary risk profile and per-finding
 * `Severity` field draw from. The lens speaks in High/Medium/Low (with
 * Critical as the top High band); this list is the canonical taxonomy the
 * downstream `audit-to-stories` consumer maps onto Story priority.
 */
export const SEVERITY_LEVELS = Object.freeze([
  'Critical',
  'High',
  'Medium',
  'Low',
]);

/**
 * Assert that a rendered markdown report conforms to the contract: it has the
 * H1 title and every required `##` section heading. Returns a structured
 * result rather than throwing, so callers (the
 * contract tests) can report precisely which sections are missing.
 *
 * Pure function — string analysis only.
 *
 * @param {string} markdown - The rendered report body.
 * @returns {{ conformant: boolean, missingSections: string[], hasTitle: boolean }}
 */
export function assertReportContract(markdown) {
  return assertSectionsContract(markdown, {
    title: REPORT_TITLE,
    requiredSections: REQUIRED_SECTIONS,
  });
}
