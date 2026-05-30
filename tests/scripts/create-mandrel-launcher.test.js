/**
 * create-mandrel-launcher.test — Story #3373
 *
 * Exercises the cold-start launcher's pure planning logic and its injected
 * orchestration:
 *
 *   - planLaunch: decides submodule-add vs skip and the bootstrap handoff.
 *   - runLauncher: probes `.agents` existence, runs the planned steps in
 *     order, and forwards passthrough flags to bootstrap unchanged.
 *
 * All git / filesystem / process boundaries are injected, so the suite is a
 * pure unit test (no real git, no network, no spawned children).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CANONICAL_REMOTE,
  DIST_BRANCH,
  planLaunch,
  runLauncher,
  SUBMODULE_PATH,
} from '../../create-mandrel/index.js';

const BOOTSTRAP_REL = path.join(SUBMODULE_PATH, 'scripts', 'bootstrap.js');

describe('planLaunch', () => {
  it('adds the submodule against the hardcoded canonical remote on the dist branch when .agents is absent', () => {
    const steps = planLaunch({ agentsPresent: false });
    const add = steps.find((s) => s.cmd === 'git' && s.args[1] === 'add');
    assert.ok(add, 'expected a `git submodule add` step');
    assert.deepEqual(add.args, [
      'submodule',
      'add',
      '-b',
      DIST_BRANCH,
      CANONICAL_REMOTE,
      SUBMODULE_PATH,
    ]);
  });

  it('pins the dist branch to the canonical Mandrel remote (never operator-supplied)', () => {
    // The remote is a build-time constant; assert its exact value so a
    // refactor that accidentally parameterizes it fails loudly.
    assert.equal(CANONICAL_REMOTE, 'https://github.com/dsj1984/mandrel.git');
    assert.equal(DIST_BRANCH, 'dist');
  });

  it('runs `git submodule update --init` after the add when .agents is absent', () => {
    const steps = planLaunch({ agentsPresent: false });
    const update = steps.find((s) => s.cmd === 'git' && s.args[1] === 'update');
    assert.ok(update, 'expected a `git submodule update --init` step');
    assert.deepEqual(update.args, [
      'submodule',
      'update',
      '--init',
      '--',
      SUBMODULE_PATH,
    ]);
    // Add must precede update.
    const addIdx = steps.findIndex((s) => s.args[1] === 'add');
    const updIdx = steps.findIndex((s) => s.args[1] === 'update');
    assert.ok(addIdx < updIdx, 'add must run before update');
  });

  it('skips the add/update steps and goes straight to bootstrap when .agents already exists', () => {
    const steps = planLaunch({ agentsPresent: true });
    assert.equal(
      steps.filter((s) => s.cmd === 'git').length,
      0,
      'no git steps expected when .agents is present',
    );
    assert.equal(steps.length, 1);
    assert.ok(steps[0].args[0].endsWith(BOOTSTRAP_REL));
  });

  it('always finishes by invoking node .agents/scripts/bootstrap.js', () => {
    for (const agentsPresent of [true, false]) {
      const steps = planLaunch({ agentsPresent });
      const last = steps[steps.length - 1];
      assert.equal(last.cmd, process.execPath);
      assert.ok(last.args[0].endsWith(BOOTSTRAP_REL));
    }
  });

  it('forwards passthrough flags to bootstrap unchanged and in order', () => {
    const passthroughArgs = [
      '--assume-yes',
      '--skip-github',
      '--owner',
      'acme',
      '--repo',
      'widget',
    ];
    const steps = planLaunch({ agentsPresent: true, passthroughArgs });
    const bootstrap = steps[steps.length - 1];
    assert.deepEqual(bootstrap.args.slice(1), passthroughArgs);
  });
});

describe('runLauncher', () => {
  it('runs add + update + bootstrap (in that order) when .agents is absent', () => {
    const ran = [];
    const result = runLauncher({
      argv: ['--assume-yes'],
      cwd: '/proj',
      exists: () => false,
      runStep: (step) => ran.push(step),
    });

    assert.equal(result.agentsPresent, false);
    assert.equal(ran.length, 3);
    assert.deepEqual(ran[0].args.slice(0, 2), ['submodule', 'add']);
    assert.deepEqual(ran[1].args.slice(0, 2), ['submodule', 'update']);
    assert.equal(ran[2].cmd, process.execPath);
    assert.deepEqual(ran[2].args.slice(1), ['--assume-yes']);
  });

  it('probes `.agents` under the supplied cwd', () => {
    const probed = [];
    runLauncher({
      argv: [],
      cwd: '/some/project',
      exists: (p) => {
        probed.push(p);
        return true;
      },
      runStep: () => {},
    });
    assert.deepEqual(probed, [path.join('/some/project', SUBMODULE_PATH)]);
  });

  it('skips git steps and only runs bootstrap when .agents exists', () => {
    const ran = [];
    const result = runLauncher({
      argv: ['--skip-github'],
      cwd: '/proj',
      exists: () => true,
      runStep: (step) => ran.push(step),
    });

    assert.equal(result.agentsPresent, true);
    assert.equal(ran.length, 1);
    assert.equal(ran[0].cmd, process.execPath);
    assert.deepEqual(ran[0].args.slice(1), ['--skip-github']);
  });

  it('halts the plan at the first failing step (does not run bootstrap if add fails)', () => {
    const ran = [];
    assert.throws(
      () =>
        runLauncher({
          argv: [],
          cwd: '/proj',
          exists: () => false,
          runStep: (step) => {
            ran.push(step);
            if (step.args[1] === 'add') {
              throw new Error('git submodule add failed');
            }
          },
        }),
      /git submodule add failed/,
    );
    // Only the add ran; update + bootstrap never fired.
    assert.equal(ran.length, 1);
    assert.equal(ran[0].args[1], 'add');
  });
});
