import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  computeExitCode,
  mergeEnvelopes,
  parseChangedSinceArg,
  parseJsonFlag,
  parseStagedFlag,
  renderTable,
  runCli,
} from '../.agents/scripts/quality-preview.js';

/**
 * quality-preview.js unit coverage: argv parsing, the pure envelope merge,
 * exit-code mapping, table rendering, and the runCli wiring (with an injected
 * spawn stub that simulates the gate scripts writing JSON envelopes to the
 * paths the CLI requested via --json).
 */

function makeMiEnvelope(violations = [], regressions = violations.length) {
  return {
    kernelVersion: '1.1.0',
    summary: {
      total: 1,
      regressions,
      newFiles: 0,
      improvements: 0,
      scope: 'diff',
      diffRef: 'HEAD',
    },
    violations,
  };
}

function makeCrapEnvelope({
  regressionViolations = [],
  newViolations = [],
} = {}) {
  return {
    kernelVersion: '1.0.0',
    escomplexVersion: 'x',
    summary: {
      total: regressionViolations.length + newViolations.length,
      regressions: regressionViolations.length,
      newViolations: newViolations.length,
      drifted: 0,
      removed: 0,
      skippedNoCoverage: 0,
      scope: 'diff',
      diffRef: 'HEAD',
    },
    violations: [...regressionViolations, ...newViolations],
  };
}

function makeStreamCapture() {
  return {
    lines: [],
    write(s) {
      this.lines.push(s);
    },
  };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quality-preview-test-'));
}

test('parseChangedSinceArg — returns ref when flag has value', () => {
  assert.equal(parseChangedSinceArg(['--changed-since', 'main']), 'main');
});

test('parseChangedSinceArg — returns "HEAD" when flag is bare', () => {
  assert.equal(parseChangedSinceArg(['--changed-since']), 'HEAD');
});

test('parseChangedSinceArg — returns null when absent', () => {
  assert.equal(parseChangedSinceArg(['--json']), null);
});

test('parseJsonFlag / parseStagedFlag — flag detection', () => {
  assert.equal(parseJsonFlag(['--json']), true);
  assert.equal(parseJsonFlag([]), false);
  assert.equal(parseStagedFlag(['--staged']), true);
  assert.equal(parseStagedFlag([]), false);
});

test('mergeEnvelopes — passing pair yields zero rows and clean totals', () => {
  const merged = mergeEnvelopes(makeMiEnvelope([], 0), makeCrapEnvelope());
  assert.deepEqual(merged.rows, []);
  assert.equal(merged.totals.miRegressions, 0);
  assert.equal(merged.totals.crapViolations, 0);
});

test('mergeEnvelopes — MI-only failure surfaces miDrop on the offending file', () => {
  const mi = makeMiEnvelope([
    {
      file: 'lib/a.js',
      current: 70.1,
      baseline: 75.0,
      drop: 4.9,
      kind: 'regression',
    },
  ]);
  const merged = mergeEnvelopes(mi, makeCrapEnvelope());
  assert.equal(merged.rows.length, 1);
  assert.equal(merged.rows[0].file, 'lib/a.js');
  assert.equal(merged.rows[0].miDrop, 4.9);
  assert.equal(merged.rows[0].worstCrapDelta, 0);
  assert.equal(merged.rows[0].newOverCeilingMethods, 0);
  assert.equal(merged.totals.miRegressions, 1);
  assert.equal(merged.totals.crapViolations, 0);
});

test('mergeEnvelopes — CRAP-only failure surfaces worstCrapDelta and new-method count', () => {
  const crap = makeCrapEnvelope({
    regressionViolations: [
      {
        file: 'lib/b.js',
        method: 'doX',
        startLine: 1,
        cyclomatic: 5,
        coverage: 0.5,
        crap: 30,
        baseline: 18,
        ceiling: 30,
        kind: 'regression',
        fixGuidance: {},
      },
    ],
    newViolations: [
      {
        file: 'lib/b.js',
        method: 'doY',
        startLine: 100,
        cyclomatic: 12,
        coverage: 0.1,
        crap: 50,
        baseline: null,
        ceiling: 30,
        kind: 'new',
        fixGuidance: {},
      },
    ],
  });
  const merged = mergeEnvelopes(makeMiEnvelope([], 0), crap);
  assert.equal(merged.rows.length, 1);
  const [row] = merged.rows;
  assert.equal(row.file, 'lib/b.js');
  assert.equal(row.miDrop, 0);
  // worstCrapDelta = max(crap-baseline=12, crap-ceiling=20) = 20
  assert.equal(row.worstCrapDelta, 20);
  // new-method with cyclomatic=12 (>8) → 1 over ceiling.
  assert.equal(row.newOverCeilingMethods, 1);
  assert.equal(merged.totals.crapViolations, 2);
});

