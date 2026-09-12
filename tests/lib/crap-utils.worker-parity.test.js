/**
 * crap-utils.worker-parity.test.js — the serial and worker CRAP scorers must
 * return the same rows and the same unscorable verdict for one input.
 *
 * Story #5311. `install()` from `lib/escomplex-ast-compat.js` used to have
 * exactly one importer, `lib/maintainability-engine.js`. The serial scorer
 * reached it only as a side effect of `crap-utils.js` importing
 * `scanDirectory` from `maintainability-utils.js`; `lib/workers/crap-worker.js`
 * spawned a module graph that never did. Measured over `.agents/scripts/lib`
 * (516 files, one coverage map, both paths): serial 4143 rows, worker 3781 —
 * 362 methods across 21 files scored zero on the worker path, which
 * `POOL_SERIAL_THRESHOLD` (256) makes the only path a real repo takes.
 *
 * The fixtures below are ordinary modern JavaScript that reaches one of the
 * nine escomplex traits which re-serialise a sub-AST through the kernel's
 * ESTree-era code generator. Without the shim `analyzeModule` throws for the
 * WHOLE file, so a parity failure here reads as "one path lost every method in
 * this file", which is exactly the regression this file guards.
 *
 * Parity is asserted by running ONE `scanAndScore` input twice — once with a
 * `serialThreshold` above the queue length (serial) and once with it at 1
 * (the CPU pool) — and comparing the full row sets.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scanAndScore } from '../../.agents/scripts/lib/crap-utils.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

/**
 * Sources whose AST needs the compat shim. Each names the Babel-only node the
 * upstream generator cannot serialise; all three abort `analyzeModule` for the
 * whole module when the shim is absent.
 */
const SHIM_DEPENDENT_SOURCES = {
  // RegExpLiteral in a `for…of` head — Babel carries pattern/flags directly.
  'regex-loop-head.js': `export function tokenize(s) {
  let n = 0;
  for (const t of s.split(/[^a-z]+/)) {
    if (t.length > 2) n += 1;
  }
  return n;
}
`,
  // OptionalMemberExpression in a `for…of` head.
  'optional-loop-head.js': `export function walk(a) {
  let n = 0;
  for (const t of a?.items ?? []) {
    if (t) n += 1;
  }
  return n;
}
`,
  // ObjectMethod / ClassProperty inside a default parameter.
  'default-param-object-method.js': `export function build(opts = { render() { return 1; } }) {
  return opts.render();
}
`,
};

/** A plain source that never needed the shim — the parity control. */
const PLAIN_SOURCE = `export function plain(x) {
  return x > 0 ? x + 1 : x - 1;
}
`;

/**
 * Coverage entry resolving every method in the file to `ratio`. Deliberately
 * wide: the join only has to land, because what is being compared is the two
 * paths against each other, not either against a hand-computed CRAP value.
 */
function wideCoverageEntry(lines, ratio) {
  const statementMap = {};
  const s = {};
  const fnMap = {};
  for (let i = 1; i <= lines; i += 1) {
    statementMap[String(i)] = {
      start: { line: i, column: 0 },
      end: { line: i, column: 80 },
    };
    s[String(i)] = i / lines <= ratio ? 1 : 0;
    fnMap[String(i)] = {
      name: `fn${i}`,
      decl: { start: { line: i, column: 0 } },
      loc: { start: { line: i, column: 0 }, end: { line: lines, column: 1 } },
    };
  }
  return { fnMap, f: {}, statementMap, s, branchMap: {}, b: {} };
}

