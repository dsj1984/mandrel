// .agents/scripts/lib/dynamic-workflow/quality-report-contract.js
import { assertSectionsContract } from './report-contract-core.js';

/**
 * The `audit-quality` report contract (Epic #3597, Story #3614).
 *
 * This is the **single source of truth** for the report shape that BOTH the
 * sequential lens (`.agents/workflows/audit-quality.md` Step 3) and the
 * orchestrated dynamic-workflow path
 * (`.claude/workflows/audit-quality.workflow.js`) MUST emit to
 * `{{auditOutputDir}}/audit-quality-results.md`. Keeping it here lets the
 * contract-tier test assert report conformance against one definition rather
 * than re-deriving headings from prose in two places.
 *
 * Generalising the orchestrated dual path to the quality lens is explicitly
 * **report-contract-preserving** — this module documents the existing shape the
 * sequential lens already emits, it does not introduce a new one.
 *
 * @module dynamic-workflow/quality-report-contract
 */

/** The artifact filename the lens writes under `auditOutputDir`. */
export const REPORT_ARTIFACT_BASENAME = 'audit-quality-results.md';

/**
 * The required top-level (`##`) section headings, in document order, that the
 * lens markdown's Step 3 template defines. A conformant report MUST contain
 * each of these headings; the orchestrated path assembles its cross-checked
 * findings into exactly this skeleton.
 */
export const REQUIRED_SECTIONS = Object.freeze([
  'Executive Summary',
  'Test Strategy Assessment',
  'Detailed Findings',
]);

/** The H1 title the report opens with. */
export const REPORT_TITLE = 'Testing & Quality Assurance Audit';

/**
 * The required field labels inside each `### <finding>` block under
 * `## Detailed Findings`. Mirrors the strict per-finding structure in the
 * lens template.
 */
export const FINDING_FIELDS = Object.freeze([
  'Category',
  'Impact',
  'Current State',
  'Recommendation & Rationale',
  'Agent Prompt',
]);

/**
 * The finding categories the per-finding `Category` field draws from. These
 * mirror the lens's Step 3 template enumeration and the Step 2 analysis
 * dimensions the quality audit decomposes into.
 */
export const FINDING_CATEGORIES = Object.freeze([
  'Flakiness',
  'Coverage',
  'Performance',
  'Mocking',
  'Test Plans',
]);

/**
 * The impact buckets the Executive Summary and per-finding `Impact` field draw
 * from. The lens speaks in High/Medium/Low; this list is the canonical
 * taxonomy the downstream `audit-to-stories` consumer maps onto Story
 * priority.
 */
export const IMPACT_LEVELS = Object.freeze(['High', 'Medium', 'Low']);

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
