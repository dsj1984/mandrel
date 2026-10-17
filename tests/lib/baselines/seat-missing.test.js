/**
 * seat-missing.test.js — the insert-only `--seat-missing` baseline mode.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCrapSeatScorer,
  resolveCrapUpdaterOptions,
} from '../../../.agents/scripts/lib/baselines/crap-updater-cli.js';
import { refreshBaseline } from '../../../.agents/scripts/lib/baselines/refresh-service.js';
import {
  checkSeatResolution,
  runSeatMissing,
  SeatRefusal,
  seatKeyFor,
  seatMaintainabilityBaseline,
  seatMissingBaseline,
  selectMissingRows,
} from '../../../.agents/scripts/lib/baselines/seat-missing.js';
import {
  write as writeEnvelope,
  writeFile as writeEnvelopeFile,
} from '../../../.agents/scripts/lib/baselines/writer.js';
import { resolveQuality } from '../../../.agents/scripts/lib/config/quality.js';
import {
  computeContentDigest,
  computeTreeDigest,
  isCoverageFresh,
  writeCaptureStamp,
} from '../../../.agents/scripts/lib/coverage-capture.js';
import { scanAndScore } from '../../../.agents/scripts/lib/crap-utils.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import {
  FOLDED_ARROW_SOURCE,
  foldedArrowCoverageEntry,
} from '../../fixtures/v8-folded-arrow.js';

function tempDir() {
  return fs.realpathSync(makeTempDir('seat-missing-'));
}

/** Write a real envelope for `kind` and return its path and bytes. */
function seedBaseline(kind, rows) {
  const writePath = path.join(tempDir(), `${kind}.json`);
  writeEnvelopeFile(writePath, writeEnvelope({ kind, rows }));
  return { writePath, bytes: fs.readFileSync(writePath, 'utf8') };
}

function silentLogger() {
  const lines = [];
  return {
    lines,
    info: (s) => lines.push(s),
    warn: (s) => lines.push(s),
    error: (s) => lines.push(s),
  };
}

const CRAP_PRIOR = [
  { path: 'src/a.js', method: 'keep', startLine: 1, crap: 2 },
  { path: 'src/a.js', method: 'moves', startLine: 10, crap: 3 },
  { path: 'src/other.js', method: 'untouched', startLine: 4, crap: 5 },
];

/** Each prior row's serialised form, in order. */
function serialisedRows(rows) {
  return rows.map((r) => JSON.stringify(r, null, 2));
}

describe('seatKeyFor / selectMissingRows', () => {
  it('keys CRAP on path::method, so a method that only moved is not missing', () => {
    const missing = selectMissingRows({
      kind: 'crap',
      priorRows: CRAP_PRIOR,
      candidateRows: [
        { path: 'src/a.js', method: 'moves', startLine: 40, crap: 9 },
        { path: 'src/a.js', method: 'fresh', startLine: 50, crap: 1 },
      ],
    });
    assert.deepEqual(
      missing.map((r) => r.method),
      ['fresh'],
    );
  });

  it('keys maintainability on path', () => {
    assert.equal(
      seatKeyFor('maintainability')({ path: 'x.js', mi: 1 }),
      'x.js',
    );
    assert.throws(() => seatKeyFor('coverage'), /unsupported kind/);
  });
});

describe('seatMissingBaseline — CRAP (AC-1)', () => {
  it('writes exactly the two new methods; every prior row stays byte-identical', async () => {
    const { writePath } = seedBaseline('crap', CRAP_PRIOR);
    const before = JSON.parse(fs.readFileSync(writePath, 'utf8'));

    const result = await seatMissingBaseline({
      kind: 'crap',
      writePath,
      baseRef: 'origin/main',
      gitDiff: async () => ['src/a.js', 'docs/readme.md'],
      score: async (files) => {
        assert.deepEqual(files, ['src/a.js']);
        return [
          { file: 'src/a.js', method: 'keep', startLine: 3, crap: 7 },
          { file: 'src/a.js', method: 'moves', startLine: 12, crap: 11 },
          { file: 'src/a.js', method: 'addedOne', startLine: 20, crap: 1 },
          { file: 'src/a.js', method: 'addedTwo', startLine: 30, crap: 2 },
        ];
      },
    });

    assert.equal(result.seated, 2);
    assert.equal(result.wrote, true);
    const afterEnv = JSON.parse(fs.readFileSync(writePath, 'utf8'));
    assert.equal(afterEnv.rows.length, CRAP_PRIOR.length + 2);
    const priorKept = afterEnv.rows.filter(
      (r) => !['addedOne', 'addedTwo'].includes(r.method),
    );
    assert.deepEqual(serialisedRows(priorKept), serialisedRows(before.rows));
    for (const key of ['$schema', 'kernelVersion', 'scoringSemantics']) {
      assert.equal(afterEnv[key], before[key]);
    }
    const text = fs.readFileSync(writePath, 'utf8');
    for (const chunk of serialisedRows(before.rows)) {
      assert.ok(
        text.includes(chunk.replaceAll('\n', '\n    ')),
        'prior row bytes present verbatim',
      );
    }
  });
});

