/**
 * lib/wave-runner/ready-set.js — the path-agnostic ready-set scheduling
 * core.
 *
 * This module is the scheduling kernel the v2 `/mandrel-deliver` multi-Story path
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
 * The scheduling surface:
 *   - `classifyStory(story)` — live-label classifier mapping a Story
 *     record's labels + issue state to one of `done | blocked | executing |
 *     ready`. Mirrors the done-predicate this module uses
 *     (`agent::done` OR closed issue) so a Story closed manually through
 *     the GitHub UI is recognised as done.
 *   - `storiesOverlap(a, b)` — the **beat-local** file-overlap co-dispatch
 *     guard: true when two Stories' file footprints intersect. Two Stories
 *     that would touch the same file MUST NOT be admitted onto parallel
 *     `story-<id>` branches on the same beat (they would race the same path
 *     and produce a merge conflict at close). The comparison runs over
 *     the **widened** footprint (`storyWidenedFootprint`) — a declared
 *     `changes[]` is treated as a lower bound and widened from the paths the
 *     Story's own text names, because a guard that trusts a prediction cannot
 *     prevent the collision nobody predicted (Story #4875).
 *   - `planReadySet({ stories, doneIds, inFlight, globalCap,
 *     inFlightRecords })` — the scheduler. Returns the deterministic,
 *     overlap-free dispatch set (capped at `globalCap − inFlight`) **and**
 *     the Stories it withheld because a **concrete** path in their footprint
 *     is reserved by a Story still in flight from an earlier beat.
 *
 * The two guards deliberately draw the glob/UNKNOWN class differently
 * (Story #4960). Within a beat an unknown-width footprint overlaps
 * everything, because admitting two Stories whose real widths are unknown is
 * the collision the guard exists to prevent. Across beats it reserves
 * nothing: an in-flight Story's window spans its whole implementation, so a
 * glob that reserved cross-beat would withhold every other Story for
 * minutes-to-hours — and `resolve-stories.js` substitutes the UNKNOWN
 * sentinel for any body it cannot parse, so a single malformed Story body
 * would collapse an N-Story run to fully serial.
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
import { detectCollision } from './footprint.js';

/**
 * How a footprint collision affects dispatch — the `footprintGuard` config
 * knob (`delivery.deliverRunner.footprintGuard`, Story #5044).
 *
 * `enforce` is the default and encodes delivery-time-only knowledge the
 * planner cannot have: which implementation windows are open right now, which
 * Stories a foreign lease holds, how far the ground has moved since the plan
 * was authored. It is never demoted automatically.
 *
 * `advisory` is an explicit operator trade for throughput on a run whose
 * `depends_on` edges are known to be complete. Detection still runs; only the
 * withholding stops.
 */
export const GUARD_MODES = Object.freeze({
  ENFORCE: 'enforce',
  ADVISORY: 'advisory',
});

/**
 * Which guard produced a withhold: a peer admitted **this beat**, or a Story
 * still in flight from an **earlier** one. The two clear on different events,
 * so an operator reading the report needs them apart.
 */
