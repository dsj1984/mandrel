/**
 * Property / model-based tests for suite admission (Story #5684).
 *
 * The example tests in `suite-admission.test.js` pin hand-picked shapes; these
 * drive the public `createAttempt` over generated workloads and generated
 * try/release sequences against an in-memory `fs`, and check the invariant the
 * header of `.agents/scripts/lib/suite-admission.js` promises:
 *
 *   - after every step, live reservation weights sum to at most `capacity`
 *     and no two live reservations share a resource;
 *   - a declared run is admitted exactly when it fits (a refusal is always
 *     justified by a clash or by capacity), so the model is not satisfied
 *     vacuously by refusing everything;
 *   - the on-disk reservation set agrees with the model after every step;
 *   - every schema-valid `{ weight, resources }` survives the reservation
 *     filename encoding: a peer reading the file back sees that exact weight
 *     and exactly those resources;
 *   - (Story #5963) with sized, backfill-gated, declared and exclusive
 *     contenders mixed, live weights still never exceed capacity, a live
 *     exclusive run never overlaps a reservation, and a gate only vetoes.
 *
 * Runs are pinned by `fcParams()` (seed + run count); override with
 * `MANDREL_FC_SEED` / `MANDREL_FC_NUM_RUNS` to explore.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import { acquireSweepLock } from '../../.agents/scripts/lib/single-story-sweep/sweep-lock.js';
import {
  createAttempt,
  FULL_SUITE_STALE_MS,
} from '../../.agents/scripts/lib/suite-admission.js';
import { fcParams } from '../helpers/fast-check-config.js';

// Deliberately un-normalized: the module joins some paths with node:path
// (backslashes on win32) and concatenates others, so the in-memory fs must
// key on the resolved path or a reservation goes missing on Windows. The
// doubled slash reproduces that mismatch on POSIX too.
const LOCK = '/fake//.git/full-suite.lock';
const RESERVATIONS = path.resolve(`${LOCK}.reservations`);

function fsError(code, p) {
  return Object.assign(new Error(`${code}: ${p}`), { code });
}

/**
 * An in-memory `fs` covering exactly what admission and the sweep lock use:
 * `wx` creates, renames, hard links, stats, directory listings and unlinks.
 */
function makeMemoryFs() {
  const files = new Map();
  const dirs = new Set();
  let nextIno = 1;
  const key = (p) => path.resolve(String(p));
  const get = (p) => {
    const f = files.get(key(p));
    if (!f) throw fsError('ENOENT', p);
    return f;
  };
  return {
    files,
    mkdirSync(p) {
      dirs.add(key(p));
    },
    openSync(p) {
      if (files.has(key(p))) throw fsError('EEXIST', p);
      files.set(key(p), {
        body: '',
        mtimeMs: Date.now(),
        ino: nextIno++,
        dev: 1,
      });
      return p;
    },
    writeSync(fd, data) {
      get(fd).body += data;
    },
    closeSync() {},
    statSync(p) {
      const { mtimeMs, ino, dev } = get(p);
      return { mtimeMs, ino, dev };
    },
    readFileSync(p) {
      return get(p).body;
    },
    readdirSync(dir) {
      if (!dirs.has(key(dir))) throw fsError('ENOENT', dir);
      return [...files.keys()]
        .filter((p) => path.dirname(p) === key(dir))
        .map((p) => path.basename(p));
    },
    utimesSync(p, _atime, mtime) {
      get(p).mtimeMs = mtime.getTime();
    },
    unlinkSync(p) {
      get(p);
      files.delete(key(p));
    },
    renameSync(from, to) {
      const f = get(from);
      files.delete(key(from));
      files.set(key(to), f);
    },
    linkSync(existing, target) {
      const f = get(existing);
      if (files.has(key(target))) throw fsError('EEXIST', target);
      files.set(key(target), f);
    },
  };
}

/** No heartbeat timers, no process listeners: thousands of runs leak nothing. */
const quietAcquire = (o) =>
  acquireSweepLock({ ...o, heartbeatMs: 0, processImpl: null });

function declaredAttempt(fsImpl, capacity, { weight, resources }) {
  return createAttempt({
    lockPath: LOCK,
    workload: { kind: 'declared', command: 'suite', weight, resources },
    capacity,
    staleMs: FULL_SUITE_STALE_MS,
    fsImpl,
    nowFn: Date.now,
    acquireReservationFn: quietAcquire,
  });
}

