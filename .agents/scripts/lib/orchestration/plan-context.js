/**
 * plan-context.js — single planner-context envelope build (Epic #4474, M3
 * PR2 — `/plan` collapse step 1).
 *
 * Folds the two `--emit-context` halves of the 12-phase pipeline
 * (`buildAuthoringContext` from `epic-plan-spec/phases/authoring-context.js`
 * and `buildDecompositionContext` from
 * `epic-plan-decompose/phases/context.js`) plus the three currently-no-CLI
 * library calls (`findSimilarOpenEpics`, clarity scoring, re-plan
 * detection) into ONE JSON envelope, so the authoring middle reads a single
 * file instead of shim-scripting library imports (the bench measured
 * ~12–15 turns of shim-writing for the dup search alone).
 *
 * Two modes (the design's mode matrix):
 *   - `epic`      — the Epic exists. Carries `epic`, `clarity` (the Epic
 *                   Clarity Gate rubric — free, same body fetch), `replan`
 *                   (already-planned signals) and `planState`.
 *   - `one-pager` — ideation; the Epic does not exist yet (creation moves
 *                   to the persist half). Carries `onePager` and
 *                   `duplicates[]` (cross-Epic dup search). Clarity is not
 *                   scored — the ideation path is definitionally clear.
 *
 * All fields are JSON-serialisable; the module performs no GitHub writes.
 * The only I/O surfaces are the injected `provider` (reads) and the
 * best-effort local scans the folded builders already perform.
 */

import { readFile } from 'node:fs/promises';
import { getLimits, resolvePreflightCeilings } from '../config-resolver.js';
import { findSimilarOpenEpics } from '../duplicate-search.js';
import { hasEpicSection, hasTechSpecContent } from '../epic-body-sections.js';
import { scoreEpicBody } from '../epic-plan-clarity.js';
import { Logger } from '../Logger.js';
import {
  renderAcceptanceSpecSystemPrompt,
  renderTechSpecSystemPrompt,
} from '../templates/spec-author-prompts.js';
import { parseDeliverySlicingTable } from './consolidation-precondition.js';
import { buildDocsDigest } from './docs-digest.js';
import { buildDecomposerSystemPrompt } from './epic-plan-decompose/phases/context.js';
import { buildAuthoringContext } from './epic-plan-spec/phases/authoring-context.js';
import { read as readPlanState } from './epic-plan-state-store.js';

/**
 * Envelope byte ceiling (regression guard for the design's named PR2 risk:
 * two envelopes → one bigger one). The folded envelope's bounded parts are:
 * the `applyBudget`-capped body (`planningContext.maxBytes` = 50 KB), the
 * tier-capped codebase snapshot (~35 KB skinny on this repo), the three
 * rendered system prompts (~15 KB), and the digest-first `docsContext`
 * (outline-only, pointer in epic mode). Measured folded envelopes on this
 * repo land at ~42 KB; 256 KB (~64K tokens at the ≈4-chars/token estimate)
 * gives >2× headroom over a worst-case budgeted body + medium-tier snapshot
 * while staying an order of magnitude under the session budget. The test
 * suite asserts serialized envelopes stay under this value — raise it only
 * with a measured justification.
 */
export const PLAN_CONTEXT_ENVELOPE_BYTE_CEILING = 256_000;

/**
 * Compact, machine-readable descriptor of the `tickets.json` array the
 * authoring pass writes and `validateAndNormalizeTickets` gates at persist
 * time. A descriptor, not a validator: the deterministic gate stays in the
 * persist half (design § 1 step 3); this field exists so the authoring
 * middle knows the shape without re-reading the decomposer prompt prose.
 */
export const TICKET_SCHEMA_DESCRIPTOR = Object.freeze({
  shape: 'array',
  itemFields: Object.freeze({
    slug: 'string — ^[a-z0-9][a-z0-9-]*$ (hyphen-case, unique per decompose)',
    type: "string — literal 'story' (2-tier hierarchy: Epic → Story only)",
    title: 'string — short descriptive title',
    body: 'string — serialized Story-body markdown (never a JSON object)',
    acceptance: 'string[] — top-level testable criteria (not nested in body)',
    verify: 'string[] — top-level exact commands/test paths with (<tier>)',
    labels: "string[] — must include 'type::story' and one 'persona::*'",
    depends_on: 'string[]? — sibling Story slugs that block execution',
  }),
  validatedBy:
    'validateAndNormalizeTickets (lib/orchestration/ticket-validator.js) at persist time',
});

/**
 * Resolve the planning risk heuristics list from the canonical config
 * block (same resolution the decompose context uses).
 *
 * @param {object} config
 * @returns {string[]}
 */
