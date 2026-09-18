// tests/contract/coverage-gate-enabled.test.js
//
// Story #4922 — the coverage gate must be able to FAIL.
//
// Before this Story `delivery.quality.gates.coverage` was absent from
// `.agentrc.json`, and `selectEnabledGates` treats a missing gate block as
// disabled. `check-baselines.js --gate coverage` therefore selected zero
// gates and exited 0 unconditionally: `npm run coverage:check` was green in
// every possible state of the repository, including a baseline of pure
// zeroes. A gate that cannot fail is worse than no gate, because it is
// trusted.
//
// These tests drive the REAL `.agentrc.json` floors against the REAL
// `baselines/coverage.json`, copied into a synthetic git repo so the
// head-vs-base compare arm has a base to read. Using the shipped config —
// not a fixture — is the point: a fixture would keep passing if someone
// deleted the coverage block again.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { rollup } from '../../.agents/scripts/lib/baselines/kinds/coverage.js';
import { getQuality } from '../../.agents/scripts/lib/config-resolver.js';
import {
  runCheckBaselines,
  selectEnabledGates,
} from '../../.agents/scripts/lib/orchestration/check-baselines/phases/pipeline.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { seedGitIdentity } from '../fixtures/git-fixture.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DISPATCHER = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'check-baselines.js',
);
const REAL_AGENTRC = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.agentrc.json'), 'utf8'),
);
const REAL_BASELINE = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'baselines', 'coverage.json'), 'utf8'),
);

// Baselines carry no persisted rollup (Story #5400): the gate derives it from
// the rows, so the "measured" number is the kind's own aggregate over them.
const MEASURED = rollup(REAL_BASELINE.rows)['*'];

const EXIT_PASS = 0;
const EXIT_FLOOR = 1;

// Drop every GIT_* var so a fixture `git init` under a husky hook cannot
// inherit the parent checkout's GIT_DIR (#4580).
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

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
}