/** Schema `delivery.execution.workloads[].resources[]` items. */
const resourceName = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,11}$/);

const POOL = ['db', 'cache', 'coverage'];

const modelScenario = fc.integer({ min: 1, max: 8 }).chain((capacity) =>
  fc.record({
    capacity: fc.constant(capacity),
    agents: fc.array(
      fc.record({
        weight: fc.integer({ min: 1, max: capacity }),
        resources: fc.subarray(POOL),
      }),
      { minLength: 2, maxLength: 6 },
    ),
    ops: fc.array(
      fc.record({
        kind: fc.constantFrom('try', 'release'),
        agent: fc.nat(),
      }),
      { maxLength: 40 },
    ),
  }),
);

function liveAgents(state) {
  return state.filter((s) => s.live);
}

function fits(state, agent) {
  const live = liveAgents(state);
  const used = live.reduce((sum, s) => sum + s.agent.weight, 0);
  const clash = live.some((s) =>
    s.agent.resources.some((r) => agent.resources.includes(r)),
  );
  return !clash && used + agent.weight <= state.capacity;
}

function assertInvariant(state, fsImpl) {
  const live = liveAgents(state);
  const used = live.reduce((sum, s) => sum + s.agent.weight, 0);
  assert.ok(used <= state.capacity, `live weight ${used} > ${state.capacity}`);
  const seen = new Set();
  for (const { agent } of live) {
    for (const r of agent.resources) {
      assert.ok(!seen.has(r), `two live reservations share "${r}"`);
      seen.add(r);
    }
  }
  const onDisk = [...fsImpl.files.keys()].filter(
    (p) => path.dirname(p) === RESERVATIONS && p.endsWith('.lock'),
  );
  assert.equal(onDisk.length, live.length, 'disk agrees with the model');
}

function step(state, fsImpl, op) {
  const slot = state[op.agent % state.length];
  if (op.kind === 'release') {
    slot.attempt?.release();
    slot.live = false;
    return;
  }
  if (slot.live) return;
  const expected = fits(state, slot.agent);
  slot.attempt = declaredAttempt(fsImpl, state.capacity, slot.agent);
  const result = slot.attempt.tryOnce();
  assert.equal(
    result.acquired,
    expected,
    `admitted=${result.acquired}, but fits=${expected}`,
  );
  slot.live = result.acquired;
}

describe('suite admission — properties (Story #5684)', () => {
  it('AC-2: live weights never exceed capacity and no two live reservations share a resource', () => {
    fc.assert(
      fc.property(modelScenario, ({ capacity, agents, ops }) => {
        const fsImpl = makeMemoryFs();
        const state = agents.map((agent) => ({
          agent,
          attempt: null,
          live: false,
        }));
        state.capacity = capacity;
        try {
          for (const op of ops) {
            step(state, fsImpl, op);
            assertInvariant(state, fsImpl);
          }
        } finally {
          for (const slot of state) slot.attempt?.release();
        }
      }),
      fcParams(),
    );
  });

  it('AC-3: every schema-valid weight and resources set survives the reservation filename', () => {
    const capacity = 64;
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: capacity }),
        fc.uniqueArray(resourceName, { maxLength: 5 }),
        resourceName,
        (weight, resources, probe) => {
          const fsImpl = makeMemoryFs();
          const held = declaredAttempt(fsImpl, capacity, {
            weight,
            resources,
          });
          try {
            assert.equal(held.tryOnce().acquired, true);

            // A peer that needs the whole capacity reads the weight back.
            const whole = declaredAttempt(fsImpl, capacity, {
              weight: capacity,
              resources: [],
            }).tryOnce();
            assert.equal(whole.acquired, false);
            assert.equal(whole.blocking.reason, 'capacity');
            assert.equal(whole.blocking.used, weight);

            // A peer naming each resource reads that exact resource back.
            for (const resource of resources) {
              const peer = declaredAttempt(fsImpl, capacity, {
                weight: 1,
                resources: [resource],
              }).tryOnce();
              assert.equal(peer.blocking?.reason, 'resource');
              assert.equal(peer.blocking.resource, resource);
            }

            // And a resource it never declared is never read back as held.
            if (!resources.includes(probe)) {
              const free = declaredAttempt(fsImpl, capacity, {
                weight: 1,
                resources: [probe],
              });
              const verdict = free.tryOnce();
              assert.notEqual(verdict.blocking?.reason, 'resource');
              free.release();
            }
          } finally {
            held.release();
          }
        },
      ),
      fcParams(),
    );
  });
});

