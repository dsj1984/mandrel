import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, test } from 'node:test';
import {
  assessComparisonBasis,
  compareCrap,
  projectRow,
} from '../../.agents/scripts/lib/baselines/kinds/crap.js';
import { coverageForMethodInEntry } from '../../.agents/scripts/lib/coverage-utils.js';
import {
  COORDINATE_ORIGINAL,
  COORDINATE_TRANSPILED,
  calculateCrapForSource,
  finalizeMethodRows,
} from '../../.agents/scripts/lib/crap-engine.js';
import {
  checkResolutionFloor,
  scanAndScore,
} from '../../.agents/scripts/lib/crap-utils.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  prepareSourceForScoring,
  transpileIfNeeded,
} from '../../.agents/scripts/lib/transpile.js';

/**
 * Story #4775 — the per-method coverage join, in ONE coordinate system.
 *
 * escomplex reports each method's `lineStart` against the code it parsed,
 * which for a TypeScript source is the TRANSPILED output. istanbul's `fnMap`
 * is keyed against the ORIGINAL source. Before this Story the join compared
 * the two by exact equality, so a TS repo resolved ~5% of its methods — and
 * the ~5% that did "resolve" were numeric collisions joining a method to an
 * unrelated function's coverage. Both halves of the fix are required and are
 * asserted separately here:
 *
 *   1. **Remap** — `transpileIfNeeded(…, {withLineMap: true})` returns a
 *      transpiled → original line resolver, so the lookup happens in the
 *      coverage entry's own coordinates.
 *   2. **Tolerant match** — remapped starts land within ±1 of the `fnMap`
 *      declaration line, so equality is replaced by containment with a
 *      bounded nearest-decl fallback.
 */

function mkTmp() {
  return makeTempDir('crap_smjoin_');
}

function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

// Two interfaces and a type alias ahead of the code: elision guarantees the
// transpiled coordinates diverge from the source's by several lines, which is
// exactly the condition the old exact-equality join could not survive.
const TS_SOURCE = `interface Options {
  retries: number;
  verbose: boolean;
}

type Result = { ok: boolean };

export function classify(n: number): Result {
  if (n > 10) {
    return { ok: true };
  }
  if (n < 0) {
    return { ok: false };
  }
  return { ok: n === 0 };
}

export function retry(opts: Options): number {
  let count = 0;
  while (count < opts.retries) {
    count += 1;
  }
  return count;
}
`;

const CLASSIFY_SOURCE_LINE = 8;
const RETRY_SOURCE_LINE = 18;

/**
 * Build a coverage entry keyed at REAL source lines — the only thing a real
 * `coverage-final.json` can contain. `declOffset` shifts every `decl` line by
 * a fixed amount so the ±1 disagreement between escomplex's method start and
 * istanbul's declaration line can be exercised deliberately.
 */
function coverageEntry(absPath, { declOffset = 0 } = {}) {
  const statementMap = {};
  const s = {};
  let id = 0;
  const addStatements = (from, to, hit) => {
    for (let line = from; line <= to; line += 1) {
      statementMap[String(id)] = {
        start: { line, column: 0 },
        end: { line, column: 20 },
      };
      s[String(id)] = hit ? 1 : 0;
      id += 1;
    }
  };
  // classify: fully covered. retry: entirely uncovered.
  addStatements(CLASSIFY_SOURCE_LINE + 1, CLASSIFY_SOURCE_LINE + 7, true);
  addStatements(RETRY_SOURCE_LINE + 1, RETRY_SOURCE_LINE + 5, false);

  const fn = (name, startLine, endLine) => ({
    name,
    decl: { start: { line: startLine + declOffset, column: 0 } },
    loc: {
      start: { line: startLine, column: 0 },
      end: { line: endLine, column: 1 },
    },
  });

  return {
    [absPath]: {
      path: absPath,
      fnMap: {
        0: fn('classify', CLASSIFY_SOURCE_LINE, CLASSIFY_SOURCE_LINE + 8),
        1: fn('retry', RETRY_SOURCE_LINE, RETRY_SOURCE_LINE + 6),
      },
      f: { 0: 1, 1: 0 },
      statementMap,
      s,
      branchMap: {},
      b: {},
    },
  };
}

