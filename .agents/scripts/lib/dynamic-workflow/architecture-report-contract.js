// .agents/scripts/lib/dynamic-workflow/architecture-report-contract.js
import { assertSectionsContract } from './report-contract-core.js';

/**
 * The `audit-architecture` report contract (Epic #3597, Story #3612).
 *
 * This is the **single source of truth** for the report shape that BOTH the
 * sequential lens (`.agents/workflows/audit-architecture.md` Step 3) and the
 * orchestrated dynamic-workflow path
 * (`.claude/workflows/audit-architecture.workflow.js`) MUST emit to
 * `{{auditOutputDir}}/audit-architecture-results.md`. Keeping it here lets the
 * contract-tier test assert report conformance against one definition rather
 * than re-deriving headings from prose in two places.
 *
 * Changing the report contract is explicitly **out of scope** for this Story —
 * the orchestrated path emits the lens's existing report contract unchanged.
 * This module documents the existing shape, it does not introduce a new one.
 *
 * @module dynamic-workflow/architecture-report-contract
 */

/** The artifact filename the lens writes under `auditOutputDir`. */
export const REPORT_ARTIFACT_BASENAME = 'audit-architecture-results.md';

/**
 * The required top-level (`##`) section headings, in document order, that the
 * lens markdown's Step 3 template defines. A conformant report MUST contain
 * each of these headings; the orchestrated path assembles its sub-agent
 * findings into exactly this skeleton.
 */
export const REQUIRED_SECTIONS = Object.freeze([
  'Executive Summary',
  'Triage Summary',
  'Architecture Guardrail Coverage',
  'Detailed Findings',
]);

/** The H1 title the report opens with. */
export const REPORT_TITLE = 'Architecture & Clean Code Review';

/**
 * The required field labels inside each `### <finding>` block under
 * `## Detailed Findings`. Mirrors the strict per-finding structure in the
 * lens template.
 */
export const FINDING_FIELDS = Object.freeze([
  'Category',
  'Dimension',
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