const mixedScenario = fc.integer({ min: 1, max: 8 }).chain((capacity) =>
  fc.record({
    capacity: fc.constant(capacity),
    agents: fc.array(
      fc.oneof(
        fc.record({ kind: fc.constant('exclusive') }),
        fc.record({
          kind: fc.constant('declared'),
          weight: fc.integer({ min: 1, max: capacity }),
          resources: fc.subarray(POOL),
          tiers: fc.array(
            fc.record({
              maxFiles: fc.nat({ max: 50 }),
              weight: fc.integer({ min: 1, max: capacity + 2 }),
            }),
            { maxLength: 3 },
          ),
          slice: fc.option(fc.nat({ max: 60 })),
        }),
      ),
      { minLength: 2, maxLength: 6 },
    ),
    ops: fc.array(
      fc.record({
        kind: fc.constantFrom('try', 'release'),
        agent: fc.nat(),
        veto: fc.option(fc.boolean()),
      }),
      { maxLength: 40 },
    ),
  }),
);

/** The model of a sized booking: the covering tier, else full weight. */
function bookedWeight({ weight, tiers, slice }) {
  if (slice === null) return weight;
  const tier = [...tiers]
    .sort((a, b) => a.maxFiles - b.maxFiles)
    .find((t) => slice <= t.maxFiles);
  return tier && tier.weight <= weight ? tier.weight : weight;
}

function mixedAttempt(fsImpl, capacity, agent) {
  const base = {
    lockPath: LOCK,
    capacity,
    staleMs: FULL_SUITE_STALE_MS,
    fsImpl,
    nowFn: Date.now,
    acquireReservationFn: quietAcquire,
    acquireOnceFn: quietAcquire,
  };
  if (agent.kind === 'exclusive') {
    return createAttempt({ ...base, workload: { kind: 'exclusive' } });
  }
  const workload = {
    kind: 'declared',
    command: 'suite',
    weight: bookedWeight(agent),
    resources: agent.resources,
  };
  return createAttempt({ ...base, workload });
}

function mixedStep(state, fsImpl, op) {
  const slot = state[op.agent % state.length];
  if (op.kind === 'release') {
    slot.attempt?.release();
    slot.attempt = null;
    slot.live = false;
    return;
  }
  if (slot.live) return;
  slot.attempt ??= mixedAttempt(fsImpl, state.capacity, slot.agent);
  const gated = slot.agent.kind === 'declared' && op.veto !== null;
  const result = gated
    ? slot.attempt.tryOnce(() => (op.veto ? { reason: 'queue' } : null))
    : slot.attempt.tryOnce();
  if (gated && op.veto) assert.equal(result.acquired, false, 'a veto holds');
  slot.live = result.acquired;
  if (slot.live && slot.agent.kind === 'declared') {
    slot.weight = bookedWeight(slot.agent);
  }
}

function assertMixedInvariant(state) {
  const live = state.filter((s) => s.live);
  const declared = live.filter((s) => s.agent.kind === 'declared');
  const used = declared.reduce((sum, s) => sum + s.weight, 0);
  assert.ok(used <= state.capacity, `live weight ${used} > ${state.capacity}`);
  assert.ok(declared.every((s) => s.weight <= s.agent.weight));
  const exclusive = live.filter((s) => s.agent.kind === 'exclusive');
  assert.ok(exclusive.length <= 1, 'one exclusive holder at most');
  if (exclusive.length) assert.equal(declared.length, 0, 'exclusive is alone');
}

describe('suite admission — sized and backfilled mixes (Story #5963)', () => {
  it('AC-8: live admitted weights never exceed capacity under any contender mix', () => {
    fc.assert(
      fc.property(mixedScenario, ({ capacity, agents, ops }) => {
        const fsImpl = makeMemoryFs();
        const state = agents.map((agent) => ({
          agent,
          attempt: null,
          live: false,
          weight: 0,
        }));
        state.capacity = capacity;
        try {
          for (const op of ops) {
            mixedStep(state, fsImpl, op);
            assertMixedInvariant(state);
          }
        } finally {
          for (const slot of state) slot.attempt?.release();
        }
      }),
      fcParams(),
    );
  });
});
