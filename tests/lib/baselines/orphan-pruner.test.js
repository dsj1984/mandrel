// tests/lib/baselines/orphan-pruner.test.js
/**
 * Story #5012 — the measurement-free orphan pruner.
 *
 * The pruner is the remedy that makes the scope gate's hard failure fair, so
 * what it MUST NOT do is as load-bearing as what it does. Two prohibitions
 * are pinned below, each guarding a way a pruned file could start lying:
 *
 *  - **Never add a row.** Adding one claims a measurement nobody took.
 *  - **Never delete a row it cannot prove inert.** Only two classes qualify:
 *    the file is absent from disk, or it has left the gate's own scope.
 *
 * Plus the two failure modes: a pruned envelope must stay schema-valid with
 * only `rows` changed (the committed shape carries no rollup — readers derive
 * it from the surviving rows, Story #5400), and an unreadable scope config
 * must degrade to orphan-only rather than reading unknown scope as empty
 * scope — which would hand the pruner the entire baseline.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { rollupOfRows } from '../../../.agents/scripts/lib/audit-baselines/rollup.js';
import { currentKernelVersion } from '../../../.agents/scripts/lib/baselines/kernel.js';
import { load } from '../../../.agents/scripts/lib/baselines/reader.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import {
  PRUNABLE_KINDS,
  planPrune,
  pruneEnvelope,
  runPrune,
} from '../../../scripts/lib/baselines/orphan-pruner.js';
import { EXTRA_REASONS } from '../../../scripts/lib/baselines/scope-assert.js';

const CLI = fileURLToPath(
  new URL('../../../scripts/prune-baseline-orphans.js', import.meta.url),
);

const TMP = fs.realpathSync(makeTempDir('orphan-pruner-'));

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let fixtureSeq = 0;

/**
 * A throwaway repo with `src/kept.js` and `src/ignored.js` on disk, a
 * maintainability baseline carrying a row for each of those plus one for a
 * file that no longer exists, and a gate config that ignores `src/ignored.js`.
 *
 * One fixture covers both prunable classes and the must-survive case, which is
 * what makes "exactly these two classes and nothing else" checkable in a
 * single assertion rather than three that could each pass in isolation.
 *
 * @param {{ withAgentrc?: boolean }} [opts]
 * @returns {{ root: string, baselinePath: string }}
 */
