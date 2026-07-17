/**
 * decomposer-context.js — system-prompt builder for the `/plan` authoring
 * pass (Story #2466; v2 keeps the prompt helper, drops the Epic-fetch
 * decomposition envelope).
 *
 * `buildDecomposerSystemPrompt` is the live surface consumed by
 * `plan-context.js#buildSystemPrompts`. The retired
 * `buildDecompositionContext` Epic-fetch path lived here until the
 * Story-only cutover removed every caller.
 */

import { renderDecomposerSystemPrompt } from '../../templates/decomposer-prompts.js';

export function buildDecomposerSystemPrompt(
  heuristics = [],
  { maxTickets } = {},
) {
  const base = renderDecomposerSystemPrompt({
    maxTickets,
  });
  const heuristicsStr =
    heuristics.length > 0
      ? `### RISK HEURISTICS (planning metadata if any apply):\n- ${heuristics.join('\n- ')}`
      : '';
  return `${base}${heuristicsStr ? `\n\n${heuristicsStr}` : ''}`;
}
