#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-plan-decompose.js — Phase 8 (decompose) entry point for the split
 * planning flow.
 *
 * Owns the deterministic decomposer engine (inlined from the retired
 * `ticket-decomposer.js` engine file in Story #1437 Task #1447) behind the
 * idempotent plan-phase lifecycle:
 *
 *   1. --emit-context   Prints the decomposer authoring context (PRD body,
 *                       Tech Spec body, risk heuristics, system prompt, ticket
 *                       cap) as JSON. The authoring middle is the
 *                       `epic-plan-decompose-author` Skill
 *                       (`.agents/skills/core/epic-plan-decompose-author/SKILL.md`)
 *                       — it consumes this envelope and writes the ticket
 *                       array JSON. The Skill carries the authoritative
 *                       system prompt; the `systemPrompt` field on the
 *                       envelope is retained as a backstop for tools that
 *                       still consume the legacy contract.
 *
 *   2. (default)        Given an author-provided tickets JSON file, persists
 *                       the Feature/Story/Task hierarchy, flips the Epic to
 *                       `agent::ready`, and updates the `epic-plan-state`
 *                       structured comment.
 *
 * --force re-decomposes (closes existing child Features/Stories/Tasks).
 *
 * Exit codes:
 *   0 — phase complete, Epic is now `agent::ready`.
 *   1 — fatal error (see stderr).
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { drainPendingCleanupAtBoot } from './epic-plan-spec.js';
import { runAsCli } from './lib/cli-utils.js';
import { DEFAULT_DECOMPOSER } from './lib/config/runners.js';
import {
  getLimits,
  getRunners,
  PROJECT_ROOT,
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr, STDERR_LOGGER } from './lib/Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from './lib/label-constants.js';
import { PlanRunnerContext } from './lib/orchestration/context.js';
import {
  PLAN_PHASES,
  PlanCheckpointer,
} from './lib/orchestration/plan-runner/plan-checkpointer.js';
import { applyBudget } from './lib/orchestration/planning-context-budget.js';
import { renderSpec } from './lib/orchestration/spec-renderer.js';
import { validateTaskBodies } from './lib/orchestration/task-body-validator.js';
import { validateAndNormalizeTickets } from './lib/orchestration/ticket-validator.js';
import { cleanupPhaseTempFiles } from './lib/plan-phase-cleanup.js';
import { createProvider } from './lib/provider-factory.js';
import { writeSpec } from './lib/spec/index.js';
import { renderDecomposerSystemPrompt } from './lib/templates/decomposer-prompts.js';
import { concurrentMap } from './lib/util/concurrent-map.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// scripts/ → .agents/ → repo root → epic-reconcile.js
const RECONCILE_CLI = path.join(__dirname, 'epic-reconcile.js');

// ─── Decomposer engine ───────────────────────────────────────────────────────
//
// Story #1437 Task #1447 inlined the deterministic helpers from the
// retired `.agents/scripts/ticket-decomposer.js` into this wrapper. The
// authoritative system prompt now lives in the `epic-plan-decompose-author`
// Skill (`.agents/skills/core/epic-plan-decompose-author/SKILL.md`);
// `renderDecomposerSystemPrompt` (in `lib/templates/decomposer-prompts.js`)
// is retained because `buildDecompositionContext` still rides it onto the
// `--emit-context` envelope as a backstop for legacy callers.

const TYPE_LABEL_TO_TYPE = {
  [TYPE_LABELS.FEATURE]: 'feature',
  [TYPE_LABELS.STORY]: 'story',
  [TYPE_LABELS.TASK]: 'task',
};

function resolveParentId(ticket, slugMap, epicId) {
  if (ticket.type === 'feature') return epicId;
  if (!ticket.parent_slug) {
    throw new Error(
      `[Decomposer] ${ticket.type.toUpperCase()} "${ticket.title}" (${ticket.slug}) has no parent_slug.`,
    );
  }
  if (!slugMap.has(ticket.parent_slug)) {
    throw new Error(
      `[Decomposer] ${ticket.type.toUpperCase()} "${ticket.title}" (${ticket.slug}) references parent_slug "${ticket.parent_slug}" which was not created. The parent is missing from the ticket array or the slug is misspelled.`,
    );
  }
  return slugMap.get(ticket.parent_slug);
}

export function resolveDependencies(ticket, slugMap) {
  const resolved = [];
  for (const dep of ticket.depends_on || []) {
    const depId = slugMap.get(dep);
    if (depId === undefined) {
      // Unreachable through normal flow: validateAndNormalizeTickets
      // already rejects unknown slugs and the new topological sort
      // guarantees creation order. A throw here turns a future regression
      // (e.g. someone bypassing the validator) into a loud failure instead
      // of a silently-dropped DAG edge.
      throw new Error(
        `[Decomposer] ${ticket.type.toUpperCase()} "${ticket.title}" (${ticket.slug}) depends on unresolved slug "${dep}". This indicates a planner bug or out-of-order ticket creation.`,
      );
    }
    resolved.push(depId);
  }
  return resolved;
}

/**
 * Topologically sort tickets within each (parent_slug, type) group, then
 * concatenate groups in typeOrder so parents are always created before
 * children (Feature → Story → Task) and intra-group dep chains resolve
 * before their dependents are created.
 */
export function orderTicketsForCreation(validated) {
  const typeOrder = { feature: 0, story: 1, task: 2 };
  const groups = new Map();

  for (const t of validated) {
    const parentKey = t.parent_slug ?? '__epic__';
    const key = `${t.type}::${parentKey}`;
    if (!groups.has(key)) groups.set(key, { type: t.type, items: [] });
    groups.get(key).items.push(t);
  }

  const ordered = [...groups.values()].sort(
    (a, b) => typeOrder[a.type] - typeOrder[b.type],
  );

  const result = [];
  for (const group of ordered) {
    for (const t of topoSortGroup(group.items)) {
      result.push(t);
    }
  }
  return result;
}

function topoSortGroup(group) {
  const slugToTicket = new Map(group.map((t) => [t.slug, t]));
  const visited = new Set();
  const sorted = [];

  function visit(t) {
    if (visited.has(t.slug)) return;
    visited.add(t.slug);
    for (const dep of t.depends_on ?? []) {
      const depTicket = slugToTicket.get(dep);
      if (depTicket) visit(depTicket);
    }
    sorted.push(t);
  }

  for (const t of group) visit(t);
  return sorted;
}

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

/**
 * Build the authoring context the host LLM (or the
 * `epic-plan-decompose-author` Skill) needs to produce the ticket JSON.
 *
 * PRD and Tech Spec bodies are bounded by the planning-context budget
 * (Epic #817 Story 9): when their combined size exceeds `maxBytes`, each
 * body is replaced with a `bodySummary` field carrying headings + bounded
 * excerpts. Pass `{ fullContext: true }` (CLI: `--full-context`) to restore
 * the unbounded full bodies.
 */
export async function buildDecompositionContext(
  epicId,
  provider,
  config = {},
  opts = {},
) {
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

  const heuristics =
    (Array.isArray(config.planning?.riskHeuristics)
      ? config.planning.riskHeuristics
      : config.agentSettings?.planning?.riskHeuristics) || [];
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
  const prdEntry =
    budgeted.mode === 'full'
      ? { id: prd.id, body: prd.body }
      : { id: prd.id, body: null, bodySummary: prdItem };
  const techSpecEntry =
    budgeted.mode === 'full'
      ? { id: techSpec.id, body: techSpec.body }
      : { id: techSpec.id, body: null, bodySummary: techSpecItem };

  return {
    epic: { id: epic.id, title: epic.title },
    prd: prdEntry,
    techSpec: techSpecEntry,
    heuristics,
    systemPrompt,
    maxTickets,
    contextMode: budgeted.mode,
  };
}

/**
 * Inspect the Epic's existing child tickets and build a title-keyed lookup
 * for resume / idempotent-create. The map's value carries the inferred type
 * so we can detect cross-type title collisions before they corrupt the DAG.
 */
function indexExistingChildren(existing) {
  const childTypes = new Set([
    TYPE_LABELS.FEATURE,
    TYPE_LABELS.STORY,
    TYPE_LABELS.TASK,
  ]);
  const byTitle = new Map();
  for (const child of existing) {
    const typeLabel = (child.labels || []).find((l) => childTypes.has(l));
    if (!typeLabel) continue;
    byTitle.set(child.title, {
      id: child.id,
      state: child.state,
      type: TYPE_LABEL_TO_TYPE[typeLabel],
    });
  }
  return byTitle;
}

/**
 * Wire an `onTransientFailure` listener on the provider's HTTP client so the
 * staged-pass loop can drop concurrency to 1 the first time GitHub returns a
 * secondary rate-limit (HTTP 403 abuse-detection). Returns a getter the
 * caller polls between passes plus a teardown to remove the listener.
 *
 * Mock providers in tests do not expose `_http`; in that case the hook is a
 * no-op and concurrency stays at the configured static cap.
 */
function attachAdaptiveConcurrencyHook(provider) {
  let observed = false;
  const http = provider?._http;
  if (!http || typeof http !== 'object' || !('onTransientFailure' in http)) {
    return { wasThrottled: () => false, detach: () => {} };
  }
  const prior = http.onTransientFailure;
  http.onTransientFailure = (info) => {
    if (info?.kind === 'secondary-rate-limit') observed = true;
    if (typeof prior === 'function') prior(info);
  };
  return {
    wasThrottled: () => observed,
    detach: () => {
      http.onTransientFailure = prior;
    },
  };
}

export async function decomposeEpic(
  epicId,
  provider,
  { tickets },
  _config = {},
  { force = false, resume = false } = {},
) {
  if (!Array.isArray(tickets)) {
    throw new Error(
      `[Decomposer] tickets must be an array (got ${typeof tickets}).`,
    );
  }
  if (force && resume) {
    throw new Error(
      '[Decomposer] --force and --resume are mutually exclusive.',
    );
  }

  Logger.info(`[Decomposer] Fetching Epic #${epicId}...`);
  const epic = await provider.getEpic(epicId);

  if (!epic?.linkedIssues?.prd || !epic.linkedIssues.techSpec) {
    throw new Error(
      `[Decomposer] Epic #${epicId} is missing linked PRD or Tech Spec. Run the Epic Planner first.`,
    );
  }

  // ── Resolve existing children for both --force (close them) and the
  // implicit/explicit resume path (skip create when title matches). A single
  // fetch covers both branches; we always prime the cache so downstream calls
  // hit the local map.
  //
  // Mock providers in unit tests omit `getTickets` because the original
  // implementation only called it on the --force branch — treat absence as
  // "no existing children" rather than failing the whole pipeline.
  const existing =
    typeof provider.getTickets === 'function'
      ? await provider.getTickets(epicId)
      : [];
  if (existing.length > 0 && typeof provider.primeTicketCache === 'function') {
    provider.primeTicketCache(existing);
  }
  const existingChildren = (existing || []).filter((t) =>
    (t.labels || []).some((l) =>
      [TYPE_LABELS.FEATURE, TYPE_LABELS.STORY, TYPE_LABELS.TASK].includes(l),
    ),
  );

  if (force) {
    Logger.info('[Decomposer] --force: Closing existing child tickets...');
    // Bound the GitHub close-mutation burst so a wide --force re-plan does
    // not race the secondary rate limit. concurrentMap surfaces the first
    // rejection deterministically (later failures from drain-through work
    // are swallowed) which preserves per-item error reporting via the
    // single thrown error.
    const openChildren = existingChildren.filter((c) => c.state !== 'closed');
    await concurrentMap(
      openChildren,
      async (child) => {
        await provider.updateTicket(child.id, {
          state: 'closed',
          state_reason: 'not_planned',
        });
        Logger.info(`[Decomposer]   Closed #${child.id}: ${child.title}`);
      },
      { concurrency: 3 },
    );
    Logger.info(
      `[Decomposer]   Closed ${existingChildren.length} old ticket(s).`,
    );
  }

  // ── Resume / idempotent create: index the (post-force) state of children
  // by title so the staged passes can skip any planned ticket whose title
  // already exists as an OPEN child of the matching type.
  const childIndex = force
    ? new Map()
    : indexExistingChildren(existingChildren);

  if (resume && childIndex.size === 0) {
    throw new Error(
      `[Decomposer] --resume requires existing child tickets under Epic #${epicId}, but none were found. Run without --resume to perform a fresh decomposition.`,
    );
  }

  const maxTickets = getLimits(_config).maxTickets;
  if (tickets.length >= maxTickets) {
    Logger.warn(
      `[Decomposer] ⚠️  Received ${tickets.length} tickets (at or above the ${maxTickets}-ticket cap). Verify every Story still has child Tasks or split the Epic into smaller scopes.`,
    );
  }

  Logger.info(
    `[Decomposer] Running cross-validation on ${tickets.length} tickets...`,
  );
  // Thread the configured base branch into the validator so the freshness
  // gate can probe `git cat-file -e <ref>:<path>` for every code-asset path
  // referenced by a Task body or AC. Defaults to 'main' when the loaded
  // config omits the field — matching ZERO_CONFIG_DEFAULTS in the resolver.
  const baseBranchRef = _config?.baseBranch ?? 'main';
  const validated = validateAndNormalizeTickets(tickets, { baseBranchRef });
  validateTaskBodies(validated);

  // Pre-pass cross-type collision check: a planned Story sharing a title with
  // an existing Task (or any other type mismatch) is unrecoverable — auto-
  // linking it would corrupt the parent/child hierarchy. Surface every
  // collision in one error so operators can rename them in one pass.
  const collisions = [];
  for (const t of validated) {
    const existingEntry = childIndex.get(t.title);
    if (existingEntry && existingEntry.type !== t.type) {
      collisions.push(
        `  - "${t.title}": planned ${t.type.toUpperCase()} but #${existingEntry.id} is a ${existingEntry.type.toUpperCase()}`,
      );
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `[Decomposer] Title collision across ticket types — refusing to auto-link:\n${collisions.join('\n')}\n\nRename the planned tickets or close the existing issues, then re-run.`,
    );
  }

  const configuredCap =
    getRunners(_config).decomposer.concurrencyCap ??
    DEFAULT_DECOMPOSER.concurrencyCap;
  let activeCap = configuredCap;

  Logger.info(
    `[Decomposer] Identified ${validated.length} tickets. Starting creation (concurrencyCap=${activeCap}${childIndex.size > 0 ? `, existing=${childIndex.size}` : ''})...`,
  );

  const slugMap = new Map();
  const ordered = orderTicketsForCreation(validated);
  const throttle = attachAdaptiveConcurrencyHook(provider);

  try {
    // Three staged passes: features → stories → tasks. Each pass blocks the
    // next so parent_slug → ID resolution is preserved (a Story's parent
    // Feature ID is in slugMap before the Story pass runs).
    for (const passType of ['feature', 'story', 'task']) {
      const passTickets = ordered.filter((t) => t.type === passType);
      if (passTickets.length === 0) continue;

      // Adaptive degrade: once a secondary RL has been observed in any prior
      // pass, drop the cap to 1 for every remaining pass. Within-pass
      // throttling is handled by the http-client's retry/backoff loop.
      if (throttle.wasThrottled() && activeCap > 1) {
        Logger.warn(
          `[Decomposer] secondary rate-limit observed — dropping concurrencyCap from ${activeCap} to 1 for remaining passes`,
        );
        activeCap = 1;
      }

      await runCreationPass(
        passTickets,
        slugMap,
        epicId,
        provider,
        activeCap,
        childIndex,
      );
    }
  } finally {
    throttle.detach();
  }

  await reconcileSubIssueLinks(epicId, provider);

  Logger.info(
    `[Decomposer] Backlog for Epic #${epicId} populated successfully!`,
  );
}

/**
 * After all creation passes complete, walk every child of the Epic and verify
 * that the native GitHub sub-issue API link matches the `parent: #<n>` body
 * footer. The decomposer is the canonical place to enforce this invariant
 * because it owns end-to-end Epic state — child create/link is otherwise an
 * eventual-consistency dance vulnerable to GraphQL secondary RL.
 *
 * Fails the run if reconciliation cannot close all gaps. Mock providers in
 * unit tests that do not expose `reconcileSubIssueLinks` are silently skipped
 * (the same convention `attachAdaptiveConcurrencyHook` uses for `_http`).
 */
async function reconcileSubIssueLinks(epicId, provider) {
  if (typeof provider.reconcileSubIssueLinks !== 'function') return;

  Logger.info(
    `[Decomposer] Reconciling sub-issue API links for Epic #${epicId}...`,
  );
  const result = await provider.reconcileSubIssueLinks(epicId);
  const { totalExpected, alreadyLinked, reconciled, failed, failures } = result;

  if (failed === 0) {
    const reconciledNote = reconciled > 0 ? ` (${reconciled} reconciled)` : '';
    Logger.info(
      `[Decomposer] linked ${alreadyLinked + reconciled}/${totalExpected} sub-issues${reconciledNote}`,
    );
    return;
  }

  for (const failure of failures) {
    Logger.error(
      `[Decomposer] sub-issue link gap: parent #${failure.parentId} ← child #${failure.childId}: ${failure.reason}`,
    );
  }
  throw new Error(
    `[Decomposer] Sub-issue reconciliation incomplete: ${failed}/${totalExpected} links could not be established (linked=${alreadyLinked}, reconciled=${reconciled}). See log for per-child reasons.`,
  );
}

/**
 * Run one staged creation pass with bounded concurrency. Within the pass,
 * intra-group `depends_on` chains are honoured via per-slug deferred promises:
 * a ticket's mapper awaits each dep's promise before reading the slugMap,
 * so a chain like t-a → t-b → t-c serialises naturally even when the cap
 * permits parallel work.
 *
 * `childIndex` is the title→{id,state,type} map of pre-existing children for
 * this Epic. When a planned ticket's title hits an OPEN entry, the create
 * call is skipped and the existing id flows into slugMap so dependents wire
 * up to the surviving issue. CLOSED entries are warned-about but re-created
 * (operator may have intentionally cancelled the prior decomposition).
 */
async function runCreationPass(
  tickets,
  slugMap,
  epicId,
  provider,
  concurrencyCap,
  childIndex = new Map(),
) {
  const deferred = new Map();
  for (const t of tickets) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Swallow rejection bookkeeping so a failed creation does not surface as
    // an unhandled rejection when no dependent ticket awaits this promise.
    // The original error is still re-thrown inside the mapper and observed
    // by concurrentMap's first-rejection-wins contract.
    promise.catch(() => {});
    deferred.set(t.slug, { promise, resolve, reject });
  }

  await concurrentMap(
    tickets,
    async (t) => {
      // Wait for any intra-pass dep to be created before reading slugMap.
      // Cross-pass deps (story → feature) are already in slugMap from a
      // prior completed pass and need no awaiting.
      for (const depSlug of t.depends_on ?? []) {
        if (deferred.has(depSlug)) {
          await deferred.get(depSlug).promise;
        }
      }

      const existingEntry = childIndex.get(t.title);
      if (existingEntry && existingEntry.state !== 'closed') {
        Logger.info(
          `[Decomposer] SKIP (already created): #${existingEntry.id} ${t.title}`,
        );
        slugMap.set(t.slug, existingEntry.id);
        deferred.get(t.slug).resolve(existingEntry.id);
        return existingEntry.id;
      }
      if (existingEntry && existingEntry.state === 'closed') {
        Logger.warn(
          `[Decomposer] Existing CLOSED #${existingEntry.id} matches planned title "${t.title}" — re-creating (prior decomposition was cancelled).`,
        );
      }

      Logger.info(
        `[Decomposer] [${t.type.toUpperCase()}] Creating "${t.title}"...`,
      );

      const parentId = resolveParentId(t, slugMap, epicId);
      const dependencies = resolveDependencies(t, slugMap);

      const auditSnapshot =
        t.type === 'task' && t.body && typeof t.body === 'object'
          ? new Date().toISOString().slice(0, 10)
          : undefined;

      try {
        const created = await provider.createTicket(parentId, {
          epicId,
          title: t.title,
          body: t.body,
          labels: t.labels || [],
          dependencies,
          auditSnapshot,
        });
        Logger.info(`[Decomposer] -> Created Issue #${created.id}`);
        slugMap.set(t.slug, created.id);
        deferred.get(t.slug).resolve(created.id);
        return created.id;
      } catch (err) {
        deferred.get(t.slug).reject(err);
        throw err;
      }
    },
    { concurrency: concurrencyCap },
  );
}

