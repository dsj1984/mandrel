import assert from 'node:assert';
import { test } from 'node:test';
import {
  axisToleranceFor,
  buildScopePredicate,
  COVERAGE_TOLERANCE,
  compareScores,
  readArtifactCaptureScope,
  readBaseline,
  readCoverageFinal,
  resolveCoverageRefreshScope,
  scoreCoverageFinal,
  scoreEntry,
  writeBaseline,
} from '../.agents/scripts/lib/coverage-baseline.js';

/**
 * Tests for the denominator-aware coverage tolerance introduced to absorb
 * single-instrumentation-event flap on tiny files under Windows/Node 22 CI.
 * The baseline tolerance (`COVERAGE_TOLERANCE`) stays at 0.01% — what
 * changes is that small-denominator files now get up to one event of slack
 * (100/N percentage points) per axis.
 */

test('axisToleranceFor — small denominator gets one-event headroom', () => {
  // 5 branches → one event = 20 percentage points
  assert.strictEqual(axisToleranceFor(5), 20);
  // 10 branches → 10 percentage points
  assert.strictEqual(axisToleranceFor(10), 10);
});

test('axisToleranceFor — large denominator falls back to base tolerance', () => {
  // 100k branches → 0.001 percentage points, way under the 0.01 floor.
  assert.strictEqual(axisToleranceFor(100_000), COVERAGE_TOLERANCE);
});

test('axisToleranceFor — zero or invalid denominator returns base tolerance', () => {
  assert.strictEqual(axisToleranceFor(0), COVERAGE_TOLERANCE);
  assert.strictEqual(axisToleranceFor(undefined), COVERAGE_TOLERANCE);
  assert.strictEqual(axisToleranceFor(-1), COVERAGE_TOLERANCE);
});

test('compareScores — single-event branch flap on a small-denominator file is absorbed', () => {
  // File with 49 branches: one branch flipping covered→uncovered = 2.04%
  // drop. Pre-fix this tripped the gate (tolerance 0.01); post-fix it sits
  // inside the 100/49 ≈ 2.04% per-axis tolerance and passes.
  const current = {
    'lib/x.js': {
      lines: 95.26,
      branches: 75.0, // was 77.04 in baseline = 1 branch flipped
      functions: 89.47,
      denominators: { lines: 200, branches: 49, functions: 19 },
    },
  };
  const baseline = {
    'lib/x.js': { lines: 95.26, branches: 77.04, functions: 89.47 },
  };
  const result = compareScores(current, baseline);
  assert.strictEqual(result.regressions.length, 0);
});

test('compareScores — two-event branch drop on the same file IS a regression', () => {
  // Same file as above, but now branches dropped by ~4.08% (two events
  // worth). That's beyond the noise floor and must surface.
  const current = {
    'lib/x.js': {
      lines: 95.26,
      branches: 72.96, // 77.04 - 4.08 = two branches flipped
      functions: 89.47,
      denominators: { lines: 200, branches: 49, functions: 19 },
    },
  };
  const baseline = {
    'lib/x.js': { lines: 95.26, branches: 77.04, functions: 89.47 },
  };
  const result = compareScores(current, baseline);
  assert.strictEqual(result.regressions.length, 1);
  assert.strictEqual(result.regressions[0].drops[0].axis, 'branches');
});

test('compareScores — large file with sub-percent flap is unaffected by the new tolerance', () => {
  // High-denominator file: 1000 branches. Per-event resolution is 0.1%, so
  // the floor is COVERAGE_TOLERANCE (0.01). A 0.5% drop must still regress.
  const current = {
    'lib/big.js': {
      lines: 95.0,
      branches: 84.5, // was 85.0 = 0.5% drop on a 1000-branch file = 5 events
      functions: 100,
      denominators: { lines: 5000, branches: 1000, functions: 200 },
    },
  };
  const baseline = {
    'lib/big.js': { lines: 95.0, branches: 85.0, functions: 100 },
  };
  const result = compareScores(current, baseline);
  assert.strictEqual(result.regressions.length, 1);
});

test('compareScores — files without denominators fall back to base tolerance (legacy callers)', () => {
  // Older code paths (or hand-built test fixtures) that don't carry the
  // `denominators` field must still behave correctly under the strict
  // base tolerance.
  const current = {
    'lib/legacy.js': { lines: 90, branches: 80, functions: 100 },
  };
  const baseline = {
    'lib/legacy.js': { lines: 90, branches: 81, functions: 100 },
  };
  const result = compareScores(current, baseline);
  assert.strictEqual(result.regressions.length, 1); // 1% drop > 0.01 base tolerance
});

