/**
 * create-mandrel-launcher.test — Story #3373, #3465
 *
 * Exercises the cold-start launcher's pure planning logic and its injected
 * orchestration:
 *
 *   - planLaunch: decides npm-install + mandrel-sync vs skip and the
 *     bootstrap handoff.
 *   - runLauncher: probes `.agents` existence, runs the planned steps in
 *     order, and forwards passthrough flags to bootstrap unchanged.
 *
 * All npm / filesystem / process boundaries are injected, so the suite is a
 * pure unit test (no real npm, no network, no spawned children).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  AGENTS_PATH,
  CANONICAL_PACKAGE,
  planLaunch,
  runLauncher,
} from '../../create-mandrel/index.js';

const BOOTSTRAP_REL = path.join(AGENTS_PATH, 'scripts', 'bootstrap.js');

describe('planLaunch', () => {
  it('installs the hardcoded canonical package when .agents is absent', () => {
    const steps = planLaunch({ agentsPresent: false });
    const install = steps.find(
      (s) => s.cmd === 'npm' && s.args[0] === 'install',
    );
    assert.ok(install, 'expected an `npm install` step');
    assert.deepEqual(install.args, ['install', CANONICAL_PACKAGE]);
  });

  it('targets the canonical Mandrel package (never operator-supplied)', () => {
    // The package name is a build-time constant; assert its exact value so a
    // refactor that accidentally parameterizes it fails loudly.
    assert.equal(CANONICAL_PACKAGE, '@mandrel/agents');
    assert.equal(AGENTS_PATH, '.agents');
  });

  it('runs `npx mandrel sync` after the install when .agents is absent', () => {
    const steps = planLaunch({ agentsPresent: false });
    const sync = steps.find((s) => s.cmd === 'npx');
    assert.ok(sync, 'expected an `npx mandrel sync` step');
    assert.deepEqual(sync.args, ['mandrel', 'sync']);
    // Install must precede sync.
    const installIdx = steps.findIndex(
      (s) => s.cmd === 'npm' && s.args[0] === 'install',
    );
    const syncIdx = steps.findIndex((s) => s.cmd === 'npx');
    assert.ok(installIdx < syncIdx, 'install must run before sync');
  });

  it('skips the install/sync steps and goes straight to bootstrap when .agents already exists', () => {
    const steps = planLaunch({ agentsPresent: true });
    assert.equal(
      steps.filter((s) => s.cmd === 'npm' || s.cmd === 'npx').length,
      0,
      'no npm/npx steps expected when .agents is present',
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
  it('runs install + sync + bootstrap (in that order) when .agents is absent', () => {
    const ran = [];
    const result = runLauncher({
      argv: ['--assume-yes'],
      cwd: '/proj',
      exists: () => false,
      runStep: (step) => ran.push(step),
    });

    assert.equal(result.agentsPresent, false);
    assert.equal(ran.length, 3);
    assert.deepEqual(ran[0], {
      cmd: 'npm',
      args: ['install', CANONICAL_PACKAGE],
    });
    assert.deepEqual(ran[1], { cmd: 'npx', args: ['mandrel', 'sync'] });
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
    assert.deepEqual(probed, [path.join('/some/project', AGENTS_PATH)]);
  });

  it('skips npm/npx steps and only runs bootstrap when .agents exists', () => {
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

  it('halts the plan at the first failing step (does not run sync/bootstrap if install fails)', () => {
    const ran = [];
    assert.throws(
      () =>
        runLauncher({
          argv: [],
          cwd: '/proj',
          exists: () => false,
          runStep: (step) => {
            ran.push(step);
            if (step.cmd === 'npm' && step.args[0] === 'install') {
              throw new Error('npm install failed');
            }
          },
        }),
      /npm install failed/,
    );
    // Only the install ran; sync + bootstrap never fired.
    assert.equal(ran.length, 1);
    assert.equal(ran[0].cmd, 'npm');
    assert.equal(ran[0].args[0], 'install');
  });
});