async function setEpicLabel(provider, epicId, targetLabel) {
  const planningLabels = [AGENT_LABELS.REVIEW_SPEC, AGENT_LABELS.READY];
  await provider.updateTicket(epicId, {
    labels: {
      add: [targetLabel],
      remove: planningLabels.filter((l) => l !== targetLabel),
    },
  });
}

/**
 * Execute the decompose phase end to end.
 *
 * Story #1498 / Task #1525 — rewires the persist half off the direct
 * `provider.createTicket` path (the legacy `decomposeEpic` helper) and
 * onto the structural reconciler. Flow:
 *
 *   1. `renderSpec(tickets, { epic })` projects the flat decomposer
 *      array into the spec schema (Story #1495).
 *   2. `writeSpec(epicId, spec)` persists the YAML under
 *      `.agents/epics/<epicId>.yaml` (Story #1491).
 *   3. `spawnSync('node', [epic-reconcile.js, epicId, --apply, --yes])`
 *      runs the structural reconciler in apply mode (Story #1496). The
 *      reconciler writes `state.json` and creates / updates / closes the
 *      GH issues to match the spec.
 *   4. Phase 8 still flips the Epic to `agent::ready` **after** the
 *      reconciler's apply path succeeds (preserving the prior label
 *      contract operators rely on).
 *   5. The pre-existing temp-file cleanup contract from
 *      `lib/plan-phase-cleanup.js` runs unchanged.
 *
 * `decomposeEpic` is retained as an exported helper so the existing
 * unit-test suite (`tests/ticket-decomposer.test.js`) keeps working;
 * it is no longer invoked from this entry point.
 *
 * @param {number} epicId
 * @param {import('./lib/ITicketingProvider.js').ITicketingProvider} provider
 * @param {{ tickets: Array<object> }} payload
 * @param {object} config
 * @param {{ force?: boolean, resume?: boolean, spawnSync?: typeof defaultSpawnSync, reconcileCli?: string, writeSpecFn?: typeof writeSpec, renderSpecFn?: typeof renderSpec, cwd?: string }} [opts]
 * @returns {Promise<{ epicId: number, ticketCount: number, checkpoint: object, reconcile: { status: number, stdout: string, stderr: string } }>}
 */