test('mergeEnvelopes — mixed-fail combines per-file rows from both gates', () => {
  const mi = makeMiEnvelope([
    { file: 'lib/a.js', drop: 1.5, kind: 'regression' },
  ]);
  const crap = makeCrapEnvelope({
    newViolations: [
      {
        file: 'lib/b.js',
        cyclomatic: 9,
        crap: 35,
        baseline: null,
        ceiling: 30,
        kind: 'new',
      },
    ],
  });
  const merged = mergeEnvelopes(mi, crap);
  assert.equal(merged.rows.length, 2);
  const a = merged.rows.find((r) => r.file === 'lib/a.js');
  const b = merged.rows.find((r) => r.file === 'lib/b.js');
  assert.equal(a.miDrop, 1.5);
  assert.equal(b.worstCrapDelta, 5);
  assert.equal(b.newOverCeilingMethods, 1);
});

test('mergeEnvelopes — null envelopes treated as empty', () => {
  const merged = mergeEnvelopes(null, null);
  assert.deepEqual(merged.rows, []);
  assert.equal(merged.totals.miRegressions, 0);
  assert.equal(merged.totals.crapViolations, 0);
});

test('computeExitCode — clean → 0', () => {
  const merged = { rows: [], totals: { miRegressions: 0, crapViolations: 0 } };
  assert.equal(computeExitCode(merged, 0, 0), 0);
});

test('computeExitCode — non-zero gate exit → 1 even with empty merge', () => {
  const merged = { rows: [], totals: { miRegressions: 0, crapViolations: 0 } };
  assert.equal(computeExitCode(merged, 1, 0), 1);
  assert.equal(computeExitCode(merged, 0, 1), 1);
});

test('computeExitCode — violations in merged rows → 1', () => {
  const merged = {
    rows: [
      {
        file: 'a.js',
        miDrop: 1,
        worstCrapDelta: 0,
        newOverCeilingMethods: 0,
      },
    ],
    totals: { miRegressions: 1, crapViolations: 0 },
  };
  assert.equal(computeExitCode(merged, 0, 0), 1);
});

test('renderTable — header columns match the AC verbatim', () => {
  const merged = mergeEnvelopes(makeMiEnvelope([], 0), makeCrapEnvelope());
  const out = renderTable(merged);
  assert.match(
    out,
    /\| file \| MI delta \| worst CRAP delta \| new-method count over c=8 \|/,
  );
  assert.match(out, /no per-file regressions/);
});

test('runCli — passing pair via stubbed spawn writes empty envelopes and exits 0', () => {
  const tmp = makeTmpDir();
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const spawnStub = (_node, args) => {
    const jsonIdx = args.indexOf('--json');
    const jsonPath = args[jsonIdx + 1];
    const isMi = args[0].endsWith('check-maintainability.js');
    const envelope = isMi ? makeMiEnvelope([], 0) : makeCrapEnvelope();
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(envelope));
    return { status: 0 };
  };
  const { exitCode, merged } = runCli({
    argv: ['--changed-since', 'HEAD'],
    cwd: process.cwd(),
    spawn: spawnStub,
    tmpDir: tmp,
    stdout: out,
    stderr: err,
    scriptsDir: '/fake/scripts',
  });
  assert.equal(exitCode, 0);
  assert.equal(merged.rows.length, 0);
  const joined = out.lines.join('');
  assert.match(joined, /quality:preview/);
  assert.match(joined, /file \| MI delta/);
});

test('runCli — MI-only failure flips exit to 1 and prints the offending row', () => {
  const tmp = makeTmpDir();
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const spawnStub = (_node, args) => {
    const jsonIdx = args.indexOf('--json');
    const jsonPath = args[jsonIdx + 1];
    const isMi = args[0].endsWith('check-maintainability.js');
    const envelope = isMi
      ? makeMiEnvelope([
          {
            file: 'lib/a.js',
            current: 70.1,
            baseline: 75.0,
            drop: 4.9,
            kind: 'regression',
          },
        ])
      : makeCrapEnvelope();
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(envelope));
    return { status: isMi ? 1 : 0 };
  };
  const { exitCode, merged } = runCli({
    argv: ['--changed-since', 'HEAD'],
    cwd: process.cwd(),
    spawn: spawnStub,
    tmpDir: tmp,
    stdout: out,
    stderr: err,
    scriptsDir: '/fake/scripts',
  });
  assert.equal(exitCode, 1);
  assert.equal(merged.rows.length, 1);
  assert.equal(merged.rows[0].file, 'lib/a.js');
  assert.match(out.lines.join(''), /lib\/a\.js/);
});

