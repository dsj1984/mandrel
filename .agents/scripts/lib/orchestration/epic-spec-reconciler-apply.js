/**
 * lib/orchestration/epic-spec-reconciler-apply.js — apply engine for the
 * epic-spec reconciler (Epic #1182 / Tech Spec #1483 / Story #1494).
 *
 * Consumes a `Plan` produced by `epic-spec-reconciler-diff.js#diff()` and
 * materialises the operations against an `ITicketingProvider` with
 * bounded concurrency. The apply engine is the only place in the
 * structural reconciler that touches the world — every other module in
 * the surface (`epic-spec-reconciler-ops.js`,
 * `epic-spec-reconciler-diff.js`,
 * `epic-spec-reconciler-discriminator.js`,
 * `epic-spec-reconciler-format.js`) is intentionally I/O-free so the
 * data path can be unit-tested in isolation.
 *
 * ## Contract
 *
 *   - `apply(plan, opts)` — executes the plan and returns a typed result
 *     envelope describing what was created, updated, closed, or
 *     relinked. The envelope's shape is stable and machine-readable.
 *   - Concurrency is bounded at 4 via `concurrentMap` from
 *     `lib/util/concurrent-map.js`. The cap matches the
 *     `RECONCILE_CONCURRENCY` constant in
 *     `lib/orchestration/reconciler.js:18` so structural and
 *     label-hygiene reconciliation operate at the same provider load.
 *   - `opts.dryRun === true` short-circuits with zero provider calls.
 *     The returned envelope echoes the plan's intent (`created`,
 *     `updated`, `closed`, `relinked` arrays populated from the plan
 *     ops, marked `dryRun: true`).
 *   - The discriminator gates (`mayClose`, `mayUpdate`) are re-asserted
 *     before any mutation runs. A plan op that fails the gate aborts
 *     `apply` synchronously (Promise rejection) **before** any provider
 *     call is dispatched, so partial failure of a forbidden op is
 *     impossible.
 *   - `assertPlanLabelAllowList` is invoked unconditionally at entry to
 *     re-prove the safety net even on hand-built plans (diff already
 *     asserts; we double-check at apply because tests and CLI callers
 *     may bypass the diff path).
 *
 * ## Result envelope
 *
 * @typedef {object} ApplyResultEntry
 * @property {string}  slug
 * @property {string}  entity
 * @property {string}  kind         'create'|'update'|'close'|'relink'
 * @property {number}  [issueNumber] Resulting issue number (post-create)
 *                                   or the targeted issue number for
 *                                   update/close/relink.
 * @property {string}  [url]        Issue URL when the provider returned one.
 *
 * @typedef {object} ApplyResult
 * @property {boolean} dryRun
 * @property {ApplyResultEntry[]} created
 * @property {ApplyResultEntry[]} updated
 * @property {ApplyResultEntry[]} closed
 * @property {ApplyResultEntry[]} relinked
 * @property {Record<string, number>} slugToIssue
 *   Post-apply slug → issue mapping. On full success, this is the
 *   complete map; on partial failure, it reflects creates that landed
 *   before the failure.
 * @property {object} [state]            The state object the apply
 *                                       pipeline persisted via the
 *                                       `writeState` hook. Omitted when
 *                                       `opts.spec` was not supplied.
 * @property {string} [statePath]        Absolute path the default
 *                                       writer returned; omitted when a
 *                                       custom `writeState` hook ran or
 *                                       when no spec was supplied.
 * @property {Error}  [failure]          Present only when apply exited
 *                                       via partial-failure: the
 *                                       provider error that aborted
 *                                       further dispatch. The state file
 *                                       was still written to reflect the
 *                                       successful ops so the operator
 *                                       can resume cleanly.
 *
 * @typedef {object} ApplyOptions
 * @property {boolean} [dryRun]              Skip provider calls; echo plan.
 * @property {number}  [concurrency]         Override the default cap (4).
 *                                           Tests use 1 to assert order.
 * @property {number}  [epicId]              Required for create ops — the
 *                                           parent Epic issue number that
 *                                           feeds into createTicket's
 *                                           ticketData.epicId field.
 * @property {Record<string, number>} [slugToIssue]
 *                                           Pre-seeded slug → issue map.
 *                                           Apply populates it as creates
 *                                           land so child creates can
 *                                           resolve parentSlug → parentId.
 *                                           Callers (state writer) may
 *                                           read the post-apply state from
 *                                           the returned envelope's
 *                                           `slugToIssue` field.
 * @property {object}  [storySnapshots]      Optional snapshot map keyed
 *                                           by slug carrying live
 *                                           execution state for the
 *                                           close-discriminator. When
 *                                           absent, close ops require
 *                                           `explicitDelete: true` per
 *                                           the discriminator's default.
 * @property {boolean} [explicitDelete]      Operator opt-in: passes
 *                                           through to `mayClose`.
 * @property {object}  [spec]                Parsed spec used to derive
 *                                           the post-apply state-file
 *                                           mapping (Task #1518). When
 *                                           omitted, apply does not
 *                                           touch state.json — useful
 *                                           for tests that only want to
 *                                           drive the provider surface.
 * @property {object}  [priorState]          Prior state loaded from
 *                                           `<epicId>.state.json` (carries
 *                                           pre-existing slug → issue
 *                                           mappings and observed agent
 *                                           states for slugs unchanged
 *                                           by this apply).
 * @property {string}  [stateNow]            Override for the
 *                                           `lastReconciledAt` timestamp.
 *                                           Tests pass a fixed string so
 *                                           the rendered state is
 *                                           byte-stable.
 * @property {(epicId: number, state: object) => string} [writeState]
 *                                           Optional state writer
 *                                           injection point. Defaults to
 *                                           `lib/spec/loader.js#writeState`.
 *                                           Tests pass an in-memory
 *                                           spy so apply does not touch
 *                                           the real on-disk file.
 * @property {{epicsDir?: string}} [writeStateOpts]
 *                                           Forwarded to the default
 *                                           `writeState` adapter so tests
 *                                           can redirect the on-disk
 *                                           output to a tmp dir.
 */

