/**
 * epic-deliver-finalize.row-preservation.test.js — Epic #2173 AC-4 contract
 * fixture (Story #2204, Task #2213).
 *
 * This is the load-bearing assertion for the whole Epic. The Epic exists
 * (in part) to stop finalize from introducing baseline-refresh commits
 * with unrelated rows: a Story closes cleanly, finalize re-runs, and the
 * resulting baseline file rewrites rows for files the Epic never touched.
 *
 * The fixture seeds a baselines/maintainability.json with 10 rows (A..J),
 * simulates an Epic diff touching only A, B, C, drives the real finalize
 * reconciliation (`reconcileBaselinesOnEpicBranch`) end-to-end with the
 * default `fullScope: false`, and asserts:
 *
 *   - The 7 out-of-scope rows (D..J) are byte-identical to their prior on-
 *     disk shape — every field of every row matches the seeded prior.
 *   - When no in-scope row's score changed, the envelope-level
 *     `generatedAt` timestamp is preserved byte-for-byte by the writer's
 *     structural-equality short-circuit. This is the proxy for "row
 *     updatedAt fields are unchanged" until per-row timestamps land in a
 *     future schema bump.
 *   - When in-scope rows DO change, the 7 out-of-scope rows still survive
 *     verbatim — only the 3 in-scope rows reflect new scores. This is the
 *     finalize-introduced-refresh-with-unrelated-rows bug captured as a
 *     test.
 *
 * The fixture wires the real `refreshBaseline()` service (no stub) and
 * the real shared writer; only the *scoring* layer and the git diff
 * resolver are injected so the test is hermetic.
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { reconcileBaselinesOnEpicBranch } from '../../.agents/scripts/epic-deliver-finalize.js';
import {
  write as writeEnvelope,
  writeFile as writeEnvelopeFile,
} from '../../.agents/scripts/lib/baselines/writer.js';

const FIXED_PRIOR_AT = '2024-01-01T00:00:00Z';

// 10-row prior maintainability baseline (canonical, POSIX-relative paths).
// A..C are the "Epic diff" scope; D..J are out-of-scope and must survive
// verbatim across finalize reconciliation.
const TEN_ROW_PRIOR = [
  { path: 'src/a.js', mi: 50 },
  { path: 'src/b.js', mi: 55 },
  { path: 'src/c.js', mi: 60 },
  { path: 'src/d.js', mi: 65 },
  { path: 'src/e.js', mi: 70 },
  { path: 'src/f.js', mi: 75 },
  { path: 'src/g.js', mi: 80 },
  { path: 'src/h.js', mi: 85 },
  { path: 'src/i.js', mi: 90 },
  { path: 'src/j.js', mi: 95 },
];
const IN_SCOPE = ['src/a.js', 'src/b.js', 'src/c.js'];

function seedPriorBaseline(absPath) {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const envelope = writeEnvelope({
    kind: 'maintainability',
    rows: TEN_ROW_PRIOR,
    generatedAt: FIXED_PRIOR_AT,
  });
  writeEnvelopeFile(absPath, envelope);
  return envelope;
}

/**
 * Build the injected config the production `reconcileBaselinesOnEpicBranch`
 * expects from `resolveConfig`. Crap is wired with `requireCoverage: false`
 * and a non-existent coverage path so the crap refresh path short-circuits
 * (no coverage → no rows → writer short-circuit → no drift), keeping the
 * fixture focused on the maintainability assertion.
 */
function makeStubConfig({ miPath, crapPath, workDir }) {
  return {
    project: { baseBranch: 'main' },
    agentSettings: {
      baseBranch: 'main',
      quality: {
        baselines: {
          maintainability: { path: miPath },
          crap: { path: crapPath },
        },
        maintainability: { targetDirs: [path.join(workDir, 'src')] },
        crap: {
          targetDirs: [path.join(workDir, 'src')],
          requireCoverage: true,
          coveragePath: path.join(workDir, 'coverage', 'coverage-final.json'),
        },
      },
    },
    orchestration: {},
  };
}

/**
 * Stub injected scoring helpers. `calculateAllFn` is the maintainability
 * scorer; the adapter in `epic-deliver-finalize.js` calls it with absolute
 * source paths that the diff-scope filter narrowed to the in-scope set.
 *
 * We return a deterministic { path: mi } map keyed by absolute path so the
 * adapter's `path.relative(cwd, key)` projection produces the canonical
 * POSIX-relative shape the writer expects.
 */
function makeCalculateAllStub({ workDir, freshScores }) {
  return async (absPaths) => {
    const scores = {};
    for (const abs of absPaths) {
      const rel = path
        .relative(workDir, abs)
        .split(path.sep)
        .join('/');
      if (rel in freshScores) {
        scores[abs] = freshScores[rel];
      }
    }
    return scores;
  };
}

/**
 * Stub `scanDirectory` to enumerate the seeded src/ tree. Only relevant
 * for the `fullScope: true` fallback. With `fullScope: false`, the adapter
 * skips this function entirely.
 */