function fixture({ withAgentrc = true } = {}) {
  fixtureSeq += 1;
  const root = path.join(TMP, `repo-${fixtureSeq}`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/kept.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src/ignored.js'), 'export const b = 2;\n');

  const baselinePath = path.join(root, 'baselines/maintainability.json');
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        $schema: '.agents/schemas/baselines/maintainability.schema.json',
        kernelVersion: currentKernelVersion('maintainability'),
        rows: [
          { path: 'src/deleted.js', mi: 10 },
          { path: 'src/ignored.js', mi: 20 },
          { path: 'src/kept.js', mi: 90 },
        ],
      },
      null,
      2,
    )}\n`,
  );

  if (withAgentrc) {
    fs.writeFileSync(
      path.join(root, '.agentrc.json'),
      JSON.stringify(
        {
          project: {
            baseBranch: 'main',
            paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
            docsContextFiles: [],
            commands: { test: 'echo', typecheck: 'echo' },
          },
          github: { owner: 'x', repo: 'y', operatorHandle: '@ci' },
          delivery: {
            quality: {
              gates: {
                maintainability: {
                  enabled: true,
                  targetDirs: ['src'],
                  ignoreGlobs: ['src/ignored.js'],
                  floors: { '*': { min: 1 } },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );
  }
  return { root, baselinePath };
}

/** The quality block the fixture's `.agentrc.json` encodes. */
const QUALITY = {
  gates: {
    maintainability: { targetDirs: ['src'], ignoreGlobs: ['src/ignored.js'] },
  },
};

/**
 * @param {string} baselinePath
 * @returns {object}
 */
function readJson(baselinePath) {
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
}

describe('planPrune — exactly two provably-inert classes (AC-7)', () => {
  test('drops the absent-from-disk row and keeps everything measurable', () => {
    const { removed, keep } = planPrune({
      rows: [{ path: 'src/kept.js' }, { path: 'src/deleted.js' }],
      inScope: new Set(['src/kept.js', 'src/deleted.js']),
      existsOnDisk: (file) => file !== 'src/deleted.js',
    });

    assert.deepEqual(removed, [
      { path: 'src/deleted.js', reason: EXTRA_REASONS.ABSENT },
    ]);
    assert.deepEqual(keep, [{ path: 'src/kept.js' }]);
  });

  test('drops the out-of-scope row while its file stays on disk', () => {
    const { removed, keep } = planPrune({
      rows: [{ path: 'src/kept.js' }, { path: 'src/ignored.js' }],
      inScope: new Set(['src/kept.js']),
      existsOnDisk: () => true,
    });

    assert.deepEqual(removed, [
      { path: 'src/ignored.js', reason: EXTRA_REASONS.OUT_OF_SCOPE },
    ]);
    assert.deepEqual(keep, [{ path: 'src/kept.js' }]);
  });

  test('unknown scope prunes orphans only — an in-scope-unknown row survives', () => {
    const { removed, keep } = planPrune({
      rows: [{ path: 'src/kept.js' }, { path: 'src/deleted.js' }],
      inScope: null,
      existsOnDisk: (file) => file !== 'src/deleted.js',
    });

    assert.deepEqual(
      removed.map((row) => row.reason),
      [EXTRA_REASONS.ABSENT],
    );
    assert.deepEqual(keep, [{ path: 'src/kept.js' }]);
  });

  test('a row with no usable path is kept, never silently swept', () => {
    const { removed, keep } = planPrune({
      rows: [{ mi: 5 }, { path: '' }],
      inScope: new Set(),
      existsOnDisk: () => false,
    });

    assert.deepEqual(removed, []);
    assert.equal(keep.length, 2);
  });
});

describe('runPrune — the file on disk (AC-7, AC-8)', () => {
  test('prunes both classes, keeps the measured row, and adds nothing', () => {
    const { root, baselinePath } = fixture();

    const report = runPrune({
      cwd: root,
      kinds: ['maintainability'],
      quality: QUALITY,
    });
    const after = readJson(baselinePath);

    assert.equal(report.removedCount, 2);
    assert.equal(report.writtenCount, 1);
    assert.deepEqual(
      after.rows.map((row) => row.path),
      ['src/kept.js'],
    );
    // `src/kept.js` is on disk AND in scope: the pruner had no licence to
    // touch it, and no licence to invent a row for anything else either.
    assert.deepEqual(after.rows, [{ path: 'src/kept.js', mi: 90 }]);
  });

  test('only rows change — the pruned file gains no stamp and no rollup (AC-7)', () => {
    const { root, baselinePath } = fixture();
    const before = readJson(baselinePath);

    runPrune({ cwd: root, kinds: ['maintainability'], quality: QUALITY });
    const after = readJson(baselinePath);

    // A stamp over rows nobody re-measured would claim the file describes
    // today's tree on the strength of a deletion; the committed shape carries
    // neither a stamp nor a rollup, and the prune must not reintroduce one.
    assert.deepEqual(Object.keys(after), Object.keys(before));
    assert.equal(after.$schema, before.$schema);
    assert.equal(after.kernelVersion, before.kernelVersion);
    assert.equal(Object.hasOwn(after, 'generatedAt'), false);
    assert.equal(Object.hasOwn(after, 'rollup'), false);
  });

  test('the derived rollup reflects only the surviving rows (AC-8)', () => {
    const { root } = fixture();
    const minOf = () =>
      rollupOfRows(
        'maintainability',
        load('maintainability', { cwd: root }).rows,
      ).min;
    assert.equal(minOf(), 10);

    runPrune({ cwd: root, kinds: ['maintainability'], quality: QUALITY });

    // Pre-prune the min was 10 — the MI of the row that just went away. A
    // floor must never be defended by a deleted file.
    assert.equal(minOf(), 90);
  });

  test('a pruned baseline still loads through reader#load (AC-8)', () => {
    const { root } = fixture();

    runPrune({ cwd: root, kinds: ['maintainability'], quality: QUALITY });

    const loaded = load('maintainability', { cwd: root });
    assert.deepEqual(
      loaded.rows.map((row) => row.path),
      ['src/kept.js'],
    );
  });

  test('a clean baseline is left byte-identical', () => {
    const { root, baselinePath } = fixture();
    runPrune({ cwd: root, kinds: ['maintainability'], quality: QUALITY });
    const firstPass = fs.readFileSync(baselinePath, 'utf8');

    const report = runPrune({
      cwd: root,
      kinds: ['maintainability'],
      quality: QUALITY,
    });

    assert.equal(report.removedCount, 0);
    assert.equal(report.writtenCount, 0);
    assert.equal(fs.readFileSync(baselinePath, 'utf8'), firstPass);
  });

  test('a kind with no baseline file is reported absent, not crashed on', () => {
    const { root } = fixture();

    const report = runPrune({ cwd: root, quality: QUALITY });

    const coverage = report.kinds.find((entry) => entry.kind === 'coverage');
    assert.equal(coverage.present, false);
    assert.deepEqual(
      report.kinds.map((entry) => entry.kind),
      [...PRUNABLE_KINDS],
    );
  });
});

describe('runPrune — degradation and --check (AC-9)', () => {
  test('an unreadable scope config falls back to orphan-only pruning', () => {
    const { root, baselinePath } = fixture();

    // No `targetDirs` anywhere: scope is unknown, not empty. Reading it as
    // empty would make every row out-of-scope and delete the whole baseline.
    const report = runPrune({
      cwd: root,
      kinds: ['maintainability'],
      quality: { gates: {} },
    });
    const after = readJson(baselinePath);

    const entry = report.kinds[0];
    assert.equal(entry.degraded, true);
    assert.match(entry.degradedReason, /targetDirs/);
    assert.deepEqual(
      entry.removed.map((row) => row.reason),
      [EXTRA_REASONS.ABSENT],
    );
    assert.deepEqual(
      after.rows.map((row) => row.path),
      ['src/ignored.js', 'src/kept.js'],
    );
  });

  test('--check reports without writing', () => {
    const { root, baselinePath } = fixture();
    const before = fs.readFileSync(baselinePath, 'utf8');

    const report = runPrune({
      cwd: root,
      kinds: ['maintainability'],
      quality: QUALITY,
      check: true,
    });

    assert.equal(report.removedCount, 2);
    assert.equal(report.writtenCount, 0);
    assert.equal(fs.readFileSync(baselinePath, 'utf8'), before);
  });

  test('the CLI exits 1 under --check when rows would be pruned, and 0 once clean', () => {
    const { root } = fixture();

    const dry = spawnSync(process.execPath, [CLI, '--check', '--cwd', root], {
      encoding: 'utf8',
    });
    assert.equal(dry.status, 1, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /would prune 2 row\(s\)/);

    const write = spawnSync(process.execPath, [CLI, '--cwd', root], {
      encoding: 'utf8',
    });
    assert.equal(write.status, 0, write.stdout + write.stderr);

    const recheck = spawnSync(
      process.execPath,
      [CLI, '--check', '--cwd', root, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(recheck.status, 0, recheck.stdout + recheck.stderr);
    assert.equal(JSON.parse(recheck.stdout).removedCount, 0);
  });

  test('an unknown flag is a config error, never a silent no-op', () => {
    const { root } = fixture();

    const run = spawnSync(process.execPath, [CLI, '--dry-run', '--cwd', root], {
      encoding: 'utf8',
    });

    assert.equal(run.status, 2);
    assert.match(JSON.parse(run.stdout).error, /unknown flag "--dry-run"/);
  });
});

describe('pruneEnvelope (AC-8)', () => {
  test('changes only rows, carrying every other key through verbatim', () => {
    const envelope = {
      $schema: '.agents/schemas/baselines/maintainability.schema.json',
      kernelVersion: '1.2.3',
      rows: [
        { path: 'src/deleted.js', mi: 1 },
        { path: 'src/kept.js', mi: 2 },
      ],
    };

    const result = pruneEnvelope({
      envelope,
      inventory: { files: ['src/kept.js', 'src/deleted.js'] },
      existsOnDisk: (file) => file !== 'src/deleted.js',
    });

    assert.deepEqual(result, {
      envelope: {
        $schema: envelope.$schema,
        kernelVersion: '1.2.3',
        rows: [{ path: 'src/kept.js', mi: 2 }],
      },
      removed: [{ path: 'src/deleted.js', reason: EXTRA_REASONS.ABSENT }],
    });
  });

  test('returns no envelope when nothing is prunable, so nothing is rewritten', () => {
    const result = pruneEnvelope({
      envelope: { rows: [{ path: 'src/kept.js', mi: 1 }] },
      inventory: { files: ['src/kept.js'] },
      existsOnDisk: () => true,
    });

    assert.deepEqual(result, { envelope: null, removed: [] });
  });
});
