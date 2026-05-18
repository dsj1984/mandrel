import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  clearRegistryCache,
  getCheck,
  loadRegistry,
  runChecks,
} from '../../../.agents/scripts/lib/checks/index.js';

/**
 * Unit tests for the registry + runner. Fixture checks are constructed
 * inline (rather than loaded from disk) so each test isolates the
 * invariant it cares about.
 *
 * The disk-discovery path is covered separately in
 * `runner-integration.test.js` (Task #1296) using fixture files.
 */

/** Build a fixture check with sensible defaults. */
function makeCheck(overrides = {}) {
  return {
    id: 'fixture-check',
    severity: 'blocker',
    scope: ['story-close'],
    autoCorrect: 'refuse-and-print',
    detect: () => null,
    ...overrides,
  };
}

/** Build a Finding shaped like a check would return one. */
function makeFinding(overrides = {}) {
  return {
    id: 'fixture-check',
    severity: 'blocker',
    scope: 'story-close',
    summary: 'fixture finding',
    fixCommand: 'echo fixme',
    autoCorrectable: false,
    ...overrides,
  };
}

describe('runChecks', () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it('throws on { scope: "retro", autoFix: true } with the exact message', async () => {
    await assert.rejects(
      () =>
        runChecks({ scope: 'retro', autoFix: true, state: {}, registry: [] }),
      /retro scope is read-only/,
    );
  });

  it('filters the registry by scope before invoking detect()', async () => {
    const seen = [];
    const registry = [
      makeCheck({
        id: 'a',
        scope: ['story-close'],
        detect: () => {
          seen.push('a');
          return null;
        },
      }),
      makeCheck({
        id: 'b',
        scope: ['epic-deliver'],
        detect: () => {
          seen.push('b');
          return null;
        },
      }),
    ];
    await runChecks({ scope: 'story-close', state: {}, registry });
    assert.deepEqual(seen, ['a']);
  });

  it('returns findings unfixed when autoFix is false', async () => {
    const finding = makeFinding();
    const registry = [
      makeCheck({
        autoCorrect: 'auto',
        detect: () => finding,
        fix: () => ({ ok: true, message: 'fixed' }),
      }),
    ];
    const result = await runChecks({
      scope: 'story-close',
      autoFix: false,
      state: {},
      registry,
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.fixed.length, 0);
  });

  it('invokes fix() only when autoCorrect === "auto" and autoFix === true', async () => {
    let fixCalled = false;
    const registry = [
      makeCheck({
        autoCorrect: 'auto',
        detect: () => makeFinding(),
        fix: () => {
          fixCalled = true;
          return { ok: true, message: 'fixed' };
        },
      }),
    ];
    const result = await runChecks({
      scope: 'story-close',
      autoFix: true,
      state: {},
      registry,
    });
    assert.equal(fixCalled, true);
    assert.equal(result.fixed.length, 1);
    assert.equal(result.findings.length, 0);
  });

  it('NEVER invokes fix() when autoCorrect === "refuse-and-print", even with autoFix:true', async () => {
    // Invariant #2 (the load-bearing one from the README). A check that
    // declares refuse-and-print is asserting "my fix is unsafe / I refuse
    // to auto-correct" — the runner must respect that even if fix() is
    // defined.
    let fixCalled = false;
    const registry = [
      makeCheck({
        autoCorrect: 'refuse-and-print',
        detect: () => makeFinding({ autoCorrectable: false }),
        fix: () => {
          fixCalled = true;
          return { ok: true, message: 'should not run' };
        },
      }),
    ];
    const result = await runChecks({
      scope: 'story-close',
      autoFix: true,
      state: {},
      registry,
    });
    assert.equal(fixCalled, false, 'fix() must not be invoked');
    assert.equal(result.findings.length, 1);
    assert.equal(result.fixed.length, 0);
  });

  it('falls back to unfixed when fix() returns ok:false (and surfaces the failure detail)', async () => {
    const registry = [
      makeCheck({
        autoCorrect: 'auto',
        detect: () => makeFinding({ detail: 'original' }),
        fix: () => ({ ok: false, message: 'fix failed because reasons' }),
      }),
    ];
    const result = await runChecks({
      scope: 'story-close',
      autoFix: true,
      state: {},
      registry,
    });
    assert.equal(result.fixed.length, 0);
    assert.equal(result.findings.length, 1);
    assert.match(
      result.findings[0].detail,
      /auto-fix attempted and failed: fix failed because reasons/,
    );
  });

  it('returns findings in registry order even when detect() runs concurrently', async () => {
    // Story #2463: detect() runs via Promise.all. Promise.all preserves
    // input order on its resolved array, so even if probe `b` resolves
    // before probe `a`, the resulting findings[] still appears in [a, b, c]
    // registry order. We force `a` to resolve LAST to make the ordering
    // contract observable.
    const order = [];
    const resolvers = {};
    const finishedFirst = new Promise((r) => {
      resolvers.first = r;
    });
    const registry = [
      makeCheck({
        id: 'a',
        detect: async () => {
          // Wait for `b` to resolve before `a` finishes, proving order is
          // NOT defined by detection completion — Promise.all keeps the
          // findings array in registry order regardless.
          await finishedFirst;
          order.push('a');
          return makeFinding({ id: 'a', summary: 'a-found' });
        },
      }),
      makeCheck({
        id: 'b',
        detect: async () => {
          order.push('b');
          resolvers.first();
          return makeFinding({ id: 'b', summary: 'b-found' });
        },
      }),
      makeCheck({
        id: 'c',
        detect: async () => {
          order.push('c');
          return makeFinding({ id: 'c', summary: 'c-found' });
        },
      }),
    ];
    const result = await runChecks({
      scope: 'story-close',
      state: {},
      registry,
    });
    // Detection completion order proves concurrency: b finished before a.
    assert.equal(order[0], 'b', 'b detect() must complete before a');
    assert.equal(order[order.length - 1], 'a', 'a detect() resolves last');
    // Findings order matches registry order regardless of completion order.
    assert.deepEqual(
      result.findings.map((f) => f.id),
      ['a', 'b', 'c'],
    );
  });

  it('passes the same `state` object to every check', async () => {
    const state = { git: { headRef: 'story-1284' } };
    const seen = [];
    const registry = ['a', 'b'].map((id) =>
      makeCheck({
        id,
        detect: (s) => {
          seen.push(s);
          return null;
        },
      }),
    );
    await runChecks({ scope: 'story-close', state, registry });
    assert.strictEqual(seen[0], state);
    assert.strictEqual(seen[1], state);
  });

  it('detect() probes overlap in flight (concurrent phase, Story #2463)', async () => {
    // Spy on a shared "in-flight" counter. Two detect() probes increment
    // on entry and decrement on exit; if they truly run concurrently the
    // counter MUST observe a maximum value of >=2 at some point during
    // the race. The probes synchronize on a barrier promise so neither
    // can finish until BOTH have entered — this is the spy that proves
    // the runner does not await each detect() before starting the next.
    let inFlight = 0;
    let peakInFlight = 0;
    let bothEntered;
    const barrier = new Promise((r) => {
      bothEntered = r;
    });
    let enteredCount = 0;
    const observe = () => {
      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      enteredCount += 1;
      if (enteredCount === 2) bothEntered();
    };
    const registry = [
      makeCheck({
        id: 'detect-a',
        detect: async () => {
          observe();
          await barrier;
          inFlight -= 1;
          return null;
        },
      }),
      makeCheck({
        id: 'detect-b',
        detect: async () => {
          observe();
          await barrier;
          inFlight -= 1;
          return null;
        },
      }),
    ];
    await runChecks({ scope: 'story-close', state: {}, registry });
    assert.equal(
      peakInFlight,
      2,
      'two detect() probes must be in flight simultaneously',
    );
  });

  it('fix() probes remain strictly serial (mutation-phase invariant, Story #2463)', async () => {
    // Symmetric spy on the FIX phase. Each fix() increments the in-flight
    // counter on entry; the second fix() must not enter until the first
    // has resolved. We deliberately stall fix-a so fix-b CANNOT run
    // concurrently — if fix() were parallelized, peakInFlight would be 2
    // and the test would fail. The serial invariant locks peakInFlight=1.
    let inFlight = 0;
    let peakInFlight = 0;
    const seen = [];
    const stallA = () => new Promise((resolve) => setTimeout(resolve, 25));
    const registry = [
      makeCheck({
        id: 'fix-a',
        autoCorrect: 'auto',
        detect: () => makeFinding({ id: 'fix-a' }),
        fix: async () => {
          inFlight += 1;
          if (inFlight > peakInFlight) peakInFlight = inFlight;
          await stallA();
          seen.push('a-done');
          inFlight -= 1;
          return { ok: true, message: 'a fixed' };
        },
      }),
      makeCheck({
        id: 'fix-b',
        autoCorrect: 'auto',
        detect: () => makeFinding({ id: 'fix-b' }),
        fix: async () => {
          inFlight += 1;
          if (inFlight > peakInFlight) peakInFlight = inFlight;
          seen.push('b-start');
          inFlight -= 1;
          return { ok: true, message: 'b fixed' };
        },
      }),
    ];
    const result = await runChecks({
      scope: 'story-close',
      autoFix: true,
      state: {},
      registry,
    });
    assert.equal(
      peakInFlight,
      1,
      'fix() must run strictly serially — peak in-flight count must be 1',
    );
    // a finishes before b starts.
    assert.deepEqual(seen, ['a-done', 'b-start']);
    assert.equal(result.fixed.length, 2);
  });

  it('runs every registered check when scope is undefined', async () => {
    const seen = [];
    const registry = ['a', 'b'].map((id) =>
      makeCheck({
        id,
        scope: ['story-close', 'epic-deliver'],
        detect: () => {
          seen.push(id);
          return null;
        },
      }),
    );
    await runChecks({ state: {}, registry });
    assert.deepEqual(seen, ['a', 'b']);
  });
});

describe('loadRegistry + getCheck (discovery)', () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it('returns the canonical registry from the default directory', async () => {
    // The default registry may be empty at this Task's commit time — only
    // index.js + state.js exist. Either way the call must succeed.
    const registry = await loadRegistry();
    assert.ok(Array.isArray(registry));
  });

  it('returns an empty array (not a throw) when the directory does not exist', async () => {
    const registry = await loadRegistry({
      dir: '/nonexistent-path-does-not-exist-xyzzy-1284',
    });
    assert.deepEqual(registry, []);
  });

  it('getCheck(id) returns undefined for an unknown id without throwing', async () => {
    const check = await getCheck('totally-unknown-check-id-xyzzy');
    assert.equal(check, undefined);
  });
});