test('scoreEntry — exposes denominators alongside percentages', () => {
  const entry = {
    s: { 0: 1, 1: 0, 2: 1 },
    b: { 0: [1, 0], 1: [1, 1] },
    f: { 0: 1, 1: 0 },
  };
  const scored = scoreEntry(entry);
  assert.strictEqual(scored.lines, 66.67);
  assert.strictEqual(scored.branches, 75);
  assert.strictEqual(scored.functions, 50);
  assert.deepStrictEqual(scored.denominators, {
    lines: 3,
    branches: 4,
    functions: 2,
  });
});

test('scoreEntry — null axes when denominators are zero (file with no functions/branches)', () => {
  const entry = { s: { 0: 1 }, b: {}, f: {} };
  const scored = scoreEntry(entry);
  assert.strictEqual(scored.lines, 100);
  assert.strictEqual(scored.branches, null);
  assert.strictEqual(scored.functions, null);
});

test('scoreEntry — empty entry returns null axes and zero denominators', () => {
  const scored = scoreEntry({});
  assert.deepStrictEqual(scored, {
    lines: null,
    branches: null,
    functions: null,
    denominators: { lines: 0, branches: 0, functions: 0 },
  });
});

test('buildScopePredicate — empty include matches everything; exclude wins', () => {
  const allOpen = buildScopePredicate({});
  assert.strictEqual(allOpen('any/path.js'), true);
  const excl = buildScopePredicate({
    include: ['lib/**'],
    exclude: ['lib/skip.js'],
  });
  assert.strictEqual(excl('lib/foo.js'), true);
  assert.strictEqual(excl('lib/skip.js'), false);
  assert.strictEqual(excl('app/foo.js'), false);
});

test('buildScopePredicate — Windows paths normalised to forward-slash', () => {
  const inLib = buildScopePredicate({ include: ['lib/**'] });
  assert.strictEqual(inLib('lib\\foo\\bar.js'), true);
});

test('scoreCoverageFinal — relativises absolute paths and applies scope', () => {
  const cwd = '/repo';
  const raw = {
    '/repo/lib/keep.js': { s: { 0: 1 }, b: {}, f: {} },
    '/repo/lib/skip.js': { s: { 0: 1 }, b: {}, f: {} },
    '/repo/other.js': { s: { 0: 1 }, b: {}, f: {} },
  };
  const scope = buildScopePredicate({
    include: ['lib/**'],
    exclude: ['lib/skip.js'],
  });
  const out = scoreCoverageFinal({ raw, cwd, scope });
  assert.deepStrictEqual(Object.keys(out), ['lib/keep.js']);
});

test('readCoverageFinal — throws helpful error when file missing', () => {
  const fakeFs = { existsSync: () => false };
  assert.throws(
    () => readCoverageFinal('/nope', fakeFs),
    /coverage-final.json not found/,
  );
});

test('readBaseline — returns null when file missing (vs {})', () => {
  const fakeFs = { existsSync: () => false };
  assert.strictEqual(readBaseline('/nope', fakeFs), null);
});

test('readBaseline — parses JSON when file exists', () => {
  const payload = '{"foo.js":{"lines":99}}';
  const fakeFs = {
    existsSync: () => true,
    readFileSync: () => payload,
  };
  assert.deepStrictEqual(readBaseline('/cwd', fakeFs), {
    'foo.js': { lines: 99 },
  });
});

test('readBaseline — projects an envelope-shape baseline back to the flat map', () => {
  const envelopeJson = JSON.stringify({
    $schema: '.agents/schemas/baselines/coverage.schema.json',
    kernelVersion: '1.0.0',
    generatedAt: '2026-05-15T00:00:00Z',
    rollup: { '*': { lines: 90, branches: 80, functions: 100 } },
    rows: [
      { path: 'src/a.js', lines: 91, branches: 80, functions: 100 },
      { path: 'src/b.js', lines: 70, branches: 50, functions: 80 },
    ],
  });
  const fakeFs = {
    existsSync: () => true,
    readFileSync: () => envelopeJson,
  };
  const result = readBaseline('/cwd', fakeFs);
  assert.deepStrictEqual(result, {
    'src/a.js': { lines: 91, branches: 80, functions: 100 },
    'src/b.js': { lines: 70, branches: 50, functions: 80 },
  });
});

