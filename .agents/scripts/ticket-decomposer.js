#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * ticket-decomposer.js
 *
 * Work Breakdown Decomposition Script (v5.6+)
 *
 * As of v5.6 the host LLM authors the ticket array directly — this script
 * no longer calls any external LLM API. It has two modes:
 *
 *   1. --emit-context  Prints a JSON envelope (PRD body, Tech Spec body,
 *                      system prompt, risk heuristics, JSON schema) to stdout.
 *                      The host LLM consumes this to author the ticket array.
 *
 *   2. (default)       Given an author-provided tickets JSON file, validates
 *                      and creates the Feature/Story/Task issues under the Epic.
 *
 * Execution model: Stories are the primary execution unit. Each Story is executed
 * on a single branch (`story/epic-<epicId>/<slug>`) with all child Tasks
 * implemented sequentially. The dispatcher groups tasks by Story.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { getLimits, getRunners, resolveConfig } from './lib/config-resolver.js';
import { DEFAULT_DECOMPOSER } from './lib/config-schema.js';
import { Logger } from './lib/Logger.js';
import { TYPE_LABELS } from './lib/label-constants.js';
import { applyBudget } from './lib/orchestration/planning-context-budget.js';
import { validateTaskBodies } from './lib/orchestration/task-body-validator.js';
import { validateAndNormalizeTickets } from './lib/orchestration/ticket-validator.js';
import { createProvider } from './lib/provider-factory.js';
import { renderDecomposerSystemPrompt } from './lib/templates/decomposer-prompts.js';
import { concurrentMap } from './lib/util/concurrent-map.js';

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
      ? `### RISK HEURISTICS (Flag as risk::medium if any apply):\n- ${heuristics.join('\n- ')}`
      : '';
  return `${base}${heuristicsStr ? `\n\n${heuristicsStr}` : ''}`;
}

/**
 * Build the authoring context the host LLM needs to produce the ticket JSON.
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

  const heuristics = config.agentSettings?.riskGates?.heuristics || [];
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

/* node:coverage ignore next */
async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      force: { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      'emit-context': { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      'full-context': { type: 'boolean', default: false },
      tickets: { type: 'string' },
    },
  });

  if (!values.epic) {
    Logger.fatal(
      'Usage: ticket-decomposer.js --epic <EpicId> (--emit-context [--pretty] [--full-context] | --tickets <file>) [--force | --resume]',
    );
  }

  const epicId = Number.parseInt(values.epic, 10);
  const config = resolveConfig();
  const provider = createProvider(config.orchestration);

  if (values['emit-context']) {
    const ctx = await buildDecompositionContext(epicId, provider, config, {
      fullContext: values['full-context'],
    });
    const json = values.pretty
      ? JSON.stringify(ctx, null, 2)
      : JSON.stringify(ctx);
    process.stdout.write(`${json}\n`);
    return;
  }

  if (!values.tickets) {
    Logger.fatal(
      'Missing --tickets <file>. (Use --emit-context first to gather authoring context.)',
    );
  }

  const raw = await readFile(values.tickets, 'utf8');
  let tickets;
  try {
    tickets = JSON.parse(raw);
  } catch (err) {
    Logger.fatal(
      `Failed to parse tickets file "${values.tickets}" as JSON: ${err.message}`,
    );
  }

  await decomposeEpic(epicId, provider, { tickets }, config, {
    force: values.force,
    resume: values.resume,
  });
}

runAsCli(import.meta.url, main, { source: 'Decomposer' });