export async function runDecomposePhase(
  epicId,
  provider,
  { tickets },
  config = {},
  {
    force = false,
    resume = false,
    spawnSync = defaultSpawnSync,
    reconcileCli = RECONCILE_CLI,
    writeSpecFn = writeSpec,
    renderSpecFn = renderSpec,
    cwd = PROJECT_ROOT,
  } = {},
) {
  if (force && resume) {
    throw new Error(
      '[epic-plan-decompose] --force and --resume are mutually exclusive.',
    );
  }
  const epic = await provider.getEpic(epicId);
  if (!epic) {
    throw new Error(`[epic-plan-decompose] Epic #${epicId} not found.`);
  }
  if (!epic.labels?.includes(TYPE_LABELS.EPIC)) {
    throw new Error(
      `[epic-plan-decompose] Ticket #${epicId} is not a ${TYPE_LABELS.EPIC}.`,
    );
  }
  if (!epic.linkedIssues?.prd || !epic.linkedIssues?.techSpec) {
    throw new Error(
      `[epic-plan-decompose] Epic #${epicId} is missing a linked PRD or Tech Spec. Run /epic-plan-spec first.`,
    );
  }
  if (!Array.isArray(tickets)) {
    throw new Error(
      `[epic-plan-decompose] tickets must be an array (got ${typeof tickets}).`,
    );
  }

  const maxTickets = getLimits(config).maxTickets;
  if (tickets.length >= maxTickets) {
    Logger.warn(
      `[epic-plan-decompose] ⚠️  Received ${tickets.length} tickets (at or above the ${maxTickets}-ticket cap). Verify every Story still has child Tasks or split the Epic into smaller scopes.`,
    );
  }

  const ctx = new PlanRunnerContext({
    epicId,
    provider,
    config: config ?? {},
    phase: PLAN_PHASES.DECOMPOSING,
  });
  const checkpointer = new PlanCheckpointer({ ctx });
  await checkpointer.initialize({
    spec: {
      prdId: epic.linkedIssues.prd,
      techSpecId: epic.linkedIssues.techSpec,
      completedAt: null,
    },
  });
  await checkpointer.setPhase(PLAN_PHASES.DECOMPOSING);

  // 1. Validate + normalise the ticket array using the same gates the
  //    legacy `decomposeEpic` path enforced; the renderer's own schema
  //    validation catches structural drift, but `validateTaskBodies` /
  //    `validateAndNormalizeTickets` apply the project-specific freshness
  //    + cross-link checks that the schema cannot express.
  Logger.info(
    `[epic-plan-decompose] Running cross-validation on ${tickets.length} tickets...`,
  );
  const baseBranchRef = config?.baseBranch ?? 'main';
  const validated = validateAndNormalizeTickets(tickets, { baseBranchRef });
  validateTaskBodies(validated);

  // 2. Render the decomposer array into the structural spec shape.
  Logger.info(
    `[epic-plan-decompose] Rendering spec for Epic #${epicId} (${validated.length} tickets)...`,
  );
  const spec = renderSpecFn(validated, {
    epic: { id: epicId, title: epic.title },
  });

  // 3. Persist the spec YAML.
  const specFilePath = writeSpecFn(epicId, spec, { epicsDir: undefined });
  Logger.info(`[epic-plan-decompose] Wrote spec → ${specFilePath}`);

  // 4. Invoke the structural reconciler in apply mode. We surface stdout /
  //    stderr to the parent stream so operators see the formatted plan
  //    inline with the planning log. `--yes` short-circuits the
  //    interactive confirmation gate (Phase 8 is a non-interactive
  //    pipeline by design).
  Logger.info(
    `[epic-plan-decompose] Spawning epic-reconcile.js --apply --yes for Epic #${epicId}...`,
  );
  const reconcileResult = spawnSync(
    process.execPath,
    [reconcileCli, String(epicId), '--apply', '--yes'],
    {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
      env: { ...process.env, EPIC_RECONCILE_INVOKER: 'epic-plan-decompose' },
    },
  );
  const reconcile = {
    status: reconcileResult.status ?? 1,
    stdout: reconcileResult.stdout ?? '',
    stderr: reconcileResult.stderr ?? '',
  };
  if (reconcile.stdout) process.stdout.write(reconcile.stdout);
  if (reconcile.stderr) process.stderr.write(reconcile.stderr);
  if (reconcile.status !== 0) {
    throw new Error(
      `[epic-plan-decompose] epic-reconcile.js exited with status ${reconcile.status}. See stderr above.`,
    );
  }

  // 4.5 Sub-issue link safety net — Story #2063. The reconciler's apply
  //     path persists structural state via `provider.createTicket`,
  //     which opportunistically calls `addSubIssue` and swallows any
  //     transient GraphQL failure into a `subIssueLinked: false` flag
  //     on the return envelope. Walk every child whose body footer
  //     carries `parent: #N` and re-establish missing native links
  //     before flipping the Epic to agent::ready. The legacy
  //     `populateBacklog` path has carried this safety net since the
  //     decomposer was first written; the spec-flow rewrite (Story
  //     #1498) accidentally dropped it, which produced silent partial
  //     backlogs across `/epic-plan` runs (see Epic #1994). `failed > 0`
  //     is a hard error — the run did not produce a consistent backlog.
  await reconcileSubIssueLinks(epicId, provider);

  const checkpoint = await checkpointer.updateDecompose({
    ticketCount: tickets.length,
    completedAt: new Date().toISOString(),
  });

  // 5. Phase 8 still flips the Epic to agent::ready — the reconciler
  //    handles structural state only, the planning lifecycle label is
  //    owned by this entry point.
  Logger.info(
    `[epic-plan-decompose] Flipping Epic #${epicId} to ${AGENT_LABELS.READY}...`,
  );
  await setEpicLabel(provider, epicId, AGENT_LABELS.READY);
  await checkpointer.setPhase(PLAN_PHASES.READY);

  const cleanup = await cleanupPhaseTempFiles({ phase: 'decompose', epicId });

  Logger.info(
    `[epic-plan-decompose] ✅ Decompose phase complete for Epic #${epicId}. ${tickets.length} ticket(s) persisted via reconciler.`,
  );
  if (cleanup.deleted.length > 0) {
    Logger.info(
      `[epic-plan-decompose] 🧹 Cleaned up ${cleanup.deleted.length} temp file(s).`,
    );
  }

  return {
    epicId,
    ticketCount: tickets.length,
    checkpoint,
    cleanup,
    reconcile,
    specPath: specFilePath,
  };
}

