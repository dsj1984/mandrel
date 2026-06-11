// tests/cli/init.test.js
/**
 * Unit tests for lib/cli/init.js — the `mandrel init` one-command cold start
 * (Story #3975).
 *
 * Every test drives `planInit` through its injectable seams (argv, exists,
 * runStep, confirm, stdout, isTTY). The suite is hermetic: no real TTY, no real
 * npm install, no network, and no filesystem writes occur (testing-standards
 * § Unit — all external I/O MUST be mocked; pure-logic assertions only).
 *
 * Coverage contract (Story #3975 AC):
 *   - Module shape: `planInit` named export + default function export.
 *   - `.agents/` absent → install `mandrel --ignore-scripts` then `sync`, in
 *     that order, against the hardcoded `mandrel` package name.
 *   - `.agents/` present → no install/sync steps run.
 *   - The two-option numbered prompt renders both options.
 *   - Choosing 1 → bootstrap step is execPath + bootstrap.js + forwarded argv.
 *   - Choosing 2 → no bootstrap, hint printed, ranBootstrap false, exit 0.
 *   - `--assume-yes` → confirm seam not consulted, bootstrap carries the flag.
 *   - Non-TTY without `--assume-yes` → files-only, exit 0.
 *   - Bin dispatch: `mandrel init --help` reaches the module (integration).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import init, { planInit } from '../../lib/cli/init.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'mandrel.js');

// ---------------------------------------------------------------------------
// Seam helpers
// ---------------------------------------------------------------------------

/**
 * Build a recording `runStep` seam. Every invocation is captured; the status
 * defaults to 0 (success) unless `statuses` supplies a per-call override.
 */
function makeRunStep({ statuses = [] } = {}) {
  const calls = [];
  const runStep = (cmd, args) => {
    calls.push({ cmd, args });
    const status = statuses.length ? statuses.shift() : 0;
    return { status };
  };
  return { calls, runStep };
}

/** Capture stdout writes into an array. */
function makeStdout() {
  const out = [];
  return { out, write: (s) => out.push(s) };
}

