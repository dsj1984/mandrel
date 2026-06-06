// .agents/scripts/lib/dynamic-workflow/clean-code-report-contract.js
import { assertSectionsContract } from './report-contract-core.js';

/**
 * The `audit-clean-code` report contract (Story #3278).
 *
 * This is the **single source of truth** for the report shape that BOTH the
 * sequential lens (`.agents/workflows/audit-clean-code.md` Step 3) and the
 * orchestrated dynamic-workflow path
 * (`.claude/workflows/audit-clean-code.workflow.js`) MUST emit to
 * `{{auditOutputDir}}/audit-clean-code-results.md`. Keeping it here lets the
 * contract-tier test assert report conformance against one definition rather
 * than re-deriving headings from prose in two places.
 *
 * This module documents the **existing** report shape; it does not introduce
 * a new one. Changing the report contract is a separate, deliberate decision —
 * not a side effect of the dual-path orchestration work.
 *
 * @module dynamic-workflow/clean-code-report-contract
 */

/** The artifact filename the lens writes under `auditOutputDir`. */
export const REPORT_ARTIFACT_BASENAME = 'audit-clean-code-results.md';

/**
 * The required top-level (`##`) section headings, in document order, that the
 * lens markdown's Step 3 template defines. A conformant report MUST contain
 * each of these headings; the orchestrated path assembles its sub-agent
 * findings into exactly this skeleton.
 */
export const REQUIRED_SECTIONS = Object.freeze([
  'Executive Summary',
  'Detailed Findings',
  'Dead Code Inventory',
  'Technical Debt Backlog',
]);

/** The H1 title the report opens with. */
export const REPORT_TITLE = 'Clean Code Audit Report';

/**
 * The required field labels inside each `### <finding>` block under
 * `## Detailed Findings`. Mirrors the strict per-finding structure in the
 * lens template.
 */
export const FINDING_FIELDS = Object.freeze([
  'Dimension',
  'Impact',
  'Current State',
  'Recommendation & Rationale',
  'Agent Prompt',
]);

/**
 * The Dead Code Inventory table column headers, in order.
 */
export const DEAD_CODE_COLUMNS = Object.freeze([
  'File',
  'Symbol / Block',
  'Type',
  'Estimated LOC',
]);

/**
 * Assert that a rendered markdown report conforms to the contract: it has the
 * H1 title and every required `##` section heading. Returns a structured
 * result rather than throwing, so callers (tests, the orchestrated path's
 * self-check) can report precisely which sections are missing.
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
