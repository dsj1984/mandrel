// tests/check-baselines-refresh-ack.test.js
//
// Story #4731 — maintainability refresh-acknowledgment seam.
//
// The check-baselines diff-scope compare demotes maintainability head-vs-base
// regressions to "acknowledged" (loud report, exit 0) for a single run when
// EITHER trigger fires:
//
//   1. A commit in the compared range (`<baseRef>..HEAD`) whose subject
//      contains the configured refresh tag AND whose diff touches the
//      maintainability baseline file.
//   2. `MAINTAINABILITY_REFRESH=1` in the environment (parity with the
//      bundle-size acknowledge seam).
//
// Invariants pinned here:
//   - The identical downward baseline change WITHOUT such a commit still
//     exits 4 (EXIT_REGRESSION).
//   - Floors never relax under acknowledgment: a rollup below the `min` floor
//     still breaches (exit 1) under either trigger.
//   - The acknowledgment names itself on the gate report (`acknowledged:true`).

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

const MI_BASELINE_REL = 'baselines/maintainability.json';

function writeJson(p, value) {
  writeFileSync(p, JSON.stringify(value, null, 2));
}

function miEnvelope({ rows, rollup } = {}) {
  return {
    $schema: 'maintainability.schema.json',
    kernelVersion: currentKernelVersion('maintainability'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: rollup ?? { '*': { min: 80, p50: 90, p95: 100 } },
    rows: rows ?? [],
  };
}

function setupTmpRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'check-baselines-refresh-'));
  mkdirSync(path.join(root, 'baselines'), { recursive: true });
  const agentrc = {
    project: {
      baseBranch: 'main',
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      docsContextFiles: [],
      commands: { lintBaseline: 'echo', test: 'echo', typecheck: 'echo' },
    },
    github: { owner: 'x', repo: 'y', operatorHandle: '@ci' },
    delivery: {
      quality: {
        gateScoping: { scope: 'diff', diffRef: 'main' },
        gates: {
          maintainability: {
            enabled: true,
            baselinePath: MI_BASELINE_REL,
            tolerance: { kind: 'absolute', value: 0.5 },
            floors: { '*': { min: 70 } },
          },
        },
      },
    },
  };
  writeJson(path.join(root, '.agentrc.json'), agentrc);
  return root;
}

/**
 * Install a git spawn stub that answers both reads the pipeline makes:
 *   - `git show main:baselines/maintainability.json` → the base baseline.
 *   - `git log main..HEAD --format=%s -- <baseline>` → the range subjects.
 *
 * @param {{ baseRows: object[], subjects?: string[] }} opts
 */
function installGitStub({ baseRows, subjects = [] }) {
  const baseJson = JSON.stringify(miEnvelope({ rows: baseRows }));
  __setSpawnRunner({
    spawn: (_cmd, args) => {
      const verb = args?.[0];
      if (verb === 'show') {
        const spec = args?.[1] ?? '';
        if (spec.endsWith(`:${MI_BASELINE_REL}`)) {
          return { status: 0, stdout: baseJson, stderr: '' };
        }
        return { status: 128, stdout: '', stderr: 'no base' };
      }
      if (verb === 'log') {
        return { status: 0, stdout: `${subjects.join('\n')}\n`, stderr: '' };
      }
      return { status: 128, stdout: '', stderr: 'unexpected' };
    },
  });
}

