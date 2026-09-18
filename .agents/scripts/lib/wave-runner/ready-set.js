/**
 * Side-effect-free ready-set scheduler: a Story is dispatchable the instant
 * its own dependencies are done (no wave barrier), capped by `globalCap` and
 * filtered by the file-footprint overlap guards.
 *
 * @module lib/wave-runner/ready-set
 */

import { AGENT_LABELS } from '../label-constants.js';
import { buildStoryAdjacency } from '../story-adjacency.js';
import { detectCollision } from './footprint.js';

/**
 * `delivery.deliverRunner.footprintGuard`: `enforce` (default, never demoted
 * automatically) withholds on collision; `advisory` still detects but only
 * reports, for runs whose `depends_on` edges are known complete.
 */
export const GUARD_MODES = Object.freeze({
  ENFORCE: 'enforce',
  ADVISORY: 'advisory',
});

/** Which guard withheld: a same-beat peer or an earlier in-flight Story. */
export const WITHHOLD_SCOPES = Object.freeze({
  BEAT: 'beat',
  IN_FLIGHT: 'in-flight',
});

/**
 * @typedef {object} StoryRecord
 * @property {number|string} [id]
 * @property {number} [number]
 * @property {string} [title]
 * @property {string} [body]
 * @property {string[]} [labels]
 * @property {string} [state]
 * @property {Array<number|string>} [dependencies]
 * @property {Array<number|string>} [dependsOn]
 * @property {string[]} [files]        Footprint (any `storyFootprint` shape).
 * @property {string[]} [changes]
 * @property {Array<{path?: string}>} [changeset]
 */

/** @typedef {'done'|'blocked'|'executing'|'ready'} StoryClass */

/**
 * Positive-integer Story id from `id` or `number`, else `null`.
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
 * Classify a Story from live labels and state. `done` (label or closed issue,
 * so a manual UI close counts) wins over any stale in-progress label;
 * `closing` counts as executing because it still occupies a slot.
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
 * Beat-local overlap guard: `true` when two footprints intersect. A glob
 * (unknown width) overlaps everything, since exact-string comparison would
 * otherwise pass two Stories that really race; this fail-safe is beat-local
 * only.
 *
 * @param {StoryRecord} a
 * @param {StoryRecord} b
 * @returns {boolean}
 */
export function storiesOverlap(a, b, options = {}) {
  return detectCollision(a, b, options) !== null;
}

/**
 * Cross-beat reservation guard: collides only on a shared concrete path. An
 * in-flight Story holds its footprint for its whole implementation window, so
 * a glob or the UNKNOWN sentinel (substituted for any unparseable body) must
 * reserve nothing or one bad body would serialize the entire run.
 *
 * @param {StoryRecord} held
 * @param {StoryRecord} candidate
 * @param {object} [options]
 * @returns {{ paths: string[], source: string }|null}
 */
function reservesConcretePath(held, candidate, options = {}) {
  return detectCollision(held, candidate, { ...options, concreteOnly: true });
}

/**
 * Select the Stories safe to dispatch this beat: `ready` Stories whose deps
 * are all done, admitted greedily in ascending-id order (deterministic) up to
 * `globalCap − inFlight`, skipping footprint collisions.
 *
 * @param {object} args
 * @param {StoryRecord[]} args.stories
 * @param {Array<number|string>|Set<number|string>} [args.doneIds] Merged with
 *   records that classify as done.
 * @param {number} [args.inFlight=0]
 * @param {number} args.globalCap
 * @param {boolean} [args.dropForeign=false] `false` keeps a dependency on an
 *   out-of-set id as a gate (operator DAG); `true` prunes it so an Epic's
 *   Story is never stranded by a foreign or mistyped `blocked by`.
 * @param {StoryRecord[]} [args.inFlightRecords=[]] In-flight Stories whose
 *   concrete paths are reserved; a bare `inFlight` count only shrinks capacity
 *   and cannot prevent a close-time merge conflict.
 * @param {'enforce'|'advisory'} [args.footprintGuard='enforce'] Advisory
 *   still records every would-be withhold with `enforced: false`.
 * @param {string} [args.tempRoot] Accepted for call-site compatibility only.
 * @returns {{
 *   selected: StoryRecord[],
 *   withheldByInFlight: Array<{id: number, blockedBy: number}>,
 *   footprintWithholds: Array<{id: number, blockedBy: number, scope: string, source: string, paths: string[], enforced: boolean}>,
 *   guardMode: 'enforce'|'advisory'
 * }}
 *   `footprintWithholds` is the complete ledger, so no withheld dispatch is
 *   unexplained.
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

  const adjacency = buildStoryAdjacency(records, { dropForeign });

  const { eligibleIds, byId } = resolveEligibility({
    records,
    doneIds,
    adjacency,
  });

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
 * Stories eligible on dependency grounds alone, plus the id→record index. The
 * done set is caller `doneIds` ∪ records classifying done; neither alone is
 * complete.
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

  const eligibleIds = [];
  for (const id of [...byId.keys()].sort((a, b) => a - b)) {
    if (classifyStory(byId.get(id)) !== 'ready') continue;
    const deps = adjacency.get(id) ?? [];
    if (deps.every((dep) => done.has(dep))) eligibleIds.push(id);
  }
  return { eligibleIds, byId };
}

/**
 * Greedily admit eligible Stories; under `advisory` collisions are recorded
 * but never withhold.
 *
 * @param {object} args
 * @param {number[]} args.eligibleIds
 * @param {Map<number, StoryRecord>} args.byId
 * @param {number} args.slots
 * @param {StoryRecord[]} args.reserved
 * @param {'enforce'|'advisory'} args.guardMode
 * @param {object} args.evidence
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
    // Shape `{ id, blockedBy }` is `stories-wave-tick.js`'s reservation input.
    withheldByInFlight: footprintWithholds
      .filter((w) => w.enforced && w.scope === WITHHOLD_SCOPES.IN_FLIGHT)
      .map(({ id, blockedBy }) => ({ id, blockedBy })),
    footprintWithholds,
    guardMode,
  };
}

/**
 * The collision withholding this candidate, or `null`. In-flight is checked
 * first so it is reported as the longer-lived blocker; order cannot change
 * `selected`.
 *
 * @param {object} args
 * @param {StoryRecord} args.rec
 * @param {number} args.id
 * @param {StoryRecord[]} args.selected
 * @param {StoryRecord[]} args.reserved
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
 * The same-beat peer this candidate would race, with the colliding paths, so
 * an unfilled slot is never unexplained.
 *
 * @param {StoryRecord} candidate
 * @param {StoryRecord[]} selected
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
 * The in-flight Story reserving a concrete path the candidate would race.
 * Skips the candidate itself (a double-listed Story must not withhold itself)
 * and id-less records (a withhold that cannot be named cannot be explained).
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