function resolveRiskHeuristics(config = {}) {
  if (Array.isArray(config.planning?.riskHeuristics)) {
    return config.planning.riskHeuristics;
  }
  return config.agentSettings?.planning?.riskHeuristics || [];
}

/**
 * Count top-level enumerated items (`- `, `* `, `1. `) under the first
 * scope-shaped `## ` heading (Scope / MVP Scope / Proposed Scope / Work
 * Breakdown / Capabilities), up to the next `## ` heading. Returns `null`
 * when no scope-shaped heading exists — the caller treats that as "no
 * sizing signal" and defaults to fan-out.
 *
 * @param {string} body
 * @returns {number|null}
 */
function countScopeItems(body) {
  if (typeof body !== 'string' || body.length === 0) return null;
  const lines = body.split(/\r?\n/);
  const headingIdx = lines.findIndex((line) =>
    /^##\s+(?:(?:MVP\s+|Proposed\s+)?Scope(?:\s+\([^)]+\))?|Work\s+Breakdown|Capabilities)\s*$/i.test(
      line.trim(),
    ),
  );
  if (headingIdx === -1) return null;
  let count = 0;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break;
    if (/^\s*(?:[-*]|\d+\.)\s+\S/.test(line)) count += 1;
  }
  return count;
}

/**
 * Advisory single-vs-fan-out delivery-shape signal (design § 1 step 1;
 * routing pilot #4475). Derived from the same size/shape heuristics the
 * scope-triage rubric anchors to — the Delivery Slicing table when the Epic
 * body already carries one (slice count + "Independent?" chain shape,
 * via the Phase 8.3 precondition parser), else a scope-enumeration count.
 *
 * **Advisory only, fan-out by default.** This signal changes no routing
 * behaviour in this PR: the deliver-side reader is #4475's scope, and until
 * it lands the recommendation defaults to `fan-out` for every ambiguous
 * case. `single` is recommended only on clear one-pass indicators: a
 * slicing table proposing ≤ 2 slices, a pure dependent chain (zero
 * realized parallelism from the Story tier — the N=2 bench finding), or a
 * scope enumeration of ≤ 2 capabilities.
 *
 * @param {{ body: string }} args
 * @returns {{ recommendation: 'single'|'fan-out', reasons: string[], advisory: true }}
 */
export function buildDeliveryShapeSignal({ body } = {}) {
  const advisory = /** @type {const} */ (true);
  const rows = parseDeliverySlicingTable(body ?? '');

  if (Array.isArray(rows) && rows.length > 0) {
    if (rows.length <= 2) {
      return {
        recommendation: 'single',
        reasons: [
          `delivery-slicing table proposes ${rows.length} slice(s) — one-pass-sized`,
        ],
        advisory,
      };
    }
    const chain = rows.slice(1).every((r) => r.independent === false);
    if (chain) {
      return {
        recommendation: 'single',
        reasons: [
          `delivery-slicing table is a pure dependent chain (${rows.length} slices, every non-first slice "Independent? No") — zero parallelism value from Story fan-out`,
        ],
        advisory,
      };
    }
    return {
      recommendation: 'fan-out',
      reasons: [
        `delivery-slicing table proposes ${rows.length} slices with independent parallelism`,
      ],
      advisory,
    };
  }

  const scopeItems = countScopeItems(body ?? '');
  if (scopeItems !== null && scopeItems > 0 && scopeItems <= 2) {
    return {
      recommendation: 'single',
      reasons: [
        `scope enumerates ${scopeItems} capability item(s) — one-pass-sized`,
      ],
      advisory,
    };
  }
  if (scopeItems !== null && scopeItems > 2) {
    return {
      recommendation: 'fan-out',
      reasons: [`scope enumerates ${scopeItems} capability items`],
      advisory,
    };
  }
  return {
    recommendation: 'fan-out',
    reasons: [
      'no delivery-slicing table or scope enumeration to size against — defaulting to fan-out',
    ],
    advisory,
  };
}

/**
 * Re-plan detection signals (folds the workflow's Phase 5 into the
 * envelope): the Tech Spec sections alone are the already-planned signal;
 * the open-Story count and section presence let the authoring middle (and
 * the persist half's `--force` prompt) cite concrete numbers.
 *
 * `openStoryCount` is best-effort: a provider listing failure degrades to
 * `null` rather than aborting the envelope build.
 *
 * @param {{ epicBody: string, provider: object, epicId: number }} args
 * @returns {Promise<{
 *   alreadyPlanned: boolean,
 *   planningSections: { techSpec: boolean, acceptanceTable: boolean },
 *   openStoryCount: number|null,
 * }>}
 */
