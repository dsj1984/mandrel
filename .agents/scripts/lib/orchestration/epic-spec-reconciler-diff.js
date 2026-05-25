/**
 * lib/orchestration/epic-spec-reconciler-diff.js — pure-function diff
 * engine for the epic-spec reconciler (Epic #1182 / Tech Spec #1483 /
 * Story #1492).
 *
 * `diff({ spec, state, ghState })` walks the three inputs and emits a
 * `Plan` (see `epic-spec-reconciler-ops.js`) carrying the structural
 * mutations the apply engine needs to perform. The function is **pure**:
 *
 *   • No file I/O, no GitHub provider calls, no clock, no env lookups.
 *   • Same inputs → byte-identical plan (operations sorted by slug; field
 *     keys + label arrays canonicalised).
 *   • Safe to call repeatedly. An empty diff is idempotent — re-running
 *     against the same `(spec, state, ghState)` triple yields the same
 *     empty plan.
 *
 * ## Inputs
 *
 * @typedef {object} SpecInput
 *   The parsed YAML returned by `lib/spec/loader.js#loadSpec`. Shape is
 *   `{ epic: {...}, features: [{slug, stories: [...]}], gates?: {...} }`
 *   per `.agents/schemas/epic-spec.schema.json`.
 *
 * @typedef {object} StateMappingEntry
 * @property {number} issueNumber          GH issue number this slug maps to.
 * @property {string} entity               'epic'|'feature'|'story'|'task'.
 * @property {string} [contentHash]        Content hash captured at last
 *                                         reconcile; absence forces an
 *                                         update when ghState carries
 *                                         structural fields. Present from
 *                                         the writer in the apply phase.
 * @property {string} [parentSlug]         Parent slug at last reconcile.
 *                                         Used for relink detection.
 * @property {string[]} [dependsOn]        Sibling-story slugs at last
 *                                         reconcile (stories only).
 *
 * @typedef {object} StateInput
 * @property {number} epicId
 * @property {Record<string, StateMappingEntry>} mapping  Slug → entry.
 * @property {string} [lastReconciledAt]
 *
 * @typedef {object} GhIssueObservation
 * @property {string}   title
 * @property {string}   [body]
 * @property {string[]} [labels]
 * @property {'open'|'closed'} [state]
 *
 * @typedef {Record<string|number, GhIssueObservation>} GhStateInput
 *   Keyed by GH issue number. Stringified numeric keys are coerced so
 *   callers may pass either `{ 1234: {...} }` or `{ "1234": {...} }`.
 *
 * ## Algorithm
 *
 *   1. Walk the spec depth-first, emitting one logical entity per
 *      `(epic|feature|story|task)`. For each entity:
 *        - look up the slug in `state.mapping`.
 *        - if no mapping → Create.
 *        - if mapped → compare structural fields against ghState[
 *          mapping.issueNumber] → Update for any diff in title/body/
 *          labels/wave.
 *        - if mapping carries `parentSlug` or `dependsOn` and they
 *          differ from the spec → Relink.
 *   2. Walk `state.mapping` for any slug that did NOT appear in the
 *      spec walk → Close.
 *   3. Sort each bucket by slug for deterministic output, then return
 *      the plan.
 *
 * Edge cases the engine deliberately handles:
 *
 *   • Epic-level entity has no parent → `parentSlug` is always `null`
 *     for the epic; relink never fires on the epic.
 *   • Tasks have no `wave` / `dependsOn` → those fields are skipped on
 *     tasks even when present in the input (defensive).
 *   • A slug in the mapping whose `ghState` is missing entirely still
 *     yields a Close (the mapping itself is the ground truth that the
 *     spec dropped this entity).
 *   • Label comparisons ignore order: arrays are sorted before compare.
 *   • `body` and other optional fields treat `undefined === ''` as
 *     equality so a spec that omits `body` does not flap against a GH
 *     issue with an empty body.
 */

