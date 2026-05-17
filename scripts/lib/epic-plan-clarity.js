/**
 * epic-plan-clarity.js — Phase 6 Epic Clarity Gate scoring.
 *
 * Pure, deterministic rubric: parse the Epic body for the five canonical
 * sections defined by `.agents/templates/epic-from-idea.md` (Problem,
 * Direction, Assumptions, MVP Scope, Not Doing) and emit a verdict of
 * `clear` (≥ 4 of 5 sections present) or `needs-refinement` along with a
 * gap list for the refinement loop seed.
 *
 * Heading variants matched per Story #2128 / Phase 6:
 *   - `## Problem` or `## Problem Statement`
 *   - `## Direction` or `## Recommended Direction`
 *   - `## Assumptions`, `## Key Assumptions`, or `## Key Assumptions to Validate`
 *   - `## MVP Scope`
 *   - `## Not Doing` or `## Not Doing (and Why)`
 *
 * Pure ESM, no I/O.
 */

const SECTION_RE = {
  problem: /^##\s+Problem(?:\s+Statement)?\s*$/im,
  direction: /^##\s+(?:Recommended\s+)?Direction\s*$/im,
  assumptions: /^##\s+(?:Key\s+)?Assumptions(?:\s+to\s+Validate)?\s*$/im,
  mvpScope: /^##\s+MVP\s+Scope\s*$/im,
  notDoing: /^##\s+Not\s+Doing(?:\s+\(and\s+Why\))?\s*$/im,
};

/**
 * Canonical section names, in document order. Exported so callers (CLI,
 * tests, downstream tooling) can iterate without re-deriving the list.
 */
export const SECTION_NAMES = Object.freeze([
  'problem',
  'direction',
  'assumptions',
  'mvpScope',
  'notDoing',
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
 * }}
 */
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
  const verdict =
    presentCount >= CLEAR_THRESHOLD ? 'clear' : 'needs-refinement';

  return { verdict, sections, missingOrPlaceholder };
}
