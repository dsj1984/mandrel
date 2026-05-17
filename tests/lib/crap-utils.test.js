import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Ajv from 'ajv';
import {
  buildBaselineEnvelope,
  getCrapBaseline,
  KERNEL_VERSION,
  resolveEscomplexVersion,
  scanAndScore,
} from '../../.agents/scripts/lib/crap-utils.js';

// Tests now pass `baselinePath` explicitly — Epic #730 Story 5.5 removed the
// silent `DEFAULT_BASELINE_PATH = 'crap-baseline.json'` default in favour of
// resolver-driven paths (`agentSettings.quality.baselines.crap.path`).
const TEST_BASELINE_PATH = 'baselines/crap.json';

const SCHEMA_PATH = path.resolve('.agents/schemas/crap-baseline.schema.json');

function mkTmpCwd(prefix = 'crap_utils_test_') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

test('getCrapBaseline — returns null when baseline file is missing', () => {
  const cwd = mkTmpCwd();
  try {
    assert.strictEqual(
      getCrapBaseline({ cwd, baselinePath: TEST_BASELINE_PATH }),
      null,
    );
  } finally {
    rmTmp(cwd);
  }
});

test('getCrapBaseline — returns null on malformed JSON', () => {
  const cwd = mkTmpCwd();
  try {
    fs.mkdirSync(path.dirname(path.join(cwd, TEST_BASELINE_PATH)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(cwd, TEST_BASELINE_PATH), '{not json');
    assert.strictEqual(
      getCrapBaseline({ cwd, baselinePath: TEST_BASELINE_PATH }),
      null,
    );
  } finally {
    rmTmp(cwd);
  }
});

test('getCrapBaseline — returns null when required fields are missing', () => {
  const cwd = mkTmpCwd();
  try {
    fs.mkdirSync(path.dirname(path.join(cwd, TEST_BASELINE_PATH)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(cwd, TEST_BASELINE_PATH),
      JSON.stringify({ rows: [] }),
    );
    assert.strictEqual(
      getCrapBaseline({ cwd, baselinePath: TEST_BASELINE_PATH }),
      null,
    );
  } finally {
    rmTmp(cwd);
  }
});

test('getCrapBaseline — surfaces kernel-version mismatch without silent rescore', () => {
  const cwd = mkTmpCwd();
  try {
    const envelope = {
      $schema: '.agents/schemas/crap-baseline.schema.json',
      kernelVersion: '9.9.9',
      escomplexVersion: '1.2.3',
      tsTranspilerVersion: '0.0.0',
      rows: [{ file: 'a.js', method: 'foo', startLine: 1, crap: 2 }],
    };
    fs.mkdirSync(path.dirname(path.join(cwd, TEST_BASELINE_PATH)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(cwd, TEST_BASELINE_PATH),
      `${JSON.stringify(envelope, null, 2)}\n`,
    );
    const loaded = getCrapBaseline({ cwd, baselinePath: TEST_BASELINE_PATH });
    assert.ok(loaded);
    assert.strictEqual(loaded.kernelVersion, '9.9.9');
    assert.notStrictEqual(loaded.kernelVersion, KERNEL_VERSION);
    // Rows are returned verbatim — no re-scoring, no stripping.
    assert.deepStrictEqual(loaded.rows, envelope.rows);
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
      coverage: null,
      requireCoverage: false,
      cwd,
    });
    // File produces a method row in the kernel, but crap is null without
    // coverage → it is filtered out of scanAndScore rows (no silent zeros).
    assert.strictEqual(result.scannedFiles, 1);
    assert.strictEqual(result.skippedFilesNoCoverage, 0);
    assert.ok(result.skippedMethodsNoCoverage >= 1);
    assert.deepStrictEqual(result.rows, []);
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
