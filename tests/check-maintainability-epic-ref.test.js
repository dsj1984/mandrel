import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { clearBaselineCache } from '../.agents/scripts/lib/baseline-loader.js';
import { loadMaintainabilityBaseline } from '../.agents/scripts/lib/baselines/kinds/maintainability.js';
import { buildDefaultGates } from '../.agents/scripts/lib/close-validation.js';

/**
 * Story #1120 — assert that check-maintainability reads its baseline at
 * `epic/<id>` HEAD via baseline-loader, not via a fs read of whatever
 * `baselines/maintainability.json` happens to be on the working tree.
 */

describe('check-maintainability — --epic-ref (Story #1120)', () => {
  afterEach(() => {
    clearBaselineCache();
  });

  it('loadMaintainabilityBaseline calls the fs reader when no epicRef is set (legacy path)', () => {
    let fsCalls = 0;
    let refCalls = 0;
    const out = loadMaintainabilityBaseline({
      baselinePath: 'baselines/maintainability.json',
      epicRef: null,
      readBaseline: (p) => {
        fsCalls += 1;
        assert.equal(p, 'baselines/maintainability.json');
        return { 'foo.js': 80 };
      },
      readAtRef: () => {
        refCalls += 1;
        return {};
      },
    });
    assert.equal(fsCalls, 1);
    assert.equal(refCalls, 0);
    assert.deepEqual(out, { 'foo.js': 80 });
  });

  it('loadMaintainabilityBaseline reads at the supplied ref instead of fs when epicRef is set', () => {
    let fsCalls = 0;
    let refCalls = 0;
    const out = loadMaintainabilityBaseline({
      baselinePath: 'baselines/maintainability.json',
      epicRef: 'epic/1114',
      readBaseline: () => {
        fsCalls += 1;
        return { 'foo.js': 999 }; // would-be-stale main-checkout value
      },
      readAtRef: (ref, p) => {
        refCalls += 1;
        assert.equal(ref, 'epic/1114');
        assert.equal(p, 'baselines/maintainability.json');
        return { 'foo.js': 80 };
      },
    });
    assert.equal(fsCalls, 0, 'fs read must not happen when epic ref is set');
    assert.equal(refCalls, 1);
    assert.deepEqual(
      out,
      { 'foo.js': 80 },
      'gate must compare against the epic-ref baseline, not the working-tree file',
    );
  });

  it('loadMaintainabilityBaseline falls back to fs when the ref read throws', () => {
    let warnings = 0;
    const out = loadMaintainabilityBaseline({
      baselinePath: 'baselines/maintainability.json',
      epicRef: 'epic/1114',
      readBaseline: () => ({ 'foo.js': 80 }),
      readAtRef: () => {
        throw new Error('git unavailable');
      },
      logger: {
        warn: () => {
          warnings += 1;
        },
      },
    });
    assert.equal(warnings, 1, 'a warning must be logged on fallback');
    assert.deepEqual(out, { 'foo.js': 80 });
  });

  it('buildDefaultGates threads epic ref into the maintainability gate args', () => {
    const gates = buildDefaultGates({ epicBranch: 'epic/1114' });
    const mi = gates.find((g) => g.name === 'check-maintainability');
    assert.ok(mi, 'maintainability gate must exist');
    assert.deepEqual(mi.args, [
      '.agents/scripts/check-maintainability.js',
      '--epic-ref',
      'epic/1114',
    ]);
  });

  it('buildDefaultGates omits --epic-ref when no epic branch is supplied (legacy)', () => {
    const gates = buildDefaultGates({});
    const mi = gates.find((g) => g.name === 'check-maintainability');
    assert.deepEqual(mi.args, ['.agents/scripts/check-maintainability.js']);
  });
});