/** A `confirm` seam that records whether it was consulted and returns `choice`. */
function makeConfirm(choice) {
  const state = { consulted: false };
  const confirm = () => {
    state.consulted = true;
    return choice;
  };
  return { state, confirm };
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('init — module shape', () => {
  it('exports planInit (named) and a default run function', () => {
    assert.equal(typeof planInit, 'function');
    assert.equal(typeof init, 'function');
  });
});

// ---------------------------------------------------------------------------
// Step 1 — install-if-absent
// ---------------------------------------------------------------------------

describe('init — install when .agents/ is absent', () => {
  it('installs the hardcoded `mandrel` with --ignore-scripts, then syncs, in order', () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm('2');
    const { write } = makeStdout();

    const result = planInit({
      argv: [],
      exists: () => false, // .agents/ absent
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    // First two steps are install then sync, in that order.
    assert.equal(calls[0].cmd, 'npm');
    assert.deepEqual(calls[0].args, ['install', 'mandrel', '--ignore-scripts']);
    assert.equal(calls[1].cmd, 'mandrel');
    assert.deepEqual(calls[1].args, ['sync']);
    assert.equal(result.installed, true);
  });

  it('targets the hardcoded package name even when argv supplies a different name', () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm('2');
    const { write } = makeStdout();

    planInit({
      // An attacker-influenced flag must NOT redirect the install target.
      argv: ['--package', 'evil-pkg', 'evil-pkg'],
      exists: () => false,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    assert.deepEqual(calls[0].args, ['install', 'mandrel', '--ignore-scripts']);
  });

  it('short-circuits with the install exit code when install fails', () => {
    const { calls, runStep } = makeRunStep({ statuses: [7] });
    const { confirm, state } = makeConfirm('1');
    const { write } = makeStdout();

    const result = planInit({
      argv: [],
      exists: () => false,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    assert.equal(result.exitCode, 7);
    assert.equal(result.ranBootstrap, false);
    assert.equal(calls.length, 1, 'sync must not run after a failed install');
    assert.equal(
      state.consulted,
      false,
      'prompt must not run after a failed install',
    );
  });
});

describe('init — skip install when .agents/ is present', () => {
  it('runs no install/sync steps and goes straight to the prompt', () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm('2');
    const { write } = makeStdout();

    const result = planInit({
      argv: [],
      exists: () => true, // .agents/ present
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    const installOrSync = calls.filter(
      (c) => c.cmd === 'npm' || (c.cmd === 'mandrel' && c.args[0] === 'sync'),
    );
    assert.equal(
      installOrSync.length,
      0,
      'no install/sync when .agents/ exists',
    );
    assert.equal(result.installed, false);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — two-option prompt
// ---------------------------------------------------------------------------

describe('init — two-option prompt rendering', () => {
  it('renders both numbered options on a TTY without --assume-yes', () => {
    const { runStep } = makeRunStep();
    const { confirm } = makeConfirm('2');
    const { out, write } = makeStdout();

    planInit({
      argv: [],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    const prompt = out.join('');
    assert.match(prompt, /1\) Configure my environment now/);
    assert.match(prompt, /2\) Just the files/);
  });
});

// ---------------------------------------------------------------------------
// Option 1 — configure (run bootstrap)
// ---------------------------------------------------------------------------

describe('init — option 1 runs bootstrap.js with forwarded argv', () => {
  it('invokes process.execPath + bootstrap.js + forwarded flags', () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm('1');
    const { write } = makeStdout();

    const result = planInit({
      argv: ['--owner', 'acme', '--repo', 'widgets'],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    const bootstrapCall = calls.find((c) => c.cmd === process.execPath);
    assert.ok(bootstrapCall, 'expected a process.execPath bootstrap step');
    assert.ok(
      bootstrapCall.args[0].endsWith(
        path.join('.agents', 'scripts', 'bootstrap.js'),
      ),
      `expected bootstrap.js path, got ${bootstrapCall.args[0]}`,
    );
    assert.deepEqual(bootstrapCall.args.slice(1), [
      '--owner',
      'acme',
      '--repo',
      'widgets',
    ]);
    assert.equal(result.ranBootstrap, true);
  });
});

// ---------------------------------------------------------------------------
// Option 2 — files-only
// ---------------------------------------------------------------------------

describe('init — option 2 skips bootstrap and prints the hint', () => {
  it('runs no bootstrap step, prints the re-run hint, sets ranBootstrap false, exits 0', () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm('2');
    const { out, write } = makeStdout();

    const result = planInit({
      argv: [],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    const bootstrapCall = calls.find((c) => c.cmd === process.execPath);
    assert.equal(bootstrapCall, undefined, 'no bootstrap step on files-only');
    assert.match(out.join(''), /Configure any time with: mandrel init/);
    assert.equal(result.ranBootstrap, false);
    assert.equal(result.exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// --assume-yes
// ---------------------------------------------------------------------------

describe('init — --assume-yes skips the prompt and forwards the flag', () => {
  it('does not consult confirm and forwards --assume-yes to bootstrap', () => {
    const { calls, runStep } = makeRunStep();
    const { confirm, state } = makeConfirm('2'); // would choose files-only if consulted
    const { write } = makeStdout();

    const result = planInit({
      argv: ['--assume-yes', '--owner', 'acme'],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    assert.equal(state.consulted, false, 'confirm seam must not be consulted');
    const bootstrapCall = calls.find((c) => c.cmd === process.execPath);
    assert.ok(
      bootstrapCall.args.includes('--assume-yes'),
      'bootstrap must carry --assume-yes',
    );
    assert.equal(result.ranBootstrap, true);
  });

  it('does not duplicate --assume-yes when argv already carries it once', () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm('1');
    const { write } = makeStdout();

    planInit({
      argv: ['--assume-yes'],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    const bootstrapCall = calls.find((c) => c.cmd === process.execPath);
    const yesCount = bootstrapCall.args.filter(
      (a) => a === '--assume-yes',
    ).length;
    assert.equal(yesCount, 1, '--assume-yes must be forwarded exactly once');
  });
});

// ---------------------------------------------------------------------------
// Non-TTY default
// ---------------------------------------------------------------------------

describe('init — non-TTY stdin defaults to files-only', () => {
  it('chooses files-only (no bootstrap) and exits 0 when stdin is not a TTY', () => {
    const { calls, runStep } = makeRunStep();
    const { confirm, state } = makeConfirm('1'); // would configure if consulted
    const { out, write } = makeStdout();

    const result = planInit({
      argv: [],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: false, // non-TTY
    });

    assert.equal(
      state.consulted,
      false,
      'confirm seam must not run in non-TTY mode',
    );
    const bootstrapCall = calls.find((c) => c.cmd === process.execPath);
    assert.equal(bootstrapCall, undefined, 'must never provision unattended');
    assert.match(out.join(''), /Configure any time with: mandrel init/);
    assert.equal(result.ranBootstrap, false);
    assert.equal(result.exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// Bin dispatch integration — mandrel init --help reaches the module
// ---------------------------------------------------------------------------

describe('mandrel init — bin dispatch integration', () => {
  it('dispatches `mandrel init --help` to the module and exits 0', () => {
    const result = spawnSync(process.execPath, [BIN, 'init', '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(
      result.status,
      0,
      `mandrel init --help exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(result.stdout, /Usage: mandrel init/);
  });
});