import { Logger } from '../Logger.js';
import { writeState as defaultWriteState } from '../spec/loader.js';
import { buildState } from '../spec/state.js';
import { concurrentMap } from '../util/concurrent-map.js';
import {
  assertPlanLabelAllowList,
  mayClose,
  mayUpdate,
} from './epic-spec-reconciler-discriminator.js';
import { isPlan, OP_KINDS } from './epic-spec-reconciler-ops.js';

/**
 * Default concurrency cap. Hard-pinned to 4 to match
 * `RECONCILE_CONCURRENCY` declared in
 * `.agents/scripts/lib/orchestration/reconciler.js:18`. That constant is
 * file-local in `reconciler.js`; rather than widen its surface for one
 * caller, we duplicate the value with a documented cross-reference. The
 * sibling `concurrency-wiring.test.js` suite owns the invariant that
 * these two values stay in sync.
 */
export const APPLY_CONCURRENCY = 4;

/**
 * Error class thrown when a plan operation fails a discriminator gate.
 * Carrying structured metadata (`slug`, `field`, `reason`) lets the CLI
 * report which op was rejected without re-parsing the message.
 */
export class ApplyGateViolation extends Error {
  /**
   * @param {string} message
   * @param {{slug?: string, kind?: string, field?: string, reason?: string}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ApplyGateViolation';
    if (meta.slug !== undefined) this.slug = meta.slug;
    if (meta.kind !== undefined) this.kind = meta.kind;
    if (meta.field !== undefined) this.field = meta.field;
    if (meta.reason !== undefined) this.reason = meta.reason;
  }
}

/**
 * Pre-flight gate check. Walks every op in the plan and asserts each one
 * passes its discriminator. Throws `ApplyGateViolation` on the first
 * failure so apply aborts before dispatching any provider call.
 *
 * Update ops are checked field-by-field: every key in `op.changes` must
 * pass `mayUpdate(_, field)`. The diff engine already constrains keys to
 * the structural allow-list, but we re-check here so a hand-built plan
 * cannot bypass the safety net.
 *
 * Close ops consult `mayClose(snapshot, { explicitDelete })`. The
 * snapshot is looked up from `opts.storySnapshots` keyed by slug;
 * absence is fine — `mayClose` defaults to the conservative "require
 * explicit delete" path.
 *
 * @param {import('./epic-spec-reconciler-ops.js').Plan} plan
 * @param {ApplyOptions} opts
 * @returns {void}
 */
function assertGates(plan, opts) {
  for (const op of plan.updates) {
    for (const field of Object.keys(op.changes ?? {})) {
      const result = mayUpdate(undefined, field);
      if (!result.allowed) {
        throw new ApplyGateViolation(
          `update for slug=${op.slug} field=${field} blocked: ${result.reason}`,
          { slug: op.slug, kind: 'update', field, reason: result.reason },
        );
      }
    }
  }
  for (const op of plan.closes) {
    const snapshot = opts.storySnapshots?.[op.slug];
    const result = mayClose(snapshot, {
      explicitDelete: opts.explicitDelete === true,
    });
    if (!result.allowed) {
      throw new ApplyGateViolation(
        `close for slug=${op.slug} blocked: ${result.reason}`,
        { slug: op.slug, kind: 'close', reason: result.reason },
      );
    }
  }
}

/**
 * Build a dry-run envelope that echoes the plan's intent without making
 * provider calls. Useful for CLI `--dry-run` output and for the apply
 * pipeline's preview path.
 *
 * @param {import('./epic-spec-reconciler-ops.js').Plan} plan
 * @param {Record<string, number>} slugToIssue
 * @returns {ApplyResult}
 */
/**
 * Seed `slugToIssue.epic` so child features can resolve
 * `parentSlug: 'epic'` through `resolveParentId`. Story #1820: the CLI
 * seeds `state.mapping.epic` so diff no longer emits a Create for the
 * epic; without this matching seed on the apply side, `slugToIssue.epic`
 * is never populated and the first feature create throws "parent slug
 * epic has no mapped issue number". Priority order:
 *   1. Existing `slugToIssue.epic` (caller-supplied) — wins.
 *   2. `opts.priorState.mapping.epic.issueNumber`.
 *   3. `opts.epicId`.
 *
 * @param {Record<string, number>} slugToIssue cloned mapping (mutated in place)
 * @param {ApplyOptions} opts
 * @returns {Record<string, number>} same mapping, returned for chaining
 */
function seedEpicSlug(slugToIssue, opts) {
  if (typeof slugToIssue.epic === 'number') return slugToIssue;
  const priorEpicNumber = opts.priorState?.mapping?.epic?.issueNumber;
  const seed =
    typeof priorEpicNumber === 'number'
      ? priorEpicNumber
      : typeof opts.epicId === 'number'
        ? opts.epicId
        : null;
  if (seed !== null) slugToIssue.epic = seed;
  return slugToIssue;
}

function buildDryRunResult(plan, slugToIssue) {
  return {
    dryRun: true,
    created: plan.creates.map((op) => ({
      slug: op.slug,
      entity: op.entity,
      kind: OP_KINDS.CREATE,
    })),
    updated: plan.updates.map((op) => ({
      slug: op.slug,
      entity: op.entity,
      kind: OP_KINDS.UPDATE,
      issueNumber: op.issueNumber,
    })),
    closed: plan.closes.map((op) => ({
      slug: op.slug,
      entity: op.entity,
      kind: OP_KINDS.CLOSE,
      issueNumber: op.issueNumber,
    })),
    relinked: plan.relinks.map((op) => ({
      slug: op.slug,
      entity: op.entity,
      kind: OP_KINDS.RELINK,
      issueNumber: op.issueNumber,
    })),
    slugToIssue: { ...slugToIssue },
  };
}

/**
 * Resolve a parent slug to an issue number using the running map. Throws
 * a structured error if the slug is required but unknown — apply must
 * not silently drop a parent edge.
 *
 * @param {string|undefined} slug
 * @param {Record<string, number>} slugToIssue
 * @returns {number|undefined}
 */
function resolveParentId(slug, slugToIssue) {
  if (!slug) return undefined;
  const id = slugToIssue[slug];
  if (typeof id !== 'number') {
    throw new ApplyGateViolation(
      `apply: parent slug ${slug} has no mapped issue number`,
      { slug, kind: 'create', reason: 'unmapped-parent' },
    );
  }
  return id;
}

/**
 * Resolve a dependsOn slug list to its issue numbers, failing loud on any
 * unresolved slug. The reconciler hands the resolved numbers to
 * `createTicket` as `ticketData.dependencies`; the provider's
 * `composeStoryBody` is the single owner that renders the canonical
 * `blocked by #N` footer from them (Story #3958). The reconciler must NOT
 * also pre-append a footer to the body — doing so doubled every dependency
 * line, since `composeStoryBody` appends from `dependencies` independently.
 *
 * Fail-loud is preserved here (not delegated to the body composer): an
 * unresolved slug means `topoSortCreates` failed to order a dependency
 * ahead of its dependent, which would otherwise be silently dropped by
 * `dependencies`' number filter. Returns `[]` when no deps.
 *
 * @param {string[]|undefined} dependsOn
 * @param {Record<string, number>} slugToIssue
 * @returns {number[]}
 */
function resolveDependencies(dependsOn, slugToIssue) {
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) return [];
  const resolved = [];
  const unresolved = [];
  for (const slug of dependsOn) {
    const issueNumber = slugToIssue[slug];
    if (typeof issueNumber === 'number') {
      resolved.push(issueNumber);
    } else {
      unresolved.push(slug);
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `[reconciler] resolveDependencies: unresolved dependsOn slugs: ${unresolved.join(', ')}. ` +
        `topoSortCreates must order dependencies ahead of dependents.`,
    );
  }
  return resolved;
}

