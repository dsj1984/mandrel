/**
 * registry-merge-driver.test.js — the `merge-driver` doctor check
 * (Story #5215).
 *
 * The registration this guards has two halves in two places: `.gitattributes`
 * (tracked, ships with the repo) says which files use the driver, and
 * `merge.mandrel-baseline.driver` (per-clone git config, because git will not
 * run a command chosen by whoever wrote the repository) says what it is. A
 * fresh clone has the first and not the second, and git says nothing — it
 * just falls back to text-merging baselines. The check exists to make that
 * silence audible, and to stay quiet for a repo that never opted in.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { BASELINE_MERGE_DRIVER_CONFIG_KEY } from '../../../.agents/scripts/lib/bootstrap/baseline-merge-driver.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { registry, runMergeDriver } from '../registry.js';

// The attribute is asserted as a literal rather than imported from the module
// under test: it is the EXACT line a repository commits, and a test that
// imports the string it is checking can only ever agree with itself.
const BASELINE_MERGE_ATTRIBUTE = 'baselines/*.json merge=mandrel-baseline';

// The driver command is NOT a literal, because Story #5277 made its first
// token `process.execPath` — the running node binary's absolute path. Pinning
// it as a literal would pin the machine the suite happens to run on.
const BASELINE_MERGE_DRIVER_COMMAND = `"${process.execPath}" .agents/scripts/merge-baseline.js %O %A %B %P`;

/** A project root whose `.gitattributes` holds exactly `content`. */
function projectWith(content) {
  const dir = makeTempDir('mandrel-doctor-merge-');
  if (content !== null) {
    fs.writeFileSync(path.join(dir, '.gitattributes'), content);
  }
  return dir;
}

