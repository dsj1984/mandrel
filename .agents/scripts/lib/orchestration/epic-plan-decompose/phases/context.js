/**
 * context.js — Phase 3 of the epic-plan-decompose pipeline (Story #2466).
 *
 * Builds the authoring context (the Epic body — which carries the folded
 * Tech Spec sections and Acceptance Table per Story #4324 — plus
 * heuristics, system prompt, ticket cap) the host LLM /
 * `epic-plan-decompose-author` Skill consumes when producing the ticket
 * JSON array.
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
import { hasTechSpecContent } from '../../../epic-body-sections.js';
import { renderDecomposerSystemPrompt } from '../../../templates/decomposer-prompts.js';
import { read as readPlanState } from '../../epic-plan-state-store.js';
import { applyBudget } from '../../planning-context-budget.js';

export function buildDecomposerSystemPrompt(
  heuristics = [],
  { maxTickets, maxTokenBudget, epicId } = {},
) {
  const base = renderDecomposerSystemPrompt({
    maxTickets,
    maxTokenBudget,
    epicId,
  });
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

async function fetchPlanningEpic(provider, epicId) {
  const epic = await provider.getEpic(epicId);
  if (!epic || !hasTechSpecContent(epic.body ?? '')) {
    throw new Error(
      `[Decomposer] Epic #${epicId} body carries no Tech Spec sections (no ## Delivery Slicing). Run the Epic Planner (Phase 7) first.`,
    );
  }
  return { epic };
}

/**
 * Build the authoring context the host LLM (or the
 * `epic-plan-decompose-author` Skill) needs to produce the ticket JSON.
 *
 * The Epic body (ideation sections + folded Tech Spec sections +
 * Acceptance Table — the AC-ID source for wave-0 BDD scaffold tags) is
 * bounded by the planning-context budget (Epic #817 Story 9). Pass
 * `{ fullContext: true }` (CLI: `--full-context`) to restore the
 * unbounded full body.
 */
export async function buildDecompositionContext(
  epicId,
  provider,
  config = {},
  opts = {},
) {
  const { epic } = await fetchPlanningEpic(provider, epicId);
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
    epicId,
  });

  const budgeted = applyBudget(
    [{ path: `epic-${epic.id}.md`, content: epic.body ?? '' }],
    planningLimits,
    { fullContext },
  );
  const [epicItem] = budgeted.items;
  return {
    epic: { id: epic.id, title: epic.title },
    // Story #4324 — the Epic body is the single planning document: it
    // carries the ideation sections, the folded Tech Spec sections
    // (## Delivery Slicing first), and the ## Acceptance Table the wave-0
    // BDD scaffold reads its AC IDs from.
    epicBody: projectBudgetedEntry(epicItem, epic, budgeted.mode),
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