async function scanFixture(dir, coverage) {
  return scanAndScore({
    targetDirs: [dir],
    coverage,
    requireCoverage: true,
    cwd: dir,
  });
}

describe('transpileIfNeeded — line mapping (AC-1)', () => {
  it('returns an original-source line mapping for a TS input', () => {
    const prepared = transpileIfNeeded('mod.ts', TS_SOURCE, {
      withLineMap: true,
    });
    assert.equal(typeof prepared.code, 'string');
    assert.equal(typeof prepared.mapLine, 'function');
    // The interfaces are elided, so the transpiled coordinates MUST differ
    // from the source's — otherwise this fixture proves nothing.
    const transpiledClassify =
      prepared.code
        .split('\n')
        .findIndex((l) => l.includes('function classify')) + 1;
    assert.notEqual(transpiledClassify, CLASSIFY_SOURCE_LINE);
    assert.equal(prepared.mapLine(transpiledClassify), CLASSIFY_SOURCE_LINE);
  });

  it('leaves JS a passthrough with no map and no behaviour change', () => {
    const js = 'export function a(x) { return x + 1; }\n';
    assert.equal(transpileIfNeeded('mod.js', js), js);
    const prepared = transpileIfNeeded('mod.js', js, { withLineMap: true });
    assert.equal(prepared.code, js);
    assert.equal(
      prepared.mapLine,
      null,
      'JS coordinates ARE original coordinates — no remap, no mapping cost',
    );
  });

  it('emits code byte-identical to the map-less transpile', () => {
    // The MI path never asks for a map. If requesting one changed the emitted
    // code by so much as the trailing sourceMappingURL comment, every
    // maintainability score for a TS tree would move (AC-9).
    const withMap = transpileIfNeeded('mod.ts', TS_SOURCE, {
      withLineMap: true,
    });
    assert.equal(withMap.code, transpileIfNeeded('mod.ts', TS_SOURCE));
  });

  it('resolves an unmappable line to null rather than guessing', () => {
    const prepared = transpileIfNeeded('mod.ts', TS_SOURCE, {
      withLineMap: true,
    });
    assert.equal(prepared.mapLine(100_000), null);
    assert.equal(prepared.mapLine(0), null);
  });
});

describe('prepareSourceForScoring', () => {
  it('distinguishes a read failure from a transpile failure', () => {
    const readFail = prepareSourceForScoring('/nope/missing.ts');
    assert.equal(readFail.error, 'read');
    const transpileFail = prepareSourceForScoring('/x/a.ts', {
      readFile: () => 'source',
      transpile: () => null,
    });
    assert.equal(transpileFail.error, 'transpile');
  });

  it('tolerates a transpile stub that returns a bare string', () => {
    const prepared = prepareSourceForScoring('/x/a.ts', {
      readFile: () => 'ignored',
      transpile: () => 'export const a = 1;',
    });
    assert.equal(prepared.code, 'export const a = 1;');
    assert.equal(prepared.mapLine, null);
  });
});

test('scanAndScore — a TS fixture keyed at real source lines resolves 100% of its methods (AC-2)', async () => {
  const dir = mkTmp();
  try {
    const tsPath = path.join(dir, 'mod.ts');
    fs.writeFileSync(tsPath, TS_SOURCE);
    const result = await scanFixture(dir, coverageEntry(tsPath));

    assert.equal(result.skippedFilesNoCoverage, 0);
    assert.equal(
      result.skippedMethodsNoCoverage,
      0,
      'no method may be dropped for want of a coordinate remap',
    );
    assert.equal(result.resolution.rate, 1);
    assert.equal(result.resolution.resolvedMethods, 2);
    assert.deepEqual(result.resolution.worstFiles, []);

    const byMethod = Object.fromEntries(result.rows.map((r) => [r.method, r]));
    // classify is fully covered → crap collapses to c.
    assert.equal(byMethod.classify.coverage, 1);
    assert.equal(byMethod.classify.crap, byMethod.classify.cyclomatic);
    // retry is instrumented but never executed → the full c² + c penalty.
    assert.equal(byMethod.retry.coverage, 0);
    assert.equal(
      byMethod.retry.crap,
      byMethod.retry.cyclomatic ** 2 + byMethod.retry.cyclomatic,
    );
    // And the persisted coordinates are the ones a reader can open.
    assert.equal(byMethod.classify.startLine, CLASSIFY_SOURCE_LINE);
    assert.equal(byMethod.retry.startLine, RETRY_SOURCE_LINE);
  } finally {
    rmTmp(dir);
  }
});

