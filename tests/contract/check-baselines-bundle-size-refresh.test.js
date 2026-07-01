// tests/contract/check-baselines-bundle-size-refresh.test.js
//
// Story #151 upstream port (mandrel-platform#151 / PR #156) — dispatcher
// contract test for the `BUNDLE_SIZE_REFRESH=1` one-shot acknowledge flag.
//
// Mirrors `tests/contract/check-baselines-regression.test.js`'s technique:
// spawn the real `check-baselines.js` binary against a synthetic git
// repository whose initial commit holds a "base" bundle-size baseline, and
// whose working-tree baseline regresses against that base. Asserts:
//
//   - Without the env var: a bundle-size regression exits 4 (EXIT_REGRESSION).
//   - With BUNDLE_SIZE_REFRESH=1: the same regression is acknowledged and
//     the run exits 0 — but the JSON report still records
//     `acknowledged: true` on the bundle-size gate so the outcome is
//     auditable, not silently invisible.
//   - Floors still apply even when acknowledged: a regression that also
//     breaches the configured `floors` budget still fails (EXIT_FLOOR)
//     with BUNDLE_SIZE_REFRESH=1 set.
//   - A malformed/absent env var value is a no-op — falls back to full
//     strict enforcement (same as the "without the env var" case).

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

function bundleSizeEnvelope({ rollup, rows } = {}) {
  return {
    $schema: 'bundle-size.schema.json',
    kernelVersion: currentKernelVersion('bundle-size'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: rollup ?? { '*': { totalKb: 200, gzippedKb: 80 } },
    rows: rows ?? [{ bundle: 'main', rawKb: 200, gzippedKb: 80 }],
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

function baseAgentrc(floors) {
  return {
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
          'bundle-size': {
            enabled: true,
            baselinePath: 'baselines/bundle-size.json',
            tolerance: { kind: 'absolute', value: 0 },
            floors: floors ?? { '*': { totalKb: 100000, gzippedKb: 100000 } },
          },
        },
      },
    },
  };
}

function setupRepo({ floors } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cb-contract-bundlesize-'));
  mkdirSync(path.join(root, 'baselines'), { recursive: true });

  writeJson(path.join(root, '.agentrc.json'), baseAgentrc(floors));

  runGit(['init', '--initial-branch=main'], root);
  runGit(['config', 'user.email', 'contract@example.com'], root);
  runGit(['config', 'user.name', 'contract'], root);
  runGit(['config', 'commit.gpgsign', 'false'], root);

  // Base commit: baseline with a "main" bundle at 200/80 KB.
  writeJson(
    path.join(root, 'baselines', 'bundle-size.json'),
    bundleSizeEnvelope(),
  );
  runGit(['add', '.agentrc.json', 'baselines/bundle-size.json'], root);
  runGit(['commit', '-m', 'baseline: initial'], root);

  return root;
}

function spawnDispatcher(cwd, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [dispatcherBin, '--no-friction', '--format', 'json'],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    },
  );
}

function bundleSizeGate(res) {
  const report = JSON.parse(res.stdout);
  return report.gates.find((g) => g.kind === 'bundle-size');
}

describe('check-baselines (binary spawn) — bundle-size BUNDLE_SIZE_REFRESH contract', () => {
  let root;

  before(() => {
    root = setupRepo();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 4 on a bundle-size regression when BUNDLE_SIZE_REFRESH is unset', () => {
    writeJson(
      path.join(root, 'baselines', 'bundle-size.json'),
      bundleSizeEnvelope({
        rollup: { '*': { totalKb: 220, gzippedKb: 80 } },
        rows: [{ bundle: 'main', rawKb: 220, gzippedKb: 80 }],
      }),
    );

    const res = spawnDispatcher(root);
    assert.equal(
      res.status,
      4,
      `expected exit 4, got ${res.status}; stdout=${res.stdout}; stderr=${res.stderr}`,
    );
    const gate = bundleSizeGate(res);
    assert.equal(gate.acknowledged, false);
    assert.equal(gate.regressionCount, 1);
  });

  it('exits 0 and marks the gate acknowledged when BUNDLE_SIZE_REFRESH=1 is set', () => {
    // Same regressing working tree as above (still uncommitted).
    const res = spawnDispatcher(root, { BUNDLE_SIZE_REFRESH: '1' });
    assert.equal(
      res.status,
      0,
      `expected exit 0, got ${res.status}; stdout=${res.stdout}; stderr=${res.stderr}`,
    );
    const gate = bundleSizeGate(res);
    assert.equal(gate.acknowledged, true);
    assert.equal(gate.regressionCount, 0);
    assert.equal(gate.breachCount, 0);
  });

  it('malformed BUNDLE_SIZE_REFRESH value is a no-op: falls back to strict enforcement (exit 4)', () => {
    const res = spawnDispatcher(root, { BUNDLE_SIZE_REFRESH: 'yes-please' });
    assert.equal(
      res.status,
      4,
      `expected exit 4 (malformed flag is a no-op), got ${res.status}; stdout=${res.stdout}; stderr=${res.stderr}`,
    );
    const gate = bundleSizeGate(res);
    assert.equal(gate.acknowledged, false);
  });

  it('parity (head === base): exits 0 regardless of BUNDLE_SIZE_REFRESH', () => {
    writeJson(
      path.join(root, 'baselines', 'bundle-size.json'),
      bundleSizeEnvelope(),
    );
    const res = spawnDispatcher(root);
    assert.equal(res.status, 0);
    const gate = bundleSizeGate(res);
    assert.equal(gate.acknowledged, false);
    assert.equal(gate.regressionCount, 0);
  });
});

describe('check-baselines (binary spawn) — floors still enforced when acknowledged', () => {
  let root;

  before(() => {
    // Floor budget tight enough that the regressed head aggregate breaches
    // it even though the ratchet-vs-base comparison would be acknowledged.
    root = setupRepo({ floors: { '*': { totalKb: 210, gzippedKb: 100000 } } });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('BUNDLE_SIZE_REFRESH=1 acknowledges the ratchet regression but floors still fail (exit 1)', () => {
    writeJson(
      path.join(root, 'baselines', 'bundle-size.json'),
      bundleSizeEnvelope({
        rollup: { '*': { totalKb: 220, gzippedKb: 80 } },
        rows: [{ bundle: 'main', rawKb: 220, gzippedKb: 80 }],
      }),
    );

    const res = spawnDispatcher(root, { BUNDLE_SIZE_REFRESH: '1' });
    assert.equal(
      res.status,
      1,
      `expected exit 1 (floor breach survives acknowledgment), got ${res.status}; stdout=${res.stdout}; stderr=${res.stderr}`,
    );
    const gate = bundleSizeGate(res);
    assert.equal(gate.acknowledged, true);
    assert.equal(gate.regressionCount, 0, 'ratchet regression is demoted');
    assert.ok(gate.breachCount > 0, 'floor breach is not suppressed');
  });
});
