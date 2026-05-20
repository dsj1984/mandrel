// tests/contract/check-baselines-kernel-mismatch.test.js
//
// Story #1972 / Task #1982 — dispatcher contract test (kernel mismatch).
//
// Spawns the real `check-baselines.js` binary against a synthetic git
// repository whose head baseline carries a kernelVersion that differs
// from the running dispatcher's kernel. Asserts:
//
//   - The dispatcher does NOT fail (kernel-mismatch alone is informational
//     and the aggregated exit code stays at EXIT_PASS = 0).
//   - The friction signal is observable in the stdout report
//     (`kernelDriftCount >= 1` and the affected gate carries
//     `kernelMatch === false` with baseline/current kernel versions
//     populated from the centralised dispatcher emission site).
//
// Friction-signal *append* (`emitFrictionSignal`) only fires when
// `--story` / `--epic` are supplied; the canonical observable for an
// unscoped CLI run is the per-gate `kernelMatch`/`kernelBaseline`/
// `kernelCurrent` fields in the JSON report. Per Task #1976 the
// dispatcher is the single emission site, so seeing the drift surface
// here is sufficient evidence that friction emission ran.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { currentKernelVersion } from '../../.agents/scripts/lib/baselines/kernel.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const dispatcherBin = path.join(
  repoRoot,
  '.agents',
  'scripts',
  'check-baselines.js',
);

function writeJson(p, value) {
  writeFileSync(p, JSON.stringify(value, null, 2));
}

function coverageEnvelope({ kernelVersion, rollup, rows } = {}) {
  return {
    $schema: 'coverage.schema.json',
    kernelVersion: kernelVersion ?? currentKernelVersion('coverage'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: rollup ?? { '*': { lines: 95, branches: 92, functions: 95 } },
    rows: rows ?? [],
  };
}

function runGit(args, cwd) {
  const res = spawnSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit=${res.status}): ${res.stderr}`,
    );
  }
  return res.stdout;
}

function setupRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'cb-contract-kernel-'));
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

  // Initialize a real git repo and commit a kernel-correct baseline so
  // git-base.readBaseFromGit returns a parseable, schema-valid base.
  // The head (working-tree) baseline written by the test is what carries
  // the mismatched kernel.
  runGit(['init', '--initial-branch=main'], root);
  runGit(['config', 'user.email', 'contract@example.com'], root);
  runGit(['config', 'user.name', 'contract'], root);
  runGit(['config', 'commit.gpgsign', 'false'], root);

  writeJson(path.join(root, 'baselines', 'coverage.json'), coverageEnvelope());
  runGit(['add', '.agentrc.json', 'baselines/coverage.json'], root);
  runGit(['commit', '-m', 'baseline: initial (kernel-correct)'], root);

  return root;
}

function spawnDispatcher(cwd, extraArgs = []) {
  return spawnSync(process.execPath, [dispatcherBin, ...extraArgs], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('check-baselines (binary spawn) — kernel-mismatch contract', () => {
  let root;

  before(() => {
    root = setupRepo();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('emits friction (kernel drift) and exits non-failing (0) when head kernel mismatches', () => {
    // Overwrite working-tree baseline with a mismatched kernelVersion.
    // Floor is met and rows are absent, so the only friction surface
    // available is the kernel-mismatch event.
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({ kernelVersion: '9.9.9' }),
    );

    const res = spawnDispatcher(root);
    assert.equal(
      res.status,
      0,
      `expected non-failing exit 0 for kernel-mismatch alone; got ${res.status}; stderr=${res.stderr}`,
    );

    let report;
    try {
      report = JSON.parse(res.stdout);
    } catch (err) {
      throw new Error(
        `dispatcher stdout was not valid JSON: ${err.message}\nstdout=${res.stdout}`,
      );
    }

    assert.ok(
      Array.isArray(report.gates) && report.gates.length >= 1,
      'expected at least one gate in report',
    );
    const coverage = report.gates.find((g) => g.kind === 'coverage');
    assert.ok(coverage, 'coverage gate missing from report');
    assert.equal(
      coverage.kernelMatch,
      false,
      'coverage gate should record kernelMatch=false',
    );
    assert.equal(coverage.kernelBaseline, '9.9.9');
    assert.equal(coverage.kernelCurrent, currentKernelVersion('coverage'));
    assert.ok(
      report.kernelDriftCount >= 1,
      `expected kernelDriftCount >= 1; got ${report.kernelDriftCount}`,
    );
  });
});
