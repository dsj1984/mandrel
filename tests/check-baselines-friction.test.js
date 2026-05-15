// tests/check-baselines-friction.test.js
//
// Story #1965 / Task #1976 — centralised friction emission contract.
//
// The dispatcher (`check-baselines.js`) is the single emission site for
// baseline friction events. Per-kind modules MUST NOT emit friction
// directly. Each (kind, severity) tuple MUST produce exactly one
// emitted event with the canonical payload shape:
//
//   { tool: 'check-baselines', kind, severity, file?, method?, delta?, baseRef }
//
// Severities covered:
//   - regression       — head vs base regression
//   - kernel-mismatch  — running kernel ≠ baseline kernelVersion
//   - floor            — floor breach (count-style or quality-score)
//   - schema           — head baseline failed schema validation / read

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

function coverageEnvelope({ rollup, rows, kernelVersion } = {}) {
  return {
    $schema: 'coverage.schema.json',
    kernelVersion: kernelVersion ?? currentKernelVersion('coverage'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: rollup ?? { '*': { lines: 95, branches: 92, functions: 95 } },
    rows: rows ?? [],
  };
}

function lintEnvelope({ rollup, rows, kernelVersion } = {}) {
  return {
    $schema: 'lint.schema.json',
    kernelVersion: kernelVersion ?? currentKernelVersion('lint'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: rollup ?? { '*': { errorCount: 0, warningCount: 0 } },
    rows: rows ?? [],
  };
}

function setupTmpRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'check-baselines-friction-'));
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
          lint: {
            enabled: true,
            baselinePath: 'baselines/lint.json',
            tolerance: { kind: 'absolute', value: 0 },
            floors: { '*': { errorCount: 0, warningCount: 5 } },
          },
        },
      },
    },
  };
  writeJson(path.join(root, '.agentrc.json'), agentrc);
  return root;
}

describe('check-baselines — friction emission (Task #1976)', () => {
  let root;

  beforeEach(() => {
    __resetForTests();
  });

  afterEach(() => {
    __resetForTests();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('emits exactly one regression event per kind when two kinds regress', async () => {
    root = setupTmpRepo();

    // Head baselines: each kind has one row that regressed vs base.
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({
        rollup: { '*': { lines: 95, branches: 92, functions: 95 } },
        rows: [
          { path: 'src/a.js', lines: 70, branches: 60, functions: 70 },
        ],
      }),
    );
    writeJson(
      path.join(root, 'baselines', 'lint.json'),
      lintEnvelope({
        rollup: { '*': { errorCount: 0, warningCount: 0 } },
        rows: [{ path: 'src/b.js', errorCount: 5, warningCount: 0 }],
      }),
    );

    // Mock git-base so reading the base baseline returns a "perfect"
    // version that the head will regress against.
    const baseCoverage = JSON.stringify(
      coverageEnvelope({
        rows: [
          { path: 'src/a.js', lines: 95, branches: 95, functions: 95 },
        ],
      }),
    );
    const baseLint = JSON.stringify(
      lintEnvelope({
        rows: [{ path: 'src/b.js', errorCount: 0, warningCount: 0 }],
      }),
    );
    __setSpawnRunner({
      spawn: (_cmd, args) => {
        // args: ['show', '<ref>:<file>']
        const spec = args?.[1] ?? '';
        if (spec.endsWith(':baselines/coverage.json')) {
          return { status: 0, stdout: baseCoverage, stderr: '' };
        }
        if (spec.endsWith(':baselines/lint.json')) {
          return { status: 0, stdout: baseLint, stderr: '' };
        }
        return { status: 128, stdout: '', stderr: 'fatal: not found' };
      },
    });

    const res = await runCheckBaselines({ argv: [], cwd: root });

    const regressionEvents = res.frictionEvents.filter(
      (e) => e.severity === 'regression',
    );
    assert.equal(
      regressionEvents.length,
      2,
      `expected exactly two regression friction events; got ${regressionEvents.length}: ${JSON.stringify(regressionEvents)}`,
    );
    const kinds = regressionEvents.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ['coverage', 'lint']);

    // Canonical payload shape.
    for (const ev of regressionEvents) {
      assert.equal(ev.tool, 'check-baselines');
      assert.equal(typeof ev.kind, 'string');
      assert.equal(ev.severity, 'regression');
      assert.ok('file' in ev);
      assert.ok('method' in ev);
      assert.ok('delta' in ev);
      assert.ok('baseRef' in ev);
    }
  });

  it('emits exactly one kernel-mismatch event per kind with drift', async () => {
    root = setupTmpRepo();
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({ kernelVersion: '9.9.9' }),
    );
    writeJson(
      path.join(root, 'baselines', 'lint.json'),
      lintEnvelope({ kernelVersion: '9.9.9' }),
    );
    // Block git so compare emits no regressions.
    __setSpawnRunner({
      spawn: () => ({ status: 128, stdout: '', stderr: 'no base' }),
    });

    const res = await runCheckBaselines({ argv: [], cwd: root });
    const kernelEvents = res.frictionEvents.filter(
      (e) => e.severity === 'kernel-mismatch',
    );
    assert.equal(kernelEvents.length, 2);
    const kinds = kernelEvents.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ['coverage', 'lint']);
    for (const ev of kernelEvents) {
      assert.equal(ev.tool, 'check-baselines');
      assert.equal(ev.severity, 'kernel-mismatch');
    }
  });

  it('emits exactly one schema event per kind when the head baseline is malformed', async () => {
    root = setupTmpRepo();
    // Coverage: malformed (missing required fields).
    writeJson(path.join(root, 'baselines', 'coverage.json'), {
      $schema: 'coverage.schema.json',
      rows: 'not-an-array',
    });
    // Lint: also malformed.
    writeJson(path.join(root, 'baselines', 'lint.json'), {
      $schema: 'lint.schema.json',
      rows: 'not-an-array',
    });
    __setSpawnRunner({
      spawn: () => ({ status: 128, stdout: '', stderr: 'no base' }),
    });

    const res = await runCheckBaselines({ argv: [], cwd: root });
    const schemaEvents = res.frictionEvents.filter(
      (e) => e.severity === 'schema',
    );
    assert.equal(schemaEvents.length, 2);
    const kinds = schemaEvents.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ['coverage', 'lint']);
  });

  it('--no-friction suppresses every emission', async () => {
    root = setupTmpRepo();
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({
        rollup: { '*': { lines: 50, branches: 50, functions: 50 } },
      }),
    );
    writeJson(path.join(root, 'baselines', 'lint.json'), lintEnvelope());
    __setSpawnRunner({
      spawn: () => ({ status: 128, stdout: '', stderr: 'no base' }),
    });

    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.frictionEvents.length, 0);
  });

  it('per-kind modules contain no direct friction emission (single-site invariant)', async () => {
    // Read each kind module and assert it does not import the friction
    // helper. The invariant is that only the dispatcher emits.
    const fs = await import('node:fs');
    const dir = path.resolve('.agents/scripts/lib/baselines/kinds');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      const source = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(
        !/from\s+['"][^'"]*friction[^'"]*['"]/.test(source) &&
          !/emitFrictionSignal/.test(source) &&
          !/appendSignal/.test(source),
        `${f} must not emit friction directly — the dispatcher is the single emission site`,
      );
    }
  });
});
