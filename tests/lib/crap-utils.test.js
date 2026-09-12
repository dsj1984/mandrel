import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Ajv from 'ajv';
import {
  buildBaselineEnvelope,
  KERNEL_VERSION,
  resolveEscomplexVersion,
  scanAndScore,
} from '../../.agents/scripts/lib/crap-utils.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const SCHEMA_PATH = path.resolve('.agents/schemas/crap-baseline.schema.json');

function mkTmpCwd(prefix = 'crap_utils_test_') {
  return makeTempDir(prefix);
}

function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

function loadSchemaValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  return ajv.compile(schema);
}

/**
 * Coverage-entry helper identical in spirit to the one in crap-engine tests:
 * produce a file entry whose per-method statement coverage resolves to
 * `ratio` for a method starting at `methodStartLine`.
 */
function coverageEntryFor(methodStartLine, ratio) {
  const total = 10;
  const covered = Math.round(ratio * total);
  const statementMap = {};
  const s = {};
  for (let i = 0; i < total; i += 1) {
    statementMap[String(i)] = {
      start: { line: methodStartLine + 1 + i, column: 0 },
      end: { line: methodStartLine + 1 + i, column: 10 },
    };
    s[String(i)] = i < covered ? 1 : 0;
  }
  return {
    fnMap: {
      0: {
        name: 'fn',
        decl: { start: { line: methodStartLine, column: 0 } },
        loc: {
          start: { line: methodStartLine, column: 0 },
          end: { line: methodStartLine + total + 1, column: 1 },
        },
      },
    },
    f: { 0: covered > 0 ? 1 : 0 },
    statementMap,
    s,
    branchMap: {},
    b: {},
  };
}

test('resolveEscomplexVersion — finds the pinned version in this repo', () => {
  const v = resolveEscomplexVersion();
  assert.match(v, /^\d+\.\d+\.\d+/);
  assert.notStrictEqual(v, '0.0.0');
});

test('resolveEscomplexVersion — returns 0.0.0 when module is absent', () => {
  const cwd = mkTmpCwd();
  try {
    assert.strictEqual(resolveEscomplexVersion(cwd), '0.0.0');
  } finally {
    rmTmp(cwd);
  }
});

test('buildBaselineEnvelope — filters rows whose crap is null (no silent zeros)', () => {
  const env = buildBaselineEnvelope({
    rows: [
      { file: 'a.js', method: 'scored', startLine: 1, crap: 3 },
      { file: 'a.js', method: 'unscored', startLine: 10, crap: null },
      { file: 'b.js', method: 'nan', startLine: 1, crap: Number.NaN },
    ],
    escomplexVersion: '1.0.0',
  });
  assert.strictEqual(env.rows.length, 1);
  assert.strictEqual(env.rows[0].method, 'scored');
});

test('buildBaselineEnvelope — requires escomplexVersion', () => {
  assert.throws(
    () => buildBaselineEnvelope({ rows: [], escomplexVersion: '' }),
    /escomplexVersion/,
  );
  assert.throws(() => buildBaselineEnvelope({ rows: [] }), /escomplexVersion/);
});

test('buildBaselineEnvelope — stamps current KERNEL_VERSION by default', () => {
  const env = buildBaselineEnvelope({ rows: [], escomplexVersion: '1.0.0' });
  assert.strictEqual(env.kernelVersion, KERNEL_VERSION);
});

test('produced baseline validates against crap-baseline.schema.json', () => {
  const validate = loadSchemaValidator();
  const env = buildBaselineEnvelope({
    rows: [
      { file: 'lib/a.js', method: 'doThing', startLine: 4, crap: 3.1 },
      { file: 'lib/a.js', method: 'other', startLine: 42, crap: 12 },
    ],
    escomplexVersion: '7.3.2',
  });
  const ok = validate(env);
  assert.ok(ok, `schema errors: ${JSON.stringify(validate.errors)}`);
});

test('schema rejects baseline with extra per-row keys', () => {
  const validate = loadSchemaValidator();
  const bad = {
    kernelVersion: '1.0.0',
    escomplexVersion: '7.3.2',
    rows: [
      {
        file: 'a.js',
        method: 'm',
        startLine: 1,
        crap: 2,
        cyclomatic: 3, // not allowed in the committed shape
      },
    ],
  };
  assert.strictEqual(validate(bad), false);
});

test('schema rejects baseline with non-semver kernelVersion', () => {
  const validate = loadSchemaValidator();
  assert.strictEqual(
    validate({
      kernelVersion: 'one',
      escomplexVersion: '7.3.2',
      rows: [],
    }),
    false,
  );
});