test('readBaseline — skips envelope rows with non-string path', () => {
  const envelopeJson = JSON.stringify({
    $schema: '.agents/schemas/baselines/coverage.schema.json',
    kernelVersion: '1.0.0',
    generatedAt: '2026-05-15T00:00:00Z',
    rollup: { '*': { lines: 90, branches: 80, functions: 100 } },
    rows: [
      { path: 'src/a.js', lines: 91, branches: 80, functions: 100 },
      { path: 123, lines: 0, branches: 0, functions: 0 },
      null,
    ],
  });
  const fakeFs = {
    existsSync: () => true,
    readFileSync: () => envelopeJson,
  };
  const result = readBaseline('/cwd', fakeFs);
  assert.deepStrictEqual(result, {
    'src/a.js': { lines: 91, branches: 80, functions: 100 },
  });
});

test('readBaseline — passes through a non-envelope JSON value (array)', () => {
  const payload = JSON.stringify(['a', 'b']);
  const fakeFs = {
    existsSync: () => true,
    readFileSync: () => payload,
  };
  // Array shape is preserved (legacy / corrupted baseline — pass through).
  assert.deepStrictEqual(readBaseline('/cwd', fakeFs), ['a', 'b']);
});

test('writeBaseline — strips denominators and produces an envelope with sorted rows', () => {
  let written = null;
  const fakeFs = {
    mkdirSync: () => {},
    writeFileSync: (_path, content) => {
      written = content;
    },
  };
  const baseline = {
    'z.js': {
      lines: 90,
      branches: 80,
      functions: 100,
      denominators: { lines: 10, branches: 5, functions: 2 },
    },
    'a.js': { lines: 50, branches: 50, functions: 50 },
  };
  writeBaseline('/cwd', baseline, fakeFs);
  const parsed = JSON.parse(written);
  // Story #1891: envelope-shape baseline. The reader projects it back to
  // the flat `{ file: { ... } }` shape for legacy consumers.
  assert.ok(Array.isArray(parsed.rows));
  assert.deepStrictEqual(
    parsed.rows.map((r) => r.path),
    ['a.js', 'z.js'],
  );
  const zRow = parsed.rows.find((r) => r.path === 'z.js');
  assert.strictEqual(zRow.lines, 90);
  assert.strictEqual(zRow.branches, 80);
  assert.strictEqual(zRow.functions, 100);
  assert.strictEqual('denominators' in zRow, false);
});

test('compareScores — newFiles array populated when current has files missing from baseline', () => {
  const current = { 'new.js': { lines: 80, branches: 70, functions: 90 } };
  const baseline = {};
  const result = compareScores(current, baseline);
  assert.strictEqual(result.newFiles.length, 1);
  assert.strictEqual(result.newFiles[0].file, 'new.js');
});

test('compareScores — removedFiles populated when baseline has files missing from current', () => {
  const current = {};
  const baseline = { 'gone.js': { lines: 100, branches: 100, functions: 100 } };
  const result = compareScores(current, baseline);
  assert.strictEqual(result.removedFiles.length, 1);
  assert.strictEqual(result.removedFiles[0].file, 'gone.js');
});

test('compareScores — improvements surfaced when every axis ≥ baseline + tolerance', () => {
  const current = {
    'foo.js': {
      lines: 95,
      branches: 90,
      functions: 100,
      denominators: { lines: 1000, branches: 1000, functions: 1000 },
    },
  };
  const baseline = { 'foo.js': { lines: 90, branches: 85, functions: 95 } };
  const result = compareScores(current, baseline);
  assert.strictEqual(result.improvements.length, 1);
  assert.strictEqual(result.regressions.length, 0);
});

test('compareScores — null axes are no-ops (skipped, not regressions)', () => {
  const current = {
    'foo.js': { lines: 100, branches: null, functions: null },
  };
  const baseline = { 'foo.js': { lines: 100, branches: 80, functions: 90 } };
  const result = compareScores(current, baseline);
  assert.strictEqual(result.regressions.length, 0);
});

// Story #5472 — an `affected` artifact measures only what the scoped run
// instrumented, so an absent baseline row is unmeasured, not removed.
const FULL = { lines: 100, branches: 100, functions: 100 };

