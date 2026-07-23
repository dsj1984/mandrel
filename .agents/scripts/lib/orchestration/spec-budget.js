/**
 * lib/orchestration/spec-budget.js — the soft `## Spec` word-budget pass
 * (Story #4723), extracted from `ticket-validator.js` so the advisory
 * length nudge lives beside neither the hard validators nor their error
 * channel: everything here is `'soft'` by construction and can never fail
 * a persist.
 */

import { parse as parseStoryBody } from '../story-body/story-body.js';

/**
 * Soft advisory word budget for a Story's inline `## Spec` (Story #4723).
 * ~250 words is the #4707 contract-level-prose target: interfaces,
 * invariants, and load-bearing constraints — not route-by-route behavior
 * narration. Distinct from the hard ~1500-token fail-closed ceiling in
 * `spec-spill.js`: this budget only warns; it never fails the persist.
 */
export const SPEC_SOFT_WORD_BUDGET = 250;

/**
 * Resolve a Story's Spec prose across both authoring shapes: the canonical
 * serialized string body (parsed; `## Spec` text block) and the
 * pre-serialize structured object body (`body.spec`). Returns `''` when
 * absent — or when a string body does not parse: this pass is advisory, so
 * an unreadable body contributes no finding here and is left to the hard
 * parse gate (`assertStoryBodiesParse`) to reject.
 *
 * @param {object} story
 * @returns {string}
 */
function resolveSpecText(story) {
  const body = story?.body;
  if (typeof body === 'string' && body.trim().length > 0) {
    let spec;
    try {
      spec = parseStoryBody(body).body.spec;
    } catch {
      return '';
    }
    return typeof spec === 'string' ? spec : '';
  }
  if (body !== null && typeof body === 'object') {
    return typeof body?.spec === 'string' ? body.spec : '';
  }
  return '';
}

/**
 * Advisory `## Spec` length pass (Story #4723). Emits one `'soft'` finding
 * per Story whose Spec prose exceeds {@link SPEC_SOFT_WORD_BUDGET} words,
 * nudging the author toward contract-level prose (#4707). Soft only — the
 * findings never reach the validator's `errors[]` channel, so an
 * over-budget Spec never fails the persist.
 *
 * @param {{ stories: object[] }} opts
 * @returns {object[]} Zero or more `spec-word-budget` findings.
 */
export function computeSpecBudgetFindings({ stories }) {
  const findings = [];
  for (const story of stories ?? []) {
    const words = resolveSpecText(story).split(/\s+/).filter(Boolean).length;
    if (words <= SPEC_SOFT_WORD_BUDGET) continue;
    findings.push({
      kind: 'spec-word-budget',
      severity: 'soft',
      ticketSlug: story.slug ?? '<unknown>',
      words,
      budget: SPEC_SOFT_WORD_BUDGET,
      message:
        `Story "${story.slug ?? '<unknown>'}" ## Spec is ~${words} words ` +
        `(soft budget ${SPEC_SOFT_WORD_BUDGET}). Prefer contract-level prose ` +
        '(interfaces, invariants, load-bearing constraints with their why) ' +
        'over per-file behavior narration — advisory only; the persist ' +
        'proceeds.',
    });
  }
  return findings;
}