function writeJson(p, value) {
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

/**
 * Build a git repo carrying the repository's real agentrc + real coverage
 * baseline on `main`, so the dispatcher's base read resolves.
 */
function setupRepo(agentrc = REAL_AGENTRC) {
  const root = makeTempDir('coverage-gate-');
  fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
  writeJson(path.join(root, '.agentrc.json'), agentrc);
  writeJson(path.join(root, 'baselines', 'coverage.json'), REAL_BASELINE);
  runGit(['init', '--initial-branch=main'], root);
  seedGitIdentity(root, { email: 'contract@example.com', name: 'contract' });
  runGit(['add', '.agentrc.json', 'baselines/coverage.json'], root);
  runGit(['commit', '-m', 'baseline: initial'], root);
  return root;
}

/**
 * Spawn the real binary — this is the exit-code contract `npm run
 * coverage:check` and the CI `baselines` job actually consume. Text format:
 * the JSON report over 556 rows exceeds the pipe buffer and comes back
 * truncated, so the structured assertions go through `reportFor` instead.
 */
function runGate(cwd) {
  return spawnSync(
    process.execPath,
    [DISPATCHER, '--gate', 'coverage', '--no-friction', '--format', 'text'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** In-process run of the same pipeline, for assertions on the report shape. */
function reportFor(cwd) {
  return runCheckBaselines({
    argv: ['--gate', 'coverage', '--no-friction'],
    cwd,
  });
}

describe('coverage gate — selection', () => {
  it('the shipped config selects the coverage gate', () => {
    const gates = selectEnabledGates(getQuality(REAL_AGENTRC));
    assert.ok(
      gates.includes('coverage'),
      'delivery.quality.gates.coverage must be configured — a missing block ' +
        'makes `check-baselines.js --gate coverage` a no-op that exits 0',
    );
  });

  it('a config WITHOUT the coverage block selects zero gates (the old bug)', () => {
    // The contrast case. This is precisely the state `.agentrc.json` was in
    // before Story #4922, and it is why `npm run coverage:check` could never
    // report anything.
    const stripped = structuredClone(REAL_AGENTRC);
    delete stripped.delivery.quality.gates.coverage;
    const gates = selectEnabledGates(getQuality(stripped));
    assert.equal(gates.includes('coverage'), false);
  });

  it('the shipped floors declare all three coverage axes', () => {
    const floors = REAL_AGENTRC.delivery.quality.gates.coverage.floors['*'];
    for (const axis of ['lines', 'branches', 'functions']) {
      assert.equal(
        typeof floors[axis],
        'number',
        `coverage floor '${axis}' must be a number`,
      );
    }
  });
});

describe('coverage gate — floors are derived from the regenerated baseline', () => {
  it('every floor sits at or below the measured rollup it was derived from', () => {
    const floors = REAL_AGENTRC.delivery.quality.gates.coverage.floors['*'];
    for (const axis of ['lines', 'branches', 'functions']) {
      assert.ok(
        floors[axis] <= MEASURED[axis],
        `coverage floor ${axis}=${floors[axis]} exceeds the measured ` +
          `rollup ${MEASURED[axis]} — a floor above the measurement fails on ` +
          'the very run it was configured from',
      );
      // ...and not so far below it that the floor is decorative. The
      // 90/85/90 example in .agents/docs/agentrc-reference.json is validated
      // only against itself; these floors track the real number.
      assert.ok(
        MEASURED[axis] - floors[axis] <= 5,
        `coverage floor ${axis}=${floors[axis]} is more than 5 points below ` +
          `the measured ${MEASURED[axis]} — that much slack makes the floor ` +
          'unable to catch a real drop',
      );
    }
  });
});

/**
 * The real baseline plus just enough NEW rows scoring 0 on `axis` (and 100 on
 * the others) to drag the rows-derived `axis` rollup under `floor`. New rows
 * are additions, never regressions, and they only raise the other axes — so
 * the floor breach on `axis` is the single failure the run can report.
 */
function poisonAxis(axis, floor) {
  const poisoned = structuredClone(REAL_BASELINE);
  let i = 0;
  while (rollup(poisoned.rows)['*'][axis] >= floor) {
    poisoned.rows.push({
      path: `poison/${i++}.js`,
      lines: 100,
      branches: 100,
      functions: 100,
      [axis]: 0,
    });
  }
  return poisoned;
}

describe('coverage gate — it can actually fail', () => {
  let root;

  before(() => {
    root = setupRepo();
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes on the real baseline with the real floors', async () => {
    const res = runGate(root);
    assert.equal(
      res.status,
      EXIT_PASS,
      `expected exit 0 on the shipped baseline; stdout=${res.stdout} stderr=${res.stderr}`,
    );
    const { report } = await reportFor(root);
    assert.equal(report.gates.length, 1, 'exactly one gate must be selected');
    assert.equal(report.gates[0].kind, 'coverage');
    assert.equal(report.totalBreaches, 0);
  });

  for (const axis of ['lines', 'branches', 'functions']) {
    it(`fails when the measured ${axis} rollup drops below its floor`, async () => {
      const floor =
        REAL_AGENTRC.delivery.quality.gates.coverage.floors['*'][axis];
      writeJson(
        path.join(root, 'baselines', 'coverage.json'),
        poisonAxis(axis, floor),
      );

      const res = runGate(root);
      assert.equal(
        res.status,
        EXIT_FLOOR,
        `expected exit ${EXIT_FLOOR} with ${axis} below floor ${floor}; ` +
          `stdout=${res.stdout} stderr=${res.stderr}`,
      );
      const { report, exitCode } = await reportFor(root);
      assert.equal(exitCode, EXIT_FLOOR);
      assert.equal(report.totalBreaches, 1);
      assert.deepEqual(
        report.gates[0].breaches.map((b) => b.axis),
        [axis],
      );

      // Restore for the next case.
      writeJson(path.join(root, 'baselines', 'coverage.json'), REAL_BASELINE);
    });
  }
});
