/**
 * lib/wave-runner/ready-set.js — the path-agnostic ready-set scheduling
 * core.
 *
 * This module is the scheduling kernel the v2 `/deliver` multi-Story path
 * dispatches through (`stories-wave-tick.js`). It replaces wave-*batch* selection
 * (group N must fully drain before group N+1 opens) with *continuous*,
 * dependency-driven selection: a Story becomes dispatchable the instant
 * **its own** dependencies are satisfied, regardless of whether unrelated
 * Stories in some nominal wave are still running. There is no false
 * barrier — a Story C that depends only on a done Story A is selected even
 * while an unrelated Story B is still pending.
 *
 * It is deliberately **path-agnostic and side-effect-free**: it neither
 * reads GitHub, the lifecycle ledger, nor a checkpoint, and it dispatches
 * nothing. Callers supply the live Story records (already fetched), the
 * resolved `inFlight` count, and the `globalCap`, and receive back the set
 * of Stories that are safe to dispatch on this beat. The
 * `stories-wave-tick.js` adapter wires this core; this module does not
 * modify that CLI surface.
 *
 * Three exports:
 *   - `classifyStory(story)` — live-label classifier mapping a Story
 *     record's labels + issue state to one of `done | blocked | executing |
 *     ready`. Mirrors the done-predicate this module uses
 *     (`agent::done` OR closed issue) so a Story closed manually through
 *     the GitHub UI is recognised as done.
 *   - `storiesOverlap(a, b)` — the file-overlap co-dispatch guard: true
 *     when two Stories' declared file footprints intersect. Two Stories
 *     that would touch the same file MUST NOT be dispatched onto parallel
 *     `story-<id>` branches in the same beat (they would race the same
 *     path and produce a merge conflict at close).
 *   - `selectReadySet({ stories, doneIds, inFlight, globalCap })` — the
 *     scheduler. Returns the deterministic, overlap-free set of ready
 *     Stories, capped at `globalCap − inFlight`.
 *
 * Adjacency is re-derived from the supplied records via the shared
 * `buildStoryAdjacency` builder (`lib/story-adjacency.js`) — the same
 * `blocked by #NNN` / `dependencies[]` source order the dispatch manifest
 * and the existing wave wrappers use — so this core never disagrees with
 * the manifest about what depends on what.
 *
 * @module lib/wave-runner/ready-set
 */

import { AGENT_LABELS } from '../label-constants.js';
import { buildStoryAdjacency } from '../story-adjacency.js';

/**
 * @typedef {object} StoryRecord
 * @property {number|string} [id]      Story id (preferred).
 * @property {number} [number]         Story id (GitHub issue-number shape).
 * @property {string} [title]
 * @property {string} [body]           Used by `buildStoryAdjacency` to parse
 *   `blocked by #NNN` / `depends on #NNN` references.
 * @property {string[]} [labels]       Live `agent::*` labels.
 * @property {string} [state]          GitHub issue state (`open` | `closed`).
 * @property {Array<number|string>} [dependencies] Explicit dependency ids.
 * @property {Array<number|string>} [dependsOn]     Operator-DAG dependency ids.
 * @property {string[]} [files]        Declared file footprint (one of the
 *   accepted footprint shapes — see `storyFootprint`).
 * @property {string[]} [changes]      Alternate footprint shape.
 * @property {Array<{path?: string}>} [changeset] Alternate footprint shape.
 */

/** @typedef {'done'|'blocked'|'executing'|'ready'} StoryClass */

/**
 * Normalize a Story record's id to a positive integer, or `null` when it is
 * absent / non-integer. Accepts both the ticket shape (`id`) and the raw
 * GitHub issue shape (`number`), matching `buildStoryAdjacency`.
 *
 * @param {StoryRecord|number|string} story
 * @returns {number|null}
 */
