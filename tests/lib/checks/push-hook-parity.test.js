import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/push-hook-parity.js';

/**
 * Tests for the `push-hook-parity` check (Task #1304 under Story #1286).
 * Drives `check.detect(state)` directly. The gate runs themselves belong
 * to `state.js`'s `gates.*` projection (under the `diagnose` scope) — this
 * test pre-builds a fixture `state.gates` and asserts the check's
 * interpretation of the pass/fail result.
 *
 * Contract under test:
 *   1. Returns a Finding with severity 'blocker' summarising which gate(s)
 *      would fail at push time.
 *   2. Returns null when both gates pass against HEAD.
 *   3. `fixCommand` cites the exact gate command(s) the operator should
 *      run locally.
 */

function makeState(gates, overrides = {}) {
  return {
    scope: 'diagnose',
    cwd: '/repo',
    git: {},
    fs: {},
    env: {},
    gates,
    ...overrides,
  };
}

describe('check: push-hook-parity', () => {
  it('exposes the expected contract metadata', () => {
    assert.equal(check.id, 'push-hook-parity');
    assert.equal(check.severity, 'blocker');
    assert.equal(check.autoCorrect, 'refuse-and-print');
    assert.ok(check.scope.includes('diagnose'));
    assert.equal(typeof check.detect, 'function');
    assert.equal(check.fix, undefined);
  });

  it('returns null when both gates pass', () => {
    const state = makeState({
      biome: { ok: true, output: '' },
      miGate: { ok: true, output: '' },
    });
    assert.equal(check.detect(state), null);
  });

  it('returns null when state has no gates projection (out-of-scope call)', () => {
    // Calling this check with a state object that has no gates key (e.g.
    // a story-close assembly) must return null rather than blow up.
    const state = makeState(undefined);
    assert.equal(check.detect(state), null);
  });

  it('returns a blocker Finding when only biome would fail', () => {
    const state = makeState({
      biome: { ok: false, output: 'biome: 3 errors in lib/foo.js' },
      miGate: { ok: true, output: '' },
    });
    const finding = check.detect(state);
    assert.ok(finding);
    assert.equal(finding.id, 'push-hook-parity');
    assert.equal(finding.severity, 'blocker');
    assert.ok(finding.summary.includes('biome'));
    assert.ok(!finding.summary.includes('miGate'));
    assert.ok(finding.detail.includes('3 errors in lib/foo.js'));
  });

  it('returns a blocker Finding when only MI gate would fail', () => {
    const state = makeState({
      biome: { ok: true, output: '' },
      miGate: { ok: false, output: 'MI baseline regression: lib/bar.js' },
    });
    const finding = check.detect(state);
    assert.ok(finding);
    assert.ok(finding.summary.includes('miGate'));
    assert.ok(!finding.summary.includes('biome'));
    assert.ok(finding.detail.includes('MI baseline regression'));
  });

  it('returns a blocker Finding listing BOTH gates when both fail', () => {
    const state = makeState({
      biome: { ok: false, output: 'biome failure' },
      miGate: { ok: false, output: 'MI failure' },
    });
    const finding = check.detect(state);
    assert.ok(finding);
    assert.ok(finding.summary.includes('biome'));
    assert.ok(finding.summary.includes('miGate'));
    assert.ok(finding.detail.includes('biome failure'));
    assert.ok(finding.detail.includes('MI failure'));
  });

  it('fixCommand cites the exact biome gate command', () => {
    const state = makeState({
      biome: { ok: false, output: 'x' },
      miGate: { ok: true, output: '' },
    });
    const finding = check.detect(state);
    assert.ok(finding);
    assert.ok(finding.fixCommand.includes('biome check'));
  });

  it('fixCommand cites the exact MI gate command', () => {
    const state = makeState({
      biome: { ok: true, output: '' },
      miGate: { ok: false, output: 'x' },
    });
    const finding = check.detect(state);
    assert.ok(finding);
    assert.ok(finding.fixCommand.includes('check:maintainability'));
  });

  it('fixCommand chains both gate commands with && when both fail', () => {
    const state = makeState({
      biome: { ok: false, output: 'x' },
      miGate: { ok: false, output: 'y' },
    });
    const finding = check.detect(state);
    assert.ok(finding);
    assert.ok(finding.fixCommand.includes('&&'));
    assert.ok(finding.fixCommand.includes('biome check'));
    assert.ok(finding.fixCommand.includes('check:maintainability'));
  });
});
