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
 */

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
 * Build the `blocked by` body footer from a dependsOn slug list. The
 * reconciler prepends this to the create body so the dispatch manifest
 * can read the dependency graph back via the same path the rest of the
 * orchestration uses (body regex). Returns `''` when no deps.
 *
 * @param {string[]|undefined} dependsOn
 * @param {Record<string, number>} slugToIssue
 * @returns {string}
 */
function renderDependsOnFooter(dependsOn, slugToIssue) {
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) return '';
  const lines = [];
  for (const slug of dependsOn) {
    const issueNumber = slugToIssue[slug];
    if (typeof issueNumber === 'number') {
      lines.push(`blocked by #${issueNumber}`);
    }
  }
  return lines.length ? `\n\n${lines.join('\n')}` : '';
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
  const body = `${op.body ?? ''}${renderDependsOnFooter(op.dependsOn, slugToIssue)}`;
  const ticketData = {
    epicId,
    title: op.title,
    body,
    labels: op.labels ?? [],
    dependencies: (op.dependsOn ?? [])
      .map((slug) => slugToIssue[slug])
      .filter((id) => typeof id === 'number'),
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
  return {
    slug: op.slug,
    entity: op.entity,
    kind: OP_KINDS.CREATE,
    issueNumber: created?.id,
    url: created?.url,
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
  if (op.dependsOn) {
    const footer = renderDependsOnFooter(op.dependsOn.after, slugToIssue);
    await provider.updateTicket(op.issueNumber, {
      body: footer ? footer.trimStart() : '',
    });
  }
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
  const slugToIssue = { ...(opts.slugToIssue ?? {}) };

  if (opts.dryRun === true) {
    return buildDryRunResult(plan, slugToIssue);
  }

  // Pre-flight gates. Throws synchronously before any provider call.
  assertGates(plan, opts);

  // Phase 1: creates. Run in parallel — the diff engine emits creates
  // sorted by slug, but child creates may depend on parent creates
  // landing first. We resolve that by seeding `slugToIssue` with any
  // parent already mapped (e.g. epic, pre-existing features) and by
  // running creates in dependency order via a topological pass.
  const orderedCreates = topoSortCreates(plan.creates, slugToIssue);
  const created = [];
  for (const batch of orderedCreates) {
    const batchResults = await concurrentMap(
      batch,
      (op) => applyCreate(op, provider, opts, slugToIssue),
      { concurrency },
    );
    created.push(...batchResults);
  }

  // Phase 2: updates. Independent — run in parallel.
  const updated = await concurrentMap(
    plan.updates,
    (op) => applyUpdate(op, provider),
    { concurrency },
  );

  // Phase 3: closes. Independent — run in parallel.
  const closed = await concurrentMap(
    plan.closes,
    (op) => applyClose(op, provider),
    { concurrency },
  );

  // Phase 4: relinks. Independent — run in parallel.
  const relinked = await concurrentMap(
    plan.relinks,
    (op) => applyRelink(op, provider, slugToIssue),
    { concurrency },
  );

  return {
    dryRun: false,
    created,
    updated,
    closed,
    relinked,
    slugToIssue,
  };
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
  const batches = [];
  while (remaining.length) {
    const ready = remaining.filter(
      (op) => !op.parentSlug || knownSlugs.has(op.parentSlug),
    );
    if (ready.length === 0) {
      // Cycle or missing parent — break out by emitting the rest as one
      // batch and letting `resolveParentId` raise the structured error.
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
