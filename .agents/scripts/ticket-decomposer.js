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
 * implemented sequentially. The dispatcher groups tasks by Story and assigns a
 * model_tier (high|low) based on the Story's complexity::high label.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { getLimits, getRunners, resolveConfig } from './lib/config-resolver.js';
import { DEFAULT_DECOMPOSER } from './lib/config-schema.js';
import { Logger } from './lib/Logger.js';
import { TYPE_LABELS } from './lib/label-constants.js';
import { applyBudget } from './lib/orchestration/planning-context-budget.js';
import { validateAndNormalizeTickets } from './lib/orchestration/ticket-validator.js';
import { createProvider } from './lib/provider-factory.js';
import { renderDecomposerSystemPrompt } from './lib/templates/decomposer-prompts.js';
import { concurrentMap } from './lib/util/concurrent-map.js';

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

export async function decomposeEpic(
  epicId,
  provider,
  { tickets },
  _config = {},
  { force = false } = {},
) {
  if (!Array.isArray(tickets)) {
    throw new Error(
      `[Decomposer] tickets must be an array (got ${typeof tickets}).`,
    );
  }

  console.log(`[Decomposer] Fetching Epic #${epicId}...`);
  const epic = await provider.getEpic(epicId);

  if (!epic?.linkedIssues?.prd || !epic.linkedIssues.techSpec) {
    throw new Error(
      `[Decomposer] Epic #${epicId} is missing linked PRD or Tech Spec. Run the Epic Planner first.`,
    );
  }

  // ── Force re-decompose: close existing child tickets ──────────────────
  if (force) {
    console.log('[Decomposer] --force: Closing existing child tickets...');
    const existing = await provider.getTickets(epicId);
    provider.primeTicketCache(existing);
    const childTypes = [
      TYPE_LABELS.FEATURE,
      TYPE_LABELS.STORY,
      TYPE_LABELS.TASK,
    ];
    const children = existing.filter((t) =>
      t.labels.some((l) => childTypes.includes(l)),
    );
    const closePromises = [];
    for (const child of children) {
      if (child.state !== 'closed') {
        const p = provider
          .updateTicket(child.id, {
            state: 'closed',
            state_reason: 'not_planned',
          })
          .then(() => {
            console.log(`[Decomposer]   Closed #${child.id}: ${child.title}`);
          });
        closePromises.push(p);
      }
    }
    await Promise.all(closePromises);
    console.log(`[Decomposer]   Closed ${children.length} old ticket(s).`);
  }

  const maxTickets = getLimits(_config).maxTickets;
  if (tickets.length >= maxTickets) {
    console.warn(
      `[Decomposer] ⚠️  Received ${tickets.length} tickets (at or above the ${maxTickets}-ticket cap). Verify every Story still has child Tasks or split the Epic into smaller scopes.`,
    );
  }

  console.log(
    `[Decomposer] Running cross-validation on ${tickets.length} tickets...`,
  );
  const validated = validateAndNormalizeTickets(tickets);

  const concurrencyCap =
    getRunners(_config).decomposer.concurrencyCap ??
    DEFAULT_DECOMPOSER.concurrencyCap;

  console.log(
    `[Decomposer] Identified ${validated.length} tickets. Starting creation (concurrencyCap=${concurrencyCap})...`,
  );

  const slugMap = new Map();
  const ordered = orderTicketsForCreation(validated);

  // Three staged passes: features → stories → tasks. Each pass blocks the
  // next so parent_slug → ID resolution is preserved (a Story's parent
  // Feature ID is in slugMap before the Story pass runs).
  for (const passType of ['feature', 'story', 'task']) {
    const passTickets = ordered.filter((t) => t.type === passType);
    if (passTickets.length === 0) continue;

    await runCreationPass(
      passTickets,
      slugMap,
      epicId,
      provider,
      concurrencyCap,
    );
  }

  console.log(
    `[Decomposer] Backlog for Epic #${epicId} populated successfully!`,
  );
}

/**
 * Run one staged creation pass with bounded concurrency. Within the pass,
 * intra-group `depends_on` chains are honoured via per-slug deferred promises:
 * a ticket's mapper awaits each dep's promise before reading the slugMap,
 * so a chain like t-a → t-b → t-c serialises naturally even when the cap
 * permits parallel work.
 */
async function runCreationPass(
  tickets,
  slugMap,
  epicId,
  provider,
  concurrencyCap,
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

      console.log(
        `[Decomposer] [${t.type.toUpperCase()}] Creating "${t.title}"...`,
      );

      const parentId = resolveParentId(t, slugMap, epicId);
      const dependencies = resolveDependencies(t, slugMap);

      try {
        const created = await provider.createTicket(parentId, {
          epicId,
          title: t.title,
          body: t.body,
          labels: t.labels || [],
          dependencies,
        });
        console.log(`[Decomposer] -> Created Issue #${created.id}`);
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
      'emit-context': { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      'full-context': { type: 'boolean', default: false },
      tickets: { type: 'string' },
    },
  });

  if (!values.epic) {
    Logger.fatal(
      'Usage: ticket-decomposer.js --epic <EpicId> (--emit-context [--pretty] [--full-context] | --tickets <file>) [--force]',
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
  });
}

runAsCli(import.meta.url, main, { source: 'Decomposer' });