export async function buildReplanSignal({ epicBody, provider, epicId }) {
  const body = epicBody ?? '';
  let openStoryCount = null;
  try {
    const tickets = await provider.getTickets(epicId, { state: 'open' });
    if (Array.isArray(tickets)) openStoryCount = tickets.length;
  } catch (err) {
    Logger.warn(
      `[plan-context] open-children listing skipped: ${err?.message ?? err}`,
    );
  }
  return {
    alreadyPlanned: hasTechSpecContent(body),
    planningSections: {
      techSpec: hasEpicSection(body, 'techSpec'),
      acceptanceTable: hasEpicSection(body, 'acceptanceTable'),
    },
    openStoryCount,
  };
}

/**
 * Render the three authoring system prompts the collapsed pipeline's
 * single authoring pass consumes. The spec/acceptance prompts render from
 * `lib/templates/spec-author-prompts.js` (the M3/M8 handshake — envelope
 * authoritative from day one); the decompose prompt reuses the existing
 * Story #4162 carrier including the risk-heuristics suffix.
 *
 * @param {{ heuristics?: string[], maxTickets?: number, maxTokenBudget?: number, epicId?: number|null }} args
 * @returns {{ spec: string, acceptance: string, decompose: string }}
 */
export function buildSystemPrompts({
  heuristics = [],
  maxTickets,
  maxTokenBudget,
  epicId = null,
} = {}) {
  return {
    spec: renderTechSpecSystemPrompt(),
    acceptance: renderAcceptanceSpecSystemPrompt(),
    decompose: buildDecomposerSystemPrompt(heuristics, {
      maxTickets,
      maxTokenBudget,
      epicId,
    }),
  };
}

/**
 * Read the `epic-plan-state` structured comment, degrading to `null` when
 * the comment is missing/unparseable or the provider fetch fails (same
 * tolerance the decompose context applies).
 *
 * @param {{ provider: object, epicId: number }} args
 * @returns {Promise<object|null>}
 */
async function readPlanStateTolerant({ provider, epicId }) {
  try {
    return await readPlanState({ provider, epicId });
  } catch (_err) {
    return null;
  }
}

/**
 * Build the epic-mode envelope. One Epic fetch feeds everything: the
 * authoring context (prefetch seam on `buildAuthoringContext`), clarity
 * scoring, re-plan detection, and the delivery-shape heuristics — the
 * fetch-twice shape of the split pipeline is gone.
 */
async function buildEpicModeEnvelope({
  epicId,
  provider,
  config,
  settings,
  fullContext,
  cwd,
}) {
  const epic = await provider.getEpic(epicId);
  if (!epic) {
    throw new Error(`[plan-context] Epic #${epicId} not found.`);
  }
  const body = epic.body ?? '';

  const authoringOpts = {
    epic,
    fullContext,
    github: config.github ?? null,
  };
  if (cwd) authoringOpts.cwd = cwd;
  const authoring = await buildAuthoringContext(
    epicId,
    provider,
    settings,
    authoringOpts,
  );

  const limits = getLimits(config);
  const heuristics = resolveRiskHeuristics(config);
  const clarityScore = scoreEpicBody({ body });
  const [replan, planState] = await Promise.all([
    buildReplanSignal({ epicBody: body, provider, epicId }),
    readPlanStateTolerant({ provider, epicId }),
  ]);

  return {
    mode: 'epic',
    epic: authoring.epic,
    clarity: clarityScore,
    replan,
    docsContext: authoring.docsContext,
    codebaseSnapshot: authoring.codebaseSnapshot,
    bddRunner: authoring.bddRunner,
    bddScenarios: authoring.bddScenarios,
    memoryFreshness: authoring.memoryFreshness,
    priorFeedback: authoring.priorFeedback,
    ticketSchema: TICKET_SCHEMA_DESCRIPTOR,
    maxTickets: limits.maxTickets,
    maxTokenBudget: limits.maxTokenBudget,
    preflightCeilings: resolvePreflightCeilings(config),
    riskHeuristics: heuristics,
    systemPrompts: buildSystemPrompts({
      heuristics,
      maxTickets: limits.maxTickets,
      maxTokenBudget: limits.maxTokenBudget,
      epicId,
    }),
    deliveryShapeSignal: buildDeliveryShapeSignal({ body }),
    planState,
  };
}

/**
 * Build the one-pager (ideation) envelope. The Epic does not exist yet —
 * creation moves to the persist half — so there is no clarity score, no
 * re-plan signal, and no plan state; the dup search replaces them as the
 * mode's gating input. `docsContext` is inline-digest (the standalone
 * `story-plan.js --emit-context` convention): there is no per-Epic temp
 * directory to anchor a digest file to yet.
 */