test('scanAndScore — skips files without coverage when requireCoverage=true', async () => {
  const cwd = mkTmpCwd();
  try {
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'covered.js'),
      'export function covered(x) { return x + 1; }\n',
    );
    fs.writeFileSync(
      path.join(srcDir, 'uncovered.js'),
      'export function uncovered(x) { return x + 2; }\n',
    );
    const coverage = {
      [path.join(srcDir, 'covered.js')]: coverageEntryFor(1, 1.0),
    };
    const result = await scanAndScore({
      targetDirs: ['src'],
      coverage,
      requireCoverage: true,
      cwd,
    });
    assert.strictEqual(result.scannedFiles, 2);
    assert.strictEqual(result.skippedFilesNoCoverage, 1);
    const files = result.rows.map((r) => r.file);
    assert.deepStrictEqual(files, ['src/covered.js']);
    const [row] = result.rows;
    assert.strictEqual(row.method, 'covered');
    assert.strictEqual(row.coverage, 1);
    assert.strictEqual(typeof row.crap, 'number');
  } finally {
    rmTmp(cwd);
  }
});

/**
 * A source `escomplex.analyzeModule` cannot parse. Story #5311: this file must
 * reach the host as a DROPPED file on both scoring paths — never as a
 * successfully-scored file that happens to have no methods.
 */
const UNPARSEABLE_SOURCE = 'export function broken( {\n';

/**
 * Drive `scanAndScore` over one scorable and one unparseable file, on whichever
 * path `serialThreshold` selects. A threshold above the queue length runs
 * serially; a threshold of 1 forces the CPU pool.
 */
async function scanFixtureWithUnparseableFile(cwd, serialThreshold) {
  const srcDir = path.join(cwd, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, 'good.js'),
    'export function good(x) { return x + 1; }\n',
  );
  fs.writeFileSync(path.join(srcDir, 'broken.js'), UNPARSEABLE_SOURCE);
  return scanAndScore({
    targetDirs: ['src'],
    coverage: {
      [path.join(srcDir, 'good.js')]: coverageEntryFor(1, 1.0),
      [path.join(srcDir, 'broken.js')]: coverageEntryFor(1, 1.0),
    },
    requireCoverage: true,
    cwd,
    serialThreshold,
  });
}

test('scanAndScore — a parse failure is counted as unscorable, serially (Story #5311, AC-3)', async () => {
  const cwd = mkTmpCwd();
  try {
    const result = await scanFixtureWithUnparseableFile(cwd, 99);
    assert.strictEqual(result.scannedFiles, 2);
    // The unparseable file contributes no rows AND moves a counter — the
    // pairing is the point: rows alone cannot distinguish "unscorable" from
    // "no methods".
    assert.strictEqual(result.unscorableFiles, 1);
    assert.strictEqual(result.skippedFilesNoCoverage, 0);
    assert.deepStrictEqual(
      result.rows.map((r) => r.file),
      ['src/good.js'],
    );
  } finally {
    rmTmp(cwd);
  }
});

test('scanAndScore — a parse failure is counted as unscorable via the worker pool too (Story #5311, AC-3)', async () => {
  const cwd = mkTmpCwd();
  try {
    // serialThreshold=1 forces the pool, which is the path a repo above
    // POOL_SERIAL_THRESHOLD always takes. Before #5311 the worker returned
    // `rows: []` here and this counter stayed at 0.
    const result = await scanFixtureWithUnparseableFile(cwd, 1);
    assert.strictEqual(result.scannedFiles, 2);
    assert.strictEqual(result.unscorableFiles, 1);
    assert.strictEqual(result.skippedFilesNoCoverage, 0);
    assert.deepStrictEqual(
      result.rows.map((r) => r.file),
      ['src/good.js'],
    );
  } finally {
    rmTmp(cwd);
  }
});

test('scanAndScore — a method-free file is scored, not counted unscorable (Story #5311)', async () => {
  const cwd = mkTmpCwd();
  try {
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'empty.js'), 'export const x = 1;\n');
    const result = await scanAndScore({
      targetDirs: ['src'],
      coverage: { [path.join(srcDir, 'empty.js')]: coverageEntryFor(1, 1.0) },
      requireCoverage: true,
      cwd,
    });
    assert.strictEqual(result.scannedFiles, 1);
    assert.strictEqual(result.unscorableFiles, 0);
    assert.strictEqual(result.rows.length, 0);
  } finally {
    rmTmp(cwd);
  }
});

