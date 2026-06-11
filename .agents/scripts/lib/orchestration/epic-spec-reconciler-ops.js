/**
 * lib/orchestration/epic-spec-reconciler-ops.js — operation types + plan shape
 * for the epic-spec reconciler diff engine.
 *
 * Story #3302: `createOp` must serialize object bodies via `story-body.js`
 * rather than blind-coercing them with `String()`. See `createOp` for the
 * serialize-or-throw contract.
 *
 * Coverage note: the pure factories and plan utilities in this module are
 * exercised by `tests/story-3302-body-shape.test.js`. The one genuinely
 * untestable branch is the `createOp` serialize catch-rethrow path — it
 * requires `serialize()` to throw on a plain object, which the library
 * contract does not support (serialize only throws on non-object inputs, and
 * those are excluded by the `typeof rawBody === 'object'` guard above); the
 * branch is annotated with a surgical `node:coverage ignore` below.
 *
 * Owns the typed shapes that flow through the structural reconciler (Epic
 * #1182 / Tech Spec #1483 / Story #1492). The diff engine produces these
 * shapes from `(spec, state, ghState)`; the apply engine consumes them.
 * Both are intentionally I/O-free — operation objects are inert plain
 * data so plans can be hashed, serialised, dry-run-rendered, and round-
 * tripped through fixtures without provider involvement.
 *
 * ## Operation kinds
 *
 *   - `create`  — spec carries a slug that is not yet mapped to a GH
 *                 issue. The apply engine will materialise it.
 *   - `update`  — spec slug ↔ GH issue is mapped, but the structural
 *                 content (title/body/labels) drifted. Carries `before`
 *                 + `after` for the changed fields only; unchanged
 *                 fields are omitted.
 *   - `close`   — state mapping points at a GH issue whose slug no
 *                 longer appears in the spec. Apply will close the
 *                 issue (subject to the close-discriminator at apply
 *                 time — orphan-vs-drift is decided there, not in diff).
 *   - `relink`  — parent or `dependsOn` edges changed for a slug whose
 *                 mapping is otherwise stable. Carries the old and new
 *                 edge sets so apply can rewrite `blocked by` references.
 *
 * ## Plan shape
 *
 * `Plan` groups operations by kind into four arrays. This is the canonical
 * shape returned by `diff()` and consumed by `formatPlan()` and the
 * apply pipeline. Arrays are always present (never undefined); an empty
 * plan has all four arrays at length 0.
 *
 * @typedef {'epic'|'story'} EntityKind
 *   The structural entity kind. Matches schema $defs — agent-execution
 *   labels (agent::*) are owned by the wave-runner and never appear in
 *   the structural surface.
 *
 * @typedef {object} CreateOp
 * @property {'create'} kind
 * @property {string}   slug      Stable kebab-case identifier from spec.
 * @property {EntityKind} entity  Which structural level the op acts on.
 * @property {string}   title     Spec-side title (becomes the GH title).
 * @property {string}  [body]     Spec-side body when present.
 * @property {string[]}[labels]   Structural labels (no agent::*).
 * @property {string}  [parentSlug] Slug of the parent feature/story (for
 *                                  features/stories/tasks). Omitted for
 *                                  the epic-level op (epic has no parent).
 * @property {string[]}[dependsOn]  Sibling-story slugs the new Story
 *                                  depends on (stories only).
 * @property {number}  [wave]      Wave number (stories only).
 *
 * @typedef {object} UpdateFieldChange
 * @property {unknown} before
 * @property {unknown} after
 *
 * @typedef {object} UpdateOp
 * @property {'update'} kind
 * @property {string}   slug
 * @property {EntityKind} entity
 * @property {number}   issueNumber  Mapped GH issue number (from state).
 * @property {Record<string, UpdateFieldChange>} changes
 *   Only the changed fields appear here. Keys are `'title'|'body'|'labels'`
 *   (and `'wave'` for stories). `before` / `after` carry the prior + new
 *   values; for `labels` they are sorted string arrays.
 *
 * @typedef {object} CloseOp
 * @property {'close'} kind
 * @property {string}  slug         Slug from state (no longer in spec).
 * @property {EntityKind} entity    Entity kind from state mapping.
 * @property {number}  issueNumber  Mapped GH issue number to close.
 * @property {string} [title]       Last-known title (for human output).
 *
 * @typedef {object} RelinkOp
 * @property {'relink'} kind
 * @property {string}   slug
 * @property {EntityKind} entity     'story' (dependsOn / parent).
 * @property {number}   issueNumber
 * @property {{ before: string|null, after: string|null }} [parent]
 *   Parent slug change. `null` on either side means "no parent" (epic
 *   root). Omitted when the parent edge is unchanged.
 * @property {{ before: string[], after: string[] }} [dependsOn]
 *   Sibling-story slug list change (stories only). Both arrays are sorted
 *   so equality is order-independent. Omitted when the edge set is
 *   unchanged.
 *
 * @typedef {object} Plan
 * @property {CreateOp[]} creates
 * @property {UpdateOp[]} updates
 * @property {CloseOp[]}  closes
 * @property {RelinkOp[]} relinks
 */