import {
  composeTaskBody,
  stripOrchestratorFooter,
} from '../templates/task-body-renderer.js';
import { assertPlanLabelAllowList } from './epic-spec-reconciler-discriminator.js';
import {
  closeOp,
  createOp,
  ENTITY_KINDS,
  emptyPlan,
  relinkOp,
  updateOp,
} from './epic-spec-reconciler-ops.js';

/**
 * Compare two label arrays for equality, ignoring order. Returns true
 * when both lists carry the same multiset of strings.
 *
 * @param {string[]|undefined} a
 * @param {string[]|undefined} b
 * @returns {boolean}
 */
function labelsEqual(a, b) {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/**
 * Label-namespace prefixes that the reconciler must NOT strip from the
 * Epic on persist. The decomposer renders the Epic spec entry from
 * `{ id, title }` only — it does not carry `epic.labels` through — so
 * a naive replace-style label diff would propose removing operator-
 * managed metadata that lives in these namespaces.
 *
 * Why: Story #2056 / Epic #1994 — `/epic-plan` was silently stripping
 * `type::epic` and `risk::*` from the parent Epic on every decompose,
 * which then broke `dispatcher.js` (`type "unknown"`). Defence-in-depth
 * lives here in the diff engine: even if a future spec author drops
 * these labels, the reconciler will not propose their removal.
 *
 * Symmetry with the `agent::*` allow-list (owned by the wave-runner,
 * defended in `epic-spec-reconciler-discriminator.js`): the diff engine
 * treats both namespaces as out-of-scope for structural reconciliation,
 * but via different mechanisms — `agent::*` is rejected at construction
 * time, while these structural namespaces are merged into the Epic's
 * after-set so the comparison stays a no-op.
 */
const PROTECTED_EPIC_LABEL_NAMESPACES = Object.freeze(['type::', 'risk::']);

/**
 * @param {unknown} label
 * @returns {boolean}
 */
function isProtectedEpicLabel(label) {
  if (typeof label !== 'string') return false;
  return PROTECTED_EPIC_LABEL_NAMESPACES.some((ns) => label.startsWith(ns));
}

/**
 * Return the spec's label list for the Epic entity, augmented with any
 * protected-namespace labels observed on the live GH issue. Stable
 * across calls (uses a Set to deduplicate). When neither input carries
 * anything to merge, the original `specLabels` reference is returned
 * unchanged so callers that compare references stay correct.
 *
 * @param {string[]|undefined} specLabels
 * @param {string[]|undefined} obsLabels
 * @returns {string[]|undefined}
 */
function mergeProtectedEpicLabels(specLabels, obsLabels) {
  if (!Array.isArray(obsLabels) || obsLabels.length === 0) return specLabels;
  const preserved = obsLabels.filter(isProtectedEpicLabel);
  if (preserved.length === 0) return specLabels;
  const merged = new Set([...(specLabels ?? []), ...preserved]);
  return [...merged];
}

/**
 * Treat undefined/null body as the empty string for comparison.
 *
 * @param {string|undefined|null} value
 * @returns {string}
 */
function normaliseBody(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Compose the canonical orchestrator footer onto a spec body for non-epic
 * entities. Resolves `parentSlug`/`dependsOn` slugs against the running
 * `state.mapping` so the rendered footer carries the live issue numbers.
 * Pure: identical inputs produce a byte-identical body.
 *
 * Story #2982 — without this re-composition, a body Update sourced from
 * the YAML spec writes just the description, silently stripping
 * `parent: #N` / `Epic: #M` / `blocked by #X` and breaking the cascade.
 *
 * @param {{entity: string, parentSlug?: string|null, dependsOn?: string[]}} specEntity
 * @param {string} specBody
 * @param {{state?: StateInput}} ctx
 * @returns {string}
 */
function composeBodyWithFooter(specEntity, specBody, ctx) {
  const state = ctx?.state ?? {};
  const mapping = state.mapping ?? {};
  const parentSlug = specEntity.parentSlug ?? null;
  const parentId =
    parentSlug && mapping[parentSlug]
      ? mapping[parentSlug].issueNumber
      : undefined;
  // Without a resolved parent we cannot render a meaningful footer.
  // Fall back to the raw spec body — apply still writes something the
  // operator can inspect; the missing-parent case is rare (the only
  // current trigger is a relink-in-flight where the new parent has not
  // landed yet, which surfaces elsewhere via the relink op anyway).
  if (typeof parentId !== 'number') return specBody;
  const epicId = typeof state.epicId === 'number' ? state.epicId : undefined;
  const dependencies = Array.isArray(specEntity.dependsOn)
    ? specEntity.dependsOn
        .map((slug) => mapping[slug]?.issueNumber)
        .filter((id) => typeof id === 'number')
    : [];
  // Strip any orchestrator footer the spec already carries before
  // recomposing. Without the strip we double-wrap when the spec body
  // round-tripped through `reverse-bootstrap` (which stores the raw GH
  // body verbatim, footer included) or any other producer that emits a
  // canonical-form body. With the strip, the function is idempotent
  // against its own output and against the createTicket-rendered shape.
  const head = stripOrchestratorFooter(specBody);
  return composeTaskBody({
    body: head,
    parentId,
    epicId,
    dependencies,
  });
}

/**
 * Pick the ghState observation for an issue number, coercing the key
 * type so numeric and string keys interop.
 *
 * @param {GhStateInput|undefined|null} ghState
 * @param {number} issueNumber
 * @returns {GhIssueObservation|undefined}
 */
function ghObservation(ghState, issueNumber) {
  if (!ghState) return undefined;
  return ghState[issueNumber] ?? ghState[String(issueNumber)] ?? undefined;
}

/**
 * Compute the structural-field changes between a spec entity and the GH
 * observation. Returns an empty object when nothing changed.
 *
 * @param {{title: string, body?: string, labels?: string[], wave?: number, entity: string}} specEntity
 * @param {GhIssueObservation|undefined} obs
 * @param {StateMappingEntry} mapping
 * @returns {Record<string, {before: unknown, after: unknown}>}
 */
function fieldChanges(specEntity, obs, mapping, ctx = {}) {
  const changes = {};
  if (!obs) {
    // Mapped but GH side missing → treat as full update (apply will
    // recreate body/labels/title). Callers can choose to escalate via
    // the close-discriminator.
    return changes;
  }
  if (specEntity.title !== obs.title) {
    changes.title = { before: obs.title, after: specEntity.title };
  }
  // Schema contract (epic-spec.schema.json §epic.body and the parallel
  // feature/story/task body fields): "When omitted, the GH issue body
  // is left untouched". Pre-Story-#2283 the engine treated `undefined`
  // as `""`, which emitted a destructive `body: <existing> → ""` Update
  // on every `/epic-plan` Phase 8 because the decomposer's renderer
  // projects the Epic spec entry from `{ id, title }` only. Skip the
  // body diff entirely when the spec did not carry a body string. An
  // explicit `body: ""` in the spec still produces a clear-op when the
  // GH side is non-empty (operator-authored intent to blank the body).
  if (typeof specEntity.body === 'string') {
    const specBody = specEntity.body;
    const obsBody = normaliseBody(obs.body);
    const isEpic = specEntity.entity === ENTITY_KINDS.EPIC;
    if (isEpic) {
      if (specBody !== obsBody) {
        changes.body = { before: obsBody, after: specBody };
      }
    } else {
      // Story #2982 — for non-epic entities, compare the spec body
      // (re-composed with the canonical orchestrator footer) against
      // the raw GH body. Single comparison catches:
      //   • description-only changes,
      //   • parent/Epic id changes (footer differs),
      //   • dependsOn changes (`blocked by` block differs),
      //   • duplicated footer blocks (obs has more than one),
      //   • missing footer (obs has none).
      // Emit a body change only when the canonical form differs from
      // what is on GH today — and write the canonical form back, so the
      // footer cascade-readers depend on stays intact across resumes.
      const after = composeBodyWithFooter(specEntity, specBody, ctx);
      if (after !== obsBody) {
        changes.body = { before: obsBody, after };
      }
    }
  }
  const effectiveAfterLabels =
    specEntity.entity === ENTITY_KINDS.EPIC
      ? mergeProtectedEpicLabels(specEntity.labels, obs.labels)
      : specEntity.labels;
  if (!labelsEqual(effectiveAfterLabels, obs.labels)) {
    changes.labels = {
      before: [...(obs.labels ?? [])].sort(),
      after: [...(effectiveAfterLabels ?? [])].sort(),
    };
  }
  // wave is story-only; only fire when both sides carry an integer and
  // they differ. Mapping carries the last-known wave under
  // `mapping.wave` (apply-engine populates it); absent → skip.
  if (specEntity.entity === ENTITY_KINDS.STORY) {
    const beforeWave =
      typeof mapping.wave === 'number' ? mapping.wave : undefined;
    const afterWave =
      typeof specEntity.wave === 'number' ? specEntity.wave : undefined;
    if (
      beforeWave !== undefined &&
      afterWave !== undefined &&
      beforeWave !== afterWave
    ) {
      changes.wave = { before: beforeWave, after: afterWave };
    }
  }
  return changes;
}

/**
 * Compare two parent-edge values. `null` represents "no parent" (the
 * epic root). Strings compare by value.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
function parentEqual(a, b) {
  const left = a == null ? null : a;
  const right = b == null ? null : b;
  return left === right;
}

/**
 * Sort an array of operations by slug, returning a new array.
 *
 * @template {{slug: string}} T
 * @param {T[]} ops
 * @returns {T[]}
 */
function sortBySlug(ops) {
  return [...ops].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Walk the spec and yield one structural-entity record per visited
 * node. The walker is iterative-via-recursion but bounded by the spec's
 * nesting (epic → features → stories → tasks); the depth never exceeds
 * 4 so an explicit work-queue would just obscure the shape.
 *
 * @param {SpecInput} spec
 * @returns {Array<{
 *   slug: string,
 *   entity: string,
 *   title: string,
 *   body?: string,
 *   labels?: string[],
 *   wave?: number,
 *   parentSlug: string|null,
 *   dependsOn?: string[],
 * }>}
 */
function flattenSpec(spec) {
  const out = [];
  if (!spec || typeof spec !== 'object') return out;

  // Epic — no parent.
  if (spec.epic && typeof spec.epic === 'object') {
    out.push({
      slug: epicSlug(spec.epic),
      entity: ENTITY_KINDS.EPIC,
      title: String(spec.epic.title ?? ''),
      body: spec.epic.body,
      labels: spec.epic.labels,
      parentSlug: null,
    });
  }

  const epicAnchor = spec.epic ? epicSlug(spec.epic) : null;
  for (const feature of spec.features ?? []) {
    out.push({
      slug: feature.slug,
      entity: ENTITY_KINDS.FEATURE,
      title: String(feature.title ?? ''),
      body: feature.body,
      labels: feature.labels,
      parentSlug: epicAnchor,
    });
    for (const story of feature.stories ?? []) {
      out.push({
        slug: story.slug,
        entity: ENTITY_KINDS.STORY,
        title: String(story.title ?? ''),
        body: story.body,
        labels: story.labels,
        wave: story.wave,
        parentSlug: feature.slug,
        dependsOn: story.dependsOn ?? [],
      });
      for (const task of story.tasks ?? []) {
        out.push({
          slug: task.slug,
          entity: ENTITY_KINDS.TASK,
          title: String(task.title ?? ''),
          body: task.body,
          labels: task.labels,
          parentSlug: story.slug,
        });
      }
    }
  }
  return out;
}

/**
 * The epic-level slug is synthetic — the spec keys the epic by GH issue
 * number, not by a slug — but the reconciler needs a stable identifier
 * to thread the epic entity through the operation surface (state
 * mapping, plan formatter, etc). We use the canonical literal `epic`
 * so the formatter can render it without special-casing.
 *
 * @param {{id: number}} epic
 * @returns {string}
 */
function epicSlug(_epic) {
  // Single epic per spec — schema requires it — so a constant slug is
  // unambiguous and matches the way mapping is keyed in writeState
  // (where the epic entry is stored under `epic`).
  return `epic`;
}

/**
 * Compute equality between two `dependsOn` lists, ignoring order.
 *
 * @param {string[]|undefined} a
 * @param {string[]|undefined} b
 * @returns {boolean}
 */
function dependsOnEqual(a, b) {
  return labelsEqual(a, b);
}

/**
 * Diff `(spec, state, ghState)` into a `Plan`. See the module header for
 * the full contract.
 *
 * @param {{spec: SpecInput, state: StateInput, ghState?: GhStateInput}} input
 * @returns {import('./epic-spec-reconciler-ops.js').Plan}
 */
export function diff({ spec, state, ghState } = {}) {
  const plan = emptyPlan();
  if (!spec || typeof spec !== 'object') return plan;
  if (!state || typeof state !== 'object') {
    throw new TypeError('diff: state argument is required');
  }
  const mapping = state.mapping ?? {};
  const seenSpecSlugs = new Set();

  for (const entity of flattenSpec(spec)) {
    seenSpecSlugs.add(entity.slug);
    const mapped = mapping[entity.slug];

    if (!mapped) {
      plan.creates.push(
        createOp({
          slug: entity.slug,
          entity: entity.entity,
          title: entity.title,
          body: entity.body,
          labels: entity.labels,
          parentSlug:
            entity.parentSlug === null ? undefined : entity.parentSlug,
          dependsOn: entity.dependsOn,
          wave: entity.wave,
        }),
      );
      continue;
    }

    // Mapped: check for content updates.
    const obs = ghObservation(ghState, mapped.issueNumber);
    const changes = fieldChanges(entity, obs, mapped, { state });
    if (Object.keys(changes).length > 0) {
      plan.updates.push(
        updateOp({
          slug: entity.slug,
          entity: entity.entity,
          issueNumber: mapped.issueNumber,
          changes,
        }),
      );
    }

    // Mapped: check for relink (parent / dependsOn edge changes).
    const relinkPayload = {};
    const beforeParent = mapped.parentSlug ?? null;
    const afterParent = entity.parentSlug ?? null;
    if (
      !parentEqual(beforeParent, afterParent) &&
      entity.entity !== ENTITY_KINDS.EPIC
    ) {
      relinkPayload.parent = { before: beforeParent, after: afterParent };
    }
    if (entity.entity === ENTITY_KINDS.STORY) {
      const beforeDeps = mapped.dependsOn ?? [];
      const afterDeps = entity.dependsOn ?? [];
      if (!dependsOnEqual(beforeDeps, afterDeps)) {
        relinkPayload.dependsOn = { before: beforeDeps, after: afterDeps };
      }
    }
    if (Object.keys(relinkPayload).length > 0) {
      plan.relinks.push(
        relinkOp({
          slug: entity.slug,
          entity: entity.entity,
          issueNumber: mapped.issueNumber,
          ...relinkPayload,
        }),
      );
    }
  }

  // Closes — anything in mapping not seen in spec.
  for (const [slug, mapped] of Object.entries(mapping)) {
    if (seenSpecSlugs.has(slug)) continue;
    plan.closes.push(
      closeOp({
        slug,
        entity: mapped.entity ?? ENTITY_KINDS.TASK,
        issueNumber: mapped.issueNumber,
        title: mapped.title,
      }),
    );
  }

  plan.creates = sortBySlug(plan.creates);
  plan.updates = sortBySlug(plan.updates);
  plan.closes = sortBySlug(plan.closes);
  plan.relinks = sortBySlug(plan.relinks);

  // Diff-time safety net (Story #1493 / Task #1515). The diff engine
  // never *intends* to emit an agent::* payload, but defence-in-depth
  // catches both a future spec-loader bug that would smuggle an agent::*
  // through a structural field and an apply-pipeline regression that
  // would otherwise silently corrupt wave-runner state. Throws
  // `LabelAllowListViolation` synchronously.
  assertPlanLabelAllowList(plan);

  return plan;
}
