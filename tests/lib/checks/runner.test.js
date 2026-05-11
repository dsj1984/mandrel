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
        scope: ['epic-close'],
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

  it('serializes checks (no Promise.all) — ordering preserved', async () => {
    const seen = [];
    const registry = ['a', 'b', 'c'].map((id) =>
      makeCheck({
        id,
        detect: async () => {
          seen.push(id);
          return null;
        },
      }),
    );
    await runChecks({ scope: 'story-close', state: {}, registry });
    assert.deepEqual(seen, ['a', 'b', 'c']);
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

  it('runs every registered check when scope is undefined', async () => {
    const seen = [];
    const registry = ['a', 'b'].map((id) =>
      makeCheck({
        id,
        scope: ['story-close', 'epic-close'],
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
