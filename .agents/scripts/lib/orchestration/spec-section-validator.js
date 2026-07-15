/**
 * spec-section-validator.js — Tech Spec post-authoring section gate.
 *
 * `/plan` Phase 7 authors a Tech Spec from documentation and the Epic body.
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
 * below) and returns a deterministic `{ ok, missing[] }` envelope.
 *
 * Story #4403 (Finding 3): this gate used to be run by a standalone
 * `epic-plan-spec-validate.js` CLI as a separate Phase 7.5 workflow step —
 * but by the time the documented ordering ran it, the Phase 7 persist path's
 * `cleanupPhaseTempFiles` had already deleted the temp `techspec.md` file the
 * gate read, so the "blocking gate" could never actually block. The CLI is
 * retired; `runSpecPhase` (`phases/run-spec-phase.js`) now calls
 * `validateSpecSections` directly against the in-memory authored content as
 * part of its input validation, before any GitHub mutation. This is the
 * Phase 8-side counterpart to the retired Phase 6 Epic Clarity Gate —
 * same detect-then-prompt pattern, one phase later, but a hard gate
 * (fail closed) rather than an advisory rubric.
 *
 * `validateSpecSections` and `formatMissingSectionMessage` are pure, I/O-free
 * helpers. `validateSpecFile` is a thin disk-reading convenience for callers
 * (tests, ad-hoc tooling) that hold a path rather than in-memory content.
 */

import { readFile } from 'node:fs/promises';
import { DELIVERY_SLICING_RE } from '../ticket-body-sections.js';

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
    re: DELIVERY_SLICING_RE,
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

/**
 * Validate an authored Tech Spec file for the required post-authoring
 * sections. Thin wrapper around `validateSpecSections` that owns the file
 * read so callers holding a path (rather than in-memory content) do not each
 * re-implement the read-then-validate sequence.
 *
 * @param {{ techspecPath: string }} args
 * @returns {Promise<{ ok: boolean, missing: string[], present: string[] }>}
 */
export async function validateSpecFile({ techspecPath }) {
  const body = await readFile(techspecPath, 'utf8');
  return validateSpecSections({ body });
}

/**
 * Build the operator-facing failure message for a missing-section result.
 * Names each missing section and tells the operator whether to re-author the
 * spec or add the section by hand before continuing.
 *
 * @param {{ techspecPath: string, missing: string[] }} args
 * @returns {string}
 */
export function formatMissingSectionMessage({ techspecPath, missing }) {
  const list = missing.map((name) => `## ${name}`).join(', ');
  return [
    `[spec-section-validator] Tech Spec is missing required section(s): ${list}`,
    `  Spec source: ${techspecPath}`,
    '',
    `  Phase 8 (decomposition) reconciles the draft ticket array against the`,
    `  Tech Spec's "## Delivery Slicing" section — without it, the Phase 8.3`,
    `  consolidation pass has no capability-boundary anchor and groups by`,
    `  technical shape instead.`,
    '',
    '  To continue, do ONE of the following and re-run the Phase 7 persist step:',
    `    1. Re-author the Tech Spec (re-run the Phase 7 spec-author step) so it`,
    `       emits a "## Delivery Slicing" section, OR`,
    `    2. Add a "## Delivery Slicing" section to the Tech Spec by hand,`,
    `       describing the capability boundaries the work should be sliced along.`,
  ].join('\n');
}
