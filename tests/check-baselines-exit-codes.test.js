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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runCheckBaselines } from '../.agents/scripts/check-baselines.js';
import {
  __resetForTests,
  __setSpawnRunner,
} from '../.agents/scripts/lib/baselines/git-base.js';
import { currentKernelVersion } from '../.agents/scripts/lib/baselines/kernel.js';

function writeJson(p, value) {
  writeFileSync(p, JSON.stringify(value, null, 2));
}

function coverageEnvelope({ rollup, rows } = {}) {
  return {
    $schema: 'coverage.schema.json',
    kernelVersion: currentKernelVersion('coverage'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: rollup ?? { '*': { lines: 95, branches: 92, functions: 95 } },
    rows: rows ?? [],
  };
}

function setupTmpRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'check-baselines-exitcodes-'));
  mkdirSync(path.join(root, 'baselines'), { recursive: true });
  const agentrc = {
    project: {
      baseBranch: 'main',
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      docsContextFiles: [],
      commands: { lintBaseline: 'echo', test: 'echo', typecheck: 'echo' },
    },
    github: { owner: 'x', repo: 'y' },
    delivery: {
      quality: {
        gateScoping: { scope: 'diff', diffRef: 'main' },
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
    writeJson(path.join(root, 'baselines', 'coverage.json'), coverageEnvelope());
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
      coverageEnvelope({
        rollup: { '*': { lines: 50, branches: 50, functions: 50 } },
      }),
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
    const tmp = mkdtempSync(path.join(tmpdir(), 'check-baselines-badconfig-'));
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
    // Head: floor-clean rollup, regressing rows vs base.
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({
        rollup: { '*': { lines: 95, branches: 92, functions: 95 } },
        rows: [{ path: 'src/a.js', lines: 60, branches: 60, functions: 60 }],
      }),
    );
    // Base baseline: same path, perfect coverage → head is a regression.
    const baseCoverage = JSON.stringify(
      coverageEnvelope({
        rows: [{ path: 'src/a.js', lines: 95, branches: 95, functions: 95 }],
      }),
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
    assert.ok(res.report.totalRegressions >= 1);
  });

  it('mixed FLOOR + REGRESSION fixture exits 4 (precedence)', async () => {
    root = setupTmpRepo();
    // Head: floor-breach rollup AND regressing rows.
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({
        rollup: { '*': { lines: 50, branches: 50, functions: 50 } },
        rows: [{ path: 'src/a.js', lines: 60, branches: 60, functions: 60 }],
      }),
    );
    const baseCoverage = JSON.stringify(
      coverageEnvelope({
        rows: [{ path: 'src/a.js', lines: 95, branches: 95, functions: 95 }],
      }),
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
    assert.ok(
      res.report.totalRegressions > 0,
      'regression also recorded',
    );
  });
});