test('scanAndScore — a remapped start one line off the fnMap decl still resolves (AC-3)', async () => {
  const dir = mkTmp();
  try {
    const tsPath = path.join(dir, 'mod.ts');
    fs.writeFileSync(tsPath, TS_SOURCE);
    // Every decl line sits one BELOW the loc start, so the remapped method
    // start never equals a decl line. Only containment can join these.
    const result = await scanFixture(
      dir,
      coverageEntry(tsPath, { declOffset: 1 }),
    );

    assert.equal(result.skippedMethodsNoCoverage, 0);
    assert.equal(result.resolution.rate, 1);
    const byMethod = Object.fromEntries(result.rows.map((r) => [r.method, r]));
    assert.equal(byMethod.classify.coverage, 1);
    assert.equal(byMethod.retry.coverage, 0);
  } finally {
    rmTmp(dir);
  }
});

test('the remap is load-bearing — the raw transpiled line mis-attributes coverage', () => {
  // Guards the fix against silent regression. Without the remap, `retry`'s
  // transpiled start falls inside `classify`'s fnMap range: the join does not
  // merely miss, it MATCHES THE WRONG FUNCTION and reports an untested method
  // as fully covered. That is the Story's central claim — a coincidental
  // match across two coordinate systems is a mis-attribution, so consumer
  // baselines pinned to it are wrong, not merely sparse.
  const entry = coverageEntry('/abs/mod.ts')['/abs/mod.ts'];
  const prepared = transpileIfNeeded('mod.ts', TS_SOURCE, {
    withLineMap: true,
  });
  const transpiledRetry =
    prepared.code.split('\n').findIndex((l) => l.includes('function retry')) +
    1;

  assert.notEqual(
    transpiledRetry,
    RETRY_SOURCE_LINE,
    'fixture drift: the transpile no longer shifts retry',
  );
  assert.equal(prepared.mapLine(transpiledRetry), RETRY_SOURCE_LINE);

  // Correct coordinates: retry is instrumented and never executed → 0.
  assert.equal(coverageForMethodInEntry(entry, RETRY_SOURCE_LINE), 0);
  // Raw transpiled coordinates: silently answers with classify's coverage.
  assert.equal(coverageForMethodInEntry(entry, transpiledRetry), 1);
});

describe('finalizeMethodRows — requireCoverage policy (AC-5)', () => {
  const raw = [
    { method: 'covered', startLine: 1, cyclomatic: 3, coverage: 1, crap: 3 },
    {
      method: 'unresolved',
      startLine: 9,
      cyclomatic: 4,
      coverage: null,
      crap: null,
    },
  ];

  it('skips and counts an unresolved method under requireCoverage: true', () => {
    const out = finalizeMethodRows(raw, { requireCoverage: true });
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].method, 'covered');
    assert.equal(out.skippedMethodsNoCoverage, 1);
  });

  it('scores an unresolved method as 0% covered under requireCoverage: false', () => {
    const out = finalizeMethodRows(raw, { requireCoverage: false });
    assert.equal(out.rows.length, 2);
    assert.equal(out.skippedMethodsNoCoverage, 0);
    const unresolved = out.rows.find((r) => r.method === 'unresolved');
    assert.equal(unresolved.coverage, 0);
    // c² + c — the formula's own treatment of untested code, not a drop.
    assert.equal(unresolved.crap, 4 ** 2 + 4);
  });

  it('counts the JOIN, not the fill, in the resolution telemetry', () => {
    // A method scored 0% because its coverage was UNRESOLVED must still count
    // as unresolved — otherwise `requireCoverage: false` would report a
    // perfect resolution rate and the updater's floor could never fire.
    const out = finalizeMethodRows(raw, { requireCoverage: false });
    assert.equal(out.totalMethods, 2);
    assert.equal(out.resolvedMethods, 1);
  });
});

