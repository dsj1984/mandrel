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

import {
  getLimits,
  resolvePreflightCeilings,
} from '../../../config-resolver.js';
import { renderDecomposerSystemPrompt } from '../../../templates/decomposer-prompts.js';
import { read as readPlanState } from '../../epic-plan-state-store.js';
import { applyBudget } from '../../planning-context-budget.js';

export function buildDecomposerSystemPrompt(
  heuristics = [],
  { maxTickets, maxTokenBudget } = {},
) {
  const base = renderDecomposerSystemPrompt({ maxTickets, maxTokenBudget });
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

/**
 * Read the persisted planning decision for the Epic so the decomposition
 * authoring step (Phase 8) can cite the same risk classification the
 * gate routing used in Phase 7. The decision lives in the `epic-plan-state`
 * structured comment written by `epic-plan-spec.js`.
 *
 * Returns `{ planningRisk: null, reviewRouting: null }` when the comment
 * is missing (older plans planned before Story #2801 landed) or when the
 * payload predates the fields. The null sentinels are part of the
 * decomposition context contract — callers MUST be able to JSON.stringify
 * the result without losing the keys.
 *
 * @param {import('../../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} epicId
 * @returns {Promise<{ planningRisk: object | null, reviewRouting: object | null }>}
 */
async function readPlanningDecision(provider, epicId) {
  let state = null;
  try {
    state = await readPlanState({ provider, epicId });
  } catch (_err) {
    // `read` already swallows JSON parse errors; a thrown error here
    // means the provider couldn't fetch comments. Treat as null state —
    // the decomposer can still author tickets without the risk envelope.
    state = null;
  }
  if (!state || typeof state !== 'object') {
    return { planningRisk: null, reviewRouting: null };
  }
  return {
    planningRisk: state.planningRisk ?? null,
    reviewRouting: state.reviewRouting ?? null,
  };
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
  const { planningRisk, reviewRouting } = await readPlanningDecision(
    provider,
    epicId,
  );
  const heuristics = resolveHeuristics(config);
  const limits = getLimits(config);
  const maxTickets = limits.maxTickets;
  const maxTokenBudget = limits.maxTokenBudget;
  const planningLimits = limits.planningContext;
  const { fullContext = false } = opts;
  const systemPrompt = buildDecomposerSystemPrompt(heuristics, {
    maxTickets,
    maxTokenBudget,
  });

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
    // Story #3875 — surface the real delivery envelope to the decomposer
    // so Stories are sized against the hydration budget and the
    // configured preflight ceilings rather than guessed. Story #4162 also
    // threads this value into the rendered systemPrompt above as a sizing
    // input so the prompt itself names the budget.
    maxTokenBudget,
    preflightCeilings: resolvePreflightCeilings(config),
    contextMode: budgeted.mode,
    // Story #2801 — surface the Phase 7 planning decision so the
    // decomposition authoring step can cite the same risk
    // classification used by gate routing. Both fields are `null`
    // when the Epic was planned before the decision contract existed.
    planningRisk,
    reviewRouting,
  };
}