export function storyIdOf(story) {
  if (typeof story === 'number') {
    return Number.isInteger(story) && story > 0 ? story : null;
  }
  const raw = story?.id ?? story?.number;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Classify a Story from its **live** labels and issue state.
 *
 * Precedence (highest first):
 *   1. `done`      — carries `agent::done` OR the issue is `state === 'closed'`.
 *                    The closed-state arm aligns with `tick.js#isStoryDone`
 *                    so a Story closed manually in the GitHub UI (issue
 *                    closed, label not flipped) still reads as done and is
 *                    never re-dispatched.
 *   2. `blocked`   — carries `agent::blocked`.
 *   3. `executing` — carries `agent::executing` OR `agent::closing` (both
 *                    are in-flight: an executing or closing Story occupies a
 *                    slot and must not be re-dispatched).
 *   4. `ready`     — none of the above; the Story is eligible for dispatch
 *                    once its dependencies are satisfied.
 *
 * `done` wins over every in-progress label so a stale `agent::executing`
 * left behind on an issue that has since closed never masks completion.
 *
 * @param {StoryRecord} story
 * @returns {StoryClass}
 */
export function classifyStory(story) {
  const labels = Array.isArray(story?.labels) ? story.labels : [];
  if (labels.includes(AGENT_LABELS.DONE) || story?.state === 'closed') {
    return 'done';
  }
  if (labels.includes(AGENT_LABELS.BLOCKED)) return 'blocked';
  if (
    labels.includes(AGENT_LABELS.EXECUTING) ||
    labels.includes(AGENT_LABELS.CLOSING)
  ) {
    return 'executing';
  }
  return 'ready';
}

/**
 * Extract a Story's declared file footprint as a normalized set of path
 * strings. Accepts the three footprint shapes a Story record can carry:
 *
 *   - `files: string[]`                         — explicit footprint.
 *   - `changes: string[]`                       — string-array sketch.
 *   - `changeset: Array<{ path }>` /            — object-array sketch (the
 *     `changes: Array<{ path }>`                   `{ path, assumption }`
 *                                                  shape from a Story body).
 *
 * Paths are trimmed; empty / non-string entries are dropped. A Story with
 * no declared footprint yields an empty set, which (by `storiesOverlap`'s
 * contract) means it overlaps with nothing and is never withheld by the
 * co-dispatch guard.
 *
 * @param {StoryRecord} story
 * @returns {Set<string>}
 */
export function storyFootprint(story) {
  const out = new Set();
  const push = (entry) => {
    const path =
      typeof entry === 'string'
        ? entry
        : typeof entry?.path === 'string'
          ? entry.path
          : null;
    if (!path) return;
    const trimmed = path.trim();
    if (trimmed) out.add(trimmed);
  };
  if (Array.isArray(story?.files)) for (const e of story.files) push(e);
  if (Array.isArray(story?.changes)) for (const e of story.changes) push(e);
  if (Array.isArray(story?.changeset)) for (const e of story.changeset) push(e);
  return out;
}

/**
 * Does a declared path contain a glob metacharacter? Mirrors the detection
 * in `story-body.js#extractChangePaths`, whose `isGlob` flag documents an
 * "unknown-width footprint" policy that was never implemented downstream.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isGlobPath(path) {
  return path.includes('*') || path.includes('?') || path.includes('{');
}

/**
 * File-overlap co-dispatch guard. Returns `true` when two Stories' declared
 * file footprints intersect — meaning they would race the same file if
 * dispatched onto parallel `story-<id>` branches in the same beat. Two
 * Stories that overlap MUST NOT both appear in one dispatch set; one is
 * withheld until the other clears.
 *
 * Two deliberate asymmetries:
 *
 *   - **An empty footprint means "no known overlap"** → `false`. A Story that
 *     declares no files is never withheld. This is permissive by necessity:
 *     an undeclared footprint carries no information, and withholding on
 *     absence would serialize every run.
 *   - **A glob footprint overlaps EVERYTHING** → `true` (Story #4539/#4540).
 *     Comparison is exact-string, so a Story declaring
 *     `.agents/scripts/lib/**` would not match another declaring
 *     `.agents/scripts/lib/story-adjacency.js` — the guard would silently
 *     pass two Stories that genuinely race. Unknown width is not the same as
 *     no width: fail safe by serializing.
 *
 * @param {StoryRecord} a
 * @param {StoryRecord} b
 * @returns {boolean}
 */
export function storiesOverlap(a, b) {
  const fa = storyFootprint(a);
  if (fa.size === 0) return false;
  const fb = storyFootprint(b);
  if (fb.size === 0) return false;
  for (const path of fa) {
    if (isGlobPath(path)) return true;
    if (fb.has(path)) return true;
  }
  for (const path of fb) {
    if (isGlobPath(path)) return true;
  }
  return false;
}

/**
 * Select the set of Stories safe to dispatch on this beat.
 *
 * Algorithm (continuous, dependency-driven — no wave barrier):
 *
 *   1. **Adjacency.** Re-derive `Map<id, depIds[]>` from the supplied
 *      records via `buildStoryAdjacency`. The `dropForeign` flag controls
 *      how a dependency on an id **outside** the supplied set is treated:
 *      - `dropForeign: false` (default, standalone-path semantics) — the
 *        foreign dependency still gates the dependent: an absent dependency
 *        is treated as not-yet-done and withholds the dependent until it
 *        completes (preserves the operator-DAG contract).
 *      - `dropForeign: true` (Epic-path semantics) — a foreign edge is
 *        pruned so the DAG stays closed over the scheduled Story set. An
 *        Epic's Stories depend only on siblings, so a `blocked by #N` whose
 *        target is out-of-scope (a foreign id, or a typo) must be dropped,
 *        not treated as a permanent unsatisfiable gate — otherwise the
 *        dependent Story is never schedulable and the run silently strands
 *        it. This matches `build-wave-dag.js`, which builds the Epic
 *        wave DAG with the same default-`dropForeign` builder.
 *   2. **Done set.** Union the caller-supplied `doneIds` with every record
 *      that classifies as `done` (live label / closed issue). A Story's
 *      dependency counts as satisfied iff it is in this union.
 *   3. **Eligibility.** A Story is *eligible* when it classifies as `ready`
 *      (not done / blocked / executing) **and** every one of its
 *      dependencies is in the done set. This is the no-false-barrier
 *      property: C depending only on A is eligible the instant A is done,
 *      even while an unrelated B is still pending.
 *   4. **Capacity.** The dispatch set never exceeds `slots = max(0,
 *      globalCap − inFlight)`. `inFlight` is the caller's count of Stories
 *      already occupying a slot (executing / closing / dispatched-not-yet-
 *      labelled). When `slots <= 0`, the result is empty.
 *   5. **Overlap guard.** Greedily admit eligible Stories in ascending-id
 *      order, skipping any whose file footprint overlaps an
 *      already-admitted Story (`storiesOverlap`). A withheld Story stays
 *      eligible and is naturally re-considered on the next beat once its
 *      overlapping peer has cleared.
 *
 * The result is deterministic: eligible Stories are considered in
 * ascending-id order, so the same inputs always yield the same set.
 *
 * @param {object} args
 * @param {StoryRecord[]} args.stories  Live Story records in scope.
 * @param {Array<number|string>|Set<number|string>} [args.doneIds]
 *   Ids the caller already knows are done (e.g. from a prior beat). Merged
 *   with records that classify as done.
 * @param {number} [args.inFlight=0]    Count of Stories already occupying a
 *   slot. Subtracted from `globalCap` to compute remaining capacity.
 * @param {number} args.globalCap       Hard ceiling on total concurrent
 *   Stories.
 * @param {boolean} [args.dropForeign=false] Adjacency closure policy (see
 *   step 1 above). `false` keeps a foreign dependency as a gate
 *   (standalone / operator-DAG semantics); `true` prunes foreign edges so
 *   the DAG stays closed over the scheduled set (Epic semantics).
 * @returns {StoryRecord[]} The dispatch set: a subset of `stories`,
 *   ascending by id, overlap-free, length ≤ `globalCap − inFlight`.
 */
export function selectReadySet({
  stories,
  doneIds = [],
  inFlight = 0,
  globalCap,
  dropForeign = false,
} = {}) {
  const records = Array.isArray(stories) ? stories : [];
  const cap = Number.isInteger(globalCap) ? globalCap : 0;
  const inFlightCount =
    Number.isInteger(inFlight) && inFlight > 0 ? inFlight : 0;
  const slots = Math.max(0, cap - inFlightCount);
  if (slots <= 0 || records.length === 0) return [];

  // Step 1 — adjacency keyed by id. The `dropForeign` policy decides whether
  // a dependency on an id outside the supplied set gates the dependent
  // (false) or is pruned (true). See the JSDoc above for the per-path
  // rationale.
  const adjacency = buildStoryAdjacency(records, { dropForeign });

  // Step 2 — done set = caller-supplied ids ∪ records that classify done.
  const done = new Set();
  for (const raw of doneIds instanceof Set ? doneIds : (doneIds ?? [])) {
    const id = Number(raw);
    if (Number.isInteger(id)) done.add(id);
  }
  const byId = new Map();
  for (const rec of records) {
    const id = storyIdOf(rec);
    if (id === null) continue;
    byId.set(id, rec);
    if (classifyStory(rec) === 'done') done.add(id);
  }

  // Step 3 — eligible: ready AND all dependencies done. Ascending id for
  // deterministic admission order.
  const eligibleIds = [];
  for (const id of [...byId.keys()].sort((a, b) => a - b)) {
    const rec = byId.get(id);
    if (classifyStory(rec) !== 'ready') continue;
    const deps = adjacency.get(id) ?? [];
    if (deps.every((dep) => done.has(dep))) eligibleIds.push(id);
  }

  // Steps 4 + 5 — greedily admit up to `slots`, skipping file-overlap
  // collisions against the already-admitted set.
  const selected = [];
  for (const id of eligibleIds) {
    if (selected.length >= slots) break;
    const rec = byId.get(id);
    if (selected.some((picked) => storiesOverlap(picked, rec))) continue;
    selected.push(rec);
  }
  return selected;
}
