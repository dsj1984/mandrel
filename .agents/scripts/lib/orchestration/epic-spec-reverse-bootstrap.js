/**
 * lib/orchestration/epic-spec-reverse-bootstrap.js — derive a structural
 * Epic spec from the live GitHub state (Story #1497 / Tasks #1529, #1532).
 *
 * The reverse-bootstrap is the "from existing Epic → spec" inverse of
 * the decomposer's "spec → Epic" projection. It is the only sanctioned
 * way to retrofit `.agents/epics/<epic-id>.yaml` for an Epic that was
 * created before the structural-SSOT migration: there is no other path
 * that preserves the slug ↔ issueNumber mapping needed for the next
 * reconcile to dry-run clean.
 *
 * Control flow:
 *
 *   1. Quiescence guard (Task #1532). Bootstrapping an Epic mid-flight
 *      would race the wave-runner — the rendered spec would carry the
 *      transient `agent::executing` state, the state file would map
 *      slugs to issue numbers that the wave-runner is about to close,
 *      and the next reconcile would produce noise. Refuse with exit 2
 *      when any child Story carries `agent::executing` (the only label
 *      the wave-runner uses to mark mid-execution).
 *
 *   2. Project live tickets into the decomposer's flat shape. The
 *      spec-renderer (Story #1495) already projects that shape into the
 *      structural spec; we reuse it verbatim so the bootstrap and the
 *      forward path emit byte-identical specs for the same inputs.
 *
 *   3. Resolve slugs. Live GH issues do not carry slugs — they were
 *      created before the SSOT existed. We derive a stable slug per
 *      issue from its title (kebab-cased) with the issue number as a
 *      tie-breaker so duplicate-title tickets stay unique. The slug
 *      becomes the spec's stable identifier; the state file carries the
 *      `slug → issueNumber` mapping so a subsequent reconcile (whether
 *      `--dry-run` or `--apply`) treats every child as already-mapped.
 *
 *   4. Project the resolved hierarchy through `renderSpec` and project
 *      the state via `buildState` (state.js). The two artefacts together
 *      form the on-disk SSOT for the Epic.
 *
 * The module exposes:
 *
 *   - `assertEpicQuiescent(tickets)` — pure guard, throws
 *     `EpicNotQuiescentError` listing the offending Story ids.
 *   - `buildBootstrapInputs(epic, tickets, opts)` — pure projection from
 *     live state to `{ flatTickets, epicDescriptor }` ready to feed into
 *     `renderSpec`.
 *   - `runReverseBootstrap(opts)` — the operator-facing entry point.
 *     Fetches the live state via the provider, runs the guard, builds
 *     the spec + state, and (unless `dryRun`) writes both files.
 *
 * The renderer reuses the canonical agent-label strip (`agent::*` is
 * never written to the spec), so live tickets whose labels still carry
 * residual agent state at bootstrap time produce a clean spec.
 *
 * Cross-references:
 *   - Tech Spec #1483 §"reverse-bootstrap"
 *   - Spec renderer: `lib/orchestration/spec-renderer.js`
 *   - State writer:  `lib/spec/state.js`, `lib/spec/loader.js#writeState`
 */

import { writeFileSync as defaultWriteFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseBlockedBy } from '../dependency-parser.js';
import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import { specPath, writeState } from '../spec/loader.js';
import { buildState } from '../spec/state.js';
import { renderSpec } from './spec-renderer.js';
import { parseParentId } from './story-grouper.js';

/**
 * Stable structured-error code for the quiescence-refusal path. Log
 * scrapers and CI dashboards key on this token rather than the prose
 * message so the prose can evolve without breaking automation.
 *
 * Story #1497 / Task #1532: the quiescence guard MUST exit 2 with a
 * structured (machine-readable) message; this constant is the token
 * the CLI prints on the structured stderr line.
 */
export const EPIC_NOT_QUIESCENT_CODE = 'EPIC_NOT_QUIESCENT';

/**
 * Raised by `assertEpicQuiescent` when at least one child Story carries
 * `agent::executing`. The CLI maps this to exit code 2 and prints a
 * structured `code=EPIC_NOT_QUIESCENT epic=#<id> stories=#<a>,#<b>` line
 * alongside the human-readable prose so both audiences are served.
 *
 * The `executingStories` array is preserved on the instance so callers
 * (tests, the CLI's structured renderer) can emit machine-readable
 * diagnostics without re-parsing the message string.
 */