export const WITHHOLD_SCOPES = Object.freeze({
  BEAT: 'beat',
  IN_FLIGHT: 'in-flight',
});

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
 * **Beat-local** file-overlap co-dispatch guard. Returns `true` when two
 * Stories' file footprints intersect — meaning they would race the same file
 * if both were admitted onto parallel `story-<id>` branches on this beat.
 *
 * Comparison runs over the **widened** footprint
 * ({@link storyWidenedFootprint}), not the declaration: a declared `changes[]`
 * is a lower bound on what a Story will touch, and two Stories whose real edits
 * collide were being co-dispatched whenever the collision was not predicted
 * (Story #4875).
 *
 * **A glob footprint overlaps EVERYTHING** → `true` (Story #4539/#4540).
 * Comparison is exact-string, so a Story declaring `.agents/scripts/lib/**`
 * would not match another declaring `.agents/scripts/lib/story-adjacency.js` —
 * the guard would silently pass two Stories that genuinely race. Unknown width
 * is not the same as no width: fail safe by serializing the rest of the beat.
 *
 * That fail-safe is **beat-local and stays that way**. The cross-beat
 * reservation uses {@link reservesConcretePath} instead, because a beat is a
 * moment and an in-flight window is an implementation (Story #4960).
 *
 * @param {StoryRecord} a
 * @param {StoryRecord} b
 * @returns {boolean}
 */
export function storiesOverlap(a, b, options = {}) {
  return detectCollision(a, b, options) !== null;
}

/**
 * **Cross-beat** reservation guard: `true` only when the two widened
 * footprints share a **concrete** (non-glob) path.
 *
 * A Story dispatched on an earlier beat holds its footprint for its entire
 * implementation window, not for a moment, so the two guards cannot share a
 * predicate (Story #4960):
 *
 *   - A **concrete** shared path is a real, named collision — two branches
 *     editing `lib/foo.js` conflict at close whether the peer was admitted
 *     alongside or hours ago. It reserves, exactly as Story #4950 shipped.
 *   - A **glob** — or the UNKNOWN sentinel `resolve-stories.js` substitutes
 *     for an unparseable body — names no file. Reserving on it withheld every
 *     eligible Story against a single unknown-width blocker for that blocker's
 *     whole window, which is strictly worse than the serial run the
 *     reservation was meant to speed up. Glob paths are therefore skipped on
 *     both sides here; the beat-local {@link storiesOverlap} fail-safe is
 *     unchanged and still serializes them within a beat.
 *
 * Set intersection is symmetric, so scanning the reserving side alone finds
 * every shared concrete path.
 *
 * @param {StoryRecord} held      The in-flight Story holding the reservation.
 * @param {StoryRecord} candidate The Story being considered for admission.
 * @param {object} [options]      Evidence-scrape options (see {@link storyEvidencePaths}).
 * @returns {{ paths: string[], source: string }|null}
 */
function reservesConcretePath(held, candidate, options = {}) {
  return detectCollision(held, candidate, { ...options, concreteOnly: true });
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
 *      order, skipping any whose file footprint overlaps a Story **already
 *      admitted this beat** ({@link storiesOverlap}) or shares a **concrete**
 *      path with a Story **still in flight from an earlier beat**
 *      (`inFlightRecords`, {@link reservesConcretePath}). A withheld Story
 *      stays eligible and is naturally re-considered on the next beat once
 *      the Story reserving its files has cleared.
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
 * @param {StoryRecord[]} [args.inFlightRecords=[]] Records for the Stories
 *   already in flight, whose **concrete** footprint paths this beat must
 *   **reserve** rather than merely count. `inFlight` is a number and can only
 *   shrink capacity; without the records a Story admitted now can share files
 *   with one dispatched on an earlier beat and still implementing — a
 *   guaranteed merge conflict at close (Story #4950). A glob / UNKNOWN
 *   footprint reserves nothing (Story #4960). Callers that hold only ids (the
 *   `--dag`/`--in-flight` flag mode) pass nothing and get the pre-#4950
 *   same-beat-only behaviour.
 * @param {'enforce'|'advisory'} [args.footprintGuard='enforce'] Whether a
 *   footprint collision **withholds** a Story (`enforce`, the default and
 *   today's behaviour) or merely **reports** one while dispatch follows the
 *   declared `depends_on` edges alone (`advisory`). Advisory never changes what
 *   the guard *detects* — every would-be withhold is still computed and
 *   returned in `footprintWithholds` with `enforced: false` — so turning it on
 *   trades serialization for throughput without going blind (Story #5044).
 * @param {string} [args.tempRoot] Resolved `project.paths.tempRoot`. Accepted
 *   for call-site compatibility; the evidence scrape that read it was retired
 *   in Story #5313 and the footprint is the declared `changes[]` alone.
 * @returns {{
 *   selected: StoryRecord[],
 *   withheldByInFlight: Array<{id: number, blockedBy: number}>,
 *   footprintWithholds: Array<{id: number, blockedBy: number, scope: string, source: string, paths: string[], enforced: boolean}>,
 *   guardMode: 'enforce'|'advisory'
 * }}
 *   `selected` is the dispatch set: a subset of `stories`, ascending by id,
 *   overlap-free, length ≤ `globalCap − inFlight`. `withheldByInFlight`
 *   names each eligible Story a reservation held back and the in-flight
 *   Story that holds it. `footprintWithholds` is the **complete** ledger —
 *   beat-local skips as well as cross-beat reservations, each with the
 *   colliding paths and its `declared-overlap` source — so no withheld
 *   dispatch is unexplained (Story #5044).
 */
export function planReadySet({
  stories,
  doneIds = [],
  inFlight = 0,
  globalCap,
  dropForeign = false,
  inFlightRecords = [],
  footprintGuard = GUARD_MODES.ENFORCE,
  tempRoot,
} = {}) {
  const records = Array.isArray(stories) ? stories : [];
  const guardMode =
    footprintGuard === GUARD_MODES.ADVISORY
      ? GUARD_MODES.ADVISORY
      : GUARD_MODES.ENFORCE;
  const cap = Number.isInteger(globalCap) ? globalCap : 0;
  const inFlightCount =
    Number.isInteger(inFlight) && inFlight > 0 ? inFlight : 0;
  const slots = Math.max(0, cap - inFlightCount);
  if (slots <= 0 || records.length === 0) {
    return {
      selected: [],
      withheldByInFlight: [],
      footprintWithholds: [],
      guardMode,
    };
  }

  // Step 1 — adjacency keyed by id. The `dropForeign` policy decides whether
  // a dependency on an id outside the supplied set gates the dependent
  // (false) or is pruned (true). See the JSDoc above for the per-path
  // rationale.
  const adjacency = buildStoryAdjacency(records, { dropForeign });

  // Steps 2 + 3 — who is eligible at all, before any footprint reasoning.
  const { eligibleIds, byId } = resolveEligibility({
    records,
    doneIds,
    adjacency,
  });

  // Steps 4 + 5 — greedily admit up to `slots`, skipping file-overlap
  // collisions against the already-admitted set AND against the footprints
  // reserved by Stories still in flight from an earlier beat.
  return admitStories({
    eligibleIds,
    byId,
    slots,
    reserved: Array.isArray(inFlightRecords) ? inFlightRecords : [],
    guardMode,
    evidence: { tempRoot },
  });
}

/**
 * Resolve which Stories are eligible to dispatch on dependency grounds alone —
 * `agent::ready` with every declared blocker done — plus the id→record index
 * the admission loop reads.
 *
 * Separated from {@link planReadySet} because it answers a different question:
 * this is the *declared graph* half of the decision (edges and lifecycle
 * state), while everything after it reasons about footprints. Keeping the two
 * apart is also what holds `planReadySet` under the cyclomatic ceiling ratchet.
 *
 * The done set is the union of two sources: ids the caller resolved from live
 * state, and records in this batch that classify done — a Story can be both,
 * and neither alone is complete.
 *
 * @param {object} args
 * @param {StoryRecord[]} args.records
 * @param {number[]|Set<number>} args.doneIds
 * @param {Map<number, number[]>} args.adjacency
 * @returns {{ eligibleIds: number[], byId: Map<number, StoryRecord> }}
 */
function resolveEligibility({ records, doneIds, adjacency }) {
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

  // Ascending id for deterministic admission order.
  const eligibleIds = [];
  for (const id of [...byId.keys()].sort((a, b) => a - b)) {
    if (classifyStory(byId.get(id)) !== 'ready') continue;
    const deps = adjacency.get(id) ?? [];
    if (deps.every((dep) => done.has(dep))) eligibleIds.push(id);
  }
  return { eligibleIds, byId };
}

/**
 * Greedily admit eligible Stories in ascending-id order under two distinct
 * withholding rules, and report which ones a reservation held back.
 *
 * The two rules are distinct predicates, not one applied twice: the
 * cross-beat reservation matches only a shared **concrete** path
 * ({@link reservesConcretePath}), while the same-beat guard also serializes
 * unknown-width footprints ({@link storiesOverlap}). See both for why.
 *
 * Which of the two a candidate is reported against is {@link blockingCollision}'s
 * decision, not this loop's.
 *
 * Under `footprintGuard: 'advisory'` neither rule withholds: dispatch follows
 * the declared `depends_on` edges alone. Detection is unchanged — every hit is
 * still computed and recorded with `enforced: false` — so advisory mode is a
 * deliberate throughput trade an operator can read the cost of, not a blind
 * spot (Story #5044).
 *
 * @param {object} args
 * @param {number[]} args.eligibleIds        Ascending eligible Story ids.
 * @param {Map<number, StoryRecord>} args.byId
 * @param {number} args.slots                Remaining dispatch capacity.
 * @param {StoryRecord[]} args.reserved      In-flight Story records.
 * @param {'enforce'|'advisory'} args.guardMode
 * @param {object} args.evidence             Evidence-scrape options.
 * @returns {{ selected: StoryRecord[], withheldByInFlight: Array<{id: number, blockedBy: number}>, footprintWithholds: object[], guardMode: string }}
 */
function admitStories({
  eligibleIds,
  byId,
  slots,
  reserved,
  guardMode,
  evidence,
}) {
  const enforced = guardMode !== GUARD_MODES.ADVISORY;
  const selected = [];
  const footprintWithholds = [];
  for (const id of eligibleIds) {
    if (selected.length >= slots) break;
    const rec = byId.get(id);
    const hit = blockingCollision({ rec, id, selected, reserved, evidence });
    if (hit) footprintWithholds.push({ id, ...hit, enforced });
    if (hit && enforced) continue;
    selected.push(rec);
  }
  return {
    selected,
    // The legacy cross-beat projection, kept at its original `{ id, blockedBy }`
    // shape: it is `stories-wave-tick.js`'s long-standing reservation input and
    // narrowing the scrape must not reshape it.
    withheldByInFlight: footprintWithholds
      .filter((w) => w.enforced && w.scope === WITHHOLD_SCOPES.IN_FLIGHT)
      .map(({ id, blockedBy }) => ({ id, blockedBy })),
    footprintWithholds,
    guardMode,
  };
}

/**
 * The one footprint collision withholding this candidate, or `null`.
 *
 * The in-flight reservation is checked **first**, so a Story racing both an
 * in-flight Story and a same-beat peer is reported against the in-flight one:
 * that is the longer-lived and more informative blocker (a Story that has been
 * implementing for beats, not one merely admitted a moment ago), and checking it
 * first is what makes the reservation report complete. Order cannot change
 * `selected` — a candidate either rule rejects is skipped whichever runs first.
 *
 * @param {object} args
 * @param {StoryRecord} args.rec
 * @param {number} args.id
 * @param {StoryRecord[]} args.selected  Peers already admitted this beat.
 * @param {StoryRecord[]} args.reserved  In-flight Story records.
 * @param {object} args.evidence
 * @returns {{ blockedBy: number, scope: string, paths: string[], source: string }|null}
 */
function blockingCollision({ rec, id, selected, reserved, evidence }) {
  const held = findInFlightBlocker(rec, id, reserved, evidence);
  if (held) return { ...held, scope: WITHHOLD_SCOPES.IN_FLIGHT };
  const peer = findBeatBlocker(rec, selected, evidence);
  return peer ? { ...peer, scope: WITHHOLD_SCOPES.BEAT } : null;
}

/**
 * The **already-admitted peer** whose footprint this candidate would race on
 * this beat, with the colliding paths — or `null` when none does.
 *
 * Until Story #5044 this was an anonymous `continue`: the candidate was
 * silently dropped from the beat and nothing in any envelope said why. An
 * unfilled slot with no explanation is indistinguishable from a cap that was
 * simply not reached, which is what let a footprint-widening artifact
 * serialize a whole audit-derived plan without leaving a trace to notice.
 *
 * @param {StoryRecord} candidate
 * @param {StoryRecord[]} selected  Stories already admitted this beat.
 * @param {object} [options]
 * @returns {{ blockedBy: number, paths: string[], source: string }|null}
 */
function findBeatBlocker(candidate, selected, options = {}) {
  for (const picked of selected) {
    const collision = detectCollision(picked, candidate, options);
    if (collision) return { blockedBy: storyIdOf(picked), ...collision };
  }
  return null;
}

/**
 * The id of the in-flight Story whose widened footprint reserves a concrete
 * path the candidate would race, or `null` when none does.
 *
 * Two records are skipped rather than treated as blockers:
 *
 *   - **The candidate itself.** Probe mode hands the whole record set to both
 *     arguments, and an in-flight Story classifies `executing` rather than
 *     `ready`, so a candidate can never legitimately appear here — but a
 *     caller that double-lists one Story must not have it withhold itself.
 *   - **An unidentifiable record.** A withholding this function cannot name
 *     is one the envelope cannot explain, and an unexplained unfilled slot is
 *     the exact operator-facing failure this reservation exists to remove.
 *     Probe-mode records always carry an integer id, so this is defensive.
 *
 * @param {StoryRecord} candidate
 * @param {number} candidateId
 * @param {StoryRecord[]} reserved
 * @param {object} [options]
 * @returns {{ blockedBy: number, paths: string[], source: string }|null}
 */
function findInFlightBlocker(candidate, candidateId, reserved, options = {}) {
  for (const held of reserved) {
    const heldId = storyIdOf(held);
    if (heldId === null || heldId === candidateId) continue;
    const collision = reservesConcretePath(held, candidate, options);
    if (collision) return { blockedBy: heldId, ...collision };
  }
  return null;
}