describe('checkResolutionFloor — fail closed on a thin result (AC-6)', () => {
  const worstFiles = [
    { file: 'src/a.ts', unresolved: 40, total: 40 },
    { file: 'src/b.ts', unresolved: 12, total: 20 },
  ];
  const thin = {
    resolvedMethods: 100,
    joinableMethods: 1618,
    rate: 100 / 1618,
    worstFiles,
  };

  it('refuses a 6% resolution rate', () => {
    const message = checkResolutionFloor(thin, 0.75);
    assert.ok(message, 'a 6% join must be refused, not persisted');
    assert.match(message, /Refusing to persist/);
  });

  it('prints resolved/total and the worst unresolved files', () => {
    const message = checkResolutionFloor(thin, 0.75);
    assert.match(message, /100\/1618/);
    assert.match(message, /6\.2%/);
    assert.match(message, /src\/a\.ts \(40\/40 unresolved\)/);
    assert.match(message, /src\/b\.ts \(12\/20 unresolved\)/);
  });

  it('names the configuration knob so the floor is tunable, not mysterious', () => {
    assert.match(
      checkResolutionFloor(thin, 0.75),
      /delivery\.quality\.gates\.crap\.minMethodResolutionRate/,
    );
  });

  it('passes a healthy rate', () => {
    assert.equal(
      checkResolutionFloor(
        { resolvedMethods: 3995, joinableMethods: 4084, rate: 0.978 },
        0.75,
      ),
      null,
    );
  });

  it('passes at exactly the floor (the floor is a minimum, not a strict bound)', () => {
    assert.equal(
      checkResolutionFloor(
        { resolvedMethods: 75, joinableMethods: 100, rate: 0.75 },
        0.75,
      ),
      null,
    );
  });

  it('does not fire below the minimum sample — a diff-scoped run is not evidence', () => {
    // One unresolved method out of four is a 75%-breaching 50% rate but says
    // nothing about the health of the join; enforcing it would make every
    // small diff-scoped refresh a coin flip.
    assert.equal(
      checkResolutionFloor(
        { resolvedMethods: 2, joinableMethods: 4, rate: 0.5, worstFiles: [] },
        0.75,
      ),
      null,
    );
  });

  it('is a no-op when the scan reported no telemetry at all', () => {
    assert.equal(checkResolutionFloor(undefined, 0.75), null);
  });
});

// ---------------------------------------------------------------------------
// Story #4866 — the mix, end to end, and the two refusals it forces.
//
// #4775 fixed the remap but let an unresolvable line fall back to the raw
// transpiled coordinate. The row then looked exactly like a remapped one, so
// a whole file could land in a coordinate system the baseline did not share:
// every row missed `exact`, fell into the nearest-line `drifted` heuristic,
// and — because the coverage join reads that same wrong coordinate — filled
// 0% and scored `c² + c` against a baseline resolved at 100%. That is a
// regression no edit can satisfy.
// ---------------------------------------------------------------------------

test('scanAndScore — a TS scan whose sourcemap never resolves emits NO mixed-coordinate rows (AC-3)', async () => {
  const dir = mkTmp();
  try {
    const tsPath = path.join(dir, 'mod.ts');
    fs.writeFileSync(tsPath, TS_SOURCE);
    // requireCoverage stays true (the framework default), so an un-remapped
    // method is unresolved and is dropped rather than persisted under a
    // coordinate the baseline does not share.
    const result = await scanFixture(dir, coverageEntry(tsPath));
    assert.equal(
      new Set(result.rows.map((r) => r.coordinateSystem)).size,
      1,
      'one scan must not emit two coordinate systems',
    );
    for (const row of result.rows) {
      assert.equal(row.coordinateSystem, COORDINATE_ORIGINAL);
    }
  } finally {
    rmTmp(dir);
  }
});

test('scanAndScore — a pure-JS scan reports original coordinates (AC-8 invariant)', async () => {
  const dir = mkTmp();
  try {
    const jsPath = path.join(dir, 'mod.js');
    fs.writeFileSync(
      jsPath,
      'export function a(x) {\n  if (x) return 1;\n  return 0;\n}\n',
    );
    const coverage = {
      [jsPath]: {
        path: jsPath,
        fnMap: {
          0: {
            name: 'a',
            decl: { start: { line: 1, column: 0 } },
            loc: { start: { line: 1, column: 0 }, end: { line: 4, column: 1 } },
          },
        },
        f: { 0: 1 },
        statementMap: {
          0: { start: { line: 2, column: 2 }, end: { line: 2, column: 20 } },
        },
        s: { 0: 1 },
        branchMap: {},
        b: {},
      },
    };
    const result = await scanFixture(dir, coverage);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].coordinateSystem, COORDINATE_ORIGINAL);
    assert.equal(result.rows[0].startLine, 1);
    assert.equal(result.rows[0].coverage, 1);
  } finally {
    rmTmp(dir);
  }
});