/**
 * Materialise a single create op. The provider returns
 * `{ id, url }`; we record the slug → id mapping and reflect it in the
 * envelope.
 *
 * @param {import('./epic-spec-reconciler-ops.js').CreateOp} op
 * @param {object} provider
 * @param {ApplyOptions} opts
 * @param {Record<string, number>} slugToIssue
 * @returns {Promise<ApplyResultEntry>}
 */
async function applyCreate(op, provider, opts, slugToIssue) {
  const parentId = resolveParentId(op.parentSlug, slugToIssue);
  const epicId = typeof opts.epicId === 'number' ? opts.epicId : parentId;
  // Story #3958 — resolve (and fail-loud validate) the dependency issue
  // numbers, but do NOT pre-append a `blocked by #N` footer to the body.
  // `composeStoryBody` (the provider's createTicket renderer) is the single
  // owner of that footer; appending here too doubled every dependency line.
  const dependencies = resolveDependencies(op.dependsOn, slugToIssue);
  const ticketData = {
    epicId,
    title: op.title,
    body: op.body ?? '',
    labels: op.labels ?? [],
    dependencies,
  };
  // Epic-level create has no parent — the provider's createTicket
  // expects a parent for sub-issue linkage. For the epic op we route to
  // the same surface but the parentId fallback (epicId) is fine since
  // the epic *is* its own anchor; the diff engine never emits this in
  // practice (the epic is bootstrapped before reconciliation), but we
  // keep the path safe.
  const created = await provider.createTicket(parentId ?? epicId, ticketData);
  if (created && typeof created.id === 'number') {
    slugToIssue[op.slug] = created.id;
  }
  // Defence — Story #2063. GitHubProvider.createTicket captures a
  // failed addSubIssue mutation into `{ subIssueLinked: false,
  // subIssueError }` rather than throwing, so a transient GraphQL
  // failure (secondary rate-limit, "Something went wrong" envelope,
  // etc.) leaves the issue created on GH but with no native sub-issue
  // link to its parent. The previous behaviour swallowed this
  // entirely — a partial backlog persisted with no operator-visible
  // signal. Surface it here at WARN so the breadcrumb is visible; the
  // canonical repair runs in `runDecomposePhase` via
  // `reconcileSubIssueLinks(epicId)` after every apply pass.
  if (created && created.subIssueLinked === false) {
    const reason =
      created.subIssueError?.message ?? 'no error message captured';
    Logger.warn(
      `[reconciler.apply] sub-issue link failed for child #${created.id} (parent #${parentId ?? epicId}): ${reason}. The runDecomposePhase safety net will retry.`,
    );
  }
  return {
    slug: op.slug,
    entity: op.entity,
    kind: OP_KINDS.CREATE,
    issueNumber: created?.id,
    url: created?.url,
    subIssueLinked: created?.subIssueLinked,
  };
}

