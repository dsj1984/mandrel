/**
 * trend-units.test.js — the roll-up counts what the instrument measures, and
 * staleness runs on two clocks (Story #4962).
 *
 * Both defects this suite pins reported **zero movement while the surface
 * moved**, which is the worst failure mode a ratchet instrument has: it does
 * not fail, it reassures.
 *
 * 1. The trend fallback reduced per *file* for every kind, so
 *    `dead-exports-production` going 590 → 589 symbols across 187 files on
 *    both sides emitted `rowCount: 0`, and a 421-byte context-budget growth
 *    emitted `rowCount: 0` too. The fixtures below are those exact shapes.
 * 2. `staleDays` measured wall time only, so a baseline already predating
 *    merges that rescored its own rows read `staleDays: 0`.
 *
 * Every git call is injected, so nothing here depends on the repository's
 * real history — the shapes are the point, not the numbers of the day.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir } from '../../test-temp.js';
import { buildGateSurface } from '../gate-surface.js';
import { ALL_KINDS, measuredTotalOf, trendRollupOf } from '../kinds.js';
import { buildTrend } from '../trend.js';

/**
 * A dead-exports baseline of `symbols` rows spread over `files` files — the
 * on-disk grain is `{ file, symbol }`, which is exactly why a per-file
 * reduction loses the movement.
 *
 * @param {{ files: number, symbols: number }} shape
 * @returns {object}
 */
function deadExportsBaseline({ files, symbols }) {
  const rows = [];
  for (let i = 0; i < symbols; i += 1) {
    rows.push({ file: `lib/mod-${i % files}.js`, symbol: `sym${i}` });
  }
  return { generatedAt: '2026-08-02T00:00:00.000Z', rows };
}

/**
 * A context-budget baseline holding one tier of `bytes`-sized files.
 *
 * @param {number[]} bytes
 * @returns {object}
 */
function contextBudgetBaseline(bytes) {
  return {
    generatedAt: '2026-08-02T00:00:00.000Z',
    tiers: {
      alwaysLoaded: {
        files: bytes.map((size, i) => ({ path: `docs/f${i}.md`, bytes: size })),
      },
    },
  };
}

/**
 * Stand in for `git log` / `git show` over a scripted per-path history,
 * newest first — the two commands `buildTrend` issues.
 *
 * @param {Record<string, Array<{sha: string, committedAt: string, baseline: object}>>} history
 * @returns {Function}
 */
