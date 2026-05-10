import assert from 'node:assert';
import { test } from 'node:test';
import {
  compareCrap,
  evaluateBaselineCompatibility,
} from '../.agents/scripts/check-crap.js';
import { KERNEL_VERSION } from '../.agents/scripts/lib/crap-utils.js';

/**
 * Tests for the pure comparator and baseline-compatibility decision helper
 * that drive check-crap.js. Covers all four hybrid match paths plus the
 * missing-baseline and kernel/escomplex-mismatch outcomes (Story #791
 * retired the informational bootstrap exit-0 path; missing baseline now
 * fails closed).
 */

function makeCurrentRow(overrides = {}) {
  return {
    file: 'lib/a.js',
    method: 'doWork',
    startLine: 10,
    cyclomatic: 4,
    coverage: 0.8,
    crap: 4.032,
    ...overrides,
  };
}

function makeBaselineRow(overrides = {}) {
  return {
    file: 'lib/a.js',
    method: 'doWork',
    startLine: 10,
    crap: 4.0,
    ...overrides,
  };
}

test('compareCrap — exact match within tolerance passes (no regression)', () => {
  const current = [makeCurrentRow({ crap: 4.0005 })];
  const baseline = [makeBaselineRow({ crap: 4.0 })];
  const result = compareCrap({
    currentRows: current,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.regressions, 0);
  assert.strictEqual(result.newViolations, 0);
  assert.strictEqual(result.drifted, 0);
  assert.strictEqual(result.removed, 0);
  assert.deepStrictEqual(result.violations, []);
});

test('compareCrap — exact-match regression above tolerance fails', () => {
  const current = [makeCurrentRow({ crap: 12.5 })];
  const baseline = [makeBaselineRow({ crap: 4.0 })];
  const result = compareCrap({
    currentRows: current,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.regressions, 1);
  assert.strictEqual(result.newViolations, 0);
  assert.strictEqual(result.violations.length, 1);
  const [v] = result.violations;
  assert.strictEqual(v.kind, 'regression');
  assert.strictEqual(v.file, 'lib/a.js');
  assert.strictEqual(v.method, 'doWork');
  assert.strictEqual(v.baseline, 4.0);
  assert.strictEqual(v.crap, 12.5);
});

test('compareCrap — line-drift fallback (same file+method, shifted startLine) does not regress spuriously', () => {
  // Method moved from line 10 → line 25 with the same score. Should match via
  // line-drift fallback, count as drifted, and produce zero regressions.
  const current = [makeCurrentRow({ startLine: 25, crap: 4.0 })];
  const baseline = [makeBaselineRow({ startLine: 10, crap: 4.0 })];
  const result = compareCrap({
    currentRows: current,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.regressions, 0);
  assert.strictEqual(result.newViolations, 0);
  assert.strictEqual(result.drifted, 1);
  assert.strictEqual(result.removed, 0); // drifted match consumed the baseline row
  assert.deepStrictEqual(result.violations, []);
});

test('compareCrap — line-drift match still enforces no-regression', () => {
  const current = [makeCurrentRow({ startLine: 25, crap: 20.0 })];
  const baseline = [makeBaselineRow({ startLine: 10, crap: 4.0 })];
  const result = compareCrap({
    currentRows: current,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.regressions, 1);
  assert.strictEqual(result.drifted, 1);
  assert.strictEqual(result.violations.length, 1);
  assert.strictEqual(result.violations[0].kind, 'drifted-regression');
  assert.strictEqual(result.violations[0].baselineStartLine, 10);
});

test('compareCrap — line-drift picks the nearest-startLine baseline when duplicates exist', () => {
  // Two baselined methods of the same name in the same file — drifted match
  // should pair each current row with the closest un-seen candidate so a
  // reorder (sort / format change) doesn't cause spurious regressions.
  const baseline = [
    makeBaselineRow({ method: 'handle', startLine: 10, crap: 3.0 }),
    makeBaselineRow({ method: 'handle', startLine: 50, crap: 20.0 }),
  ];
  const current = [
    makeCurrentRow({ method: 'handle', startLine: 55, crap: 20.0 }),
    makeCurrentRow({ method: 'handle', startLine: 12, crap: 3.0 }),
  ];
  const result = compareCrap({
    currentRows: current,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.regressions, 0);
  assert.strictEqual(result.drifted, 2);
  assert.strictEqual(result.removed, 0);
});

test('compareCrap — reordering rows must not produce a regression (determinism)', () => {
  const baseline = [
    makeBaselineRow({ method: 'alpha', startLine: 10, crap: 4.0 }),
    makeBaselineRow({ method: 'beta', startLine: 30, crap: 5.0 }),
  ];
  const forward = [
    makeCurrentRow({ method: 'alpha', startLine: 10, crap: 4.0 }),
    makeCurrentRow({ method: 'beta', startLine: 30, crap: 5.0 }),
  ];
  const reversed = [forward[1], forward[0]];
  const a = compareCrap({
    currentRows: forward,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  const b = compareCrap({
    currentRows: reversed,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(a.regressions, 0);
  assert.strictEqual(b.regressions, 0);
  assert.strictEqual(a.newViolations, 0);
  assert.strictEqual(b.newViolations, 0);
});

test('compareCrap — new (unmatched) method at or below ceiling passes', () => {
  const current = [
    makeCurrentRow({ method: 'freshlyAdded', startLine: 99, crap: 25 }),
  ];
  const result = compareCrap({
    currentRows: current,
    baselineRows: [],
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.regressions, 0);
  assert.strictEqual(result.newViolations, 0);
});

test('compareCrap — new method over ceiling fails with kind=new', () => {
  const current = [
    makeCurrentRow({ method: 'freshlyAdded', startLine: 99, crap: 45.3 }),
  ];
  const result = compareCrap({
    currentRows: current,
    baselineRows: [],
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.regressions, 0);
  assert.strictEqual(result.newViolations, 1);
  assert.strictEqual(result.violations.length, 1);
  const [v] = result.violations;
  assert.strictEqual(v.kind, 'new');
  assert.strictEqual(v.baseline, null);
  assert.strictEqual(v.ceiling, 30);
});

test('compareCrap — baseline rows not seen in current scan are reported as removed (not failures)', () => {
  const baseline = [
    makeBaselineRow({ method: 'ghost', startLine: 200, crap: 6.0 }),
    makeBaselineRow({ method: 'present', startLine: 10, crap: 4.0 }),
  ];
  const current = [
    makeCurrentRow({ method: 'present', startLine: 10, crap: 4.0 }),
  ];
  const result = compareCrap({
    currentRows: current,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.regressions, 0);
  assert.strictEqual(result.newViolations, 0);
  assert.strictEqual(result.removed, 1);
  assert.strictEqual(result.removedRows.length, 1);
  assert.strictEqual(result.removedRows[0].method, 'ghost');
});

test('compareCrap — tolerance lets tiny floating-point drift slide', () => {
  const current = [makeCurrentRow({ crap: 4.0001 })];
  const baseline = [makeBaselineRow({ crap: 4.0 })];
  const result = compareCrap({
    currentRows: current,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.regressions, 0);
});

test('compareCrap — handles empty current with non-empty baseline (everything removed)', () => {
  const baseline = [
    makeBaselineRow({ method: 'gone', startLine: 10, crap: 4 }),
    makeBaselineRow({ method: 'alsoGone', startLine: 20, crap: 5 }),
  ];
  const result = compareCrap({
    currentRows: [],
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.removed, 2);
  assert.strictEqual(result.regressions, 0);
});

test('compareCrap — handles empty baseline + empty current cleanly', () => {
  const result = compareCrap({
    currentRows: [],
    baselineRows: [],
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.total, 0);
  assert.strictEqual(result.regressions, 0);
  assert.strictEqual(result.newViolations, 0);
  assert.strictEqual(result.removed, 0);
});

test('evaluateBaselineCompatibility — missing baseline fails closed (exit 1)', () => {
  const r = evaluateBaselineCompatibility({
    baseline: null,
    runningKernelVersion: KERNEL_VERSION,
    runningEscomplexVersion: '7.3.2',
    runningTsTranspilerVersion: '5.9.3',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.kind, 'missing-baseline');
  assert.match(r.message, /no baseline found/);
  assert.match(r.message, /npm run crap:update/);
  assert.match(r.message, /baseline-refresh:/);
});

test('evaluateBaselineCompatibility — kernel-version drift warns, does not fail (5.29.0)', () => {
  const r = evaluateBaselineCompatibility({
    baseline: {
      kernelVersion: '0.9.0',
      escomplexVersion: '7.3.2',
      tsTranspilerVersion: '5.9.3',
      rows: [],
    },
    runningKernelVersion: KERNEL_VERSION,
    runningEscomplexVersion: '7.3.2',
    runningTsTranspilerVersion: '5.9.3',
  });
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.warnings));
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /kernelVersion drift/);
  assert.match(r.warnings[0], /baseline=0\.9\.0/);
  assert.match(r.warnings[0], /npm run crap:update/);
  assert.match(r.warnings[0], /baseline-refresh:/);
});

test('evaluateBaselineCompatibility — escomplex-version mismatch fails closed (exit 1)', () => {
  const r = evaluateBaselineCompatibility({
    baseline: {
      kernelVersion: KERNEL_VERSION,
      escomplexVersion: '7.0.0',
      tsTranspilerVersion: '5.9.3',
      rows: [],
    },
    runningKernelVersion: KERNEL_VERSION,
    runningEscomplexVersion: '7.3.2',
    runningTsTranspilerVersion: '5.9.3',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.kind, 'escomplex-mismatch');
  assert.match(r.message, /scorer changed from 7\.0\.0 to 7\.3\.2/);
  assert.match(r.message, /npm run crap:update/);
});

test('evaluateBaselineCompatibility — tsTranspilerVersion drift warns, does not fail (5.29.0)', () => {
  const r = evaluateBaselineCompatibility({
    baseline: {
      kernelVersion: KERNEL_VERSION,
      escomplexVersion: '7.3.2',
      tsTranspilerVersion: '5.4.0',
      rows: [],
    },
    runningKernelVersion: KERNEL_VERSION,
    runningEscomplexVersion: '7.3.2',
    runningTsTranspilerVersion: '5.9.3',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /tsTranspilerVersion drift/);
  assert.match(r.warnings[0], /baseline=5\.4\.0/);
  assert.match(r.warnings[0], /running=5\.9\.3/);
  assert.match(r.warnings[0], /npm run crap:update/);
});

test('evaluateBaselineCompatibility — kernel 1.0.0 baseline (no tsTranspilerVersion field) warns once for kernel drift only', () => {
  // Simulates a consumer's first 5.29.0 run against a 1.0.0 baseline.
  // tsTranspilerVersion was absent in 1.0.0; getCrapBaseline backfills the
  // sentinel '0.0.0', which then triggers the second warning. Here we feed
  // the sentinel directly to mimic the post-load envelope.
  const r = evaluateBaselineCompatibility({
    baseline: {
      kernelVersion: '1.0.0',
      escomplexVersion: '7.3.2',
      tsTranspilerVersion: '0.0.0',
      rows: [],
    },
    runningKernelVersion: KERNEL_VERSION,
    runningEscomplexVersion: '7.3.2',
    runningTsTranspilerVersion: '5.9.3',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warnings.length, 2);
  assert.match(r.warnings[0], /kernelVersion drift/);
  assert.match(r.warnings[1], /tsTranspilerVersion drift/);
});

test('evaluateBaselineCompatibility — matching kernel + escomplex + ts returns ok with no warnings', () => {
  const r = evaluateBaselineCompatibility({
    baseline: {
      kernelVersion: KERNEL_VERSION,
      escomplexVersion: '7.3.2',
      tsTranspilerVersion: '5.9.3',
      rows: [],
    },
    runningKernelVersion: KERNEL_VERSION,
    runningEscomplexVersion: '7.3.2',
    runningTsTranspilerVersion: '5.9.3',
  });
  assert.deepStrictEqual(r, { ok: true, warnings: [] });
});

test('compareCrap — trivial (cyclomatic=1) methods are exempted from regression check (Node 22 instrumentation noise)', () => {
  // c=1 methods have no decision points; their CRAP score collapses to a
  // pure coverage proxy in [1, 2]. Single-statement wrappers like
  // `deleteComment(ctx, id)` flap between cov=1.00 (crap=1) and cov=0.17
  // (crap≈1.58) across Windows/Node 22 CI runs of identical source. The
  // gate should not regress on them — a real "regression" requires the
  // method to gain branches, at which point cyclomatic > 1.
  const current = [
    makeCurrentRow({
      file: '.agents/scripts/providers/github/comments.js',
      method: 'deleteComment',
      startLine: 25,
      cyclomatic: 1,
      coverage: 0.17,
      crap: 1.58,
    }),
  ];
  const baseline = [
    makeBaselineRow({
      file: '.agents/scripts/providers/github/comments.js',
      method: 'deleteComment',
      startLine: 25,
      crap: 1.0,
    }),
  ];
  const result = compareCrap({
    currentRows: current,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.05,
  });
  assert.strictEqual(result.regressions, 0);
  assert.strictEqual(result.violations.length, 0);
});

test('compareCrap — trivial method exemption only applies to c=1 (c=2 still regresses)', () => {
  // Guardrail: the exemption must not bleed into c≥2 methods. A method that
  // grew a branch (c=1 → c=2) and saw a CRAP jump is real signal.
  const current = [
    makeCurrentRow({ cyclomatic: 2, coverage: 0.17, crap: 4.5 }),
  ];
  const baseline = [makeBaselineRow({ crap: 1.0 })];
  const result = compareCrap({
    currentRows: current,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.05,
  });
  assert.strictEqual(result.regressions, 1);
  assert.strictEqual(result.violations[0].kind, 'regression');
});

test('compareCrap — drifted c=1 method does not regress on coverage flap', () => {
  // Same file+method, line shifted (drift fallback path). c=1 must still
  // be exempt from the regression check there.
  const current = [
    makeCurrentRow({
      cyclomatic: 1,
      coverage: 0.0,
      crap: 2.0,
      startLine: 42,
    }),
  ];
  const baseline = [makeBaselineRow({ crap: 1.0, startLine: 10 })];
  const result = compareCrap({
    currentRows: current,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.05,
  });
  assert.strictEqual(result.drifted, 1);
  assert.strictEqual(result.regressions, 0);
});