describe('seatMissingBaseline — nothing missing (AC-4)', () => {
  it('seats 0 and leaves the baseline bytes untouched', async () => {
    const { writePath, bytes } = seedBaseline('crap', CRAP_PRIOR);
    const result = await seatMissingBaseline({
      kind: 'crap',
      writePath,
      baseRef: 'origin/main',
      gitDiff: async () => ['src/a.js'],
      score: async () => [
        { file: 'src/a.js', method: 'keep', startLine: 1, crap: 99 },
      ],
    });
    assert.deepEqual(
      { seated: result.seated, wrote: result.wrote },
      { seated: 0, wrote: false },
    );
    assert.equal(fs.readFileSync(writePath, 'utf8'), bytes);
  });

  it('runSeatMissing reports `seated: 0` and exits 0', async () => {
    const { writePath, bytes } = seedBaseline('maintainability', [
      { path: 'src/a.js', mi: 90 },
    ]);
    const logger = silentLogger();
    const code = await runSeatMissing({
      kind: 'maintainability',
      label: 'Maintainability',
      writePath,
      logger,
      score: async () => [],
      seat: (opts) =>
        seatMissingBaseline({ ...opts, gitDiff: async () => ['src/a.js'] }),
    });
    assert.equal(code, 0);
    assert.ok(logger.lines.includes('[Maintainability] seated: 0'));
    assert.equal(fs.readFileSync(writePath, 'utf8'), bytes);
  });
});

describe('seatMissingBaseline — maintainability (AC-3)', () => {
  it('seats only absent paths and keeps existing rows byte-identical', async () => {
    const prior = [
      { path: 'src/a.js', mi: 90.5 },
      { path: 'src/z.js', mi: 80.25 },
    ];
    const { writePath } = seedBaseline('maintainability', prior);
    const before = JSON.parse(fs.readFileSync(writePath, 'utf8'));
    const result = await seatMissingBaseline({
      kind: 'maintainability',
      writePath,
      baseRef: 'origin/main',
      gitDiff: async () => ['src/a.js', 'src/new.js'],
      score: async () => [
        { path: 'src/a.js', mi: 70.1 },
        { path: 'src/new.js', mi: 88.8 },
      ],
    });
    assert.equal(result.seated, 1);
    const afterEnv = JSON.parse(fs.readFileSync(writePath, 'utf8'));
    assert.deepEqual(afterEnv.rows, [
      { path: 'src/a.js', mi: 90.5 },
      { path: 'src/new.js', mi: 88.8 },
      { path: 'src/z.js', mi: 80.25 },
    ]);
    assert.equal(afterEnv.kernelVersion, before.kernelVersion);
  });

  it('refuses --seat-missing with --full-scope', async () => {
    await assert.rejects(
      () =>
        seatMaintainabilityBaseline(['--seat-missing', '--full-scope'], {
          cwd: tempDir(),
        }),
      /incompatible with --seat-missing/,
    );
  });
});

