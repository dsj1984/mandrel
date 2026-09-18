// tests/contract/check-baselines-duplication-floor.test.js
//
// Story #4923 (AC-1) — the duplication ratchet was inert. Its baseline was
// stamped 2026-06-14, 39 of its 99 rows named files that no longer existed,
// and `check-baselines.js --gate duplication` reported every remaining row
// `unchanged` with `head` byte-identical to `base`. A gate in that state is
// indistinguishable, from its exit code alone, from a gate that is working.
//
// Regenerating the baseline fixes the staleness, but "the baseline is fresh"
// is not the same claim as "the gate can fail". This test makes the second
// claim checkable: it spawns the real dispatcher against a synthetic repo
// whose rows-derived duplication rollup breaches the configured floor, and
// asserts the non-zero exit and the named breach. It deliberately does NOT
// assert the production floor value — that number is a tuning decision and
// this test must not have to move every time it is tightened.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { currentKernelVersion } from '../../.agents/scripts/lib/baselines/kernel.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { seedGitIdentity } from '../fixtures/git-fixture.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const dispatcherBin = path.join(
  repoRoot,
  '.agents',
  'scripts',
  'check-baselines.js',
);

/** Exit-code contract, restated so a change to either side is visible here. */
const EXIT_PASS = 0;
const EXIT_FLOOR = 1;

// Under a husky hook from a linked worktree git exports GIT_DIR at the shared
// main gitdir, and a fixture `git init` under that env writes core.bare into
// the MAIN checkout's config (#4580). Drop every GIT_* variable.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function runGit(args, cwd) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: CLEAN_ENV,
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res.stdout;
}

// The reader derives the rollup `percentage` from the rows' line counts
// (`duplicatedLines / totalLines`), so the counts are chosen to reproduce
// `percentage` exactly to two decimals.
function duplicationEnvelope(percentage) {
  return {
    $schema: '.agents/schemas/baselines/duplication.schema.json',
    kernelVersion: currentKernelVersion('duplication'),
    rows: [
      {
        path: 'src/a.js',
        percentage,
        duplicatedLines: Math.round(percentage * 100),
        totalLines: 10000,
      },
    ],
  };
}

function setupRepo({ floorPercentage, measuredPercentage }) {
  const root = makeTempDir('cb-contract-duplication-');
  created.push(root);
  mkdirSync(path.join(root, 'baselines'), { recursive: true });
  writeFileSync(
    path.join(root, '.agentrc.json'),
    JSON.stringify(
      {
        project: {
          baseBranch: 'main',
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        github: { owner: 'x', repo: 'y', operatorHandle: '@ci' },
        delivery: {
          quality: {
            gates: {
              duplication: {
                enabled: true,
                baselinePath: 'baselines/duplication.json',
                floors: { '*': { percentage: floorPercentage } },
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(root, 'baselines', 'duplication.json'),
    JSON.stringify(duplicationEnvelope(measuredPercentage), null, 2),
  );
  runGit(['init', '--initial-branch=main'], root);
  seedGitIdentity(root, { email: 'contract@example.com', name: 'contract' });
  runGit(['add', '.'], root);
  runGit(['commit', '-m', 'baseline: initial'], root);
  return root;
}

function runDispatcher(cwd) {
  const res = spawnSync(
    process.execPath,
    [
      dispatcherBin,
      '--gate',
      'duplication',
      '--no-friction',
      '--format',
      'json',
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: CLEAN_ENV,
    },
  );
  return { status: res.status, report: JSON.parse(res.stdout) };
}

describe('check-baselines --gate duplication can actually fail', () => {
  it('exits EXIT_FLOOR and names the breach when the rollup exceeds the floor', () => {
    const root = setupRepo({ floorPercentage: 12, measuredPercentage: 20.5 });
    const { status, report } = runDispatcher(root);

    assert.equal(
      status,
      EXIT_FLOOR,
      `expected the floor breach to exit ${EXIT_FLOOR}; report was ${JSON.stringify(report)}`,
    );
    const gate = report.gates.find((g) => g.kind === 'duplication');
    assert.ok(gate, 'the duplication gate must appear in the report');
    assert.equal(gate.breachCount, 1);
    const breach = gate.breaches[0];
    assert.equal(breach.axis, 'percentage');
    assert.equal(breach.floor, 12);
    assert.equal(breach.value, 20.5);
  });

  it('exits clean when the same measurement sits under the floor', () => {
    const root = setupRepo({ floorPercentage: 12, measuredPercentage: 8.35 });
    const { status, report } = runDispatcher(root);
    assert.equal(status, EXIT_PASS, JSON.stringify(report));
    assert.equal(
      report.gates.find((g) => g.kind === 'duplication').breachCount,
      0,
    );
  });
});
