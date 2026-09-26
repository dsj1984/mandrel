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
import {
  computeContentDigest,
  isCoverageFresh,
  writeCaptureStamp,
} from '../../../.agents/scripts/lib/coverage-capture.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

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
});