describe('CRAP seat refusal (AC-2)', () => {
  const options = resolveCrapUpdaterOptions(
    { seatMissing: true },
    {
      crap: { targetDirs: ['src'] },
      baselines: { crap: { path: 'baselines/crap.json' } },
    },
    '/repo',
  );

  function seatScorer({ fresh = true, resolution }) {
    return buildCrapSeatScorer(options, {
      cwd: '/repo',
      isFresh: ({ requireScope }) => ({
        fresh: fresh && requireScope === 'incremental',
      }),
      loadCoverage: () => ({}),
      scan: async () => ({
        rows: [{ file: 'src/a.js', method: 'n', startLine: 1, crap: 1 }],
        scannedFiles: 1,
        resolution,
      }),
      logger: silentLogger(),
    });
  }

  async function assertRefusedUnchanged(score, pattern) {
    const { writePath, bytes } = seedBaseline('crap', CRAP_PRIOR);
    const logger = silentLogger();
    const code = await runSeatMissing({
      kind: 'crap',
      label: 'CRAP',
      writePath,
      logger,
      score,
      seat: (opts) =>
        seatMissingBaseline({ ...opts, gitDiff: async () => ['src/a.js'] }),
    });
    assert.equal(code, 1);
    assert.match(logger.lines.join('\n'), pattern);
    assert.match(logger.lines.join('\n'), /coverage-capture\.js --cwd \/repo/);
    assert.equal(fs.readFileSync(writePath, 'utf8'), bytes);
  }

  it('refuses below 100% resolution, naming the rate and the files', async () => {
    await assertRefusedUnchanged(
      seatScorer({
        resolution: {
          resolvedMethods: 81,
          joinableMethods: 100,
          rate: 0.81,
          worstFiles: [{ file: 'src/a.js', unresolved: 19, total: 100 }],
        },
      }),
      /81\/100 \(81\.0%\)[\s\S]*src\/a\.js \(19\/100 unresolved\)/,
    );
  });

  it('refuses a stale coverage artifact, naming the in-scope files', async () => {
    await assertRefusedUnchanged(
      seatScorer({ fresh: false }),
      /no coverage artifact .* is fresh[\s\S]*src\/a\.js/,
    );
  });

  it('proceeds at exactly 100% on any fresh stamp scope', async () => {
    const rows = await seatScorer({
      resolution: { resolvedMethods: 3, joinableMethods: 3, rate: 1 },
    })(['src/a.js']);
    assert.equal(rows.length, 1);
  });

  it('checkSeatResolution passes an empty join and refuses one miss', () => {
    assert.equal(checkSeatResolution(undefined, 'fix'), null);
    assert.match(
      checkSeatResolution({ resolvedMethods: 1, joinableMethods: 2 }, 'fix'),
      /50\.0%/,
    );
  });

  it('only a SeatRefusal maps to exit 1; other errors propagate', async () => {
    await assert.rejects(
      () =>
        runSeatMissing({
          kind: 'crap',
          label: 'CRAP',
          writePath: '/nope.json',
          logger: silentLogger(),
          seat: async () => {
            throw new Error('boom');
          },
        }),
      /boom/,
    );
    assert.ok(new SeatRefusal('x') instanceof Error);
  });

  const forbidden = (name) => () => {
    throw new Error(`${name} must not be called`);
  };

  function scopedScorer({ ignoreGlobs = [], fresh, scan }) {
    const scoped = resolveCrapUpdaterOptions(
      { seatMissing: true },
      {
        crap: { targetDirs: ['src'], ignoreGlobs },
        baselines: { crap: { path: 'baselines/crap.json' } },
      },
      '/repo',
    );
    return buildCrapSeatScorer(scoped, {
      cwd: '/repo',
      isFresh: fresh ?? forbidden('isFresh'),
      loadCoverage: fresh ? () => ({}) : forbidden('loadCoverage'),
      scan: scan ?? forbidden('scan'),
      logger: silentLogger(),
    });
  }

  async function seatOver(score, diff) {
    const { writePath, bytes } = seedBaseline('crap', CRAP_PRIOR);
    const logger = silentLogger();
    const code = await runSeatMissing({
      kind: 'crap',
      label: 'CRAP',
      writePath,
      logger,
      score,
      seat: (opts) =>
        seatMissingBaseline({ ...opts, gitDiff: async () => diff }),
    });
    return {
      code,
      log: logger.lines.join('\n'),
      unchanged: fs.readFileSync(writePath, 'utf8') === bytes,
    };
  }

  it('seats nothing and never reads coverage when no diff file is under targetDirs', async () => {
    const result = await seatOver(scopedScorer({}), [
      'scripts/verify.mjs',
      'scripts/verify.test.mjs',
      'src-other/x.js',
      'docs/notes.md',
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.unchanged, true);
    assert.match(result.log, /seated: 0/);
  });

  it('seats nothing when every targetDirs file matches ignoreGlobs', async () => {
    const result = await seatOver(
      scopedScorer({ ignoreGlobs: ['**/*.test.js'] }),
      ['src/a.test.js', 'scripts/verify.mjs'],
    );
    assert.equal(result.code, 0);
    assert.equal(result.unchanged, true);
    assert.match(result.log, /seated: 0/);
  });

  it('a mixed diff with no fresh artifact refuses naming only the in-scope files', async () => {
    const result = await seatOver(
      scopedScorer({
        ignoreGlobs: ['**/*.test.js'],
        fresh: () => ({ fresh: false }),
      }),
      ['scripts/verify.mjs', 'src/a.js', 'src/a.test.js'],
    );
    assert.equal(result.code, 1);
    assert.equal(result.unchanged, true);
    assert.match(result.log, /unresolved files: src\/a\.js\)/);
    assert.doesNotMatch(result.log, /scripts\/verify\.mjs|src\/a\.test\.js/);
  });

  it('hands the scan only the in-scope files', async () => {
    let scopeFiles;
    const score = scopedScorer({
      fresh: () => ({ fresh: true }),
      scan: async (opts) => {
        scopeFiles = opts.scopeFiles;
        return { rows: [], scannedFiles: 1 };
      },
    });
    await score(['scripts/verify.mjs', 'src/a.js', 'srcx/b.js']);
    assert.deepEqual(scopeFiles, ['src/a.js']);
  });
});

