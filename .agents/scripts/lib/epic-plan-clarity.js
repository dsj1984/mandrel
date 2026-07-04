/**
 * epic-plan-clarity.js — Phase 6 Epic Clarity Gate scoring.
 *
 * Pure, deterministic rubric: parse the Epic body for the five canonical
 * sections defined by `.agents/templates/epic-from-idea.md` (Context,
 * Goal, Non-Goals, Scope, Acceptance Criteria) and emit a verdict of
 * `clear` or `needs-refinement` along with a gap list for the refinement
 * loop seed.
 *
 * Verdict rule: `clear` requires **both** (a) ≥ 4 of 5 canonical sections
 * present, **and** (b) the **Acceptance Criteria** section present. The
 * Acceptance-Criteria requirement is load-bearing: a downstream
 * `/deliver` start gate and the close-time acceptance-spec reconciler
 * both assume the Epic carries acceptance criteria, so a gate that passed an
 * Epic with no Acceptance Criteria (the pre-Story-#3910 `≥ 4 of 5` behaviour)
 * advertised a clarity guarantee it did not provide. AC is now a required
 * section, not one of the four optional passers.
 *
 * Heading variants accepted per canonical section (back-compat with the
 * pre-canonical-headings ideation shape):
 *   - `## Context`, `## Background`, `## Problem`, `## Problem Statement`,
 *     `## Context & Problem`
 *   - `## Goal`, `## Goals`, `## Objective`, `## Objectives`,
 *     `## Direction`, `## Recommended Direction`
 *   - `## Non-Goals`, `## Non Goals`, `## Out of Scope`, `## Not Doing`,
 *     `## Not Doing (and Why)`
 *   - `## Scope`, `## Scope (...)`, `## MVP Scope`, `## Proposed Scope`,
 *     `## Work Breakdown`
 *   - `## Acceptance Criteria`, `## Acceptance`, `## AC`
 *
 * Story #4324 folded the Tech Spec and Acceptance Spec into the Epic body
 * as managed sections (`## Delivery Slicing`-led spec sections and the
 * `## Acceptance Table`). The gate *recognises* those planning sections —
 * reporting their presence under `planningSections[]` so a post-fold Epic
 * body scores exactly as its ideation content deserves — but they never
 * count toward (or against) the five-ideation-section verdict: Phase 6
 * runs before Phase 7 authors them, and a re-planned Epic that already
 * carries them must not be penalised or auto-passed by their presence.
 *
 * Pure ESM, no I/O.
 */

const SECTION_RE = {
  context:
    /^##\s+(?:Context(?:\s+&\s+Problem)?|Background|Problem(?:\s+Statement)?)\s*$/im,
  goal: /^##\s+(?:Goals?|Objectives?|(?:Recommended\s+)?Direction)\s*$/im,
  nonGoals:
    /^##\s+(?:Non[\s-]?Goals|Out\s+of\s+Scope|Not\s+Doing(?:\s+\(and\s+Why\))?)\s*$/im,
  scope:
    /^##\s+(?:MVP\s+|Proposed\s+)?Scope(?:\s+\([^)]+\))?\s*$|^##\s+Work\s+Breakdown\s*$/im,
  acceptanceCriteria: /^##\s+(?:Acceptance(?:\s+Criteria)?|AC)\s*$/im,
};

/**
 * Canonical section names, in document order. Exported so callers (CLI,
 * tests, downstream tooling) can iterate without re-deriving the list.
 */
export const SECTION_NAMES = Object.freeze([
  'context',
  'goal',
  'nonGoals',
  'scope',
  'acceptanceCriteria',
]);

/**
 * Post-fold planning sections (Story #4324) — recognised and reported,
 * never scored. `deliverySlicing` accepts the same heading variants as
 * `spec-section-validator.js`.
 */
const PLANNING_SECTION_RE = {
  deliverySlicing: /^##\s+(?:Delivery\s+)?Slicing\s*$/im,
  acceptanceTable: /^##\s+Acceptance\s+Table\s*$/im,
};

/**
 * Names of the recognised (unscored) planning sections, in document order.
 * Module-private: consumers read the reported `planningSections[]` rows on
 * the scoreEpicBody result rather than importing the name list.
 */
const PLANNING_SECTION_NAMES = Object.freeze([
  'deliverySlicing',
  'acceptanceTable',
]);

const CLEAR_THRESHOLD = 4;
const PLACEHOLDER_PATTERN = /^_\(not\s+specified\)_$/i;

/**
 * Classify a section's content as `present`, `placeholder`, or `missing`.
 *
 * @param {string|null} content - The text between this heading and the next
 *   `## ` heading (or EOF). `null` when the heading was not found.
 * @returns {'present' | 'placeholder' | 'missing'}
 */
function classify(content) {
  if (content === null) return 'missing';
  const trimmed = content.trim();
  if (trimmed.length === 0) return 'placeholder';
  if (PLACEHOLDER_PATTERN.test(trimmed)) return 'placeholder';
  return 'present';
}

/**
 * Score an Epic body against the five canonical sections.
 *
 * @param {{ body: string }} args
 * @returns {{
 *   verdict: 'clear' | 'needs-refinement',
 *   sections: Array<{ name: string, status: 'present' | 'placeholder' | 'missing' }>,
 *   missingOrPlaceholder: string[],
 *   planningSections: Array<{ name: string, status: 'present' | 'missing' }>,
 * }}
 */
const REQUIRED_SECTION = 'acceptanceCriteria';

export function scoreEpicBody({ body } = {}) {
  const source = typeof body === 'string' ? body : '';

  // First pass: locate every canonical heading and its byte offset so we
  // can slice the section body up to the next `## ` heading or EOF.
  const headingHits = [];
  for (const name of SECTION_NAMES) {
    const re = SECTION_RE[name];
    const m = source.match(re);
    if (m && typeof m.index === 'number') {
      headingHits.push({
        name,
        start: m.index,
        headingLength: m[0].length,
      });
    }
  }
  headingHits.sort((a, b) => a.start - b.start);

  // Generic next-heading regex (any `## ` heading, including non-canonical
  // ones the author may have added between canonical sections).
  const NEXT_HEADING_RE = /^##\s+/m;

  /** @type {Map<string, string>} */
  const contentByName = new Map();
  for (const hit of headingHits) {
    const sliceStart = hit.start + hit.headingLength;
    const rest = source.slice(sliceStart);
    const nextMatch = rest.match(NEXT_HEADING_RE);
    const sliceEnd =
      nextMatch && typeof nextMatch.index === 'number'
        ? sliceStart + nextMatch.index
        : source.length;
    contentByName.set(hit.name, source.slice(sliceStart, sliceEnd));
  }

  const sections = SECTION_NAMES.map((name) => {
    const content = contentByName.has(name) ? contentByName.get(name) : null;
    return { name, status: classify(content ?? null) };
  });

  const missingOrPlaceholder = sections
    .filter((s) => s.status !== 'present')
    .map((s) => s.name);

  const presentCount = sections.filter((s) => s.status === 'present').length;
  const requiredPresent = sections.some(
    (s) => s.name === REQUIRED_SECTION && s.status === 'present',
  );
  const verdict =
    presentCount >= CLEAR_THRESHOLD && requiredPresent
      ? 'clear'
      : 'needs-refinement';

  // Informational only: presence of the post-fold planning sections
  // (Story #4324). Never feeds the verdict.
  const planningSections = PLANNING_SECTION_NAMES.map((name) => ({
    name,
    status: PLANNING_SECTION_RE[name].test(source) ? 'present' : 'missing',
  }));

  return { verdict, sections, missingOrPlaceholder, planningSections };
}