/**
 * Materialise a single update op. Translates the plan's `changes` map
 * into the provider's `mutations` shape: `title`/`body` map directly,
 * `labels` becomes `{ add, remove }` derived from the before/after
 * difference, and `wave` is appended to the body marker (the wave
 * integer lives in the body, not on a label).
 *
 * @param {import('./epic-spec-reconciler-ops.js').UpdateOp} op
 * @param {object} provider
 * @returns {Promise<ApplyResultEntry>}
 */
async function applyUpdate(op, provider) {
  const mutations = {};
  const changes = op.changes ?? {};
  if (changes.title) {
    mutations.title = changes.title.after;
  }
  if (changes.body) {
    mutations.body = changes.body.after;
  }
  if (changes.labels) {
    const before = new Set(changes.labels.before ?? []);
    const after = new Set(changes.labels.after ?? []);
    const add = [...after].filter((l) => !before.has(l));
    const remove = [...before].filter((l) => !after.has(l));
    if (add.length || remove.length) {
      mutations.labels = { add, remove };
    }
  }
  await provider.updateTicket(op.issueNumber, mutations);
  return {
    slug: op.slug,
    entity: op.entity,
    kind: OP_KINDS.UPDATE,
    issueNumber: op.issueNumber,
  };
}

/**
 * Materialise a single close op. The provider's `updateTicket`
 * mutation surface accepts `{ state: 'closed' }`, matching the mock
 * provider in `tests/fixtures/mock-provider.js`.
 *
 * @param {import('./epic-spec-reconciler-ops.js').CloseOp} op
 * @param {object} provider
 * @returns {Promise<ApplyResultEntry>}
 */
