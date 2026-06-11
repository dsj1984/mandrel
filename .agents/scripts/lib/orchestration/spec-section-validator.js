/**
 * spec-section-validator.js — Phase 7.5 Tech Spec post-authoring section gate.
 *
 * `/plan` Phase 7 authors a Tech Spec from documentation and the PRD.
 * Phase 8.3 (Holistic Consolidation) then reconciles the draft ticket array
 * against the Tech Spec's `## Delivery Slicing` section, which the
 * decompose-author skill uses as the capability-boundary anchor. When the
 * authored Tech Spec omits that section, the consolidation pass runs against
 * a void and produces groupings that reflect technical shape (cron jobs
 * together) rather than capability boundaries — observed on Epic #18 in
 * `dsj1984/athportal` (planned with v1.54.0).
 *
 * `validateSpecSections` parses a Tech Spec body for the required
 * `## Delivery Slicing` heading (accepting the casing/wording variants
 * below) and returns a deterministic `{ ok, missing[] }` envelope. The
 * caller (`epic-plan-spec-validate.js`) maps a non-empty `missing[]` to a
 * non-zero exit so Phase 8 decomposition cannot proceed against an
 * un-anchored spec.
 *
 * This is the Phase 8-side counterpart to the Phase 6 Epic Clarity Gate
 * ({@link ../epic-plan-clarity.js#scoreEpicBody}) — same detect-then-prompt
 * pattern, one phase later, but a hard gate (exit non-zero) rather than an
 * advisory rubric.
 *
 * Pure ESM, no I/O.
 */

/**
 * The single required Tech Spec section, with the heading variants the
 * Architect persona may emit. Matched case-insensitively against any
 * level-2 (`## `) heading.
 *
 *   - `## Delivery Slicing`   (canonical)
 *   - `## Delivery slicing`   (variant casing)
 *   - `## DELIVERY SLICING`   (variant casing)
 *   - `## Slicing`            (shorthand)
 */
const REQUIRED_SECTIONS = Object.freeze([
  {
    name: 'Delivery Slicing',
    /** Level-2 heading, allowing the `Delivery ` qualifier to be optional. */
    re: /^##\s+(?:Delivery\s+)?Slicing\s*$/im,
  },
]);

/**
 * Canonical names of the required sections, in document order. Exported so
 * callers (CLI, tests, downstream tooling) can iterate without re-deriving
 * the list.
 *
 * @type {readonly string[]}
 */
export const REQUIRED_SECTION_NAMES = Object.freeze(
  REQUIRED_SECTIONS.map((s) => s.name),
);

/**
 * Validate a Tech Spec body for the required post-authoring sections.
 *
 * @param {{ body: string }} [args]
 * @returns {{ ok: boolean, missing: string[], present: string[] }}
 *   `ok` is true when every required section heading is present. `missing`
 *   lists the canonical names of absent sections (empty when `ok`).
 *   `present` lists the canonical names that were found.
 */
export function validateSpecSections({ body } = {}) {
  const source = typeof body === 'string' ? body : '';

  const present = [];
  const missing = [];
  for (const section of REQUIRED_SECTIONS) {
    if (section.re.test(source)) {
      present.push(section.name);
    } else {
      missing.push(section.name);
    }
  }

  return { ok: missing.length === 0, missing, present };
}
