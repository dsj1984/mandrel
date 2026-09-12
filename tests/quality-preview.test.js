import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { envelopeExtras } from '../.agents/scripts/lib/baselines/kinds/crap.js';
import { runCrapPreview } from '../.agents/scripts/lib/baselines/preview-gates.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import {
  computeExitCode,
  mergeEnvelopes,
  parseChangedSinceArg,
  parseJsonFlag,
  parseStagedFlag,
  renderAdvisories,
  renderDiagnostics,
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

function _makeTmpDir() {
  return makeTempDir('quality-preview-test-');
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

test('quality:preview npm script keeps quality-preview.js LAST (passthrough reachability)', () => {
  // Story #4603 — load-bearing ordering, proven by experiment: for a compound
  // `A && B` npm script, `npm run <script> -- <args>` appends the passthrough
  // args to the LAST command ONLY. When quality-preview.js ran first, an
  // operator's `-- --changed-since <base>` landed on check-dead-exports.js
  // (which ignores unknown flags) and the MI gate silently scored against its
  // own default instead — printing a false green for a branch it never
  // compared. That is how #4593's -5.86 ratchet violation cleared review.
  //
  // Any command appended AFTER quality-preview.js re-breaks this. Keep the
  // flag-consuming gate last.
  // fileURLToPath (not `new URL(...).pathname`) so the drive letter resolves
  // correctly on Windows — the raw pathname is `/D:/…`, and path.join would
  // yield a doubled-drive `D:\D:\…` that ENOENTs. See Windows Smoke CI.
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const script = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).scripts[
    'quality:preview'
  ];
  const commands = script.split('&&').map((c) => c.trim());
  assert.ok(
    commands[commands.length - 1].includes('quality-preview.js'),
    `quality-preview.js must be the LAST command in the quality:preview script so ` +
      `npm's "--" passthrough reaches it; got: ${script}`,
  );
});

