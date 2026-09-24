/**
 * Model-based tests for the ready-set scheduler (Story #5424).
 *
 * `planReadySet` is synchronous and stateless, so there is nothing for
 * `fc.scheduler()` to interleave; the state lives in the caller across beats.
 * These properties model that caller: generated acyclic DAGs (edges only to
 * lower ids, plus the occasional foreign id), footprints drawn from a small
 * path pool with an occasional glob, a cap of 1–4 and both guard modes, then
 * multi-beat `Tick` / `Land` / `Block` / `Unblock` command sequences
 * (`fc.commands`). Checked on every `Tick`:
 *
 *   - enforce mode: selected ≤ cap − inFlight; every selected Story
 *     classifies `ready` with all dependencies done; none shares a concrete
 *     path with an in-flight record; selected Stories are pairwise
 *     non-overlapping (a glob overlaps everything within a beat);
 *   - advisory mode: no enforced withholds, every ledger row reads
 *     `enforced: false`, and admission is simply the eligible Stories in
 *     ascending id order up to capacity;
 *   - both: the result is independent of input record order, and with nothing
 *     in flight and at least one eligible Story, a `Tick` selects at least one.
 *
 * Run-to-completion: with no `Block`, ticking and landing everything selected
 * lands every Story whose dependency closure lies inside the set within
 * `|stories|` beats.
 *
 * Out of model (Non-Goals): `stories-wave-tick.js`'s cross-beat reservation
 * handoff and the idle watchdog. Parameters come from
 * `tests/helpers/fast-check-config.js`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { storyFootprint } from '../../.agents/scripts/lib/wave-runner/footprint.js';
import {
  classifyStory,
  GUARD_MODES,
  planReadySet,
  storiesOverlap,
  storyIdOf,
} from '../../.agents/scripts/lib/wave-runner/ready-set.js';
import { fcParams } from '../helpers/fast-check-config.js';

const MAX_STORIES = 6;
const FOREIGN_ID = 50;
const CONCRETE_PATHS = ['lib/a.js', 'lib/b.js', 'docs/c.md'];
const GLOB_PATH = 'lib/**';

const isGlob = (p) => p.includes('*') || p.includes('?') || p.includes('{');
const concretePaths = (rec) =>
  new Set([...storyFootprint(rec)].filter((p) => !isGlob(p)));
const idsOf = (records) => records.map(storyIdOf);

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const rare = (n) => fc.integer({ min: 0, max: n }).map((v) => v === 0);

const storySpecArb = fc.record({
  depMask: fc.array(rare(2), {
    minLength: MAX_STORIES,
    maxLength: MAX_STORIES,
  }),
  foreignDep: rare(6),
  paths: fc.subarray(CONCRETE_PATHS),
  glob: rare(6),
});

/** Stories with ids 1..n; dependencies only on lower ids ⇒ acyclic. */
const planArb = fc.record({
  stories: fc
    .array(storySpecArb, { minLength: 1, maxLength: MAX_STORIES })
    .map((specs) =>
      specs.map((s, i) => ({
        id: i + 1,
        deps: [
          ...s.depMask.slice(0, i).flatMap((on, j) => (on ? [j + 1] : [])),
          ...(s.foreignDep ? [FOREIGN_ID] : []),
        ],
        files: [...s.paths, ...(s.glob ? [GLOB_PATH] : [])],
      })),
    ),
  cap: fc.integer({ min: 1, max: 4 }),
  mode: fc.constantFrom(GUARD_MODES.ENFORCE, GUARD_MODES.ADVISORY),
  dropForeign: fc.boolean(),
});

// ---------------------------------------------------------------------------
// The caller model: per-Story lifecycle state across beats.
// ---------------------------------------------------------------------------

class Run {
  constructor({ stories, cap, mode, dropForeign }) {
    Object.assign(this, { stories, cap, mode, dropForeign });
    this.state = new Map(stories.map((s) => [s.id, 'ready']));
    this.byId = new Map(stories.map((s) => [s.id, s]));
  }

  record(s) {
    return {
      id: s.id,
      labels: ['type::story', `agent::${this.state.get(s.id)}`],
      state: 'open',
      dependencies: [...s.deps],
      files: [...s.files],
    };
  }

  records() {
    return this.stories.map((s) => this.record(s));
  }

  idsIn(state) {
    return this.stories.filter((s) => this.state.get(s.id) === state);
  }

  /** Dependency-eligible per the model, not the scheduler. */
  eligibleIds() {
    return this.idsIn('ready')
      .filter((s) =>
        s.deps.every((d) =>
          this.byId.has(d) ? this.state.get(d) === 'done' : this.dropForeign,
        ),
      )
      .map((s) => s.id);
  }

  /** Stories whose whole dependency closure lies inside the set. */
  landableIds() {
    const memo = new Map();
    const landable = (id) => {
      if (memo.has(id)) return memo.get(id);
      const ok = this.byId
        .get(id)
        .deps.every((d) => (this.byId.has(d) ? landable(d) : this.dropForeign));
      memo.set(id, ok);
      return ok;
    };
    return this.stories.map((s) => s.id).filter(landable);
  }