describe('compareCrap — refuses to drift-resolve across coordinate systems (AC-4)', () => {
  const baselineRows = [
    { file: 'src/a.ts', method: 'run', startLine: 8, crap: 2 },
    { file: 'src/a.ts', method: 'other', startLine: 20, crap: 2 },
  ];

  it('does not resolve a transpiled row against an original-coordinate baseline', () => {
    // The exact phantom: same file, same method, a startLine in the OTHER
    // coordinate system, and a crap of c²+c because the coverage join read
    // the wrong coordinate and filled 0%. The old drift heuristic paired
    // these two rows on line distance and reported a regression.
    const result = compareCrap({
      currentRows: [
        {
          file: 'src/a.ts',
          method: 'run',
          startLine: 3,
          cyclomatic: 2,
          coverage: 0,
          crap: 6,
          coordinateSystem: COORDINATE_TRANSPILED,
        },
      ],
      baselineRows,
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.equal(result.regressions, 0, 'a phantom regression must not fire');
    assert.equal(result.drifted, 0, 'the drift heuristic must not claim it');
    assert.equal(result.incomparable, 1);
    assert.deepEqual(result.violations, []);
    const [row] = result.incomparableRows;
    assert.equal(row.kind, 'incomparable');
    assert.equal(row.coordinateSystem, COORDINATE_TRANSPILED);
    assert.equal(row.baselineCoordinateSystem, COORDINATE_ORIGINAL);
  });

  it('does not fall through to the new-method ceiling arm either', () => {
    // An incomparable row is not new — it is unmeasurable against THIS
    // baseline. Charging it the new-method ceiling would swap one phantom
    // for another.
    const result = compareCrap({
      currentRows: [
        {
          file: 'src/a.ts',
          method: 'run',
          startLine: 3,
          cyclomatic: 9,
          coverage: 0,
          crap: 90,
          coordinateSystem: COORDINATE_TRANSPILED,
        },
      ],
      baselineRows,
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.equal(result.newViolations, 0);
    assert.equal(result.incomparable, 1);
  });

  it('still drift-resolves rows that DO share the baseline coordinate system', () => {
    // The refusal is scoped to a provenance mismatch — an ordinary line shift
    // inside one coordinate system keeps its existing behaviour.
    const result = compareCrap({
      currentRows: [
        {
          file: 'src/a.ts',
          method: 'run',
          startLine: 11,
          cyclomatic: 2,
          coverage: 1,
          crap: 2,
          coordinateSystem: COORDINATE_ORIGINAL,
        },
      ],
      baselineRows,
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.equal(result.drifted, 1);
    assert.equal(result.incomparable, 0);
    assert.equal(result.regressions, 0);
  });

  it('treats an unstamped baseline row as original — legacy rows compare as before', () => {
    const result = compareCrap({
      currentRows: [
        {
          file: 'src/a.js',
          method: 'run',
          startLine: 8,
          cyclomatic: 2,
          coverage: 1,
          crap: 2,
          coordinateSystem: COORDINATE_ORIGINAL,
        },
      ],
      baselineRows: [
        { file: 'src/a.js', method: 'run', startLine: 8, crap: 2 },
      ],
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.equal(result.incomparable, 0);
    assert.equal(result.drifted, 0);
    assert.equal(result.regressions, 0);
  });
});

describe('compareCrap — provenance evidence survives the filter (#4871 AC-2)', () => {
  it('counts a mismatched candidate even when another candidate agrees', () => {
    // Two baseline rows for the same method, one of them in the other
    // coordinate system. The provenance filter keeps the agreeing one, so the
    // row scores normally and `incomparable` stays 0 — but the disagreement
    // happened, and the backstop's numerator is the only place it can be seen.
    const result = compareCrap({
      currentRows: [
        {
          file: 'src/a.ts',
          method: 'run',
          startLine: 8,
          cyclomatic: 2,
          coverage: 1,
          crap: 2,
          coordinateSystem: COORDINATE_ORIGINAL,
        },
      ],
      baselineRows: [
        { file: 'src/a.ts', method: 'run', startLine: 8, crap: 2 },
        {
          file: 'src/a.ts',
          method: 'run',
          startLine: 3,
          crap: 2,
          coordinateSystem: COORDINATE_TRANSPILED,
        },
      ],
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.equal(result.incomparable, 0, 'the filter resolved it');
    assert.equal(result.provenanceMismatched, 1, 'the evidence survived');
  });

  it('reports zero mismatch for a uniform pure-JavaScript scan', () => {
    const result = compareCrap({
      currentRows: [
        {
          file: 'src/a.js',
          method: 'run',
          startLine: 40,
          cyclomatic: 2,
          coverage: 1,
          crap: 2,
        },
      ],
      baselineRows: [
        { file: 'src/a.js', method: 'run', startLine: 8, crap: 2 },
      ],
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.equal(result.drifted, 1, 'an ordinary line shift');
    assert.equal(result.provenanceMismatched, 0, 'and no coordinate mixing');
  });

  it('buckets an unscorable row out of the comparable denominator (AC-6)', () => {
    const result = compareCrap({
      currentRows: [
        {
          file: 'src/a.js',
          method: 'run',
          startLine: 8,
          cyclomatic: 2,
          coverage: 1,
          crap: 2,
        },
        {
          file: 'src/a.js',
          method: 'unmeasured',
          startLine: 20,
          cyclomatic: 9,
          coverage: null,
          crap: null,
        },
      ],
      baselineRows: [
        { file: 'src/a.js', method: 'run', startLine: 8, crap: 2 },
      ],
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.equal(result.total, 2);
    assert.equal(result.unscorable, 1);
    assert.equal(result.comparable, 1);
    assert.equal(result.newViolations, 0, 'never charged the ceiling');
    assert.deepEqual(result.violations, []);
    assert.equal(result.unscorableRows[0].kind, 'unscorable');
  });
});

describe('assessComparisonBasis — the unsound-basis backstop (#4871)', () => {
  it('accepts a compare where every row drifted but none mismatched (AC-4)', () => {
    // The regression tell. Ordinary insertions re-key every method below the
    // edit, so a 100%-drift scan is the normal operating state of a
    // pure-JavaScript repository — never evidence of coordinate mixing.
    const verdict = assessComparisonBasis({
      comparable: 133,
      drifted: 133,
      provenanceMismatched: 0,
      incomparable: 0,
    });
    assert.equal(verdict.sound, true);
  });

  it('refuses a basis where most comparable rows hit a provenance mismatch', () => {
    const verdict = assessComparisonBasis({
      comparable: 133,
      drifted: 4,
      provenanceMismatched: 101,
      incomparable: 0,
    });
    assert.equal(verdict.sound, false);
    assert.equal(verdict.diagnostic.name, 'crap-unsound-comparison-basis');
  });

  it('Story #5717 AC-7: the re-seed remedy names the configured capture script', () => {
    const verdict = assessComparisonBasis(
      { comparable: 133, provenanceMismatched: 101, incomparable: 0 },
      { captureScript: 'test:coverage:py' },
    );
    assert.match(verdict.diagnostic.message, /'npm run test:coverage:py'/);
  });

  it('names the coordinate mismatch and the re-seed remedy exactly once', () => {
    const { diagnostic } = assessComparisonBasis({
      comparable: 133,
      provenanceMismatched: 101,
      incomparable: 0,
    });
    assert.match(diagnostic.message, /101\/133/);
    assert.match(diagnostic.message, /line coordinates/);
    assert.match(diagnostic.message, /crap:update -- --full-scope/);
    assert.match(diagnostic.message, /baseline-refresh:/);
    assert.match(diagnostic.message, /check-baselines gate still gates/);
  });

  it('counts incomparable rows even when the caller reports no mismatch', () => {
    const verdict = assessComparisonBasis({
      comparable: 40,
      drifted: 0,
      incomparable: 30,
    });
    assert.equal(verdict.sound, false);
  });

  it('measures against comparable rows, not the unscorable-inflated total (AC-6)', () => {
    // 21 comparable rows, 20 of them mismatched, plus 100 unscorable ones.
    // Against `total` the ratio is 17% and the basis passes; against the rows
    // that could actually be compared it is 95% and must not.
    const verdict = assessComparisonBasis({
      total: 121,
      comparable: 21,
      unscorable: 100,
      provenanceMismatched: 20,
    });
    assert.equal(verdict.sound, false);
  });

  it('does not fire below the minimum sample — a small diff is not evidence', () => {
    assert.equal(
      assessComparisonBasis({ comparable: 3, provenanceMismatched: 2 }).sound,
      true,
    );
  });

  it('passes exactly at the threshold — the ratio is a ceiling, not a bound', () => {
    assert.equal(
      assessComparisonBasis({ comparable: 100, provenanceMismatched: 50 })
        .sound,
      true,
    );
    assert.equal(
      assessComparisonBasis({ comparable: 100, provenanceMismatched: 51 })
        .sound,
      false,
    );
  });
});

describe('projectRow — what reaches disk (AC-1, AC-8)', () => {
  it('writes the unchanged four-key row for original coordinates', () => {
    // The invariant that keeps the committed baseline green without a
    // refresh: a JavaScript row is byte-identical to what it always was.
    assert.deepEqual(
      projectRow({
        file: 'src/a.js',
        method: 'run',
        startLine: 8,
        crap: 2,
        coordinateSystem: COORDINATE_ORIGINAL,
      }),
      { path: 'src/a.js', method: 'run', startLine: 8, crap: 2 },
    );
  });

  it('writes the same four keys for a row that never carried a stamp', () => {
    assert.deepEqual(
      Object.keys(
        projectRow({ file: 'a.js', method: 'r', startLine: 1, crap: 1 }),
      ),
      ['path', 'method', 'startLine', 'crap'],
    );
  });

  it('records transpiled provenance so the two are distinguishable on disk', () => {
    assert.deepEqual(
      projectRow({
        file: 'src/a.ts',
        method: 'run',
        startLine: 8,
        crap: 2,
        coordinateSystem: COORDINATE_TRANSPILED,
      }),
      {
        path: 'src/a.ts',
        method: 'run',
        startLine: 8,
        crap: 2,
        coordinateSystem: 'transpiled',
      },
    );
  });
});

test('a REAL TS source whose map resolves one method and not the other never mixes silently (AC-3)', () => {
  // The closest reproduction of the defect available in-repo: a genuine
  // TypeScript source, genuinely transpiled, with a genuine sourcemap — but
  // one method's generated line deliberately fails to resolve, exactly as it
  // does when the map carries no entry originating on that line.
  const prepared = transpileIfNeeded('mod.ts', TS_SOURCE, {
    withLineMap: true,
  });
  const generatedRetry =
    prepared.code.split('\n').findIndex((l) => l.includes('function retry')) +
    1;
  assert.notEqual(
    generatedRetry,
    RETRY_SOURCE_LINE,
    'fixture drift: the transpile no longer shifts retry',
  );
  // `classify` resolves; `retry` does not.
  const partialMap = (line) =>
    line === generatedRetry ? null : prepared.mapLine(line);

  const entry = coverageEntry('/abs/mod.ts')['/abs/mod.ts'];
  const crapRows = calculateCrapForSource(prepared.code, entry, partialMap);
  const byMethod = Object.fromEntries(crapRows.map((r) => [r.method, r]));

  // The resolved method reports an ORIGINAL coordinate and joins coverage.
  assert.equal(byMethod.classify.coordinateSystem, COORDINATE_ORIGINAL);
  assert.equal(byMethod.classify.startLine, CLASSIFY_SOURCE_LINE);
  assert.equal(byMethod.classify.coverage, 1);

  // The unresolved one is reported AS unresolved — it keeps the transpiled
  // line, says so, and joins nothing. Before this Story it carried the same
  // transpiled line with no marking at all, and that line falls INSIDE
  // classify's fnMap range: the join would have reported this untested
  // method as fully covered.
  assert.equal(byMethod.retry.coordinateSystem, COORDINATE_TRANSPILED);
  assert.equal(byMethod.retry.startLine, generatedRetry);
  assert.equal(byMethod.retry.coverage, null);
  assert.equal(byMethod.retry.crap, null);
  assert.equal(
    coverageForMethodInEntry(entry, generatedRetry),
    1,
    'fixture guard: the un-remapped line DOES collide with classify, which is ' +
      'why refusing the join — not falling back to it — is the fix',
  );
});