async function applyClose(op, provider) {
  await provider.updateTicket(op.issueNumber, { state: 'closed' });
  return {
    slug: op.slug,
    entity: op.entity,
    kind: OP_KINDS.CLOSE,
    issueNumber: op.issueNumber,
  };
}

/**
 * Materialise a single relink op. Parent edge changes are written by
 * removing the existing sub-issue link (when present) and adding the
 * new one. DependsOn edge changes rewrite the body's `blocked by`
 * footer; we surface the new edge list to the provider via an
 * `updateTicket` body mutation. The plan carries before/after so the
 * caller can render the body locally without re-fetching the ticket
 * (`opts.bodyRenderer` injects the renderer; absence = no-op on body).
 *
 * @param {import('./epic-spec-reconciler-ops.js').RelinkOp} op
 * @param {object} provider
 * @param {Record<string, number>} slugToIssue
 * @returns {Promise<ApplyResultEntry>}
 */
async function applyRelink(op, provider, slugToIssue) {
  if (op.parent) {
    const before = op.parent.before;
    const after = op.parent.after;
    if (before) {
      const beforeId = slugToIssue[before];
      if (typeof beforeId === 'number') {
        await provider.removeSubIssue(beforeId, op.issueNumber);
      }
    }
    if (after) {
      const afterId = slugToIssue[after];
      if (typeof afterId === 'number') {
        await provider.addSubIssue(afterId, op.issueNumber);
      }
    }
  }
  // Story #2982 — dependsOn edge changes no longer write the body here.
  // The diff engine recomposes the canonical orchestrator footer
  // (`---\nparent:`/`Epic:`/`blocked by`) and routes a body change
  // through `applyUpdate`. Writing it from the relink path stripped
  // description + parent + Epic on every dep change. The relink op
  // remains the authoritative carrier of the dependsOn delta for the
  // state writer and for the parent sub-issue add/remove above.
  return {
    slug: op.slug,
    entity: op.entity,
    kind: OP_KINDS.RELINK,
    issueNumber: op.issueNumber,
  };
}

/**
 * Apply a plan against an `ITicketingProvider`.
 *
 * Execution order: creates → updates → closes → relinks. Creates run
 * first so subsequent updates/relinks can target the newly minted
 * issue numbers (the running `slugToIssue` map propagates IDs across
 * phases). Within each phase, ops are dispatched through `concurrentMap`
 * at cap=4.
 *
 * Errors:
 *   - `ApplyGateViolation` — pre-flight gate failed; no provider call
 *     was issued.
 *   - Provider errors — `concurrentMap`'s first-rejection-wins semantics
 *     surface the first failure; later rejections are swallowed. The
 *     `slugToIssue` map reflects whatever creates completed before the
 *     failure, so the caller (state writer) can persist a partial
 *     mapping if desired.
 *
 * @param {import('./epic-spec-reconciler-ops.js').Plan} plan
 * @param {object} provider                 ITicketingProvider instance.
 * @param {ApplyOptions} [opts]
 * @returns {Promise<ApplyResult>}
 */
