import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildInProcessBaselineGate } from '../../../../.agents/scripts/lib/close-validation/in-process-baseline-gate.js';

// ---------------------------------------------------------------------------
// Story #2012 — close-validation regression test for the in-process MI compare.
//
// Story #1973 / Task #1984 migrated the maintainability gate off the
// `check-maintainability.js` CLI and onto an in-process `compare(head, base)`
// call against the per-kind module. The migration carried over a latent
// defect: new files (head row that base lacks) inherited `base.mi = 100`
// and any real-world MI under 100 (essentially every file) flipped to a
// regression — blocking close-validation on every Story that introduced
// new source files.
//
// This test pins the fix end-to-end at the gate boundary:
//   - new file with MI 70 → gate passes (status 0, additions, not regression)
//   - new file with MI 22 → gate STILL passes (floor enforcement is the
//                            unified `check-baselines` gate's job; the
//                            in-process compare arm must not double-report
//                            it as a regression)
//   - existing file MI 80 → 60 → gate fails (status 1) — proves the gate
//                            still fires on real per-file regressions.
// ---------------------------------------------------------------------------

function makeBaselineEnvelope(rows) {
  return {
    $schema: 'https://example.invalid/maintainability.schema.json',
    kernelVersion: '0.0.0',
    generatedAt: '2026-05-16T00:00:00.000Z',
    rollup: {},
    rows,
  };
}

function buildGate({ headRows, baseRows }) {
  return buildInProcessBaselineGate({
    kind: 'maintainability',
    epicBranch: 'main',
    agentSettings: {},
    loadHeadBaseline: () => makeBaselineEnvelope(headRows),
    readBaseFromGit: () => JSON.stringify(makeBaselineEnvelope(baseRows)),
  });
}

describe('in-process MI gate — new files no longer count as regressions (Story #2012)', () => {
  it('a Story that adds a single new file with MI 70 passes the gate', async () => {
    const captured = [];
    const gate = buildGate({
      headRows: [{ path: 'lib/baselines/preview-gates.js', mi: 70 }],
      baseRows: [],
    });
    const result = await gate(null, null, {
      cwd: '/tmp/repo',
      log: (m) => captured.push(m),
    });
    assert.equal(result.status, 0);
    // The fix-pinning assertion: no regression line was emitted for the
    // new file. If the gate had treated the new file as a -30 MI drop, a
    // "[maintainability] 1 regression(s) detected:" line would surface
    // here.
    const regressionLine = captured.find((m) =>
      /regression\(s\) detected/.test(m),
    );
    assert.equal(
      regressionLine,
      undefined,
      `gate must not log a regression line for a new file; saw: ${regressionLine}`,
    );
  });

  it('a new file with MI 22 (well below any reasonable floor) still passes the compare gate', async () => {
    // The floor (default 70 for `.agents/scripts/**`) is enforced by the
    // unified `check-baselines` gate, not by the in-process compare arm.
    // The compare arm's only job is regression-vs-base classification;
    // an absolute-floor breach surfaces elsewhere with the correct
    // "absolute MI floor violated" message, not as a "regression".
    const gate = buildGate({
      headRows: [{ path: 'lib/new-low-mi.js', mi: 22 }],
      baseRows: [],
    });
    const result = await gate(null, null, {
      cwd: '/tmp/repo',
      log: () => {},
    });
    assert.equal(result.status, 0);
  });

  it('a genuine regression on an existing file (MI 80 → 60) still fires the gate', async () => {
    const captured = [];
    const gate = buildGate({
      headRows: [{ path: 'lib/existing.js', mi: 60 }],
      baseRows: [{ path: 'lib/existing.js', mi: 80 }],
    });
    const result = await gate(null, null, {
      cwd: '/tmp/repo',
      log: (m) => captured.push(m),
    });
    assert.equal(result.status, 1);
    const regressionLine = captured.find((m) =>
      /regression\(s\) detected/.test(m),
    );
    assert.ok(
      regressionLine,
      'expected the gate to log a regression line for the existing-file MI drop',
    );
  });

  it('mixed payload (one new file + one real regression) reports only the real regression', async () => {
    const gate = buildGate({
      headRows: [
        { path: 'lib/new.js', mi: 55 },
        { path: 'lib/existing.js', mi: 65 },
      ],
      baseRows: [{ path: 'lib/existing.js', mi: 80 }],
    });
    const result = await gate(null, null, {
      cwd: '/tmp/repo',
      log: () => {},
    });
    assert.equal(result.status, 1);
  });
});