test('parseChangedSinceArg — last occurrence wins (npm-alias passthrough)', () => {
  // Story #4603. `npm run quality:preview -- --changed-since <base>` appends the
  // operator's flag AFTER any flag baked into the npm script. A first-wins scan
  // silently dropped the operator's base and scored against the script's
  // hardcoded `HEAD`, printing a false green for a branch it never compared.
  assert.equal(
    parseChangedSinceArg([
      '--changed-since',
      'HEAD',
      '--changed-since',
      'main',
    ]),
    'main',
  );
  assert.equal(
    parseChangedSinceArg([
      '--changed-since',
      'HEAD',
      '--json',
      '--changed-since',
      'cf90bea7',
    ]),
    'cf90bea7',
  );
  // A bare trailing flag still resolves to the documented HEAD default.
  assert.equal(
    parseChangedSinceArg(['--changed-since', 'main', '--changed-since']),
    'HEAD',
  );
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

// --- Story #4923 (AC-4): the flag ceiling is the resolved config value ------
//
// `codingGuardrails.cyclomaticFlag` was schema-validated, bootstrap-defaulted
// and resolver-resolved, then shadowed here by a literal `8` — so a consumer
// that tuned it saw the knob accepted and ignored. These two cases pin the
// tuned reading; a hardcoded literal cannot satisfy both.

test('mergeEnvelopes — the over-ceiling count uses the supplied cyclomaticFlag', () => {
  const crap = makeCrapEnvelope({
    newViolations: [
      {
        file: 'lib/b.js',
        cyclomatic: 6,
        crap: 35,
        baseline: null,
        ceiling: 30,
        kind: 'new',
      },
    ],
  });
  // c=6 is under the framework default of 8 …
  assert.equal(
    mergeEnvelopes(makeMiEnvelope([], 0), crap).rows[0].newOverCeilingMethods,
    0,
  );
  // … and over a tuned flag of 5.
  const tuned = mergeEnvelopes(makeMiEnvelope([], 0), crap, {
    cyclomaticFlag: 5,
  });
  assert.equal(tuned.rows[0].newOverCeilingMethods, 1);
  assert.equal(tuned.cyclomaticFlag, 5);
});

test('renderTable — the header names the flag the count was taken against', () => {
  const merged = mergeEnvelopes(makeMiEnvelope([], 0), makeCrapEnvelope(), {
    cyclomaticFlag: 5,
  });
  assert.match(renderTable(merged), /new-method count over c=5/);
});

test('renderTable — a merge result with no flag falls back to the default', () => {
  assert.match(
    renderTable({ rows: [], totals: { miRegressions: 0, crapViolations: 0 } }),
    /new-method count over c=8/,
  );
});

test('mergeEnvelopes — a non-numeric flag falls back to the framework default', () => {
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
  const merged = mergeEnvelopes(makeMiEnvelope([], 0), crap, {
    cyclomaticFlag: 'not-a-number',
  });
  assert.equal(merged.cyclomaticFlag, 8);
  // c=9 is over the fallback ceiling of 8, so the count still lands.
  assert.equal(merged.rows[0].newOverCeilingMethods, 1);
});

test('mergeEnvelopes — an unusable CRAP delta never becomes a worst delta', () => {
  const crap = makeCrapEnvelope({
    regressionViolations: [
      {
        file: 'lib/b.js',
        cyclomatic: 3,
        crap: Number.NaN,
        baseline: 4,
        ceiling: 30,
        kind: 'regression',
      },
    ],
  });
  const merged = mergeEnvelopes(makeMiEnvelope([], 0), crap);
  assert.equal(merged.rows[0].worstCrapDelta, 0);
});

test('runCli — reads the resolved cyclomaticFlag from the project config', async () => {
  const root = makeTempDir('quality-preview-flag-');
  fs.writeFileSync(
    path.join(root, '.agentrc.json'),
    JSON.stringify({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      github: { owner: 'x', repo: 'y', operatorHandle: '@ci' },
      delivery: { quality: { codingGuardrails: { cyclomaticFlag: 4 } } },
    }),
  );
  const out = makeStreamCapture();
  const { merged } = await runCli({
    argv: [],
    cwd: root,
    stdout: out,
    stderr: makeStreamCapture(),
    runMi: makeMiStub(makeMiEnvelope([], 0)),
    runCrap: makeCrapStub(makeCrapEnvelope()),
  });
  assert.equal(merged.cyclomaticFlag, 4);
  assert.match(out.lines.join(''), /new-method count over c=4/);
  fs.rmSync(root, { recursive: true, force: true });
});

function makeMiStub(envelope, exitCode = 0) {
  return async () => ({ exitCode, envelope });
}

function makeCrapStub(envelope, exitCode = 0) {
  return async () => ({ exitCode, envelope });
}

test('runCli — an unreadable config degrades to the framework flag, not a crash', async () => {
  // `quality:preview` is a developer-facing report: a tree whose `.agentrc.json`
  // cannot be parsed should still render its table at the framework default
  // rather than abort the pre-commit hook over a config error it did not cause.
  const root = makeTempDir('quality-preview-badcfg-');
  fs.writeFileSync(path.join(root, '.agentrc.json'), '{ not json');
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const { merged, exitCode } = await runCli({
    argv: [],
    cwd: root,
    stdout: out,
    stderr: err,
    runMi: makeMiStub(makeMiEnvelope([], 0)),
    runCrap: makeCrapStub(makeCrapEnvelope()),
  });
  assert.equal(exitCode, 0);
  assert.equal(merged.cyclomaticFlag, 8);
  assert.match(err.lines.join(''), /config resolution failed/);
  assert.match(out.lines.join(''), /new-method count over c=8/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('runCli — passing pair returns empty envelopes and exits 0', async () => {
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const { exitCode, merged } = await runCli({
    argv: ['--changed-since', 'HEAD'],
    cwd: process.cwd(),
    stdout: out,
    stderr: err,
    runMi: makeMiStub(makeMiEnvelope([], 0)),
    runCrap: makeCrapStub(makeCrapEnvelope()),
  });
  assert.equal(exitCode, 0);
  assert.equal(merged.rows.length, 0);
  const joined = out.lines.join('');
  assert.match(joined, /quality:preview/);
  assert.match(joined, /file \| MI delta/);
});

test('runCli — MI-only failure flips exit to 1 and prints the offending row', async () => {
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const { exitCode, merged } = await runCli({
    argv: ['--changed-since', 'HEAD'],
    cwd: process.cwd(),
    stdout: out,
    stderr: err,
    runMi: makeMiStub(
      makeMiEnvelope([
        {
          file: 'lib/a.js',
          current: 70.1,
          baseline: 75.0,
          drop: 4.9,
          kind: 'regression',
        },
      ]),
      1,
    ),
    runCrap: makeCrapStub(makeCrapEnvelope()),
  });
  assert.equal(exitCode, 1);
  assert.equal(merged.rows.length, 1);
  assert.equal(merged.rows[0].file, 'lib/a.js');
  assert.match(out.lines.join(''), /lib\/a\.js/);
});

test('runCli — CRAP-only failure flips exit to 1', async () => {
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const { exitCode, merged } = await runCli({
    argv: ['--changed-since', 'HEAD'],
    cwd: process.cwd(),
    stdout: out,
    stderr: err,
    runMi: makeMiStub(makeMiEnvelope([], 0)),
    runCrap: makeCrapStub(
      makeCrapEnvelope({
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
      }),
      1,
    ),
  });
  assert.equal(exitCode, 1);
  assert.equal(merged.rows.length, 1);
  assert.equal(merged.rows[0].file, 'lib/b.js');
});

test('runCli — mixed-fail surfaces both files and exits 1', async () => {
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const { exitCode, merged } = await runCli({
    argv: ['--changed-since', 'HEAD'],
    cwd: process.cwd(),
    stdout: out,
    stderr: err,
    runMi: makeMiStub(
      makeMiEnvelope([{ file: 'lib/a.js', drop: 2.0, kind: 'regression' }]),
      1,
    ),
    runCrap: makeCrapStub(
      makeCrapEnvelope({
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
      }),
      1,
    ),
  });
  assert.equal(exitCode, 1);
  assert.equal(merged.rows.length, 2);
});

test('runCli — --json mode emits structured envelope to stdout', async () => {
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const { exitCode } = await runCli({
    argv: ['--changed-since', 'HEAD', '--json'],
    cwd: process.cwd(),
    stdout: out,
    stderr: err,
    runMi: makeMiStub(makeMiEnvelope([], 0)),
    runCrap: makeCrapStub(makeCrapEnvelope()),
  });
  assert.equal(exitCode, 0);
  const payload = JSON.parse(out.lines.join(''));
  assert.equal(payload.ref, 'HEAD');
  assert.ok(payload.mi.envelope);
  assert.ok(payload.crap.envelope);
  assert.deepEqual(payload.merged.rows, []);
});

test('runCli — --staged forwards staged mode to preview runners', async () => {
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  let miOpts;
  let crapOpts;
  const { exitCode } = await runCli({
    argv: ['--staged'],
    cwd: process.cwd(),
    stdout: out,
    stderr: err,
    runMi: async (opts) => {
      miOpts = opts;
      return { exitCode: 0, envelope: makeMiEnvelope([], 0) };
    },
    runCrap: async (opts) => {
      crapOpts = opts;
      return { exitCode: 0, envelope: makeCrapEnvelope() };
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(miOpts.staged, true);
  assert.equal(crapOpts.staged, true);
  assert.equal(miOpts.changedSinceRef, null);
  assert.equal(crapOpts.changedSinceRef, null);
  assert.match(out.lines.join(''), /scope=staged \(git diff --cached\)/);
});

test('runCli — --changed-since without --staged keeps ref-based diff mode', async () => {
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  let miOpts;
  await runCli({
    argv: ['--changed-since', 'main'],
    cwd: process.cwd(),
    stdout: out,
    stderr: err,
    runMi: async (opts) => {
      miOpts = opts;
      return { exitCode: 0, envelope: makeMiEnvelope([], 0) };
    },
    runCrap: makeCrapStub(makeCrapEnvelope()),
  });
  assert.equal(miOpts.staged, false);
  assert.equal(miOpts.changedSinceRef, 'main');
  assert.match(out.lines.join(''), /scope=diff ref=main/);
});

// ---------------------------------------------------------------------------
// Story #4866 — the preview gate's unsound-basis backstop.
//
// The pre-commit preview is not the authoritative gate; `check-baselines`
// gates the merge. So when the preview establishes that its own comparison
// basis cannot produce a meaningful verdict, blocking the commit costs a
// provably defect-free commit while failing open costs no real coverage. It
// says so once, by name, and exits 0.
// ---------------------------------------------------------------------------

/**
 * Build a minimal but real consumer tree the CRAP preview can run against.
 *
 * `withCoverage: false` (Story #4871) omits the coverage artifact entirely —
 * the shape of a freshly initialized story worktree, whose first commit must
 * not be failed on files it never touched.
 */
function makeCrapFixture({
  methodCount,
  baselineRows,
  scoringSemantics,
  // Story #4986: written to the envelope only when set, so the #4901 cases
  // below keep testing an unstamped baseline. Defaulting it on would make the
  // stamped path the only one anything exercises — which is how the legacy
  // projection dropped it undetected in the first place.
  provenanceStamped,
  withCoverage = true,
  cyclomaticPerMethod = 1,
}) {
  const dir = fs.realpathSync(makeTempDir('crap_preview_'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'baselines'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.agentrc.json'),
    JSON.stringify({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      delivery: { quality: { gates: { crap: { targetDirs: ['src'] } } } },
    }),
  );

  // One method per line keeps the fixture's coordinates trivially readable.
  // `cyclomaticPerMethod: 2` adds a branch so the row clears the c=1
  // regression exemption and a real CRAP regression can actually be observed.
  const lines = [];
  for (let i = 0; i < methodCount; i += 1) {
    lines.push(
      cyclomaticPerMethod > 1
        ? `export function m${i}(x) { return x ? x + ${i} : ${i}; }`
        : `export function m${i}(x) { return x + ${i}; }`,
    );
  }
  const absSrc = path.join(dir, 'src', 'mod.js');
  fs.writeFileSync(absSrc, `${lines.join('\n')}\n`);

  const fnMap = {};
  const statementMap = {};
  const f = {};
  const s = {};
  for (let i = 0; i < methodCount; i += 1) {
    const line = i + 1;
    fnMap[String(i)] = {
      name: `m${i}`,
      decl: { start: { line, column: 0 } },
      loc: { start: { line, column: 0 }, end: { line, column: 60 } },
    };
    f[String(i)] = 1;
    statementMap[String(i)] = {
      start: { line, column: 0 },
      end: { line, column: 60 },
    };
    s[String(i)] = 1;
  }
  if (withCoverage) {
    fs.writeFileSync(
      path.join(dir, 'coverage', 'coverage-final.json'),
      JSON.stringify({
        [absSrc]: {
          path: absSrc,
          fnMap,
          f,
          statementMap,
          s,
          branchMap: {},
          b: {},
        },
      }),
    );
  }

  fs.writeFileSync(
    path.join(dir, 'baselines', 'crap.json'),
    JSON.stringify({
      $schema: '.agents/schemas/baselines/crap.schema.json',
      kernelVersion: '0.1.0',
      generatedAt: new Date().toISOString(),
      scoringSemantics:
        scoringSemantics === undefined
          ? envelopeExtras().scoringSemantics
          : scoringSemantics,
      ...(provenanceStamped === undefined ? {} : { provenanceStamped }),
      rollup: { '*': { p50: 1, p95: 1, max: 1, methodsAbove20: 0 } },
      rows: baselineRows,
    }),
  );
  return dir;
}

function rmFixture(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

/** Baseline rows for `methodCount` methods, each shifted by `lineOffset`. */
function baselineRowsFor(methodCount, lineOffset, crap = 1, extra = {}) {
  const rows = [];
  for (let i = 0; i < methodCount; i += 1) {
    rows.push({
      path: 'src/mod.js',
      method: `m${i}`,
      startLine: i + 1 + lineOffset,
      crap,
      ...extra,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Story #4871 — the backstop must measure what it claims to measure.
//
// #4866's numerator was `drifted + incomparable`, but a row reaches the drift
// arm only AFTER passing the provenance filter — so `drifted` counts rows
// whose coordinate systems AGREED and can never evidence a mismatch. On this
// pure-JavaScript repository the ratio therefore tripped on every diff,
// suppressing the gate's verdicts while it still reported success.
// ---------------------------------------------------------------------------

describe('runCrapPreview — the backstop measures coordinate mixing (#4871)', () => {
  it('reports a per-method regression on a pure-JavaScript diff (AC-1, AC-4)', async () => {
    // Every baseline row sits 1000 lines away, so EVERY row drifts — the shape
    // that used to suppress the run. Coordinates are uniform (plain .js), so
    // the basis is sound and a real regression must surface as a verdict.
    const methodCount = 25;
    const dir = makeCrapFixture({
      methodCount,
      cyclomaticPerMethod: 2,
      baselineRows: baselineRowsFor(methodCount, 1000, 0),
    });
    try {
      const { exitCode, envelope } = await runCrapPreview({ cwd: dir });
      assert.equal(envelope.summary.drifted, methodCount, 'all rows drifted');
      assert.equal(envelope.summary.provenanceMismatched, 0);
      assert.equal(
        envelope.diagnostics,
        undefined,
        'uniform provenance must never suppress',
      );
      assert.ok(
        envelope.summary.regressions > 0,
        'the per-method verdict must be reported, not suppressed',
      );
      assert.ok(envelope.violations.length > 0);
      assert.equal(exitCode, 1);
    } finally {
      rmFixture(dir);
    }
  });

  it('still suppresses, names, and exits 0 on genuine mixing (AC-3, AC-8)', async () => {
    // Baseline rows stamped `transpiled` against an original-coordinate
    // JavaScript scan: a real provenance mismatch on every row.
    const methodCount = 25;
    const dir = makeCrapFixture({
      methodCount,
      cyclomaticPerMethod: 2,
      baselineRows: baselineRowsFor(methodCount, 1000, 0, {
        coordinateSystem: 'transpiled',
      }),
    });
    try {
      const { exitCode, envelope } = await runCrapPreview({ cwd: dir });
      assert.equal(exitCode, 0, 'the preview gate must fail OPEN');
      assert.deepEqual(envelope.violations, []);
      assert.equal(envelope.summary.regressions, 0);
      assert.equal(envelope.summary.newViolations, 0);
      assert.equal(envelope.diagnostics.length, 1, 'exactly ONE diagnostic');
      assert.equal(
        envelope.diagnostics[0].name,
        'crap-unsound-comparison-basis',
      );
      assert.match(envelope.diagnostics[0].message, /line coordinates/);
      assert.match(envelope.diagnostics[0].message, /crap:update/);
      // The evidence stays — only the accusations go.
      assert.equal(envelope.summary.provenanceMismatched, methodCount);
      assert.equal(envelope.summary.incomparable, methodCount);
    } finally {
      rmFixture(dir);
    }
  });

  it('leaves an exactly-keyed comparison reporting normally', async () => {
    const methodCount = 25;
    const dir = makeCrapFixture({
      methodCount,
      baselineRows: baselineRowsFor(methodCount, 0, 0),
    });
    try {
      const { exitCode, envelope } = await runCrapPreview({ cwd: dir });
      assert.equal(envelope.summary.drifted, 0);
      assert.equal(envelope.diagnostics, undefined);
      // c=1 methods are exempt from the regression arm, so this fixture is
      // clean — what matters is that no diagnostic replaced the verdicts.
      assert.equal(exitCode, 0);
      assert.equal(envelope.summary.total, methodCount);
    } finally {
      rmFixture(dir);
    }
  });
});

describe('runCrapPreview — absent coverage is not zero coverage (#4871)', () => {
  it('reports methods unscorable instead of scoring them at 0% (AC-5, AC-7)', async () => {
    // A freshly initialized story worktree has no coverage directory. Filling
    // an absent observation with 0% drives CRAP to c²+c and fails the first
    // commit on files the Story never touched.
    const methodCount = 25;
    const dir = makeCrapFixture({
      methodCount,
      cyclomaticPerMethod: 2,
      withCoverage: false,
      baselineRows: baselineRowsFor(methodCount, 0, 0),
    });
    try {
      const { exitCode, envelope } = await runCrapPreview({ cwd: dir });
      assert.equal(exitCode, 0, 'a coverage-less worktree must not fail');
      assert.deepEqual(envelope.violations, []);
      assert.equal(envelope.summary.regressions, 0);
      assert.equal(envelope.summary.newViolations, 0);
      assert.ok(
        envelope.summary.unscorable > 0,
        'the unscorable methods must be reported, not silently absent',
      );
    } finally {
      rmFixture(dir);
    }
  });

  it('does not let unscorable rows suppress the basis (AC-6)', async () => {
    // Uniform coordinates plus a pile of unscorable rows must still produce a
    // sound basis — the unscorable count cannot become a suppression lever.
    const methodCount = 25;
    const dir = makeCrapFixture({
      methodCount,
      withCoverage: false,
      baselineRows: baselineRowsFor(methodCount, 1000, 0),
    });
    try {
      const { envelope } = await runCrapPreview({ cwd: dir });
      assert.equal(envelope.diagnostics, undefined);
    } finally {
      rmFixture(dir);
    }
  });
});

describe('runCrapPreview — compat check runs BEFORE the compare (AC-6)', () => {
  it('yields the named diagnostic instead of per-method regressions', async () => {
    const methodCount = 25;
    const dir = makeCrapFixture({
      methodCount,
      baselineRows: baselineRowsFor(methodCount, 1000, 0),
      scoringSemantics: 'coverage-join-v1',
    });
    try {
      const { exitCode, envelope } = await runCrapPreview({ cwd: dir });
      assert.equal(exitCode, 0);
      assert.deepEqual(envelope.violations, []);
      assert.equal(envelope.diagnostics[0].name, 'crap-baseline-incompatible');
      assert.match(
        envelope.diagnostics[0].message,
        /scoring semantics changed/,
      );
      // Nothing was compared: the incompatible envelope is refused before the
      // scan's rows ever meet it.
      assert.equal(envelope.summary.total, 0);
      assert.equal(envelope.summary.drifted, 0);
    } finally {
      rmFixture(dir);
    }
  });

  it('lets a compatible baseline through to the compare', async () => {
    const methodCount = 25;
    const dir = makeCrapFixture({
      methodCount,
      baselineRows: baselineRowsFor(methodCount, 0, 0),
    });
    try {
      const { envelope } = await runCrapPreview({ cwd: dir });
      assert.equal(envelope.summary.total, methodCount);
    } finally {
      rmFixture(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Story #4901 — the upgrade door. A baseline written before provenance
// stamping asserts by omission that all its rows are original coordinates.
// The preview must fail OPEN and say "re-seed", not emit regressions derived
// from a join it cannot key.
// ---------------------------------------------------------------------------
describe('runCrapPreview — a pre-provenance baseline is refused (#4901)', () => {
  it('exits 0, suppresses verdicts, and names the re-seed remedy', async () => {
    const methodCount = 25;
    // A TS row with no `provenanceStamped` marker: the pre-#4866 writer's
    // exact output shape, and the one the ts-transpiler axis deliberately
    // exempts.
    const baselineRows = [
      ...baselineRowsFor(methodCount, 0, 0),
      { path: 'src/legacy.tsx', method: 'render', startLine: 458, crap: 2 },
    ];
    const dir = makeCrapFixture({ methodCount, baselineRows });
    try {
      const { exitCode, envelope } = await runCrapPreview({ cwd: dir });
      assert.equal(exitCode, 0, 'the preview fails open, never closed');
      assert.deepEqual(envelope.violations, []);
      assert.equal(envelope.diagnostics[0].name, 'crap-baseline-incompatible');
      assert.match(
        envelope.diagnostics[0].message,
        /predates coordinate-provenance stamping/,
      );
      assert.match(
        envelope.diagnostics[0].message,
        /crap:update -- --full-scope/,
      );
      // Refused before the scan's rows ever meet it.
      assert.equal(envelope.summary.total, 0);
    } finally {
      rmFixture(dir);
    }
  });

  // Story #4986 — the case #4901 never wrote, and the reason its regression
  // shipped. Every test above drives an UNSTAMPED baseline, so the preview's
  // read path could drop `provenanceStamped` entirely and the suite stayed
  // green. This is the door a real consumer walks through on every commit:
  // a current writer's stamp, a TS row, and an expectation that the gate
  // compares instead of refusing.
  it('accepts a stamped TS baseline and actually compares it (#4986)', async () => {
    const methodCount = 25;
    const baselineRows = [
      ...baselineRowsFor(methodCount, 0, 0),
      { path: 'src/legacy.tsx', method: 'render', startLine: 458, crap: 2 },
    ];
    const dir = makeCrapFixture({
      methodCount,
      baselineRows,
      provenanceStamped: true,
    });
    try {
      const { exitCode, envelope } = await runCrapPreview({ cwd: dir });
      assert.equal(exitCode, 0);
      assert.deepEqual(
        envelope.diagnostics ?? [],
        [],
        'the pre-commit arm refused a baseline the authoritative gate accepts',
      );
      // The assertion that separates "accepted" from "silently suppressed":
      // a refused envelope reports zero rows compared, so only a non-zero
      // total proves the scan's rows actually met the baseline.
      assert.equal(envelope.summary.total, methodCount);
    } finally {
      rmFixture(dir);
    }
  });

  it('leaves a pure-JavaScript baseline alone even without the marker', async () => {
    // The invariant that keeps every JS consumer (this repo included) off the
    // re-seed path: no transpiled row means no coordinate that could be wrong.
    const methodCount = 25;
    const dir = makeCrapFixture({
      methodCount,
      baselineRows: baselineRowsFor(methodCount, 0, 0),
    });
    try {
      const { envelope } = await runCrapPreview({ cwd: dir });
      assert.deepEqual(envelope.diagnostics ?? [], []);
      assert.equal(envelope.summary.total, methodCount);
    } finally {
      rmFixture(dir);
    }
  });
});

test('renderDiagnostics — a suppressed gate is never silent', () => {
  assert.equal(renderDiagnostics([{ envelope: null }, { envelope: {} }]), null);
  const rendered = renderDiagnostics([
    { envelope: null },
    {
      envelope: {
        diagnostics: [
          { name: 'crap-unsound-comparison-basis', message: 're-seed me' },
        ],
      },
    },
  ]);
  assert.match(rendered, /\[crap-unsound-comparison-basis\] re-seed me/);
});

test('runCli — prints the diagnostic even though the gate exits 0', async () => {
  // The gate fails open, so without this the operator would see a clean table
  // and no hint that the verdicts were suppressed.
  const out = [];
  const { exitCode } = await runCli({
    argv: [],
    cwd: process.cwd(),
    stdout: { write: (s) => out.push(s) },
    stderr: { write: () => {} },
    runMi: async () => ({
      exitCode: 0,
      envelope: { violations: [], summary: { regressions: 0 } },
    }),
    runCrap: async () => ({
      exitCode: 0,
      envelope: {
        violations: [],
        summary: { regressions: 0, newViolations: 0 },
        diagnostics: [
          {
            name: 'crap-unsound-comparison-basis',
            message: 'basis unsound; re-seed the baseline',
          },
        ],
      },
    }),
  });
  assert.equal(exitCode, 0);
  const printed = out.join('');
  assert.match(printed, /crap-unsound-comparison-basis/);
  assert.match(printed, /re-seed the baseline/);
});

// ---------------------------------------------------------------------------
// Story #5313 — a method at cyclomatic 12 or above is an ADVISORY: reported,
// never a verdict. The ratchet in check-cyclomatic.js owns enforcement.
// ---------------------------------------------------------------------------

test('AC-9: mergeEnvelopes carries the scan advisories and computeExitCode ignores them', () => {
  const crap = {
    ...makeCrapEnvelope(),
    cyclomaticAdvisories: [
      { file: 'lib/a.js', method: 'branchy', startLine: 10, cyclomatic: 12 },
      { file: 'lib/b.js', method: 'worse', startLine: 3, cyclomatic: 19 },
    ],
  };
  const merged = mergeEnvelopes(makeMiEnvelope([], 0), crap);
  assert.equal(merged.rows.length, 0, 'an advisory is not a regression row');
  assert.deepEqual(
    merged.advisories.map((a) => a.cyclomatic),
    [12, 19],
  );
  assert.equal(computeExitCode(merged, 0, 0), 0);
});

test('AC-9: runCli reports a c=12 method as an advisory and exits 0 on it', async () => {
  const out = makeStreamCapture();
  const { exitCode, merged } = await runCli({
    argv: ['--changed-since', 'HEAD'],
    cwd: process.cwd(),
    stdout: out,
    stderr: makeStreamCapture(),
    runMi: makeMiStub(makeMiEnvelope([], 0)),
    runCrap: makeCrapStub({
      ...makeCrapEnvelope(),
      cyclomaticAdvisories: [
        { file: 'lib/a.js', method: 'branchy', startLine: 10, cyclomatic: 12 },
      ],
    }),
  });
  assert.equal(exitCode, 0);
  assert.equal(merged.advisories.length, 1);
  const text = out.lines.join('');
  assert.match(text, /Advisory — 1 method\(s\) at cyclomatic 12 or above/);
  assert.match(text, /lib\/a\.js:10 branchy \(c=12\)/);
  assert.match(text, /reported, not a verdict/);
});

test('renderAdvisories is silent without advisories and tolerates a missing list', () => {
  assert.equal(renderAdvisories([]), null);
  assert.equal(renderAdvisories(undefined), null);
  assert.deepEqual(
    mergeEnvelopes(makeMiEnvelope([], 0), makeCrapEnvelope()).advisories,
    [],
  );
});