export async function apply(plan, provider, opts = {}) {
  if (!isPlan(plan)) {
    throw new TypeError('apply: plan must conform to the Plan shape');
  }
  if (!provider || typeof provider !== 'object') {
    throw new TypeError('apply: provider is required');
  }
  // Re-prove the label allow-list safety net at the apply boundary.
  assertPlanLabelAllowList(plan);

  const concurrency =
    typeof opts.concurrency === 'number' && opts.concurrency > 0
      ? opts.concurrency
      : APPLY_CONCURRENCY;
  const slugToIssue = seedEpicSlug({ ...(opts.slugToIssue ?? {}) }, opts);

  if (opts.dryRun === true) {
    return buildDryRunResult(plan, slugToIssue);
  }

  // Pre-flight gates. Throws synchronously before any provider call.
  assertGates(plan, opts);

  const created = [];
  const updated = [];
  const closed = [];
  const relinked = [];
  let failure = null;

  // Phase 1: creates. Topo-batched so parent issues materialise before
  // their children.
  try {
    const orderedCreates = topoSortCreates(plan.creates, slugToIssue);
    for (const batch of orderedCreates) {
      const batchResults = await concurrentMap(
        batch,
        (op) => applyCreate(op, provider, opts, slugToIssue),
        { concurrency },
      );
      created.push(...batchResults);
    }
    // Phase 2: updates. Independent — run in parallel.
    updated.push(
      ...(await concurrentMap(plan.updates, (op) => applyUpdate(op, provider), {
        concurrency,
      })),
    );
    // Phase 3: closes. Independent — run in parallel. Note we remove the
    // slug from `slugToIssue` so the projected state mapping drops it
    // (matches the AC: closes disappear from state).
    closed.push(
      ...(await concurrentMap(
        plan.closes,
        async (op) => {
          const entry = await applyClose(op, provider);
          delete slugToIssue[op.slug];
          return entry;
        },
        { concurrency },
      )),
    );
    // Phase 4: relinks. Independent — run in parallel.
    relinked.push(
      ...(await concurrentMap(
        plan.relinks,
        (op) => applyRelink(op, provider, slugToIssue),
        { concurrency },
      )),
    );
  } catch (err) {
    failure = err;
  }

  const result = {
    dryRun: false,
    created,
    updated,
    closed,
    relinked,
    slugToIssue: { ...slugToIssue },
  };

  // State writer integration (Task #1518). When the caller provided a
  // spec, project the resulting state and persist it. On partial failure
  // the state reflects only completed operations — the `slugToIssue` map
  // above already encodes that (failed creates never landed; closed
  // slugs were removed; failed closes leave the slug present).
  if (opts.spec && typeof opts.spec === 'object') {
    const writeStateFn = opts.writeState ?? defaultWriteState;
    const epicId =
      typeof opts.epicId === 'number'
        ? opts.epicId
        : typeof opts.spec?.epic?.id === 'number'
          ? opts.spec.epic.id
          : undefined;
    const state = projectStateForWrite({
      spec: opts.spec,
      priorState: opts.priorState,
      slugToIssue,
      now: opts.stateNow,
    });
    const writeArgs = [epicId, state];
    if (opts.writeStateOpts) writeArgs.push(opts.writeStateOpts);
    const writePath = writeStateFn(...writeArgs);
    result.state = state;
    if (typeof writePath === 'string') {
      result.statePath = writePath;
    }
  }

  if (failure) {
    result.failure = failure;
  }
  return result;
}

/**
 * Project a state object from `(spec, priorState, slugToIssue)` for the
 * state writer. Layers the post-apply slug → issue map onto the
 * canonical `buildState` output so newly-created issues get their fresh
 * numbers, dropped slugs disappear, and pre-existing observed agent
 * state is preserved for slugs unchanged by this apply.
 *
 * Idempotency contract (AC: "successful apply followed by an immediate
 * second apply is a no-op"). The diff engine's empty plan, the projected
 * mapping, and the byte-identical state writer compose to produce the
 * same on-disk state across re-runs.
 *
 * @param {{spec: object, priorState?: object, slugToIssue: Record<string, number>, now?: string}} input
 * @returns {{epicId: number, lastReconciledAt: string, mapping: object}}
 */