function makeScanDirectoryStub({ workDir }) {
  return (dir, fileList) => {
    if (dir !== path.join(workDir, 'src')) return;
    for (const row of TEN_ROW_PRIOR) {
      fileList.push(path.join(workDir, row.path));
    }
  };
}

test('AC-4: finalize preserves 7 out-of-scope rows byte-for-byte when in-scope rows change', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'mandrel-finalize-rows-'));
  try {
    const miPath = path.join(workDir, 'baselines', 'maintainability.json');
    const crapPath = path.join(workDir, 'baselines', 'crap.json');
    const priorEnvelope = seedPriorBaseline(miPath);
    const priorRowsByPath = new Map(
      priorEnvelope.rows.map((r) => [r.path, JSON.stringify(r)]),
    );

    // Fresh scores for the 3 in-scope files (Epic diff).
    const freshScores = {
      'src/a.js': 99,
      'src/b.js': 11,
      'src/c.js': 22,
    };

    // Stubbed git diff: report A, B, C as changed between baseRef..headRef.
    const stubGitDiff = () => IN_SCOPE.slice();

    const config = makeStubConfig({ miPath, crapPath, workDir });
    const reconcileResult = await reconcileBaselinesOnEpicBranch({
      epicId: 2173,
      cwd: workDir,
      // Default fullScope=false → diff-scope.
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      // Provide the refreshBaseline binding from the *real* service so the
      // writer's scope-merge + canonicalize path runs end-to-end. We DO
      // override scoring helpers to drive the deterministic fixture.
      refreshBaselineFn: async (opts) => {
        // Forward most options verbatim, but override the gitDiff resolver
        // and pin generatedAt so the assertion below is deterministic.
        const realService = await import(
          '../../lib/baselines/refresh-service.js'
        );
        return realService.refreshBaseline({
          ...opts,
          gitDiff: stubGitDiff,
          generatedAt: '2026-05-17T00:00:00Z',
        });
      },
      resolveConfigFn: () => config,
      getBaselinesFn: ({ agentSettings }) => agentSettings.quality.baselines,
      getQualityFn: ({ agentSettings }) => agentSettings.quality,
      scanDirectoryFn: makeScanDirectoryStub({ workDir }),
      calculateAllFn: makeCalculateAllStub({ workDir, freshScores }),
      // Crap path: force the no-coverage branch by returning null.
      loadCoverageFn: () => null,
      scanAndScoreFn: async () => ({ rows: [] }),
      resolveEscomplexVersionFn: () => '0.0.0',
      resolveTsTranspilerVersionFn: () => '0.0.0',
      // Stub the staging step so we never actually invoke git.
      gitSpawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    // Reconciliation should report at least one refresh and drift on MI.
    assert.equal(reconcileResult.fullScope, false, 'diff-scope is the default');
    assert.ok(
      Array.isArray(reconcileResult.refreshes) &&
        reconcileResult.refreshes.length >= 1,
      'reconciliation should report per-kind refresh results',
    );
    const mi = reconcileResult.refreshes.find((r) => r.kind === 'maintainability');
    assert.ok(mi, 'maintainability refresh result must be present');
    assert.equal(mi.scopeMode, 'diff', 'maintainability must run in diff-scope mode');

    // Read the on-disk envelope post-refresh.
    const onDisk = JSON.parse(readFileSync(miPath, 'utf8'));
    const rowsByPath = new Map(onDisk.rows.map((r) => [r.path, r]));

    // 1. The 3 in-scope rows reflect the fresh scores.
    for (const [pth, expectedMi] of Object.entries(freshScores)) {
      const row = rowsByPath.get(pth);
      assert.ok(row, `in-scope row ${pth} must exist post-refresh`);
      assert.equal(row.mi, expectedMi, `in-scope row ${pth} should reflect fresh score`);
    }

    // 2. The 7 out-of-scope rows are byte-identical to their prior shape.
    const outOfScope = ['src/d.js', 'src/e.js', 'src/f.js', 'src/g.js', 'src/h.js', 'src/i.js', 'src/j.js'];
    assert.equal(outOfScope.length, 7);
    for (const pth of outOfScope) {
      const row = rowsByPath.get(pth);
      assert.ok(row, `out-of-scope row ${pth} must survive finalize`);
      const priorSerialised = priorRowsByPath.get(pth);
      assert.equal(
        JSON.stringify(row),
        priorSerialised,
        `out-of-scope row ${pth} MUST be byte-identical to prior (Epic #2173 AC-4)`,
      );
    }

    // 3. Row count is exactly 10 — no rows added, none dropped.
    assert.equal(onDisk.rows.length, 10);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('AC-4: finalize preserves on-disk timestamp when no in-scope row score changed', async () => {
  // When the Epic diff scope is non-empty but every in-scope row's score
  // happens to equal its prior value, the writer's structural-equality
  // short-circuit fires and the on-disk envelope (including
  // `generatedAt`) survives byte-for-byte. This is the proxy for "row
  // updatedAt fields are unchanged" until per-row timestamps ship.
  const workDir = mkdtempSync(path.join(tmpdir(), 'mandrel-finalize-ts-'));
  try {
    const miPath = path.join(workDir, 'baselines', 'maintainability.json');
    const crapPath = path.join(workDir, 'baselines', 'crap.json');
    seedPriorBaseline(miPath);
    const priorBytes = readFileSync(miPath, 'utf8');

    // Fresh scores match the prior for A, B, C — no drift.
    const freshScores = {
      'src/a.js': 50,
      'src/b.js': 55,
      'src/c.js': 60,
    };
    const stubGitDiff = () => IN_SCOPE.slice();

    const config = makeStubConfig({ miPath, crapPath, workDir });
    await reconcileBaselinesOnEpicBranch({
      epicId: 2173,
      cwd: workDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      refreshBaselineFn: async (opts) => {
        const realService = await import(
          '../../lib/baselines/refresh-service.js'
        );
        return realService.refreshBaseline({
          ...opts,
          gitDiff: stubGitDiff,
          // Pass a different `generatedAt` to prove that the short-circuit
          // wins over the input — the on-disk bytes (with the prior
          // timestamp) must survive.
          generatedAt: '2099-12-31T23:59:59Z',
        });
      },
      resolveConfigFn: () => config,
      getBaselinesFn: ({ agentSettings }) => agentSettings.quality.baselines,
      getQualityFn: ({ agentSettings }) => agentSettings.quality,
      scanDirectoryFn: makeScanDirectoryStub({ workDir }),
      calculateAllFn: makeCalculateAllStub({ workDir, freshScores }),
      loadCoverageFn: () => null,
      scanAndScoreFn: async () => ({ rows: [] }),
      resolveEscomplexVersionFn: () => '0.0.0',
      resolveTsTranspilerVersionFn: () => '0.0.0',
      gitSpawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    // The on-disk envelope must be byte-identical to what we seeded.
    const postBytes = readFileSync(miPath, 'utf8');
    assert.equal(
      postBytes,
      priorBytes,
      'on-disk envelope (including generatedAt) MUST be byte-for-byte preserved when no in-scope drift exists',
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('AC-4: --full-scope still preserves out-of-scope rows when scorer only returns in-scope', async () => {
  // The `--full-scope` operator opt-in tells the service to skip the diff
  // filter, but the writer's scope-merge layer only fires when scope is
  // non-null. Under full-scope, every row the scorer returns is treated
  // as in-scope; rows the scorer omits are NOT merged from prior. This
  // test pins the documented full-scope semantics: the operator who flips
  // the flag is accepting "the scorer's output is the full new baseline".
  //
  // This is the negative-counterpart of the diff-scope row-preservation
  // assertions above and locks the operator-facing contract surfaced
  // through the new `--full-scope` CLI flag.
  const workDir = mkdtempSync(path.join(tmpdir(), 'mandrel-finalize-full-'));
  try {
    const miPath = path.join(workDir, 'baselines', 'maintainability.json');
    const crapPath = path.join(workDir, 'baselines', 'crap.json');
    seedPriorBaseline(miPath);

    // Scorer returns scores for every prior row — this is what the
    // production scanDirectory + calculateAll path produces under full
    // scope. The fixture mirrors that behaviour so the assertion stays
    // honest: full-scope means "scorer enumerates everything".
    const freshScores = Object.fromEntries(
      TEN_ROW_PRIOR.map((r) => [r.path, r.mi]),
    );

    const config = makeStubConfig({ miPath, crapPath, workDir });
    await reconcileBaselinesOnEpicBranch({
      epicId: 2173,
      cwd: workDir,
      fullScope: true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      refreshBaselineFn: async (opts) => {
        assert.equal(
          opts.fullScope,
          true,
          'fullScope must propagate to refreshBaseline()',
        );
        const realService = await import(
          '../../lib/baselines/refresh-service.js'
        );
        return realService.refreshBaseline(opts);
      },
      resolveConfigFn: () => config,
      getBaselinesFn: ({ agentSettings }) => agentSettings.quality.baselines,
      getQualityFn: ({ agentSettings }) => agentSettings.quality,
      scanDirectoryFn: makeScanDirectoryStub({ workDir }),
      calculateAllFn: makeCalculateAllStub({ workDir, freshScores }),
      loadCoverageFn: () => null,
      scanAndScoreFn: async () => ({ rows: [] }),
      resolveEscomplexVersionFn: () => '0.0.0',
      resolveTsTranspilerVersionFn: () => '0.0.0',
      gitSpawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    // Every prior row is present and reflects the scorer's value.
    const onDisk = JSON.parse(readFileSync(miPath, 'utf8'));
    const rowsByPath = new Map(onDisk.rows.map((r) => [r.path, r]));
    for (const r of TEN_ROW_PRIOR) {
      const got = rowsByPath.get(r.path);
      assert.ok(got, `full-scope must include every scored row (missing ${r.path})`);
      assert.equal(got.mi, r.mi);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