describe('CRAP seat reads the CRAP coverage source (Story #5717 AC-3)', () => {
  const COVERAGE_GATE_PATH = 'coverage/coverage-final.json';
  const CRAP_PATH = 'coverage-py/coverage-final.json';
  const ARTIFACTS = {
    // The coverage gate's artifact measures another language: no CRAP-target entry.
    [path.resolve('/repo', COVERAGE_GATE_PATH)]: { 'lib/other.js': {} },
    [path.resolve('/repo', CRAP_PATH)]: { 'src/a.js': {} },
  };

  function seatFor(gates) {
    const { crap } = resolveQuality({ gates });
    const options = resolveCrapUpdaterOptions(
      { seatMissing: true },
      { crap, baselines: { crap: { path: 'baselines/crap.json' } } },
      '/repo',
    );
    const loaded = [];
    const score = buildCrapSeatScorer(options, {
      cwd: '/repo',
      // Only the CRAP artifact carries a fresh capture stamp.
      isFresh: ({ coveragePath }) => ({ fresh: coveragePath === CRAP_PATH }),
      loadCoverage: (abs) => {
        loaded.push(abs);
        return ARTIFACTS[abs] ?? null;
      },
      scan: async ({ coverage, scopeFiles }) => {
        const resolved = scopeFiles.filter((f) => coverage[f]).length;
        return {
          rows: [{ file: 'src/a.js', method: 'added', startLine: 1, crap: 1 }],
          scannedFiles: scopeFiles.length,
          resolution: {
            resolvedMethods: resolved,
            joinableMethods: scopeFiles.length,
            rate: resolved / scopeFiles.length,
          },
        };
      },
      logger: silentLogger(),
    });
    return { options, loaded, score };
  }

  async function seat(score) {
    const { writePath } = seedBaseline('crap', CRAP_PRIOR);
    const logger = silentLogger();
    const code = await runSeatMissing({
      kind: 'crap',
      label: 'CRAP',
      writePath,
      logger,
      score,
      seat: (opts) =>
        seatMissingBaseline({ ...opts, gitDiff: async () => ['src/a.js'] }),
    });
    return { code, log: logger.lines.join('\n') };
  }

  it('an own crap.coveragePath seats rows from the CRAP artifact', async () => {
    const { options, loaded, score } = seatFor({
      crap: { targetDirs: ['src'], coveragePath: CRAP_PATH },
    });
    assert.equal(options.coveragePath, CRAP_PATH);
    const { code, log } = await seat(score);
    assert.equal(code, 0);
    assert.match(log, /seated: 1/);
    assert.deepEqual(loaded, [path.resolve('/repo', CRAP_PATH)]);
  });

  it('without the key the seat reads the coverage gate artifact and refuses', async () => {
    const { options, score } = seatFor({ crap: { targetDirs: ['src'] } });
    assert.equal(options.coveragePath, COVERAGE_GATE_PATH);
    const { code, log } = await seat(score);
    assert.equal(code, 1);
    assert.match(log, /coverage\/coverage-final\.json is fresh/);
  });

  it('--coverage still wins over config', () => {
    const { crap } = resolveQuality({
      gates: { crap: { coveragePath: CRAP_PATH } },
    });
    const options = resolveCrapUpdaterOptions(
      { coveragePath: 'elsewhere/cov.json' },
      { crap, baselines: { crap: { path: 'baselines/crap.json' } } },
      '/repo',
    );
    assert.equal(options.coveragePath, 'elsewhere/cov.json');
  });
});

