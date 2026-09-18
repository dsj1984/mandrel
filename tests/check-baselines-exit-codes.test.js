// tests/check-baselines-exit-codes.test.js
//
// Story #1965 / Task #1975 — exit-code contract for the dispatcher.
//
// Locks the 0/1/2/3/4 exit-code contract end-to-end with one fixture per
// code plus a mixed-failure fixture asserting precedence.
//
//   0 EXIT_PASS        — every gate passes (clean fixture).
//   1 EXIT_FLOOR       — at least one floor breach.
//   2 EXIT_SCHEMA      — at least one schema validation error.
//   3 EXIT_CONFIG      — config resolution failure (malformed agentrc).
//   4 EXIT_REGRESSION  — at least one head-vs-base regression.
//
// Mixed-failure (floor + regression) MUST exit 4 per the precedence rule
// in `lib/baselines/exit-codes.js#aggregate` (numeric maximum).

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runCheckBaselines } from '../.agents/scripts/check-baselines.js';
import {
  __resetForTests,
  __setSpawnRunner,
} from '../.agents/scripts/lib/baselines/git-base.js';
import { currentKernelVersion } from '../.agents/scripts/lib/baselines/kernel.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

function writeJson(p, value) {
  writeFileSync(p, JSON.stringify(value, null, 2));
}

function covRow(p, v) {
  return { path: p, lines: v, branches: v, functions: v };
}

// The floor check reads the rollup derived from the rows, so a floor-clean
// default needs rows whose mean clears the 90/85/90 floors.
const HEALTHY_ROWS = [
  { path: 'src/ok.js', lines: 95, branches: 92, functions: 95 },
];

function coverageEnvelope({ rows } = {}) {
  return {
    $schema: 'coverage.schema.json',
    kernelVersion: currentKernelVersion('coverage'),
    rows: rows ?? HEALTHY_ROWS,
  };
}

function setupTmpRepo() {
  const root = makeTempDir('check-baselines-exitcodes-');
  mkdirSync(path.join(root, 'baselines'), { recursive: true });
  const agentrc = {
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
          coverage: {
            enabled: true,
            baselinePath: 'baselines/coverage.json',
            tolerance: { kind: 'absolute', value: 0 },
            floors: { '*': { lines: 90, branches: 85, functions: 90 } },
          },
        },
      },
    },
  };
  writeJson(path.join(root, '.agentrc.json'), agentrc);
  return root;
}

describe('check-baselines — exit-code contract (Task #1975)', () => {
  let root;

  beforeEach(() => {
    __resetForTests();
  });

  afterEach(() => {
    __resetForTests();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('PASS fixture exits 0', async () => {
    root = setupTmpRepo();
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope(),
    );
    __setSpawnRunner({
      spawn: () => ({ status: 128, stdout: '', stderr: 'no base' }),
    });
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 0);
  });

  it('FLOOR fixture exits 1', async () => {
    root = setupTmpRepo();
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      // Derived rollup 50/50/50 sits below every floor.
      coverageEnvelope({ rows: [covRow('src/a.js', 50)] }),
    );
    __setSpawnRunner({
      spawn: () => ({ status: 128, stdout: '', stderr: 'no base' }),
    });
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 1);
  });

  it('SCHEMA fixture exits 2', async () => {
    root = setupTmpRepo();
    writeJson(path.join(root, 'baselines', 'coverage.json'), {
      $schema: 'coverage.schema.json',
      rows: 'not-an-array',
    });
    __setSpawnRunner({
      spawn: () => ({ status: 128, stdout: '', stderr: 'no base' }),
    });
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 2);
  });

  it('CONFIG fixture rejects (CLI shell maps to exit 3)', async () => {
    const tmp = makeTempDir('check-baselines-badconfig-');
    try {
      writeFileSync(path.join(tmp, '.agentrc.json'), '{ not: valid');
      await assert.rejects(() =>
        runCheckBaselines({ argv: ['--no-friction'], cwd: tmp }),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('REGRESSION fixture exits 4', async () => {
    root = setupTmpRepo();
    // Head: src/a.js regressed vs base, but four healthy rows hold the
    // derived rollup at 92/92/92 — clear of the floors.
    const healthy = ['b', 'c', 'd', 'e'].map((n) => covRow(`src/${n}.js`, 100));
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({ rows: [covRow('src/a.js', 60), ...healthy] }),
    );
    // Base baseline: same paths, src/a.js higher → head is a regression.
    const baseCoverage = JSON.stringify(
      coverageEnvelope({ rows: [covRow('src/a.js', 95), ...healthy] }),
    );
    __setSpawnRunner({
      spawn: (_cmd, args) => {
        const spec = args?.[1] ?? '';
        if (spec.endsWith(':baselines/coverage.json')) {
          return { status: 0, stdout: baseCoverage, stderr: '' };
        }
        return { status: 128, stdout: '', stderr: 'no base' };
      },
    });
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 4);
    assert.equal(res.report.totalBreaches, 0, 'derived rollup clears floors');
    assert.ok(res.report.totalRegressions >= 1);
  });

  it('mixed FLOOR + REGRESSION fixture exits 4 (precedence)', async () => {
    root = setupTmpRepo();
    // Head: regressing row whose derived rollup (60) also breaches floors.
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({ rows: [covRow('src/a.js', 60)] }),
    );
    const baseCoverage = JSON.stringify(
      coverageEnvelope({ rows: [covRow('src/a.js', 95)] }),
    );
    __setSpawnRunner({
      spawn: (_cmd, args) => {
        const spec = args?.[1] ?? '';
        if (spec.endsWith(':baselines/coverage.json')) {
          return { status: 0, stdout: baseCoverage, stderr: '' };
        }
        return { status: 128, stdout: '', stderr: 'no base' };
      },
    });
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    // EXIT_REGRESSION (4) > EXIT_FLOOR (1) — aggregate(...) takes the max.
    assert.equal(res.exitCode, 4);
    assert.ok(res.report.totalBreaches > 0, 'floor breach also recorded');
    assert.ok(res.report.totalRegressions > 0, 'regression also recorded');
  });
});