export class EpicNotQuiescentError extends Error {
  /**
   * @param {number} epicId
   * @param {Array<{id:number,title:string}>} executingStories
   */
  constructor(epicId, executingStories) {
    const ids = executingStories.map((s) => `#${s.id}`).join(', ');
    super(
      `Epic #${epicId} is not quiescent: ${executingStories.length} Story/Stories carry agent::executing (${ids}). ` +
        'Bootstrap refused — wait for the wave to close before reverse-bootstrapping.',
    );
    this.name = 'EpicNotQuiescentError';
    this.code = EPIC_NOT_QUIESCENT_CODE;
    this.epicId = epicId;
    this.executingStories = executingStories;
  }

  /**
   * Render the structured (machine-readable) stderr line. The shape is
   * `code=<TOKEN> epic=<id> stories=#<a>,#<b>` so log scrapers can match
   * a single regex without parsing prose.
   *
   * @returns {string}
   */
  toStructuredLine() {
    const ids = this.executingStories.map((s) => `#${s.id}`).join(',');
    return `code=${this.code} epic=#${this.epicId} stories=${ids}`;
  }
}

/**
 * Throw `EpicNotQuiescentError` when any child Story carries
 * `agent::executing`. Other agent labels (`agent::ready`, `agent::done`,
 * `agent::blocked`) are explicitly accepted — only the `executing`
 * state races the wave-runner. Pure: no I/O, no clocks.
 *
 * @param {number} epicId
 * @param {Array<{id:number,title:string,labels:string[]}>} tickets
 *   The Epic's children as returned by `provider.getTickets(epicId)`
 *   (Epic itself excluded — pass the children array only).
 */
export function assertEpicQuiescent(epicId, tickets) {
  const offending = [];
  for (const t of tickets ?? []) {
    if (!t || !Array.isArray(t.labels)) continue;
    if (!t.labels.includes(TYPE_LABELS.STORY)) continue;
    if (t.labels.includes(AGENT_LABELS.EXECUTING)) {
      offending.push({ id: t.id, title: t.title });
    }
  }
  if (offending.length > 0) {
    throw new EpicNotQuiescentError(epicId, offending);
  }
}

/**
 * Slug-safe characters per `.agents/schemas/epic-spec.schema.json#/$defs/slug`:
 * `^[a-z0-9][a-z0-9-]*$`. We don't share `git-utils.js#slugify` here because
 * that helper preserves underscores — the schema forbids them.
 *
 * @param {string} text
 * @returns {string}
 */