test('runCli — CRAP-only failure flips exit to 1', () => {
  const tmp = makeTmpDir();
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const spawnStub = (_node, args) => {
    const jsonIdx = args.indexOf('--json');
    const jsonPath = args[jsonIdx + 1];
    const isMi = args[0].endsWith('check-maintainability.js');
    const envelope = isMi
      ? makeMiEnvelope([], 0)
      : makeCrapEnvelope({
          newViolations: [
            {
              file: 'lib/b.js',
              cyclomatic: 12,
              crap: 50,
              baseline: null,
              ceiling: 30,
              kind: 'new',
            },
          ],
        });
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(envelope));
    return { status: isMi ? 0 : 1 };
  };
  const { exitCode, merged } = runCli({
    argv: ['--changed-since', 'HEAD'],
    cwd: process.cwd(),
    spawn: spawnStub,
    tmpDir: tmp,
    stdout: out,
    stderr: err,
    scriptsDir: '/fake/scripts',
  });
  assert.equal(exitCode, 1);
  assert.equal(merged.rows.length, 1);
  assert.equal(merged.rows[0].file, 'lib/b.js');
});

test('runCli — mixed-fail surfaces both files and exits 1', () => {
  const tmp = makeTmpDir();
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const spawnStub = (_node, args) => {
    const jsonIdx = args.indexOf('--json');
    const jsonPath = args[jsonIdx + 1];
    const isMi = args[0].endsWith('check-maintainability.js');
    const envelope = isMi
      ? makeMiEnvelope([{ file: 'lib/a.js', drop: 2.0, kind: 'regression' }])
      : makeCrapEnvelope({
          newViolations: [
            {
              file: 'lib/b.js',
              cyclomatic: 9,
              crap: 35,
              baseline: null,
              ceiling: 30,
              kind: 'new',
            },
          ],
        });
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(envelope));
    return { status: 1 };
  };
  const { exitCode, merged } = runCli({
    argv: ['--changed-since', 'HEAD'],
    cwd: process.cwd(),
    spawn: spawnStub,
    tmpDir: tmp,
    stdout: out,
    stderr: err,
    scriptsDir: '/fake/scripts',
  });
  assert.equal(exitCode, 1);
  assert.equal(merged.rows.length, 2);
});

test('runCli — --json mode emits structured envelope to stdout', () => {
  const tmp = makeTmpDir();
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const spawnStub = (_node, args) => {
    const jsonIdx = args.indexOf('--json');
    const jsonPath = args[jsonIdx + 1];
    const isMi = args[0].endsWith('check-maintainability.js');
    const envelope = isMi ? makeMiEnvelope([], 0) : makeCrapEnvelope();
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(envelope));
    return { status: 0 };
  };
  const { exitCode } = runCli({
    argv: ['--changed-since', 'HEAD', '--json'],
    cwd: process.cwd(),
    spawn: spawnStub,
    tmpDir: tmp,
    stdout: out,
    stderr: err,
    scriptsDir: '/fake/scripts',
  });
  assert.equal(exitCode, 0);
  const payload = JSON.parse(out.lines.join(''));
  assert.equal(payload.ref, 'HEAD');
  assert.ok(payload.mi.envelope);
  assert.ok(payload.crap.envelope);
  assert.deepEqual(payload.merged.rows, []);
});

test('runCli — --staged forwards the flag to both gates', () => {
  const tmp = makeTmpDir();
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const seenArgs = [];
  const spawnStub = (_node, args) => {
    seenArgs.push(args.slice());
    const jsonIdx = args.indexOf('--json');
    const jsonPath = args[jsonIdx + 1];
    const isMi = args[0].endsWith('check-maintainability.js');
    const envelope = isMi ? makeMiEnvelope([], 0) : makeCrapEnvelope();
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(envelope));
    return { status: 0 };
  };
  runCli({
    argv: ['--changed-since', 'HEAD', '--staged'],
    cwd: process.cwd(),
    spawn: spawnStub,
    tmpDir: tmp,
    stdout: out,
    stderr: err,
    scriptsDir: '/fake/scripts',
  });
  assert.equal(seenArgs.length, 2);
  for (const args of seenArgs) {
    assert.ok(
      args.includes('--staged'),
      `expected --staged in ${args.join(' ')}`,
    );
    assert.ok(args.includes('--changed-since'));
  }
});