function writeFixture(cwd, files) {
  const srcDir = path.join(cwd, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const coverage = {};
  for (const [name, source] of Object.entries(files)) {
    const abs = path.join(srcDir, name);
    fs.writeFileSync(abs, source);
    coverage[abs] = wideCoverageEntry(source.split('\n').length + 2, 0.6);
  }
  return coverage;
}

/**
 * Run one input through both scorers. `serialThreshold` above the queue length
 * selects the in-process path; 1 forces every file through the CPU pool.
 */
async function scoreBothPaths(cwd, coverage) {
  const params = {
    targetDirs: ['src'],
    coverage,
    requireCoverage: true,
    cwd,
  };
  const serial = await scanAndScore({ ...params, serialThreshold: 99 });
  const worker = await scanAndScore({ ...params, serialThreshold: 1 });
  return { serial, worker };
}

/** The row fields parity is defined over — the ones that reach the baseline. */
function comparableRows(result) {
  return result.rows.map((r) => ({
    file: r.file,
    method: r.method,
    startLine: r.startLine,
    cyclomatic: r.cyclomatic,
    coverage: r.coverage,
    crap: r.crap,
  }));
}

function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

test('AC-1: serial and worker paths agree row-for-row on shim-dependent sources', async () => {
  const cwd = makeTempDir('crap_worker_parity_');
  try {
    const coverage = writeFixture(cwd, {
      ...SHIM_DEPENDENT_SOURCES,
      'plain.js': PLAIN_SOURCE,
    });
    const { serial, worker } = await scoreBothPaths(cwd, coverage);

    // Guard the guard: a fixture that scored nothing on BOTH paths would make
    // the parity assertion below vacuously true.
    assert.ok(
      serial.rows.length >= Object.keys(SHIM_DEPENDENT_SOURCES).length + 1,
      `expected at least one row per fixture, got ${serial.rows.length}`,
    );
    const scoredFiles = new Set(serial.rows.map((r) => r.file));
    for (const name of Object.keys(SHIM_DEPENDENT_SOURCES)) {
      assert.ok(
        scoredFiles.has(`src/${name}`),
        `serial path scored no method in ${name} — the shim is not installed`,
      );
    }

    assert.deepStrictEqual(comparableRows(worker), comparableRows(serial));
    assert.strictEqual(worker.scannedFiles, serial.scannedFiles);
    assert.strictEqual(
      worker.skippedFilesNoCoverage,
      serial.skippedFilesNoCoverage,
    );
    assert.strictEqual(
      worker.skippedMethodsNoCoverage,
      serial.skippedMethodsNoCoverage,
    );
  } finally {
    rmTmp(cwd);
  }
});

test('AC-1: both paths reach the same unscorable verdict for an unparseable source', async () => {
  const cwd = makeTempDir('crap_worker_parity_unscorable_');
  try {
    const coverage = writeFixture(cwd, {
      'plain.js': PLAIN_SOURCE,
      // Not a syntax the shim can rescue — genuinely unparseable.
      'broken.js': 'export function broken( {\n',
    });
    const { serial, worker } = await scoreBothPaths(cwd, coverage);

    assert.deepStrictEqual(comparableRows(worker), comparableRows(serial));
    // Both must DROP the file and say so — `[]` rows with a zero counter is
    // the silent loss this Story exists to close.
    assert.strictEqual(serial.unscorableFiles, 1);
    assert.strictEqual(worker.unscorableFiles, serial.unscorableFiles);
    assert.deepStrictEqual(
      worker.rows.map((r) => r.file),
      ['src/plain.js'],
    );
  } finally {
    rmTmp(cwd);
  }
});

test('AC-1: parity holds when a shim-dependent file is the ONLY file', async () => {
  // The pool path batches, so a single-file queue exercises a different
  // dispatch shape than the multi-file case above.
  const cwd = makeTempDir('crap_worker_parity_single_');
  try {
    const coverage = writeFixture(cwd, {
      'regex-loop-head.js': SHIM_DEPENDENT_SOURCES['regex-loop-head.js'],
    });
    const { serial, worker } = await scoreBothPaths(cwd, coverage);
    assert.ok(serial.rows.length > 0, 'fixture scored nothing serially');
    assert.deepStrictEqual(comparableRows(worker), comparableRows(serial));
    assert.strictEqual(worker.unscorableFiles, 0);
  } finally {
    rmTmp(cwd);
  }
});