/**
 * Best-effort recovery diagnostics emitted when `runDecomposePhase` throws
 * mid-pass (typically GitHub secondary RL after dozens of issue creations).
 * Never throws — diagnostics must not eclipse the original failure.
 */
async function reportPartialFailure({ epicId, provider, err }) {
  Logger.error('');
  Logger.error('[epic-plan-decompose] ❌ Decompose phase aborted.');
  Logger.error(`[epic-plan-decompose] Reason: ${err?.message ?? err}`);
  try {
    if (typeof provider.getEpic === 'function') {
      const epic = await provider.getEpic(epicId);
      const lifecycleLabel =
        (epic?.labels || []).find((l) => l.startsWith('agent::')) ?? 'unknown';
      Logger.error(
        `[epic-plan-decompose] Epic #${epicId} current label: ${lifecycleLabel}`,
      );
    }
    if (typeof provider.getTickets === 'function') {
      const existing = await provider.getTickets(epicId);
      const childTypes = [
        TYPE_LABELS.FEATURE,
        TYPE_LABELS.STORY,
        TYPE_LABELS.TASK,
      ];
      const created = (existing || []).filter(
        (t) =>
          (t.labels || []).some((l) => childTypes.includes(l)) &&
          t.state !== 'closed',
      ).length;
      Logger.error(
        `[epic-plan-decompose] Children currently open under Epic: ${created}`,
      );
    }
  } catch (probeErr) {
    Logger.error(
      `[epic-plan-decompose] (diagnostics probe failed: ${probeErr.message})`,
    );
  }
  Logger.error('');
  Logger.error('[epic-plan-decompose] To resume from the partial backlog:');
  Logger.error(
    `[epic-plan-decompose]   node .agents/scripts/epic-plan-decompose.js --epic ${epicId} --tickets <tickets-file> --resume`,
  );
  Logger.error('');
}

