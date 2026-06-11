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
 *   `{ epic: {...}, stories: [...], gates?: {...} }`
 *   per `.agents/schemas/epic-spec.schema.json`.
 *
 * @typedef {object} StateMappingEntry
 * @property {number} issueNumber          GH issue number this slug maps to.
 * @property {string} entity               'epic'|'story'.
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
 * Why: Story #2056 / Epic #1994 — `/plan` was silently stripping
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
const PROTECTED_EPIC_LABEL_NAMESPACES = Object.freeze([
  'type::',
  'risk::',
  // Story #3050 — `acceptance::*` is set by Phase 7 spec-persist when
  // `planningRisk.acceptanceDisposition='not-applicable'` (or another
  // disposition) and gates downstream `/deliver` start/finalize
  // behavior. Before this namespace was protected, Phase 8 decompose
  // diffed the Epic's labels against a spec entry that doesn't carry
  // `acceptance::*`, silently emitting an Update that stripped the
  // waiver and broke the contract documented in `.agents/docs/SDLC.md`.
  'acceptance::',
  // `planning::*` carries operator-applied planning-gate waivers
  // (e.g. `planning::healthcheck-waived`, see persist.js gate). Same
  // failure mode as `acceptance::*`: applied between spec and
  // decompose, stripped by the naive replace-style diff.
  'planning::',
]);

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
 * Match the canonical orchestrator footer anchored on a `---` separator
 * line followed by `parent: #<digits>`. Greedy through end of string so
 * duplicate footer blocks and trailing `blocked by` lines are removed in
 * a single pass. Kept local to this module so the diff engine does not
 * depend on the Task-body renderer (Story #3185 / Epic #3163: the renderer
 * is going away with the 2-tier producer cutover).
 */
const ORCHESTRATOR_FOOTER_RE = /\n?---[ \t]*\r?\n+parent:\s*#\d+[\s\S]*$/;

/**
 * Strip the canonical orchestrator footer from a body and return just the
 * description portion. Safe to call on bodies without a footer — returns
 * the input unchanged modulo a trailing-whitespace trim. The trim keeps
 * the result byte-stable when fed back through `composeBodyWithFooter`.
 *
 * @param {string|null|undefined} body
 * @returns {string}
 */
function stripFooter(body) {
  const value = typeof body === 'string' ? body : '';
  return value.replace(ORCHESTRATOR_FOOTER_RE, '').replace(/\s+$/, '');
}

/**
 * Render the canonical orchestrator footer (no leading newline). Format
 * matches the byte-stable shape that the cascade-reading consumers
 * (story-init, dispatcher, manifest, close-gate) parse line-anchored:
 *
 *   ---
 *   parent: #<parentId>
 *   [Epic: #<epicId>]            // only when epicId !== parentId
 *
 *   [blocked by #<dep>]          // one per dependency
 *
 * @param {{parentId: number, epicId?: number, dependencies?: number[]}} opts
 * @returns {string}
 */
function renderFooter({ parentId, epicId, dependencies = [] }) {
  const lines = ['---', `parent: #${parentId}`];
  if (epicId !== undefined && epicId !== null && epicId !== parentId) {
    lines.push(`Epic: #${epicId}`);
  }
  if (dependencies.length > 0) {
    lines.push('');
    for (const dep of dependencies) {
      lines.push(`blocked by #${dep}`);
    }
  }
  return lines.join('\n');
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
 * Story #3185 — the footer compose/strip logic is inlined here rather
 * than reused from the legacy Task-body renderer module. That renderer
 * was removed, so the diff engine carries its own footer shape. The shape
 * is byte-identical to the legacy renderer's `parent: #<n>` /
 * `Epic: #<m>` / `blocked by #<x>` output so cascade-readers continue
 * to parse it unchanged.
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
  // came from a producer that stored the raw GH body verbatim (footer
  // included) or emits a canonical-form body. With the strip, the
  // function is idempotent against its own output.
  const head = stripFooter(specBody);
  const footer = renderFooter({ parentId, epicId, dependencies });
  return `${head}\n\n${footer}`;
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
  // on every `/plan` Phase 8 because the decomposer's renderer
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
 * node. The spec is 2-tier (epic → stories), so the walk is a single
 * flat pass over `spec.stories` after the Epic record.
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
  // Duplicate-slug guard. The schema cannot express slug uniqueness across
  // a hand-edited spec, and two same-slug Creates would orphan one GH
  // issue (the second create overwrites the first's mapping entry).
  // flattenSpec is the chokepoint both the loader path and the diff path
  // flow through, so the check lives here.
  const seenSlugs = new Set();
  const duplicateSlugs = new Set();
  for (const story of spec.stories ?? []) {
    if (seenSlugs.has(story.slug)) duplicateSlugs.add(story.slug);
    seenSlugs.add(story.slug);
  }
  if (duplicateSlugs.size > 0) {
    throw new Error(
      `spec contains duplicate story slug(s): ${[...duplicateSlugs].join(', ')}. ` +
        `Each story slug must be unique — rename the duplicated entries in ` +
        `the spec and re-run.`,
    );
  }
  for (const story of spec.stories ?? []) {
    out.push({
      slug: story.slug,
      entity: ENTITY_KINDS.STORY,
      title: String(story.title ?? ''),
      body: story.body,
      labels: story.labels,
      wave: story.wave,
      parentSlug: epicAnchor,
      dependsOn: story.dependsOn ?? [],
    });
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
 * Entity kinds that only exist in pre-v4 (3-tier) state files. The v4
 * hard cutover (v1.60.0) removed the Feature/Task tiers; encountering one
 * of these in `state.mapping` means the state file predates the cutover
 * and must be migrated by the operator — there is deliberately no legacy
 * close-op support (hard-cutover policy, git-conventions.md).
 */
const LEGACY_ENTITY_KINDS = Object.freeze(new Set(['feature', 'task']));

/**
 * Throw a loud, actionable error when the state mapping carries legacy
 * Feature/Task entries. Raised early in `diff()` so the operator sees a
 * migration instruction instead of `unknown entity kind: feature` from
 * deep inside `closeOp`.
 *
 * @param {Record<string, StateMappingEntry>} mapping
 */
function assertNoLegacyEntities(mapping) {
  const legacy = Object.entries(mapping).filter(([, entry]) =>
    LEGACY_ENTITY_KINDS.has(entry?.entity),
  );
  if (legacy.length === 0) return;
  const summary = legacy
    .map(([slug, entry]) => `${slug} (#${entry.issueNumber}, ${entry.entity})`)
    .join(', ');
  throw new Error(
    `diff: the epic state file is pre-v4 — it carries legacy Feature/Task ` +
      `mapping entries: ${summary}. The 2-tier reconciler cannot process ` +
      `these. Close the legacy Feature issues manually, then delete (or ` +
      `reseed) the .agents/epics/<epicId>.state.json file per the v1.60.0 ` +
      `migration notes, and re-run.`,
  );
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
  assertNoLegacyEntities(mapping);
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
        entity: mapped.entity ?? ENTITY_KINDS.STORY,
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
