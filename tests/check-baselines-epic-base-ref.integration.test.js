// tests/check-baselines-epic-base-ref.integration.test.js
//
// Story #3890 — the close-validation `check-baselines` gate must compare a
// Story/Epic's head baseline against the **epic integration branch**
// (`origin/<epicBranch>`), not the framework-default `origin/main`, so
// inherited main-vs-epic drift in files OUTSIDE the Story's own diff does
// not surface as a phantom regression — while a genuine regression
// introduced by the Story's own diff still fails.
//
// This is the real-git acceptance leg (`*.integration.test.js`). It commits
// a maintainability baseline at two refs — `main` (the stale framework
// default) and `epic/9999` (the integration branch that already absorbed
// the drift) — then drives the live compare phase (`resolveDispatchScope` →
// `evaluateCompare` → `runCompareStage`, the same chain `check-baselines`
// runs) against each ref via the real `readBaseFromGit`.
//
// Two directions, one fixture:
//   - File A regressed vs `main` but matches the `epic/9999` baseline
//     (inherited drift, outside the diff). Against `epic/9999` it is NOT a
//     regression; against `origin/main` it phantom-regresses.
//   - File B regressed vs the `epic/9999` baseline (a real in-diff
//     regression). Against `epic/9999` it IS a regression — the fix narrows
//     the base, it does not disable the gate.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { __resetForTests } from '../.agents/scripts/lib/baselines/git-base.js';
import {
  evaluateCompare,
  resolveDispatchScope,
  runCompareStage,
} from '../.agents/scripts/lib/orchestration/check-baselines/phases/compare.js';

const KIND = 'maintainability';
const BASELINE_PATH = 'baselines/maintainability.json';

function maintainabilityBaseline(rows) {
  return JSON.stringify(
    {
      $schema: '.agents/schemas/baselines/maintainability.schema.json',
      kernelVersion: '0.1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      rollup: { '*': { min: 50, p50: 70, p95: 90 } },
      rows,
    },
    null,
    2,
  );
}

/**
 * Spin up a throwaway repo with `baselines/maintainability.json` committed
 * at both `main` and an `epic/9999` integration branch.
 *
 * - `main` carries the pre-drift values (file-a: 90).
 * - `epic/9999` carries the post-drift values (file-a: 80) — i.e. drift that
 *   already landed on the integration branch in untouched files.
 */
function makeEpicBaselineRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cb-epic-ref-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
  const commit = (msg) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.email=test@example.com',
        '-c',
        'user.name=Test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        msg,
      ],
      { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );

  git('init', '-q', '-b', 'main');
  const baselineAbs = path.join(dir, BASELINE_PATH);
  execFileSync('mkdir', ['-p', path.dirname(baselineAbs)]);

  // main: pre-drift baseline.
  writeFileSync(
    baselineAbs,
    maintainabilityBaseline([
      { path: 'src/file-a.js', mi: 90 },
      { path: 'src/file-b.js', mi: 90 },
    ]),
  );
  git('add', BASELINE_PATH);
  commit('seed main baseline (pre-drift)');

  // epic/9999: file-a already drifted down to 80 on the integration branch.
  git('checkout', '-q', '-b', 'epic/9999');
  writeFileSync(
    baselineAbs,
    maintainabilityBaseline([
      { path: 'src/file-a.js', mi: 80 },
      { path: 'src/file-b.js', mi: 90 },
    ]),
  );
  git('add', BASELINE_PATH);
  commit('absorb file-a drift on epic branch');

  // Local refs double as `origin/<ref>` for read purposes: point the
  // origin-prefixed refs at the same commits so `origin/epic/9999` and
  // `origin/main` both resolve under `git show`.
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('update-ref', 'refs/remotes/origin/epic/9999', 'epic/9999');

  return dir;
}

// Head baseline (working-tree): file-a sits at the epic value (80 — inherited
// drift, untouched by this Story) and file-b regressed to 70 (the Story's own
// in-diff regression).
const HEAD_BASELINE = {
  rows: [
    { path: 'src/file-a.js', mi: 80 },
    { path: 'src/file-b.js', mi: 70 },
  ],
};

async function compareAgainstRef(dir, ref) {
  const scope = resolveDispatchScope({
    kind: KIND,
    quality: {},
    env: { BASELINE_REF: ref },
  });
  assert.equal(scope.ref, ref, 'scope ref should reflect BASELINE_REF');
  const cmp = await evaluateCompare({
    kind: KIND,
    gateBlock: {},
    scope,
    cwd: dir,
  });
  return runCompareStage(HEAD_BASELINE, cmp);
}

describe('check-baselines epic base-ref propagation (Story #3890)', () => {
  afterEach(() => {
    __resetForTests();
  });

  it('inherited main-vs-epic drift outside the diff does NOT regress against the epic base ref', async () => {
    const dir = makeEpicBaselineRepo();
    try {
      __resetForTests(); // ensure real spawnSync
      const result = await compareAgainstRef(dir, 'origin/epic/9999');
      const regressedPaths = result.regressions.map((r) => r.key);
      assert.ok(
        !regressedPaths.includes('src/file-a.js'),
        `inherited-drift file must not regress vs the epic base; got: ${regressedPaths.join(', ')}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a genuine in-diff regression STILL fails against the epic base ref (the fix narrows the base, it does not disable the gate)', async () => {
    const dir = makeEpicBaselineRepo();
    try {
      __resetForTests();
      const result = await compareAgainstRef(dir, 'origin/epic/9999');
      const regressedPaths = result.regressions.map((r) => r.key);
      assert.ok(
        regressedPaths.includes('src/file-b.js'),
        `the Story's own in-diff regression must still fail; got: ${regressedPaths.join(', ')}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the same head against the stale origin/main base surfaces the inherited drift as a phantom regression (regression-witness)', async () => {
    const dir = makeEpicBaselineRepo();
    try {
      __resetForTests();
      const result = await compareAgainstRef(dir, 'origin/main');
      const regressedPaths = result.regressions.map((r) => r.key);
      assert.ok(
        regressedPaths.includes('src/file-a.js'),
        'the bug this Story fixes: against origin/main, inherited drift phantom-regresses',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
