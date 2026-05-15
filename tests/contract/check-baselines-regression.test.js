// tests/contract/check-baselines-regression.test.js
//
// Story #1972 / Task #1982 — dispatcher contract test (regression).
//
// Spawns the real `check-baselines.js` binary against a synthetic git
// repository whose initial commit holds a "perfect" baseline and whose
// working-tree baseline regresses against that base. Asserts:
//
//   - Regression scenario exits 4 (EXIT_REGRESSION).
//   - Parity scenario (head identical to base) exits 0 (EXIT_PASS).
//
// The real binary is spawned via `child_process.spawnSync` with the
// repo root as `cwd`; the test does not import the dispatcher's JS
// directly. This pins the end-to-end CLI surface from argv parsing
// through git-base read through per-kind compare to exit-code emission.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
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

function coverageEnvelope({ rollup, rows } = {}) {
  return {
    $schema: 'coverage.schema.json',
    kernelVersion: currentKernelVersion('coverage'),
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

function setupRepo({ baseRollup, baseRows } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cb-contract-regress-'));
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

  // Initialize git repo and commit the base baseline on `main`.
  runGit(['init', '--initial-branch=main'], root);
  runGit(['config', 'user.email', 'contract@example.com'], root);
  runGit(['config', 'user.name', 'contract'], root);
  runGit(['config', 'commit.gpgsign', 'false'], root);

  writeJson(
    path.join(root, 'baselines', 'coverage.json'),
    coverageEnvelope({ rollup: baseRollup, rows: baseRows }),
  );
  runGit(['add', '.agentrc.json', 'baselines/coverage.json'], root);
  runGit(['commit', '-m', 'baseline: initial'], root);

  return root;
}

function spawnDispatcher(cwd, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [dispatcherBin, '--no-friction', ...extraArgs],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

describe('check-baselines (binary spawn) — regression contract', () => {
  let root;

  beforeEach(() => {
    root = undefined;
  });

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('exits 4 when the head baseline regresses against the committed base', () => {
    root = setupRepo({
      baseRollup: { '*': { lines: 95, branches: 92, functions: 95 } },
      baseRows: [{ path: 'src/a.js', lines: 95, branches: 95, functions: 95 }],
    });

    // Overwrite the working-tree baseline with a regressing row. Floor
    // is still met by the rollup (95/92/95), so the only failure mode
    // available is regression — isolating EXIT_REGRESSION.
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({
        rollup: { '*': { lines: 95, branches: 92, functions: 95 } },
        rows: [{ path: 'src/a.js', lines: 60, branches: 60, functions: 60 }],
      }),
    );

    const res = spawnDispatcher(root);
    assert.equal(
      res.status,
      4,
      `expected exit 4, got ${res.status}; stdout=${res.stdout}; stderr=${res.stderr}`,
    );
  });

  it('exits 0 when the head baseline matches the committed base (parity)', () => {
    root = setupRepo({
      baseRollup: { '*': { lines: 95, branches: 92, functions: 95 } },
      baseRows: [{ path: 'src/a.js', lines: 95, branches: 95, functions: 95 }],
    });
    // Working-tree baseline is the same as the committed one — no regression,
    // no floor breach, kernel matches.
    const res = spawnDispatcher(root);
    assert.equal(
      res.status,
      0,
      `expected exit 0, got ${res.status}; stdout=${res.stdout}; stderr=${res.stderr}`,
    );
  });
});