function kebabSlug(text) {
  const trimmed = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Schema requires a leading [a-z0-9]. A pathological title (e.g. one
  // composed entirely of separators) collapses to '' — callers append
  // the issue number to keep the slug well-formed and unique.
  return trimmed;
}

/**
 * Derive a unique, schema-conforming slug for `(issueId, title)` taking
 * `seen` as the running set of already-allocated slugs. Strategy:
 *
 *   1. kebab-case the title.
 *   2. If empty, fall back to `t-<issueId>` / `s-<issueId>` etc.
 *   3. If the slug is already taken, append `-<issueId>` (issue numbers
 *      are globally unique within the repo, so the suffix guarantees a
 *      collision-free second attempt).
 *
 * @param {{ id: number, title: string, type: 'feature'|'story'|'task' }} ticket
 * @param {Set<string>} seen
 * @returns {string}
 */
function deriveSlug(ticket, seen) {
  const base = kebabSlug(ticket.title);
  const fallback = `${ticket.type}-${ticket.id}`;
  const candidate = base.length > 0 ? base : fallback;
  if (!seen.has(candidate)) {
    seen.add(candidate);
    return candidate;
  }
  const suffixed = `${candidate}-${ticket.id}`;
  if (!seen.has(suffixed)) {
    seen.add(suffixed);
    return suffixed;
  }
  // Pathological case — two tickets share both the slug and the id.
  // Fall back to the canonical `type-id` form, which is guaranteed
  // unique because issue numbers are unique.
  seen.add(fallback);
  return fallback;
}

/**
 * Determine the structural type of a child ticket from its labels.
 * Returns one of `'feature'`, `'story'`, `'task'`, or `null` when no
 * structural label is present (the ticket is then silently dropped — it
 * is not part of the spec's hierarchy).
 *
 * @param {{labels?: string[]}} ticket
 * @returns {'feature'|'story'|'task'|null}
 */
function classifyTicket(ticket) {
  const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
  if (labels.includes(TYPE_LABELS.FEATURE)) return 'feature';
  if (labels.includes(TYPE_LABELS.STORY)) return 'story';
  if (labels.includes('type::task')) return 'task';
  return null;
}

/**
 * Project the live Epic + children into the decomposer's flat-array shape
 * (`{slug, type, title, body, labels, parent_slug, depends_on}` per row).
 * The spec renderer consumes this shape verbatim, which keeps the
 * forward-projection and reverse-bootstrap codepaths identical from
 * `renderSpec` onwards.
 *
 * Steps:
 *
 *   1. Classify each child ticket (feature/story/task) by label; drop
 *      anything else (PRD/Tech-Spec context tickets, agent retrospectives,
 *      etc. — they are not part of the structural hierarchy).
 *   2. Allocate slugs in stable order (features → stories → tasks; within
 *      each, by ascending issue number) so re-running the bootstrap
 *      against the same Epic produces a byte-identical spec.
 *   3. Resolve `parent_slug` by parsing the `parent: #<id>` line from the
 *      ticket body. Tickets whose parent is the Epic itself attach to
 *      the synthetic root (`parent_slug: ''`); tickets whose parent is
 *      another structural ticket attach via that ticket's slug.
 *   4. Resolve `depends_on` from `blocked by #<id>` references in the
 *      Story body, filtering to inter-Story edges (the spec-renderer
 *      reapplies the filter, but doing it here avoids leaking
 *      cross-Task edges through the intermediate representation).
 *
 * @param {{id:number,title:string,body:string,labels:string[]}} epic
 * @param {Array<{id:number,title:string,body:string,labels:string[]}>} tickets
 * @returns {{
 *   flatTickets: Array<object>,
 *   epicDescriptor: {id:number,title:string,body?:string,labels?:string[]},
 *   issueToSlug: Map<number,string>,
 * }}
 */
export function buildBootstrapInputs(epic, tickets) {
  if (!epic || !Number.isInteger(epic.id)) {
    throw new TypeError('[reverse-bootstrap] epic.id is required');
  }
  const safeTickets = Array.isArray(tickets) ? tickets : [];

  // Partition + sort by ascending issue number so slug allocation is
  // deterministic across runs.
  const byType = { feature: [], story: [], task: [] };
  for (const t of safeTickets) {
    if (!t || typeof t.id !== 'number') continue;
    if (t.id === epic.id) continue; // Epic itself is supplied separately.
    const type = classifyTicket(t);
    if (!type) continue;
    byType[type].push(t);
  }
  for (const list of Object.values(byType)) {
    list.sort((a, b) => a.id - b.id);
  }

  // Phase 1: allocate slugs. Issue id → slug.
  const issueToSlug = new Map();
  const seen = new Set();
  for (const type of /** @type {const} */ (['feature', 'story', 'task'])) {
    for (const t of byType[type]) {
      const slug = deriveSlug({ id: t.id, title: t.title, type }, seen);
      issueToSlug.set(t.id, slug);
    }
  }

  // Phase 2: resolve parent / depends_on edges. Tasks may parent to a
  // Story; Stories may parent to a Feature; Features parent to the Epic
  // (represented as the empty `parent_slug` so the renderer treats them
  // as top-level).
  const flatTickets = [];
  for (const type of /** @type {const} */ (['feature', 'story', 'task'])) {
    for (const t of byType[type]) {
      const slug = issueToSlug.get(t.id);
      const parentId = parseParentId(t.body);
      const parentSlug =
        parentId != null && parentId !== epic.id
          ? (issueToSlug.get(parentId) ?? '')
          : '';
      const dependsOn = parseBlockedBy(t.body)
        .map((depId) => issueToSlug.get(depId))
        .filter((s) => typeof s === 'string' && s.length > 0);
      flatTickets.push({
        slug,
        type,
        title: t.title,
        body: t.body ?? '',
        labels: Array.isArray(t.labels) ? [...t.labels] : [],
        parent_slug: parentSlug,
        depends_on: dependsOn,
      });
    }
  }

  // Strip agent::* labels from the epic descriptor — schema rejects
  // them and the renderer would otherwise pass them through verbatim
  // (the renderer's strip path runs on entries in `features[]`, not
  // on the supplied `opts.epic`).
  const epicLabels = Array.isArray(epic.labels)
    ? epic.labels.filter(
        (l) => typeof l === 'string' && !l.startsWith('agent::'),
      )
    : undefined;

  const epicDescriptor = {
    id: epic.id,
    title: epic.title,
  };
  if (typeof epic.body === 'string' && epic.body.length > 0) {
    epicDescriptor.body = epic.body;
  }
  if (epicLabels && epicLabels.length > 0) {
    epicDescriptor.labels = epicLabels;
  }

  return { flatTickets, epicDescriptor, issueToSlug };
}

/**
 * Convert the renderer's spec output back into a state-file shape that
 * carries the slug → issue-number map derived during bootstrap, plus
 * the structural metadata (`entity`, `parentSlug`, `dependsOn`, `wave`)
 * the reconciler-diff engine consults when deciding "no change".
 *
 * The vanilla `buildState` projection in `lib/spec/state.js` is content-
 * hash-only — it carries `{ issueNumber, contentHash, lastObservedAgentState }`,
 * which is enough for the upstream "did this entry change?" check but
 * leaves the diff engine without the parent / dependsOn / wave columns
 * it compares against `flattenSpec(spec)`. Without those columns a
 * follow-up `--dry-run` would synthesise a `relink` op for every node
 * (every parent edge looks new).
 *
 * The bootstrap therefore stitches the structural columns onto each
 * mapping entry alongside the issue number. The resulting state file
 * has the property the AC requires: a subsequent `diff({spec, state,
 * ghState})` against the same Epic yields an empty Plan.
 *
 * The synthetic `epic` slug (`epicSlug()` in the diff engine) is also
 * added — the diff engine walks `flattenSpec` which includes the epic
 * row, and would otherwise produce a phantom `create` for the Epic itself.
 *
 * @param {object} spec
 * @param {Map<number, string>} issueToSlug
 * @param {{now?: string, lastObservedAgentState?: (slug:string)=>string|null}} [opts]
 * @returns {{epicId:number, lastReconciledAt:string, mapping:object}}
 */
export function buildBootstrapState(spec, issueToSlug, opts = {}) {
  // Invert the map for O(1) slug → issueNumber lookup.
  const slugToIssue = new Map();
  for (const [issueId, slug] of issueToSlug.entries()) {
    slugToIssue.set(slug, issueId);
  }
  const state = buildState(spec, undefined, { now: opts.now });

  // Index spec entities so we can stamp the structural columns the diff
  // engine reads. Order matches `flattenSpec` so the synthetic `epic`
  // row appears first; downstream readers don't depend on insertion
  // order but the writer canonicalises keys anyway.
  const structuralByslug = new Map();
  const epicSlugLiteral = 'epic';
  structuralByslug.set(epicSlugLiteral, {
    entity: 'epic',
    parentSlug: null,
  });
  for (const feature of spec.features ?? []) {
    structuralByslug.set(feature.slug, {
      entity: 'feature',
      parentSlug: epicSlugLiteral,
    });
    for (const story of feature.stories ?? []) {
      structuralByslug.set(story.slug, {
        entity: 'story',
        parentSlug: feature.slug,
        wave: typeof story.wave === 'number' ? story.wave : 0,
        dependsOn: Array.isArray(story.dependsOn) ? [...story.dependsOn] : [],
      });
      for (const task of story.tasks ?? []) {
        structuralByslug.set(task.slug, {
          entity: 'task',
          parentSlug: story.slug,
        });
      }
    }
  }

  const stitched = {};
  // The synthetic epic row is keyed by the literal `epic`, mapped to the
  // Epic's GH issue number (taken from spec.epic.id). `buildState` does
  // not emit this row (its iterator starts at `features[]`), so we
  // construct it here from spec.epic.
  if (spec?.epic && typeof spec.epic.id === 'number') {
    stitched[epicSlugLiteral] = {
      ...(state.mapping[epicSlugLiteral] ?? {}),
      issueNumber: spec.epic.id,
      entity: 'epic',
      parentSlug: null,
      contentHash: state.mapping[epicSlugLiteral]?.contentHash,
      lastObservedAgentState: opts.lastObservedAgentState
        ? (opts.lastObservedAgentState(epicSlugLiteral) ?? null)
        : null,
    };
  }

  for (const slug of Object.keys(state.mapping)) {
    const issueNumber = slugToIssue.get(slug) ?? null;
    const lastObservedAgentState = opts.lastObservedAgentState
      ? (opts.lastObservedAgentState(slug) ?? null)
      : null;
    const structural = structuralByslug.get(slug) ?? {};
    stitched[slug] = {
      ...state.mapping[slug],
      ...structural,
      issueNumber,
      lastObservedAgentState,
    };
  }

  return { ...state, mapping: stitched };
}

/**
 * Resolve a per-slug `lastObservedAgentState` from the live tickets.
 * The reverse-bootstrap captures the *current* agent state at bootstrap
 * time so the state file's `lastObservedAgentState` field is honest;
 * downstream reconciles compare against the live state on each run.
 *
 * @param {Map<number,string>} issueToSlug
 * @param {Array<{id:number,labels:string[]}>} tickets
 * @returns {(slug:string)=>string|null}
 */
export function makeAgentStateResolver(issueToSlug, tickets) {
  const slugToTicket = new Map();
  for (const t of tickets ?? []) {
    if (!t || typeof t.id !== 'number') continue;
    const slug = issueToSlug.get(t.id);
    if (slug) slugToTicket.set(slug, t);
  }
  return (slug) => {
    const t = slugToTicket.get(slug);
    if (!t || !Array.isArray(t.labels)) return null;
    for (const l of t.labels) {
      if (typeof l === 'string' && l.startsWith('agent::')) return l;
    }
    return null;
  };
}

/**
 * Fetch the live Epic + child tickets. Mirrors `epic-reconcile.js#fetchGhState`
 * but returns the raw issue shape (we need `body` + `labels` for slug
 * derivation, dependency parsing, and the quiescence guard — the
 * reconciler's `ghState` projection drops the parent/dep information we
 * rely on).
 *
 * @param {object} provider
 * @param {number} epicId
 * @returns {Promise<{epic: object, tickets: object[]}>}
 */
export async function fetchLiveEpic(provider, epicId) {
  if (!provider || typeof provider.getEpic !== 'function') {
    throw new Error('[reverse-bootstrap] provider must implement getEpic');
  }
  if (typeof provider.getTickets !== 'function') {
    throw new Error('[reverse-bootstrap] provider must implement getTickets');
  }
  const [epic, tickets] = await Promise.all([
    provider.getEpic(epicId),
    provider.getTickets(epicId),
  ]);
  if (!epic || typeof epic.id !== 'number') {
    throw new Error(`[reverse-bootstrap] epic #${epicId} not found`);
  }
  return { epic, tickets: Array.isArray(tickets) ? tickets : [] };
}

/**
 * Run the reverse-bootstrap end-to-end.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   dryRun?: boolean,
 *   epicsDir?: string,
 *   schemaPath?: string,
 *   now?: string,
 *   fs?: {writeFileSync: typeof defaultWriteFileSync},
 * }} args
 * @returns {Promise<{
 *   spec: object,
 *   state: object,
 *   specPath: string,
 *   statePath: string,
 *   dryRun: boolean,
 *   wroteSpec: boolean,
 *   wroteState: boolean,
 * }>}
 */
export async function runReverseBootstrap(args) {
  const {
    epicId,
    provider,
    dryRun = false,
    epicsDir,
    schemaPath,
    now,
    fs,
  } = args ?? {};
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      '[reverse-bootstrap] epicId must be a positive integer',
    );
  }

  // 1. Fetch live state.
  const { epic, tickets } = await fetchLiveEpic(provider, epicId);

  // 2. Quiescence guard.
  assertEpicQuiescent(epicId, tickets);

  // 3. Project into the decomposer flat shape.
  const { flatTickets, epicDescriptor, issueToSlug } = buildBootstrapInputs(
    epic,
    tickets,
  );

  // 4. Render the spec.
  const spec = renderSpec(flatTickets, {
    epic: epicDescriptor,
    schemaPath,
  });

  // 5. Project state, stitch in slug → issueNumber + agent-state.
  const state = buildBootstrapState(spec, issueToSlug, {
    now,
    lastObservedAgentState: makeAgentStateResolver(issueToSlug, tickets),
  });

  // 6. Write artefacts.
  const targetSpecPath = specPath(epicId, { epicsDir });
  const targetStatePath = path.join(
    path.dirname(targetSpecPath),
    `${String(epicId)}.state.json`,
  );

  let wroteSpec = false;
  let wroteState = false;
  if (!dryRun) {
    const writer = fs?.writeFileSync ?? defaultWriteFileSync;
    // Render YAML deterministically: js-yaml's `sortKeys` produces stable
    // key ordering across runs (matches the renderer's pure output).
    const yamlText = yaml.dump(spec, { sortKeys: false, noRefs: true });
    // Ensure parent dir exists. `writeState` (used below) creates it
    // lazily; we mirror that behaviour here for symmetry.
    const fsMkdir = await import('node:fs');
    fsMkdir.mkdirSync(path.dirname(targetSpecPath), { recursive: true });
    writer(targetSpecPath, yamlText, 'utf8');
    wroteSpec = true;
    writeState(epicId, state, { epicsDir });
    wroteState = true;
  }

  return {
    spec,
    state,
    specPath: targetSpecPath,
    statePath: targetStatePath,
    dryRun,
    wroteSpec,
    wroteState,
  };
}