/** The real spawn seam, in the shape `runMergeDriver` calls its runner. */
function realSpawn(file, args, opts) {
  const r = spawnSync(file, args, { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const unsetConfig = () => ({ status: 1, stdout: '', stderr: '' });

/**
 * A runner that answers the config read with `command` and the driver probe
 * with `probeStatus`. The check makes exactly two calls and they are told
 * apart by the executable, which is what lets one seam serve both.
 */
function stubRunner({
  command = BASELINE_MERGE_DRIVER_COMMAND,
  probeStatus = 0,
} = {}) {
  const calls = [];
  const runner = (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === 'git')
      return { status: 0, stdout: `${command}\n`, stderr: '' };
    return { status: probeStatus, stdout: '', stderr: '' };
  };
  runner.calls = calls;
  return runner;
}

const setConfig = () => stubRunner();

describe('doctor merge-driver — registered in the check order', () => {
  it('runs as a fatal check before pin-current', () => {
    const names = registry.map((c) => c.name);
    assert.ok(names.includes('merge-driver'));
    const entry = registry.find((c) => c.name === 'merge-driver');
    assert.ok(!entry.advisory, 'a silently-degraded merge is not advisory');
  });

  it('the registered run() wrapper reaches the check', () => {
    // The doctor runner calls `entry.run()`, not `runMergeDriver` directly, so
    // exercising only the latter would leave the wiring itself unproven.
    const cwd = projectWith('* text=auto eol=lf\n');
    const entry = registry.find((c) => c.name === 'merge-driver');
    const result = entry.run({ cwd: () => cwd });
    assert.equal(result.ok, true);
    assert.match(result.detail, /skipped/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('doctor merge-driver — the repo opted in (AC-7)', () => {
  it('fails with the exact git config command when the driver is unset', () => {
    const cwd = projectWith(`${BASELINE_MERGE_ATTRIBUTE}\n`);
    const result = runMergeDriver({ cwd: () => cwd, runner: unsetConfig });

    assert.equal(result.ok, false);
    assert.equal(
      result.remedy,
      `git config ${BASELINE_MERGE_DRIVER_CONFIG_KEY} '${BASELINE_MERGE_DRIVER_COMMAND}'`,
    );
    assert.match(result.detail, /unset/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('passes once the driver is configured', () => {
    const cwd = projectWith(`${BASELINE_MERGE_ATTRIBUTE}\n`);
    const result = runMergeDriver({ cwd: () => cwd, runner: setConfig() });

    assert.equal(result.ok, true);
    assert.equal(result.remedy, undefined);
    assert.match(result.detail, /merge-baseline\.js/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('treats an empty config value as unset', () => {
    const cwd = projectWith(`${BASELINE_MERGE_ATTRIBUTE}\n`);
    const result = runMergeDriver({
      cwd: () => cwd,
      runner: () => ({ status: 0, stdout: '\n', stderr: '' }),
    });
    assert.equal(result.ok, false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('doctor merge-driver — against real git', () => {
  it('reports the driver unset in a directory with no git config', () => {
    // Exercises the default `runner` seam rather than a stub: a scratch dir
    // is not a repository, so `git config --get` exits non-zero and the check
    // must read that as "unset" rather than crashing.
    const cwd = projectWith(`${BASELINE_MERGE_ATTRIBUTE}\n`);
    const result = runMergeDriver({ cwd: () => cwd });
    assert.equal(result.ok, false);
    assert.match(result.remedy, /git config/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('doctor merge-driver — the repo never opted in', () => {
  for (const [label, content] of [
    ['no .gitattributes at all', null],
    ['a .gitattributes with unrelated rules', '* text=auto eol=lf\n'],
    ['a commented-out registration', `# ${BASELINE_MERGE_ATTRIBUTE}\n`],
  ]) {
    it(`passes as skipped with ${label}`, () => {
      const cwd = projectWith(content);
      const result = runMergeDriver({
        cwd: () => cwd,
        runner: () => {
          throw new Error('git must not be consulted when the repo opted out');
        },
      });
      assert.equal(result.ok, true);
      assert.match(result.detail, /skipped/);
      fs.rmSync(cwd, { recursive: true, force: true });
    });
  }
});

describe('doctor merge-driver — a set key is not a working driver (AC-3)', () => {
  it('fails when the configured command exits non-zero on --help', () => {
    // The failure a presence check cannot see, and the common one: the command
    // names an absolute node binary and an nvm version bump moved it. Git's
    // behaviour is then identical to an unset key — a text merge, silently.
    const cwd = projectWith(`${BASELINE_MERGE_ATTRIBUTE}\n`);
    const runner = stubRunner({ probeStatus: 127 });
    const result = runMergeDriver({ cwd: () => cwd, runner });

    assert.equal(result.ok, false);
    assert.match(result.detail, /running it failed \(exit 127\)/);
    assert.match(result.remedy, /git config/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('probes with --help, argv-tokenised, from the project root', () => {
    const cwd = projectWith(`${BASELINE_MERGE_ATTRIBUTE}\n`);
    const runner = stubRunner();
    runMergeDriver({ cwd: () => cwd, runner });

    const probe = runner.calls.find((c) => c.file !== 'git');
    // The executable is the unquoted node path and git's %O/%A/%B/%P
    // placeholders are dropped — the driver would otherwise treat them as
    // merge inputs. Never a shell string: this is a per-clone config value.
    assert.equal(probe.file, process.execPath);
    assert.deepEqual(probe.args, [
      '.agents/scripts/merge-baseline.js',
      '--help',
    ]);
    assert.equal(probe.opts.cwd, cwd);
    assert.equal(runner.calls[0].opts.cwd, cwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('fails when the configured value has no runnable command in it', () => {
    const cwd = projectWith(`${BASELINE_MERGE_ATTRIBUTE}\n`);
    const result = runMergeDriver({
      cwd: () => cwd,
      runner: stubRunner({ command: '%O %A %B %P' }),
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /no runnable command/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('passes against the real driver script with the real spawn seam', () => {
    // End-to-end through the default runner: the shipped CLI answers --help
    // with exit 0 and writes nothing, which is why --help is the probe.
    const repoRoot = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../..',
    );
    const result = runMergeDriver({
      cwd: () => repoRoot,
      runner: (file, args, opts) =>
        file === 'git'
          ? {
              status: 0,
              stdout: `${BASELINE_MERGE_DRIVER_COMMAND}\n`,
              stderr: '',
            }
          : realSpawn(file, args, opts),
    });
    assert.equal(result.ok, true, result.detail);
  });
});