import { StoryBodyParseError, serialize } from '../story-body/story-body.js';

/** Operation kind discriminator values. Exported for use by tests + apply. */
export const OP_KINDS = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  CLOSE: 'close',
  RELINK: 'relink',
});

/** Entity-kind discriminator values, matching the schema $defs. */
export const ENTITY_KINDS = Object.freeze({
  EPIC: 'epic',
  STORY: 'story',
});

const VALID_OP_KINDS = new Set(Object.values(OP_KINDS));
const VALID_ENTITY_KINDS = new Set(Object.values(ENTITY_KINDS));

/**
 * Internal helper — assert non-empty slug. Throws so test failures point
 * at the constructor argument rather than surfacing later as a silent
 * "slug: undefined" in formatted output.
 *
 * @param {unknown} slug
 * @returns {string}
 */
function requireSlug(slug) {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new TypeError(
      `operation slug must be a non-empty string (got ${String(slug)})`,
    );
  }
  return slug;
}

/**
 * Internal helper — assert entity kind belongs to the structural set.
 *
 * @param {unknown} entity
 * @returns {EntityKind}
 */
function requireEntity(entity) {
  if (!VALID_ENTITY_KINDS.has(/** @type {string} */ (entity))) {
    throw new TypeError(`unknown entity kind: ${String(entity)}`);
  }
  return /** @type {EntityKind} */ (entity);
}

/**
 * Construct a `CreateOp`. Tests build plans declaratively via this
 * factory so the inert-data shape never drifts from the typedef.
 *
 * @param {{slug: string, entity: EntityKind, title: string, body?: string,
 *          labels?: string[], parentSlug?: string, dependsOn?: string[], wave?: number}} input
 * @returns {CreateOp}
 */
export function createOp(input) {
  const op = {
    kind: OP_KINDS.CREATE,
    slug: requireSlug(input?.slug),
    entity: requireEntity(input?.entity),
    title: String(input?.title ?? ''),
  };
  if (input.body !== undefined) {
    // Story #3302: never blind-coerce body with String(). An object body
    // must be serialized via story-body.js so the caller gets the canonical
    // markdown string rather than "[object Object]". A non-string,
    // non-object value is still coerced (e.g. null, undefined are already
    // gated above by the `!== undefined` check at this branch's entrance).
    const rawBody = input.body;
    if (rawBody !== null && typeof rawBody === 'object') {
      try {
        op.body = serialize(rawBody);
        /* node:coverage ignore next 7 -- serialize() only throws on non-object
           inputs; the rawBody guard above (`typeof rawBody === 'object'`) already
           excludes every value that could make serialize() throw, so this catch
           branch is unreachable in practice. It is kept as a defensive wrapper
           for hypothetical future serialize contract changes. */
      } catch (err) {
        // Re-throw with extra context so callers know which op triggered
        // the serialization failure. StoryBodyParseError is already
        // informative; any other error gets wrapped.
        throw new StoryBodyParseError(
          `createOp: body for slug "${input?.slug}" is an object but could not be serialized: ${err.message}`,
          { field: 'body', raw: JSON.stringify(rawBody).slice(0, 200) },
        );
      }
    } else {
      op.body = String(rawBody);
    }
  }
  if (input.labels !== undefined) op.labels = [...input.labels].sort();
  if (input.parentSlug !== undefined) op.parentSlug = String(input.parentSlug);
  if (input.dependsOn !== undefined) op.dependsOn = [...input.dependsOn].sort();
  if (input.wave !== undefined) op.wave = Number(input.wave);
  return op;
}