async function buildOnePagerModeEnvelope({
  onePagerPath,
  onePagerContent,
  provider,
  config,
  settings,
  fullContext,
  cwd,
}) {
  const content =
    onePagerContent ?? (await readFile(onePagerPath ?? '', 'utf-8'));
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error(
      `[plan-context] one-pager at ${onePagerPath} is empty — nothing to plan from.`,
    );
  }

  let duplicates = [];
  try {
    duplicates = await findSimilarOpenEpics({
      onePager: content,
      provider,
      owner: config.github?.owner,
      repo: config.github?.repo,
    });
  } catch (err) {
    // The dup search is a triage signal, not a gate: a provider listing
    // failure must not abort the envelope build. Surface the degradation
    // on stderr; the authoring middle sees an empty candidate list.
    Logger.warn(
      `[plan-context] duplicate search degraded to no candidates: ${err?.message ?? err}`,
    );
    duplicates = [];
  }

  // Fold the same authoring-context builders the epic path uses, grounded
  // in the one-pager prose instead of an Epic body. Reuse
  // `buildAuthoringContext` via the prefetch seam so the fold has exactly
  // one implementation of the snapshot/BDD/memory/feedback pipeline to
  // drift from. `docsContextFiles` is emptied for this call: the per-Epic
  // digest-file path needs an Epic id (and a temp directory) that does not
  // exist yet — the inline digest below replaces it.
  const authoring = await buildAuthoringContext(
    0,
    /* provider (unused behind the prefetch seam) */ {},
    { ...settings, docsContextFiles: [] },
    {
      epic: { id: 0, title: onePagerPath ?? 'one-pager', body: content },
      fullContext,
      github: config.github ?? null,
      cwd,
    },
  );

  // Replace the per-Epic digest-file pointer with an inline digest — the
  // Epic (and its temp directory) does not exist yet.
  const paths = settings?.paths ?? {};
  const inlineDigest = await buildDocsDigest({
    docsContextFiles: settings?.docsContextFiles,
    docsRoot: paths.docsRoot,
  });
  const docsContext =
    inlineDigest == null
      ? null
      : { mode: 'digest-inline', digest: inlineDigest };

  const limits = getLimits(config);
  const heuristics = resolveRiskHeuristics(config);

  return {
    mode: 'one-pager',
    onePager: { path: onePagerPath ?? null, content },
    duplicates,
    docsContext,
    codebaseSnapshot: authoring.codebaseSnapshot,
    bddRunner: authoring.bddRunner,
    bddScenarios: authoring.bddScenarios,
    memoryFreshness: authoring.memoryFreshness,
    priorFeedback: authoring.priorFeedback,
    ticketSchema: TICKET_SCHEMA_DESCRIPTOR,
    maxTickets: limits.maxTickets,
    maxTokenBudget: limits.maxTokenBudget,
    preflightCeilings: resolvePreflightCeilings(config),
    riskHeuristics: heuristics,
    systemPrompts: buildSystemPrompts({
      heuristics,
      maxTickets: limits.maxTickets,
      maxTokenBudget: limits.maxTokenBudget,
      epicId: null,
    }),
    deliveryShapeSignal: buildDeliveryShapeSignal({ body: content }),
    planState: null,
  };
}

/**
 * Build the single planner-context envelope.
 *
 * @param {{
 *   mode: 'epic'|'one-pager',
 *   epicId?: number,
 *   onePagerPath?: string,
 *   onePagerContent?: string,
 *   provider: object,
 *   config: object,
 *   settings: object,
 *   cwd?: string,
 * }} args
 * @returns {Promise<object>} the JSON-serialisable envelope.
 */
export async function buildPlanContext({
  mode,
  epicId,
  onePagerPath,
  onePagerContent,
  provider,
  config = {},
  settings = {},
  fullContext = false,
  cwd,
}) {
  if (mode === 'epic') {
    if (!Number.isInteger(epicId)) {
      throw new Error('[plan-context] epic mode requires a numeric epicId.');
    }
    return buildEpicModeEnvelope({
      epicId,
      provider,
      config,
      settings,
      fullContext,
      cwd,
    });
  }
  if (mode === 'one-pager') {
    if (!onePagerPath && typeof onePagerContent !== 'string') {
      throw new Error(
        '[plan-context] one-pager mode requires --one-pager <path>.',
      );
    }
    return buildOnePagerModeEnvelope({
      onePagerPath,
      onePagerContent,
      provider,
      config,
      settings,
      fullContext,
      cwd,
    });
  }
  throw new Error(
    `[plan-context] unknown mode "${mode}" — expected "epic" or "one-pager".`,
  );
}
