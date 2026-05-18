/**
 * context.js — Phase 3 of the epic-plan-decompose pipeline (Story #2466).
 *
 * Builds the authoring context (PRD + Tech Spec bodies, heuristics, system
 * prompt, ticket cap) the host LLM / `epic-plan-decompose-author` Skill
 * consumes when producing the ticket JSON array.
 *
 * Extracted verbatim from `epic-plan-decompose.js`; both
 * `buildDecomposerSystemPrompt` and `buildDecompositionContext` retain
 * their public-export contract for the existing unit tests.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/context
 */

import { getLimits } from '../../../config-resolver.js';
import { renderDecomposerSystemPrompt } from '../../../templates/decomposer-prompts.js';
import { applyBudget } from '../../planning-context-budget.js';

export function buildDecomposerSystemPrompt(
  heuristics = [],
  { maxTickets } = {},
) {
  const base = renderDecomposerSystemPrompt({ maxTickets });
  const heuristicsStr =
    heuristics.length > 0
      ? `### RISK HEURISTICS (planning metadata if any apply):\n- ${heuristics.join('\n- ')}`
      : '';
  return `${base}${heuristicsStr ? `\n\n${heuristicsStr}` : ''}`;
}

function resolveHeuristics(config) {
  if (Array.isArray(config.planning?.riskHeuristics)) {
    return config.planning.riskHeuristics;
  }
  return config.agentSettings?.planning?.riskHeuristics || [];
}

function projectBudgetedEntry(item, ticket, mode) {
  if (mode === 'full') return { id: ticket.id, body: ticket.body };
  return { id: ticket.id, body: null, bodySummary: item };
}

async function fetchPlanningTickets(provider, epicId) {
  const epic = await provider.getEpic(epicId);
  if (!epic?.linkedIssues?.prd || !epic.linkedIssues.techSpec) {
    throw new Error(
      `[Decomposer] Epic #${epicId} is missing linked PRD or Tech Spec. Run the Epic Planner first.`,
    );
  }
  const [prd, techSpec] = await Promise.all([
    provider.getTicket(epic.linkedIssues.prd),
    provider.getTicket(epic.linkedIssues.techSpec),
  ]);
  return { epic, prd, techSpec };
}

/**
 * Build the authoring context the host LLM (or the
 * `epic-plan-decompose-author` Skill) needs to produce the ticket JSON.
 *
 * PRD and Tech Spec bodies are bounded by the planning-context budget
 * (Epic #817 Story 9). Pass `{ fullContext: true }` (CLI: `--full-context`)
 * to restore the unbounded full bodies.
 */
export async function buildDecompositionContext(
  epicId,
  provider,
  config = {},
  opts = {},
) {
  const { epic, prd, techSpec } = await fetchPlanningTickets(provider, epicId);
  const heuristics = resolveHeuristics(config);
  const limits = getLimits(config);
  const maxTickets = limits.maxTickets;
  const planningLimits = limits.planningContext;
  const { fullContext = false } = opts;
  const systemPrompt = buildDecomposerSystemPrompt(heuristics, { maxTickets });

  const budgeted = applyBudget(
    [
      { path: `prd-${prd.id}.md`, content: prd.body ?? '' },
      { path: `tech-spec-${techSpec.id}.md`, content: techSpec.body ?? '' },
    ],
    planningLimits,
    { fullContext },
  );
  const [prdItem, techSpecItem] = budgeted.items;
  return {
    epic: { id: epic.id, title: epic.title },
    prd: projectBudgetedEntry(prdItem, prd, budgeted.mode),
    techSpec: projectBudgetedEntry(techSpecItem, techSpec, budgeted.mode),
    heuristics,
    systemPrompt,
    maxTickets,
    contextMode: budgeted.mode,
  };
}