test('scanAndScore — incremental join resolves an untouched file from its baseline (Story #4981)', async () => {
  const cwd = mkTmpCwd();
  try {
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'touched.js'),
      'export function touched(x) { return x + 1; }\n',
    );
    fs.writeFileSync(
      path.join(srcDir, 'untouched.js'),
      'export function untouched(x) { return x + 2; }\n',
    );
    // Only `touched.js` has a fresh coverage entry — as an incremental
    // `npm run test:coverage -- src/touched.js` run would produce.
    const coverage = {
      [path.join(srcDir, 'touched.js')]: coverageEntryFor(1, 1.0),
    };
    const result = await scanAndScore({
      targetDirs: ['src'],
      coverage,
      requireCoverage: true,
      cwd,
      incremental: {
        touchedFiles: new Set(['src/touched.js']),
        baselineRows: [
          {
            file: 'src/untouched.js',
            method: 'untouched',
            startLine: 1,
            crap: 9.5,
          },
        ],
      },
    });
    assert.strictEqual(result.scannedFiles, 2);
    // AC-2: no unresolved-method skip attributed to the untouched file.
    assert.strictEqual(result.skippedFilesNoCoverage, 0);
    assert.strictEqual(result.skippedMethodsNoCoverage, 0);
    const byFile = Object.fromEntries(result.rows.map((r) => [r.file, r]));
    assert.strictEqual(byFile['src/touched.js'].coverage, 1);
    // AC-2: the untouched-file verdict equals its committed baseline row.
    assert.strictEqual(byFile['src/untouched.js'].crap, 9.5);
    assert.strictEqual(byFile['src/untouched.js'].resolvedFromBaseline, true);
  } finally {
    rmTmp(cwd);
  }
});

test('scanAndScore — incremental join fails closed when an untouched file has no baseline row (Story #4981, AC-3)', async () => {
  const cwd = mkTmpCwd();
  try {
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'untouched.js'),
      'export function untouched(x) { return x + 2; }\n',
    );
    const result = await scanAndScore({
      targetDirs: ['src'],
      coverage: {}, // no coverage entry anywhere
      requireCoverage: true,
      cwd,
      incremental: {
        touchedFiles: new Set(), // nothing touched
        baselineRows: [], // and no baseline row for this method
      },
    });
    // Fails closed to the existing requireCoverage skip-and-count policy —
    // it must never silently pass an unresolved method.
    assert.strictEqual(result.skippedFilesNoCoverage, 1);
    assert.strictEqual(result.rows.length, 0);
  } finally {
    rmTmp(cwd);
  }
});

test('scanAndScore — scores uncovered files when requireCoverage=false', async () => {
  const cwd = mkTmpCwd();
  try {
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'a.js'),
      'export function a(x) { return x + 1; }\n',
    );
    const result = await scanAndScore({
      targetDirs: ['src'],
      // A real coverage run happened; it simply never reached src/a.js.
      // That absence IS a measurement (Story #4871), so the 0%-covered arm
      // below is the honest reading of it.
      coverage: { [path.join(cwd, 'src', 'other.js')]: { path: 'other.js' } },
      requireCoverage: false,
      cwd,
    });
    // Story #4775 (AC-5): `requireCoverage: false` means "score it anyway".
    // A method with no coverage entry is untested code, so it scores at 0%
    // coverage — crap = c² + c — and lands in the baseline. Previously the
    // flag only stopped whole FILES being skipped while each method was
    // still dropped individually, making it a no-op for baseline population.
    assert.strictEqual(result.scannedFiles, 1);
    assert.strictEqual(result.skippedFilesNoCoverage, 0);
    assert.strictEqual(result.skippedMethodsNoCoverage, 0);
    assert.strictEqual(result.rows.length, 1);
    const [row] = result.rows;
    assert.strictEqual(row.method, 'a');
    assert.strictEqual(row.coverage, 0);
    assert.strictEqual(row.crap, row.cyclomatic ** 2 + row.cyclomatic);
  } finally {
    rmTmp(cwd);
  }
});

test('scanAndScore — no coverage artifact at all leaves methods unscorable', async () => {
  // Story #4871: the freshly-initialized-worktree case. `requireCoverage:
  // false` asks for untested code to be scored, but with no coverage run
  // behind the verdict there is nothing to read "untested" off — filling the
  // gap with 0% would drive every method to c² + c and fail the first commit
  // on files the change never touched.
  const cwd = mkTmpCwd();
  try {
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'a.js'),
      'export function a(x) { return x + 1; }\n',
    );
    const result = await scanAndScore({
      targetDirs: ['src'],
      coverage: null,
      requireCoverage: false,
      cwd,
    });
    assert.strictEqual(result.scannedFiles, 1);
    assert.strictEqual(result.rows.length, 0, 'never scored from a guess');
    assert.strictEqual(
      result.skippedMethodsNoCoverage,
      1,
      'reported unscorable, not silently absent',
    );
  } finally {
    rmTmp(cwd);
  }
});

