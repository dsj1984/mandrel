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
 *     and exactly those resources.
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

const LOCK = '/fake/.git/full-suite.lock';
const RESERVATIONS = `${LOCK}.reservations`;

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
  const get = (p) => {
    const f = files.get(p);
    if (!f) throw fsError('ENOENT', p);
    return f;
  };
  return {
    files,
    mkdirSync(p) {
      dirs.add(p);
    },
    openSync(p) {
      if (files.has(p)) throw fsError('EEXIST', p);
      files.set(p, { body: '', mtimeMs: Date.now(), ino: nextIno++, dev: 1 });
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
      if (!dirs.has(dir)) throw fsError('ENOENT', dir);
      return [...files.keys()]
        .filter((p) => path.dirname(p) === dir)
        .map((p) => path.basename(p));
    },
    utimesSync(p, _atime, mtime) {
      get(p).mtimeMs = mtime.getTime();
    },
    unlinkSync(p) {
      get(p);
      files.delete(p);
    },
    renameSync(from, to) {
      const f = get(from);
      files.delete(from);
      files.set(to, f);
    },
    linkSync(existing, target) {
      const f = get(existing);
      if (files.has(target)) throw fsError('EEXIST', target);
      files.set(target, f);
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