function fakeTrendGit(history) {
  return (_cmd, args) => {
    if (args[0] === 'log') {
      const relPath = args[args.length - 1];
      return (history[relPath] ?? [])
        .map((s) => `${s.sha} ${s.committedAt}`)
        .join('\n');
    }
    if (args[0] === 'show') {
      const [sha, relPath] = args[1].split(':');
      const sample = (history[relPath] ?? []).find((s) => s.sha === sha);
      if (!sample) throw new Error(`no blob at ${args[1]}`);
      return JSON.stringify(sample.baseline);
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

/**
 * Build a two-sample history for one kind and return its `trend[]` entry.
 *
 * @param {{ kind: string, previous: object, current: object }} args
 * @returns {object | undefined}
 */
function trendFor({ kind, previous, current }) {
  const relPath = `baselines/${kind}.json`;
  const run = fakeTrendGit({
    [relPath]: [
      {
        sha: 'b'.repeat(40),
        committedAt: '2026-08-02T23:00:00Z',
        baseline: current,
      },
      {
        sha: 'a'.repeat(40),
        committedAt: '2026-08-02T20:00:00Z',
        baseline: previous,
      },
    ],
  });
  const [entry] = buildTrend({
    cwd: '/nowhere',
    kinds: [kind],
    pathFor: () => relPath,
    run,
  });
  return entry;
}

describe('the trend roll-up counts the measured quantity, not the rows', () => {
  it('reports moving dead-export SYMBOLS while the file count holds constant', () => {
    // The exact shape observed on 2026-08-02: 187 files on both sides, one
    // symbol fewer on the newer side. The old per-file reduction emitted
    // `rowCount: 0` here — a clean ratchet report for a surface that moved.
    const entry = trendFor({
      kind: 'dead-exports-production',
      previous: deadExportsBaseline({ files: 187, symbols: 590 }),
      current: deadExportsBaseline({ files: 187, symbols: 589 }),
    });
    assert.deepEqual(entry.deltas, { symbols: -1 });
    assert.equal(entry.deltas.rowCount, undefined, 'rowCount must not survive');
  });

  it('reports context-budget movement in BYTES', () => {
    const entry = trendFor({
      kind: 'context-budget',
      previous: contextBudgetBaseline([1000, 2000, 3000]),
      current: contextBudgetBaseline([1000, 2421, 3000]),
    });
    assert.deepEqual(entry.deltas, { bytes: 421 });
  });

  it('keeps a declared rollup verbatim rather than overriding its axes', () => {
    const rollup = (percentage) => ({
      generatedAt: '2026-08-02T00:00:00.000Z',
      rollup: { '*': { percentage } },
      rows: [{ path: 'lib/a.js', percentage }],
    });
    const entry = trendFor({
      kind: 'duplication',
      previous: rollup(9),
      current: rollup(8.5),
    });
    assert.deepEqual(entry.deltas, { percentage: -0.5 });
  });

  it('names a non-additive metric filesTracked rather than summing scores', () => {
    // Averaging per-file percentages unweighted would fabricate a statistic.
    // Counting the rows is honest — provided the axis says so.
    const rows = (n) => ({
      generatedAt: '2026-08-02T00:00:00.000Z',
      rows: Array.from({ length: n }, (_, i) => ({
        path: `lib/a${i}.js`,
        lines: 90,
      })),
    });
    assert.deepEqual(trendRollupOf('coverage', rows(4)), { filesTracked: 4 });
  });

  it('gives every kind the engine walks a declared unit', () => {
    const undeclared = ALL_KINDS.filter(
      (kind) => measuredTotalOf(kind, { rows: [], cycles: [] }) === null,
    );
    assert.deepEqual(
      undeclared,
      [],
      'a kind with no declared unit falls back to no trend signal at all',
    );
  });
});

describe('gateSurface reports the measured total beside the row count', () => {
  it('separates 590 symbols from the 187 files they sit in', () => {
    const baseline = deadExportsBaseline({ files: 187, symbols: 590 });
    assert.deepEqual(measuredTotalOf('dead-exports-production', baseline), {
      unit: 'symbols',
      value: 590,
    });
  });
});

/**
 * Write a fixture repo root from `[relPath, body]` pairs.
 *
 * @param {Array<[string, object]>} files
 * @returns {string}
 */
function makeFixture(files) {
  const root = makeTempDir('audit-baselines-staleness-');
  for (const [rel, body] of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(body, null, 2));
  }
  return root;
}

/** A coverage baseline stamped now, with two rows to key the surface on. */
const FRESH_COVERAGE = {
  kernelVersion: '1.0.0',
  generatedAt: '2026-08-02T00:00:00.000Z',
  rollup: { '*': { lines: 90, branches: 80, functions: 85 } },
  rows: [
    { path: 'src/a.js', lines: 90, branches: 80, functions: 85 },
    { path: 'src/b.js', lines: 91, branches: 81, functions: 86 },
  ],
};

/**
 * Stand in for the two git commands `buildGateSurface` issues.
 *
 * @param {{ commits: number }} args
 * @returns {Function}
 */
function fakeSurfaceGit({ commits }) {
  return (_cmd, args) => {
    if (args[0] === 'log') return `${'c'.repeat(40)}\n`;
    if (args[0] === 'rev-list') return `${commits}\n`;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

/**
 * Index a fixture's surface entries by kind.
 *
 * @param {{ root: string, run: Function, quality?: object }} args
 * @returns {Map<string, object>}
 */
function surfaceOf({ root, run, quality = { gates: {} } }) {
  const { entries } = buildGateSurface({
    cwd: root,
    quality,
    now: new Date('2026-08-02T00:00:00.000Z'),
    run,
  });
  return new Map(entries.map((e) => [e.kind, e]));
}

describe('staleness accounts for commits, not only wall time', () => {
  it('reports a baseline stale at zero wall-clock days when the surface moved', () => {
    const byKind = surfaceOf({
      root: makeFixture([['baselines/coverage.json', FRESH_COVERAGE]]),
      run: fakeSurfaceGit({ commits: 4 }),
    });
    const coverage = byKind.get('coverage');
    assert.equal(coverage.staleDays, 0, 'the wall clock still reads fresh');
    assert.equal(coverage.staleCommits, 4);
    assert.equal(coverage.surfaceStale, true);
  });

  it('does not call a baseline stale when nothing has touched its surface', () => {
    const byKind = surfaceOf({
      root: makeFixture([['baselines/coverage.json', FRESH_COVERAGE]]),
      run: fakeSurfaceGit({ commits: 0 }),
    });
    assert.equal(byKind.get('coverage').staleCommits, 0);
    assert.equal(byKind.get('coverage').surfaceStale, false);
  });

  it('prefers the gate targetDirs over the row paths as the measured surface', () => {
    const seen = [];
    const run = (_cmd, args) => {
      if (args[0] === 'log') return `${'c'.repeat(40)}\n`;
      seen.push(args.slice(args.indexOf('--') + 1));
      return '2\n';
    };
    surfaceOf({
      root: makeFixture([['baselines/coverage.json', FRESH_COVERAGE]]),
      run,
      quality: { gates: { coverage: { targetDirs: ['src', 'lib'] } } },
    });
    assert.deepEqual(seen, [['src', 'lib']]);
  });

  it('reports unknown rather than zero when git cannot answer', () => {
    const byKind = surfaceOf({
      root: makeFixture([['baselines/coverage.json', FRESH_COVERAGE]]),
      run: () => {
        throw new Error('not a git work tree');
      },
    });
    assert.equal(byKind.get('coverage').staleCommits, null);
    assert.equal(byKind.get('coverage').surfaceStale, null);
  });

  it('claims nothing for a kind whose rows are not file paths', () => {
    // bundle-size keys on bundle names; handing one to git as a pathspec
    // would answer a question about a file that does not exist.
    const byKind = surfaceOf({
      root: makeFixture([
        [
          'baselines/bundle-size.json',
          {
            generatedAt: '2026-08-02T00:00:00.000Z',
            rows: [{ bundle: 'main', rawKb: 90 }],
          },
        ],
      ]),
      run: fakeSurfaceGit({ commits: 7 }),
    });
    assert.equal(byKind.get('bundle-size').staleCommits, null);
    assert.equal(byKind.get('bundle-size').surfaceStale, null);
  });

  it('claims nothing for a baseline that is not on disk', () => {
    const byKind = surfaceOf({
      root: makeFixture([]),
      run: fakeSurfaceGit({ commits: 7 }),
    });
    assert.equal(byKind.get('coverage').baselineExists, false);
    assert.equal(byKind.get('coverage').staleCommits, null);
    assert.equal(byKind.get('coverage').measured, null);
  });
});