describe('check-baselines — maintainability refresh acknowledgment (#4731)', () => {
  let root;

  beforeEach(() => {
    __resetForTests();
  });

  afterEach(() => {
    __resetForTests();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  // AC-1 — a tagged range commit touching the baseline acknowledges.
  it('acknowledges a downward change when a tagged range commit touches the baseline (exit 0)', async () => {
    root = setupTmpRepo();
    // Head: floor-clean rollup (min 80 ≥ 70), row regressed vs base.
    writeJson(
      path.join(root, 'baselines', 'maintainability.json'),
      miEnvelope({
        rollup: { '*': { min: 80, p50: 90, p95: 100 } },
        rows: [{ path: 'src/a.js', mi: 80 }],
      }),
    );
    installGitStub({
      baseRows: [{ path: 'src/a.js', mi: 95 }],
      subjects: [
        'chore(baselines): baseline-refresh: regenerate MI full-scope',
      ],
    });
    const res = await runCheckBaselines({ argv: ['--no-friction'], cwd: root });
    assert.equal(res.exitCode, 0);
    const gate = res.report.gates.find((g) => g.kind === 'maintainability');
    assert.equal(gate.acknowledged, true, 'gate names itself acknowledged');
    assert.equal(gate.regressionCount, 0, 'regressions demoted');
  });

  // AC-1 — the identical downward change WITHOUT a tagged commit still fails.
  it('does NOT acknowledge the identical downward change without a tagged commit (exit 4)', async () => {
    root = setupTmpRepo();
    writeJson(
      path.join(root, 'baselines', 'maintainability.json'),
      miEnvelope({
        rollup: { '*': { min: 80, p50: 90, p95: 100 } },
        rows: [{ path: 'src/a.js', mi: 80 }],
      }),
    );
    installGitStub({
      baseRows: [{ path: 'src/a.js', mi: 95 }],
      subjects: ['fix(gate): unrelated change that does not carry the tag'],
    });
    const res = await runCheckBaselines({ argv: ['--no-friction'], cwd: root });
    assert.equal(res.exitCode, 4);
    const gate = res.report.gates.find((g) => g.kind === 'maintainability');
    assert.equal(gate.acknowledged, false);
    assert.ok(gate.regressionCount >= 1, 'regression preserved');
  });

  // AC-2 — MAINTAINABILITY_REFRESH=1 acknowledges, mirroring bundle-size.
  it('acknowledges via MAINTAINABILITY_REFRESH=1 even with no tagged commit (exit 0)', async () => {
    root = setupTmpRepo();
    writeJson(
      path.join(root, 'baselines', 'maintainability.json'),
      miEnvelope({
        rollup: { '*': { min: 80, p50: 90, p95: 100 } },
        rows: [{ path: 'src/a.js', mi: 80 }],
      }),
    );
    installGitStub({
      baseRows: [{ path: 'src/a.js', mi: 95 }],
      subjects: ['fix(gate): no tag here'],
    });
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
      env: { MAINTAINABILITY_REFRESH: '1' },
    });
    assert.equal(res.exitCode, 0);
    const gate = res.report.gates.find((g) => g.kind === 'maintainability');
    assert.equal(gate.acknowledged, true);
    assert.equal(gate.regressionCount, 0);
  });

  // AC-2 — a floor breach still fails under either acknowledgment path.
  it('floor breach still fails under the commit-tag acknowledgment (exit 1)', async () => {
    root = setupTmpRepo();
    // Head: rollup below the min-70 floor AND a regression vs base.
    writeJson(
      path.join(root, 'baselines', 'maintainability.json'),
      miEnvelope({
        rollup: { '*': { min: 50, p50: 90, p95: 100 } },
        rows: [{ path: 'src/a.js', mi: 50 }],
      }),
    );
    installGitStub({
      baseRows: [{ path: 'src/a.js', mi: 95 }],
      subjects: [
        'chore(baselines): baseline-refresh: regenerate MI full-scope',
      ],
    });
    const res = await runCheckBaselines({ argv: ['--no-friction'], cwd: root });
    // Regression is acknowledged, but the floor breach survives → EXIT_FLOOR.
    assert.equal(res.exitCode, 1);
    const gate = res.report.gates.find((g) => g.kind === 'maintainability');
    assert.ok(gate.breachCount > 0, 'floor breach recorded');
  });

  it('floor breach still fails under the MAINTAINABILITY_REFRESH env acknowledgment (exit 1)', async () => {
    root = setupTmpRepo();
    writeJson(
      path.join(root, 'baselines', 'maintainability.json'),
      miEnvelope({
        rollup: { '*': { min: 50, p50: 90, p95: 100 } },
        rows: [{ path: 'src/a.js', mi: 50 }],
      }),
    );
    installGitStub({
      baseRows: [{ path: 'src/a.js', mi: 95 }],
      subjects: ['fix(gate): no tag'],
    });
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
      env: { MAINTAINABILITY_REFRESH: '1' },
    });
    assert.equal(res.exitCode, 1);
    const gate = res.report.gates.find((g) => g.kind === 'maintainability');
    assert.ok(gate.breachCount > 0, 'floor breach recorded');
  });
});