  plan({ reorder = (xs) => xs } = {}) {
    const inFlightRecords = this.idsIn('executing').map((s) => this.record(s));
    return planReadySet({
      stories: reorder(this.records()),
      doneIds: reorder(this.idsIn('done').map((s) => s.id)),
      inFlight: inFlightRecords.length,
      inFlightRecords: reorder(inFlightRecords),
      globalCap: this.cap,
      footprintGuard: this.mode,
      dropForeign: this.dropForeign,
    });
  }
}

/** A deterministic non-identity reordering: rotate, then reverse. */
function rotateReverse(shift) {
  return (xs) => {
    if (xs.length === 0) return xs;
    const k = shift % xs.length;
    return [...xs.slice(k), ...xs.slice(0, k)].reverse();
  };
}

/** The per-beat safety contract for one `planReadySet` result. */
function assertBeatSafety(run, result) {
  const inFlight = run.idsIn('executing').map((s) => run.record(s));
  const selected = result.selected;
  const ids = idsOf(selected);
  const eligible = run.eligibleIds();

  assert.equal(result.guardMode, run.mode);
  assert.equal(new Set(ids).size, ids.length, 'a Story selected twice');
  assert.ok(
    selected.length <= Math.max(0, run.cap - inFlight.length),
    `selected ${selected.length} with cap ${run.cap} and ${inFlight.length} in flight`,
  );
  for (const rec of selected) {
    assert.equal(classifyStory(rec), 'ready', `#${rec.id} was not ready`);
    assert.ok(
      eligible.includes(rec.id),
      `#${rec.id} selected with a dependency not done`,
    );
  }

  if (run.mode === GUARD_MODES.ADVISORY) {
    assert.ok(
      result.footprintWithholds.every((w) => w.enforced === false),
      'advisory ledger rows must read enforced: false',
    );
    assert.deepEqual(result.withheldByInFlight, []);
    const slots = Math.max(0, run.cap - inFlight.length);
    assert.deepEqual(ids, eligible.slice(0, slots), 'advisory withheld');
    return;
  }

  for (const rec of selected) {
    const mine = concretePaths(rec);
    for (const held of inFlight) {
      const shared = [...concretePaths(held)].filter((p) => mine.has(p));
      assert.deepEqual(
        shared,
        [],
        `#${rec.id} races in-flight #${held.id} on a concrete path`,
      );
    }
  }
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      assert.equal(
        storiesOverlap(selected[i], selected[j]),
        false,
        `#${selected[i].id} and #${selected[j].id} overlap in one beat`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const pick = (run, idx) => run.stories[idx % run.stories.length].id;

class TickCommand {
  constructor(shift) {
    this.shift = shift;
  }
  check() {
    return true;
  }
  run(_m, run) {
    const result = run.plan();
    assertBeatSafety(run, result);
    const reordered = run.plan({ reorder: rotateReverse(this.shift) });
    assert.deepEqual(
      idsOf(reordered.selected),
      idsOf(result.selected),
      'selection depends on input record order',
    );
    if (run.idsIn('executing').length === 0 && run.eligibleIds().length > 0) {
      assert.ok(result.selected.length > 0, 'no progress with a free slot');
    }
    for (const rec of result.selected) run.state.set(rec.id, 'executing');
  }
  toString() {
    return `Tick(shift=${this.shift})`;
  }
}

/** Moves one Story `from` a state `to` another; a no-op otherwise. */
class TransitionCommand {
  constructor(name, idx, from, to) {
    Object.assign(this, { name, idx, from, to });
  }
  check() {
    return true;
  }
  run(_m, run) {
    const id = pick(run, this.idx);
    if (this.from.includes(run.state.get(id))) run.state.set(id, this.to);
  }
  toString() {
    return `${this.name}(#${this.idx})`;
  }
}

const idxArb = fc.nat({ max: MAX_STORIES - 1 });
const commandsArb = fc.commands(
  [
    fc.nat({ max: MAX_STORIES }).map((s) => new TickCommand(s)),
    idxArb.map((i) => new TransitionCommand('Land', i, ['executing'], 'done')),
    idxArb.map(
      (i) =>
        new TransitionCommand('Block', i, ['executing', 'ready'], 'blocked'),
    ),
    idxArb.map(
      (i) => new TransitionCommand('Unblock', i, ['blocked'], 'ready'),
    ),
  ],
  { maxCommands: 20 },
);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('planReadySet — multi-beat model (fast-check)', () => {
  it('keeps every beat safe, order-independent and progressing over any Tick/Land/Block/Unblock sequence', () => {
    fc.assert(
      fc.property(planArb, commandsArb, (plan, cmds) => {
        fc.modelRun(() => ({ model: {}, real: new Run(plan) }), cmds);
      }),
      fcParams(),
    );
  });

  it('lands every Story with in-set dependencies within |stories| beats when nothing blocks', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const run = new Run(plan);
        for (let beat = 0; beat < plan.stories.length; beat++) {
          const result = run.plan();
          assertBeatSafety(run, result);
          for (const rec of result.selected) run.state.set(rec.id, 'done');
        }
        const done = run.idsIn('done').map((s) => s.id);
        assert.deepEqual(done, run.landableIds(), 'run did not complete');
      }),
      fcParams(),
    );
  });
});