describe('capture stamp vs a baseline-refresh commit (AC-6)', () => {
  it('a baseline-JSON-only commit leaves the stamp fresh; a source edit does not', () => {
    const cwd = tempDir();
    const git = (...args) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
    git('init', '-q');
    git('config', 'user.email', 'seat@test.local');
    git('config', 'user.name', 'seat');
    git('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.mkdirSync(path.join(cwd, 'baselines'));
    fs.mkdirSync(path.join(cwd, 'coverage'));
    fs.writeFileSync(path.join(cwd, 'src/a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(cwd, 'baselines/crap.json'), '{"rows":[]}\n');
    fs.writeFileSync(path.join(cwd, 'coverage/coverage-final.json'), '{}\n');
    git('add', 'src', 'baselines');
    git('commit', '-qm', 'seed');

    const probe = { coveragePath: 'coverage/coverage-final.json', cwd };
    const targetDirs = ['src', 'baselines'];
    assert.ok(
      writeCaptureStamp({
        ...probe,
        digest: computeContentDigest(cwd, targetDirs),
        treeDigest: computeTreeDigest(cwd, probe.coveragePath),
      }),
    );
    assert.equal(isCoverageFresh({ ...probe, targetDirs }).fresh, true);

    fs.writeFileSync(
      path.join(cwd, 'baselines/crap.json'),
      '{"rows":[{"path":"src/a.js"}]}\n',
    );
    git('commit', '-qam', 'baseline-refresh: seat src/a.js');
    assert.equal(isCoverageFresh({ ...probe, targetDirs }).fresh, true);

    fs.writeFileSync(path.join(cwd, 'src/a.js'), 'export const a = 2;\n');
    git('commit', '-qam', 'feat: change a');
    assert.equal(isCoverageFresh({ ...probe, targetDirs }).fresh, false);
  });

  // Story #5548: the suite reads more than the sources, so a test-only
  // commit after the capture must void the stamp a baseline commit keeps.
  it('a test-only commit voids the stamp', () => {
    const cwd = tempDir();
    const git = (...args) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
    git('init', '-q');
    git('config', 'user.email', 'seat@test.local');
    git('config', 'user.name', 'seat');
    git('config', 'commit.gpgsign', 'false');
    for (const dir of ['src', 'tests', 'coverage']) {
      fs.mkdirSync(path.join(cwd, dir));
    }
    fs.writeFileSync(path.join(cwd, 'src/a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(cwd, 'tests/a.test.js'), '// ok\n');
    fs.writeFileSync(path.join(cwd, 'coverage/coverage-final.json'), '{}\n');
    git('add', 'src', 'tests');
    git('commit', '-qm', 'seed');
    const probe = { coveragePath: 'coverage/coverage-final.json', cwd };
    const targetDirs = ['src'];
    writeCaptureStamp({
      ...probe,
      digest: computeContentDigest(cwd, targetDirs),
      treeDigest: computeTreeDigest(cwd, probe.coveragePath),
    });
    assert.equal(isCoverageFresh({ ...probe, targetDirs }).fresh, true);
    fs.writeFileSync(path.join(cwd, 'tests/a.test.js'), 'throw 1;\n');
    git('commit', '-qam', 'test: break a');
    assert.equal(isCoverageFresh({ ...probe, targetDirs }).fresh, false);
  });
});

/**
 * Story #5738 — the refresh scope predicate accepted `.jsx` while the CRAP/MI
 * walk skipped it, so a changed `.jsx` was in scope, produced no row, and
 * tripped the "scoped file(s) produced no baseline rows" refusal.
 */
describe('a changed .jsx file seats a CRAP row (Story #5738 AC-2)', () => {
  const JSX = [
    'export function App({ count }) {',
    '  if (count > 0) {',
    '    return <div>{count}</div>;',
    '  }',
    '  return <span>none</span>;',
    '}',
    '',
  ].join('\n');

  /** A fully-covered istanbul entry for `App` (line 1), keyed on `abs`. */
  function coverageFor(abs) {
    const statementMap = {};
    const hits = {};
    for (let i = 0; i < 4; i += 1) {
      statementMap[String(i)] = {
        start: { line: 2 + i, column: 0 },
        end: { line: 2 + i, column: 10 },
      };
      hits[String(i)] = 1;
    }
    return {
      [abs]: {
        path: abs,
        fnMap: {
          0: {
            name: 'App',
            decl: { start: { line: 1, column: 0 } },
            loc: { start: { line: 1, column: 0 }, end: { line: 6, column: 1 } },
            line: 1,
          },
        },
        f: { 0: 1 },
        statementMap,
        s: hits,
        branchMap: {},
        b: {},
      },
    };
  }

  function jsxRepo() {
    const cwd = tempDir();
    const abs = path.join(cwd, 'src', 'App.jsx');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSX);
    const coverage = coverageFor(abs);
    const score = async (files) =>
      (
        await scanAndScore({
          targetDirs: ['src'],
          coverage,
          cwd,
          scopeFiles: files,
        })
      ).rows;
    return { cwd, score };
  }

  it('--seat-missing seats the .jsx method', async () => {
    const { cwd, score } = jsxRepo();
    const { writePath } = seedBaseline('crap', CRAP_PRIOR);
    const result = await seatMissingBaseline({
      kind: 'crap',
      writePath,
      baseRef: 'origin/main',
      cwd,
      gitDiff: async () => ['src/App.jsx'],
      score,
    });
    assert.equal(result.seated, 1);
    const rows = JSON.parse(fs.readFileSync(writePath, 'utf8')).rows;
    assert.ok(
      rows.some((r) => r.path === 'src/App.jsx' && r.method === 'App'),
      'the .jsx method row is seated',
    );
  });

  it('a scoped refresh requiring rows does not refuse the .jsx', async () => {
    const { cwd, score } = jsxRepo();
    const { writePath } = seedBaseline('crap', CRAP_PRIOR);
    const result = await refreshBaseline({
      kind: 'crap',
      writePath,
      cwd,
      scopeFiles: ['src/App.jsx'],
      requireRowsForScopeFiles: true,
      scorer: score,
    });
    assert.ok(
      result.envelope.rows.some((r) => r.path === 'src/App.jsx'),
      'the .jsx row is written',
    );
  });
});

describe('CRAP seat over a V8-folded module-scope arrow (Story #5755 AC-1)', () => {
  function foldedRepo() {
    const cwd = tempDir();
    const abs = path.join(cwd, 'src', 'mod.js');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, FOLDED_ARROW_SOURCE);
    return { cwd, coverage: { [abs]: foldedArrowCoverageEntry(abs) } };
  }

  it('resolves every joinable method, so the scoped seat does not refuse', async () => {
    const { cwd, coverage } = foldedRepo();
    const summary = await scanAndScore({
      targetDirs: ['src'],
      coverage,
      cwd,
      scopeFiles: ['src/mod.js'],
    });
    assert.equal(summary.resolution.joinableMethods, 2);
    assert.equal(summary.resolution.resolvedMethods, 2);
    assert.equal(checkSeatResolution(summary.resolution, 'fix'), null);

    const { writePath } = seedBaseline('crap', CRAP_PRIOR);
    const result = await seatMissingBaseline({
      kind: 'crap',
      writePath,
      baseRef: 'origin/main',
      cwd,
      gitDiff: async () => ['src/mod.js'],
      score: async () => summary.rows,
    });
    assert.equal(result.seated, 2);
  });
});