function projectStateForWrite({ spec, priorState, slugToIssue, now }) {
  const base = buildState(spec, priorState ?? {}, now ? { now } : {});
  // `buildState` projects feature/story/task slugs — `iterSpecEntries`
  // intentionally walks features down, so the epic slug is not yielded.
  // The reconciler's contract (Tech Spec §"state.json") expects the
  // epic to appear in the mapping too: layer it on explicitly here so
  // a follow-up diff sees the epic mapped and emits no create for it.
  if (spec?.epic && typeof spec.epic.id === 'number' && !base.mapping.epic) {
    const priorEpic = priorState?.mapping?.epic ? priorState.mapping.epic : {};
    base.mapping.epic = {
      issueNumber:
        typeof slugToIssue.epic === 'number'
          ? slugToIssue.epic
          : typeof priorEpic.issueNumber === 'number'
            ? priorEpic.issueNumber
            : spec.epic.id,
      contentHash:
        typeof priorEpic.contentHash === 'string' ? priorEpic.contentHash : '',
      lastObservedAgentState:
        typeof priorEpic.lastObservedAgentState === 'string'
          ? priorEpic.lastObservedAgentState
          : null,
      entity: 'epic',
      parentSlug: null,
    };
  }
  // Layer structural edge metadata (entity, parentSlug, dependsOn) onto
  // each mapping entry. The diff engine reads these fields to decide
  // whether a Relink op should fire; without them every follow-up diff
  // would re-emit a relink for the parent edge that already exists in
  // GH. The AC's idempotency invariant requires this layering — the
  // pure mapping projection (`spec/state.js`) intentionally does not
  // carry edge data so the hashing path can stay isolated.
  const edgeLookup = collectStructuralEdges(spec);
  for (const slug of Object.keys(base.mapping)) {
    const entry = base.mapping[slug];
    const issueNumber = slugToIssue[slug];
    if (typeof issueNumber === 'number') {
      entry.issueNumber = issueNumber;
    }
    const edges = edgeLookup[slug];
    if (edges) {
      entry.entity = edges.entity;
      entry.parentSlug = edges.parentSlug;
      if (edges.dependsOn) entry.dependsOn = edges.dependsOn;
    }
  }
  // Closed slugs (dropped from spec) are absent from `base.mapping`
  // because `buildState` walks the spec. That matches the AC: closed
  // entries do not appear in state.
  return base;
}

/**
 * Walk the spec once and emit `{ slug → { entity, parentSlug, dependsOn? } }`
 * so `projectStateForWrite` can layer the edges back onto the state
 * mapping. Pure / allocation-bounded; runs O(spec size).
 *
 * @param {object} spec
 * @returns {Record<string, {entity: string, parentSlug: string|null, dependsOn?: string[]}>}
 */
function collectStructuralEdges(spec) {
  const out = {};
  if (!spec || typeof spec !== 'object') return out;
  const epicSlug = 'epic';
  for (const story of spec.stories ?? []) {
    if (!story?.slug) continue;
    out[story.slug] = {
      entity: 'story',
      parentSlug: epicSlug,
      dependsOn: [...(story.dependsOn ?? [])].sort(),
    };
  }
  return out;
}

/**
 * Topologically sort the create ops into dependency batches. Each batch
 * is a list of ops whose parents are already in `slugToIssue` or in an
 * earlier batch. This keeps parent creates ahead of child creates
 * without forcing a global single-file execution.
 *
 * @param {import('./epic-spec-reconciler-ops.js').CreateOp[]} creates
 * @param {Record<string, number>} slugToIssue
 * @returns {import('./epic-spec-reconciler-ops.js').CreateOp[][]}
 */
function topoSortCreates(creates, slugToIssue) {
  if (!creates.length) return [];
  const remaining = [...creates];
  const knownSlugs = new Set(Object.keys(slugToIssue));
  // dependsOn slugs may reference siblings that are themselves in the
  // create batch — those become known once their batch lands. Any slug
  // that is neither pre-known nor will be created here is an external
  // reference we can't satisfy via topo order; treat it as "satisfiable
  // outside the batch" so we don't deadlock. The fail-loud renderer
  // catches truly unresolved slugs at apply time.
  const createSlugs = new Set(creates.map((op) => op.slug));
  const batches = [];
  while (remaining.length) {
    const ready = remaining.filter((op) => {
      const parentReady = !op.parentSlug || knownSlugs.has(op.parentSlug);
      const depsReady =
        !Array.isArray(op.dependsOn) ||
        op.dependsOn.every((d) => knownSlugs.has(d) || !createSlugs.has(d));
      return parentReady && depsReady;
    });
    if (ready.length === 0) {
      // Cycle or missing parent — break out by emitting the rest as one
      // batch and letting `resolveParentId` / footer renderer raise the
      // structured error.
      batches.push(remaining.splice(0));
      break;
    }
    batches.push(ready);
    for (const op of ready) knownSlugs.add(op.slug);
    for (const op of ready) {
      const idx = remaining.indexOf(op);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }
  return batches;
}