/* node:coverage ignore next */
async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      tickets: { type: 'string' },
      force: { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      'emit-context': { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      'full-context': { type: 'boolean', default: false },
    },
  });

  if (!values.epic) {
    throw new Error(
      'Usage: epic-plan-decompose.js --epic <EpicId> (--emit-context [--pretty] [--full-context] | --tickets <file>) [--force | --resume]',
    );
  }
  if (values.force && values.resume) {
    throw new Error('--force and --resume are mutually exclusive.');
  }

  const epicId = Number.parseInt(values.epic, 10);
  if (Number.isNaN(epicId)) {
    throw new Error(`Invalid epic ID: "${values.epic}" — must be a number.`);
  }

  let config;
  try {
    config = resolveConfig();
    validateOrchestrationConfig(config.orchestration);
  } catch (err) {
    throw new Error(
      `Orchestration config schema validation failed:\n${err.message}`,
    );
  }
  const provider = createProvider(config.orchestration);

  const emitContext = values['emit-context'];
  // Story #2278 — in --emit-context mode stdout is reserved for the JSON
  // envelope. Flip every Logger sink that could land on stdout to stderr
  // *before* any orchestration code runs (drainPendingCleanupAtBoot,
  // buildDecompositionContext, validators) so a captured file is
  // unconditionally parseable by `JSON.parse`.
  if (emitContext) routeAllOutputToStderr();

  try {
    await drainPendingCleanupAtBoot({
      repoRoot: PROJECT_ROOT,
      orchestration: config.orchestration,
      provider,
      // In --emit-context mode stdout is reserved for the JSON envelope;
      // route every drain/sweep log line through stderr so the captured
      // file is unconditionally parseable.
      logger: emitContext ? STDERR_LOGGER : undefined,
    });
  } catch (err) {
    Logger.warn(`[epic-plan-decompose] worktree sweep skipped: ${err.message}`);
  }

  if (emitContext) {
    const ctx = await buildDecompositionContext(epicId, provider, config, {
      fullContext: values['full-context'],
    });
    // Surface the resolved cap on stderr so a misconfigured `.agentrc.json`
    // (e.g. flat-key `maxTickets` instead of grouped `limits.maxTickets`)
    // is visible to the operator rather than silently falling through to
    // the framework default. The decomposer prompt embeds the same value
    // — see buildDecompositionContext above.
    Logger.error(
      `[epic-plan-decompose] Resolved limits.maxTickets = ${ctx.maxTickets} (prompt cap).`,
    );
    const json = values.pretty
      ? JSON.stringify(ctx, null, 2)
      : JSON.stringify(ctx);
    process.stdout.write(`${json}\n`);
    return;
  }

  if (!values.tickets) {
    throw new Error(
      'Missing --tickets <file>. (Use --emit-context first to gather authoring context.)',
    );
  }

  const raw = await readFile(values.tickets, 'utf8');
  let tickets;
  try {
    tickets = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse tickets file "${values.tickets}" as JSON: ${err.message}`,
    );
  }

  let result;
  try {
    result = await runDecomposePhase(epicId, provider, { tickets }, config, {
      force: values.force,
      resume: values.resume,
    });
  } catch (err) {
    await reportPartialFailure({ epicId, provider, err });
    throw err;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'epic-plan-decompose' });