test('scanAndScore — returns deterministic, POSIX-normalized paths sorted by (file, startLine)', async () => {
  const cwd = mkTmpCwd();
  try {
    const dir = path.join(cwd, 'src');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'z.js'),
      'export function zz(x) { return x + 1; }\n',
    );
    fs.writeFileSync(
      path.join(dir, 'a.js'),
      [
        'export function first() { return 1; }',
        '',
        'export function second() { return 2; }',
        '',
      ].join('\n'),
    );
    const coverage = {
      [path.join(dir, 'z.js')]: coverageEntryFor(1, 1.0),
      [path.join(dir, 'a.js')]: {
        ...coverageEntryFor(1, 1.0),
        fnMap: {
          0: {
            name: 'first',
            decl: { start: { line: 1, column: 0 } },
            loc: {
              start: { line: 1, column: 0 },
              end: { line: 1, column: 40 },
            },
          },
          1: {
            name: 'second',
            decl: { start: { line: 3, column: 0 } },
            loc: {
              start: { line: 3, column: 0 },
              end: { line: 3, column: 40 },
            },
          },
        },
        statementMap: {
          0: { start: { line: 1, column: 25 }, end: { line: 1, column: 35 } },
          1: { start: { line: 3, column: 25 }, end: { line: 3, column: 35 } },
        },
        s: { 0: 1, 1: 1 },
      },
    };
    const result = await scanAndScore({
      targetDirs: ['src'],
      coverage,
      requireCoverage: true,
      cwd,
    });
    for (const row of result.rows) {
      assert.ok(!row.file.includes('\\'), 'paths must use forward slashes');
    }
    const files = result.rows.map((r) => r.file);
    // a.js sorts before z.js; within a.js, startLine ascending.
    assert.deepStrictEqual(
      files.filter((_, i, arr) => arr.indexOf(_) === i),
      ['src/a.js', 'src/z.js'],
    );
    const aRows = result.rows.filter((r) => r.file === 'src/a.js');
    assert.ok(
      aRows[0].startLine <= aRows[aRows.length - 1].startLine,
      'rows within a file ordered by startLine',
    );
  } finally {
    rmTmp(cwd);
  }
});

test('scanAndScore — rejects when targetDirs is not an array', async () => {
  await assert.rejects(
    () => scanAndScore({ targetDirs: 'src', coverage: null }),
    /targetDirs/,
  );
});

test('scanAndScore — tolerates non-existent target directories', async () => {
  const cwd = mkTmpCwd();
  try {
    const result = await scanAndScore({
      targetDirs: ['does-not-exist'],
      coverage: null,
      cwd,
    });
    assert.strictEqual(result.scannedFiles, 0);
    assert.deepStrictEqual(result.rows, []);
  } finally {
    rmTmp(cwd);
  }
});

test('scanAndScore — preScannedFiles skips the directory walk and produces identical results (Story #3663)', async () => {
  const cwd = mkTmpCwd();
  try {
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'covered.js'),
      'export function covered(x) { return x + 1; }\n',
    );
    const coverage = {
      [path.join(srcDir, 'covered.js')]: coverageEntryFor(1, 1.0),
    };

    // Reference result via the normal directory walk.
    const resultFromWalk = await scanAndScore({
      targetDirs: ['src'],
      coverage,
      requireCoverage: true,
      cwd,
    });

    // Equivalent result via pre-scanned file list (simulating what
    // regenerateMainFromTree passes after the MI scan).
    const preScannedFiles = [path.join(srcDir, 'covered.js')];
    const resultFromPreScanned = await scanAndScore({
      targetDirs: ['src'],
      coverage,
      requireCoverage: true,
      cwd,
      preScannedFiles,
    });

    // Both paths must produce byte-identical row output.
    assert.deepStrictEqual(
      resultFromPreScanned.rows,
      resultFromWalk.rows,
      'preScannedFiles path must yield identical rows to the walk path',
    );
    assert.strictEqual(
      resultFromPreScanned.scannedFiles,
      resultFromWalk.scannedFiles,
    );
  } finally {
    rmTmp(cwd);
  }
});