test('compareScores AC-5 — affected artifact: unmeasured baseline rows are not removed files', () => {
  const current = { 'a.js': FULL };
  const baseline = { 'a.js': FULL, 'untouched.js': FULL };
  const result = compareScores(current, baseline, undefined, {
    artifactScope: 'affected',
    changedFiles: ['a.js'],
  });
  assert.deepStrictEqual(result.removedFiles, []);
  assert.deepStrictEqual(result.newFiles, []);
});

test('compareScores AC-6 — affected artifact: a changed file it did not measure fails as new', () => {
  const baseline = { 'changed.js': FULL };
  const result = compareScores({}, baseline, undefined, {
    artifactScope: 'affected',
    changedFiles: ['changed.js', 'brand-new.js'],
  });
  assert.deepStrictEqual(
    result.newFiles.map((f) => f.file),
    ['changed.js', 'brand-new.js'],
  );
  assert.strictEqual(result.newFiles[0].reason, 'unmeasured');
  assert.deepStrictEqual(result.removedFiles, []);
});

test('compareScores — a full artifact keeps reporting absent rows as removed', () => {
  const result = compareScores({}, { 'gone.js': FULL }, undefined, {
    artifactScope: 'full',
    changedFiles: ['gone.js'],
  });
  assert.deepStrictEqual(result.removedFiles, [{ file: 'gone.js' }]);
  assert.deepStrictEqual(result.newFiles, []);
});

test('readArtifactCaptureScope — reads the stamp scope, full when absent or unscoped', () => {
  const stampFs = (body) => ({
    readFileSync: () => {
      if (body === null) throw new Error('ENOENT');
      return body;
    },
  });
  const read = (body) =>
    readArtifactCaptureScope('/cwd', undefined, stampFs(body));
  assert.strictEqual(read(JSON.stringify({ scope: 'affected' })), 'affected');
  assert.strictEqual(read(JSON.stringify({ digest: 'x' })), 'full');
  assert.strictEqual(read(null), 'full');
});

test('writeBaseline AC-5 — a write scoped to measured rows leaves unmeasured rows in place', () => {
  let written = null;
  const fakeFs = {
    mkdirSync: () => {},
    writeFileSync: (_p, body) => {
      written = body;
    },
    readFileSync: () => {
      throw new Error('unused: prior is passed');
    },
  };
  const prior = [
    { path: 'a.js', lines: 50, branches: 50, functions: 50 },
    { path: 'untouched.js', lines: 80, branches: 80, functions: 80 },
  ];
  writeBaseline('/cwd', { 'a.js': FULL }, fakeFs, {
    prior,
    scope: {
      mode: 'diff',
      files: new Set(['a.js']),
    },
  });
  const rows = JSON.parse(written).rows;
  assert.deepStrictEqual(
    rows.map((r) => [r.path, r.lines]),
    [
      ['a.js', 100],
      ['untouched.js', 80],
    ],
  );
});

test('resolveCoverageRefreshScope AC-5 — an affected artifact narrows every refresh to measured rows', async () => {
  const base = {
    cwd: '/cwd',
    listMeasured: () => ['a.js', 'b.js'],
    deriveDiffFiles: async () => ['a.js', 'skipped.js'],
  };
  const affected = { ...base, readCaptureScope: () => 'affected' };
  assert.deepStrictEqual(
    await resolveCoverageRefreshScope({
      ...affected,
      fullScope: true,
      diffScopeRef: null,
    }),
    { scopeFiles: ['a.js', 'b.js'] },
  );
  assert.deepStrictEqual(
    await resolveCoverageRefreshScope({
      ...affected,
      fullScope: false,
      diffScopeRef: null,
    }),
    { scopeFiles: ['a.js'] },
  );
  const full = { ...base, readCaptureScope: () => 'full' };
  assert.deepStrictEqual(
    await resolveCoverageRefreshScope({
      ...full,
      fullScope: true,
      diffScopeRef: null,
    }),
    { fullScope: true },
  );
  assert.deepStrictEqual(
    await resolveCoverageRefreshScope({
      ...full,
      fullScope: false,
      diffScopeRef: 'origin/x',
    }),
    { baseRef: 'origin/x' },
  );
  assert.deepStrictEqual(
    await resolveCoverageRefreshScope({
      ...full,
      fullScope: false,
      diffScopeRef: null,
    }),
    {},
  );
});
