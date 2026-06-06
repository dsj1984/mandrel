// .agents/scripts/lib/dynamic-workflow/performance-report-contract.js
import { assertSectionsContract } from './report-contract-core.js';

/**
 * The `audit-performance` report contract (Epic #3597, Story #3611).
 *
 * This is the **single source of truth** for the report shape that BOTH the
 * sequential lens (`.agents/workflows/audit-performance.md` Step 3) and the
 * orchestrated dynamic-workflow path
 * (`.claude/workflows/audit-performance.workflow.js`) MUST emit to
 * `{{auditOutputDir}}/audit-performance-results.md`. Keeping it here lets the
 * contract-tier test assert report conformance against one definition rather
 * than re-deriving headings from prose in two places.
 *
 * Changing the report contract is explicitly **out of scope** for this Story —
 * this module documents the existing shape already declared by the lens
 * markdown's Step 3 template, it does not introduce a new one.
 *
 * @module dynamic-workflow/performance-report-contract
 */

/** The artifact filename the lens writes under `auditOutputDir`. */
export const REPORT_ARTIFACT_BASENAME = 'audit-performance-results.md';

/**
 * The required top-level (`##`) section headings, in document order, that the
 * lens markdown's Step 3 template defines. A conformant report MUST contain
 * each of these headings; the orchestrated path assembles its cross-checked
 * sub-agent findings into exactly this skeleton.
 *
 * The `Low-Hanging Fruit` section is the performance lens's distinguishing
 * section — the quick-win backlog the synthesis stage must always emit.
 */
export const REQUIRED_SECTIONS = Object.freeze([
  'Executive Summary',
  'Detailed Findings',
  'Low-Hanging Fruit',
]);

/** The H1 title the report opens with. */
export const REPORT_TITLE = 'Performance Audit Report';

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