/**
 * Construct an `UpdateOp`. `changes` keys are normalised to the closed
 * field set the reconciler is allowed to touch (`title|body|labels|wave`).
 *
 * @param {{slug: string, entity: EntityKind, issueNumber: number,
 *          changes: Record<string, UpdateFieldChange>}} input
 * @returns {UpdateOp}
 */
export function updateOp(input) {
  const changes = {};
  for (const [key, value] of Object.entries(input?.changes ?? {})) {
    if (!value || !('before' in value) || !('after' in value)) {
      throw new TypeError(
        `updateOp change[${key}] must carry { before, after }`,
      );
    }
    changes[key] = { before: value.before, after: value.after };
  }
  return {
    kind: OP_KINDS.UPDATE,
    slug: requireSlug(input?.slug),
    entity: requireEntity(input?.entity),
    issueNumber: Number(input?.issueNumber),
    changes,
  };
}

/**
 * Construct a `CloseOp`.
 *
 * @param {{slug: string, entity: EntityKind, issueNumber: number, title?: string}} input
 * @returns {CloseOp}
 */
export function closeOp(input) {
  const op = {
    kind: OP_KINDS.CLOSE,
    slug: requireSlug(input?.slug),
    entity: requireEntity(input?.entity),
    issueNumber: Number(input?.issueNumber),
  };
  if (input.title !== undefined) op.title = String(input.title);
  return op;
}

/**
 * Construct a `RelinkOp`. At least one of `parent` / `dependsOn` must be
 * present — a relink with no edges changed is meaningless and almost
 * certainly a diff bug, so we reject it loudly.
 *
 * @param {{slug: string, entity: EntityKind, issueNumber: number,
 *          parent?: {before: string|null, after: string|null},
 *          dependsOn?: {before: string[], after: string[]}}} input
 * @returns {RelinkOp}
 */
export function relinkOp(input) {
  if (!input?.parent && !input?.dependsOn) {
    throw new TypeError(
      'relinkOp requires at least one of { parent, dependsOn } to be set',
    );
  }
  const op = {
    kind: OP_KINDS.RELINK,
    slug: requireSlug(input?.slug),
    entity: requireEntity(input?.entity),
    issueNumber: Number(input?.issueNumber),
  };
  if (input.parent) {
    op.parent = {
      before: input.parent.before == null ? null : String(input.parent.before),
      after: input.parent.after == null ? null : String(input.parent.after),
    };
  }
  if (input.dependsOn) {
    op.dependsOn = {
      before: [...input.dependsOn.before].sort(),
      after: [...input.dependsOn.after].sort(),
    };
  }
  return op;
}

/**
 * Build an empty `Plan` — every array length 0. Exported because the
 * diff engine and tests both want the same canonical zero value.
 *
 * @returns {Plan}
 */
export function emptyPlan() {
  return { creates: [], updates: [], closes: [], relinks: [] };
}

/**
 * Type-guard / runtime narrowing — true when `value` looks like a valid
 * `Plan`. Used by `formatPlan` so the formatter can reject malformed
 * inputs with a structured error rather than crashing on `.map`.
 *
 * @param {unknown} value
 * @returns {value is Plan}
 */
export function isPlan(value) {
  if (!value || typeof value !== 'object') return false;
  const p = /** @type {Record<string, unknown>} */ (value);
  return (
    Array.isArray(p.creates) &&
    Array.isArray(p.updates) &&
    Array.isArray(p.closes) &&
    Array.isArray(p.relinks)
  );
}

/**
 * Total operation count across all kinds in a plan. Handy for callers
 * that just want to know "is anything happening?" without inspecting
 * each bucket.
 *
 * @param {Plan} plan
 * @returns {number}
 */
export function planSize(plan) {
  if (!isPlan(plan)) return 0;
  return (
    plan.creates.length +
    plan.updates.length +
    plan.closes.length +
    plan.relinks.length
  );
}

/**
 * True when a plan carries no operations — used by callers (CLI,
 * dry-run output) to short-circuit on the idempotent no-op case.
 *
 * @param {Plan} plan
 * @returns {boolean}
 */
export function isEmptyPlan(plan) {
  return planSize(plan) === 0;
}

/**
 * True for any value that conforms to one of the four operation shapes.
 * Used by tests + formatter validation.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isOperation(value) {
  if (!value || typeof value !== 'object') return false;
  const op = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof op.kind === 'string' &&
    VALID_OP_KINDS.has(op.kind) &&
    typeof op.slug === 'string' &&
    VALID_ENTITY_KINDS.has(/** @type {string} */ (op.entity))
  );
}
