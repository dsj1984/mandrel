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
 *   - The yes/no prompt renders the question and `[Y/n]` hint.
 *   - Answering yes → bootstrap step is execPath + bootstrap.js + forwarded argv.
 *   - Answering no → no bootstrap, hint printed, ranBootstrap false, exit 0.
 *   - `--assume-yes` → confirm seam not consulted, bootstrap carries the flag.
 *   - Non-TTY without `--assume-yes` → files-only, exit 0.
 *   - Bin dispatch: `mandrel init --help` reaches the module (integration).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import init, { defaultConfirm, planInit } from '../../lib/cli/init.js';

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

/**
 * A `confirm` seam that records whether it was consulted and returns `answer`
 * (a boolean — true = configure now / yes, false = files-only / no).
 */
function makeConfirm(answer) {
  const state = { consulted: false };
  const confirm = () => {
    state.consulted = true;
    return answer;
  };
  return { state, confirm };
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('init — module shape', () => {
  it('exports planInit (named) and a default run function', async () => {
    assert.equal(typeof planInit, 'function');
    assert.equal(typeof init, 'function');
  });
});

// ---------------------------------------------------------------------------
// Step 1 — install-if-absent
// ---------------------------------------------------------------------------

describe('init — install when .agents/ is absent', () => {
  it('installs the hardcoded `mandrel` with --ignore-scripts, then syncs, in order', async () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm(false);
    const { write } = makeStdout();

    const result = await planInit({
      argv: [],
      exists: () => false, // .agents/ absent
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    // First two steps are install then sync, in that order. The sync step is
    // dispatched against the locally installed bin via process.execPath, NOT a
    // bare `mandrel` on PATH (Story #4016).
    assert.equal(calls[0].cmd, 'npm');
    assert.deepEqual(calls[0].args, ['install', 'mandrel', '--ignore-scripts']);
    assert.equal(calls[1].cmd, process.execPath);
    assert.equal(calls[1].args.length, 2);
    assert.ok(
      calls[1].args[0].endsWith(
        path.join('node_modules', 'mandrel', 'bin', 'mandrel.js'),
      ),
      `expected the resolved local bin path, got ${calls[1].args[0]}`,
    );
    assert.equal(calls[1].args[1], 'sync');
    assert.equal(result.installed, true);
  });

  it('resolves the sync step to the local bin, never a bare `mandrel` on PATH (Story #4016)', async () => {
    // Regression guard for the post-install (non-npx) cold start: reached via a
    // documented `npm install mandrel` then `mandrel init`, or a plain
    // `node bin/mandrel.js init`, the freshly installed binary lives at
    // ./node_modules/mandrel/bin/mandrel.js and is NOT on PATH. A bare
    // spawnSync('mandrel', ['sync']) dies with ENOENT and leaves .agents/
    // un-materialized. The sync step must instead spawn process.execPath against
    // the resolved local entrypoint.
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm(false);
    const { write } = makeStdout();

    await planInit({
      argv: [],
      exists: () => false, // .agents/ absent → install + sync path
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    // No step may invoke a bare `mandrel` (the PATH-dependent shape).
    const bareMandrel = calls.find((c) => c.cmd === 'mandrel');
    assert.equal(
      bareMandrel,
      undefined,
      'sync must not spawn a bare `mandrel` on PATH',
    );

    // The sync step is process.execPath + the cwd-relative local bin + `sync`.
    const syncCall = calls.find((c) => c.args.includes('sync'));
    assert.ok(syncCall, 'expected a sync step');
    assert.equal(
      syncCall.cmd,
      process.execPath,
      'sync must be dispatched through process.execPath (node)',
    );
    assert.equal(
      syncCall.args[0],
      path.join('node_modules', 'mandrel', 'bin', 'mandrel.js'),
      'sync must target the resolved local Mandrel entrypoint',
    );
    assert.equal(syncCall.args[1], 'sync');
  });

  it('targets the hardcoded package name even when argv supplies a different name', async () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm(false);
    const { write } = makeStdout();

    await planInit({
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

  it('short-circuits with the install exit code when install fails', async () => {
    const { calls, runStep } = makeRunStep({ statuses: [7] });
    const { confirm, state } = makeConfirm(true);
    const { write } = makeStdout();

    const result = await planInit({
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
  it('runs no install/sync steps and goes straight to the prompt', async () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm(false);
    const { write } = makeStdout();

    const result = await planInit({
      argv: [],
      exists: () => true, // .agents/ present
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    const installOrSync = calls.filter(
      (c) => c.cmd === 'npm' || c.args.includes('sync'),
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
// Step 2 — yes/no prompt
// ---------------------------------------------------------------------------

describe('init — yes/no prompt rendering', () => {
  it('renders the yes/no question on a TTY without --assume-yes', async () => {
    const { runStep } = makeRunStep();
    const { confirm } = makeConfirm(false);
    const { out, write } = makeStdout();

    await planInit({
      argv: [],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    const prompt = out.join('');
    assert.match(prompt, /Begin interactive setup\?/);
    assert.match(prompt, /\[Y\/n\]:/);
  });
});

// ---------------------------------------------------------------------------
// Answering yes — configure (run bootstrap)
// ---------------------------------------------------------------------------

describe('init — answering yes runs bootstrap.js with forwarded argv', () => {
  it('invokes process.execPath + bootstrap.js + forwarded flags', async () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm(true);
    const { write } = makeStdout();

    const result = await planInit({
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
// Answering no — files-only
// ---------------------------------------------------------------------------

describe('init — answering no skips bootstrap and prints the hint', () => {
  it('runs no bootstrap step, prints the re-run hint, sets ranBootstrap false, exits 0', async () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm(false);
    const { out, write } = makeStdout();

    const result = await planInit({
      argv: [],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
    });

    const bootstrapCall = calls.find((c) => c.cmd === process.execPath);
    assert.equal(bootstrapCall, undefined, 'no bootstrap step on files-only');
    assert.match(out.join(''), /Setup any time with: npx mandrel init/);
    assert.equal(result.ranBootstrap, false);
    assert.equal(result.exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// --assume-yes
// ---------------------------------------------------------------------------

describe('init — --assume-yes skips the prompt and forwards the flag', () => {
  it('does not consult confirm and forwards --assume-yes to bootstrap', async () => {
    const { calls, runStep } = makeRunStep();
    const { confirm, state } = makeConfirm(false); // would choose files-only if consulted
    const { write } = makeStdout();

    const result = await planInit({
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

  it('does not duplicate --assume-yes when argv already carries it once', async () => {
    const { calls, runStep } = makeRunStep();
    const { confirm } = makeConfirm(true);
    const { write } = makeStdout();

    await planInit({
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
  it('chooses files-only (no bootstrap) and exits 0 when stdin is not a TTY', async () => {
    const { calls, runStep } = makeRunStep();
    const { confirm, state } = makeConfirm(true); // would configure if consulted
    const { out, write } = makeStdout();

    const result = await planInit({
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
    assert.match(out.join(''), /Setup any time with: npx mandrel init/);
    assert.equal(result.ranBootstrap, false);
    assert.equal(result.exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// afterBootstrap seam — init tail is called after bootstrap succeeds
// ---------------------------------------------------------------------------

describe('init — afterBootstrap seam called after successful bootstrap', () => {
  it('calls afterBootstrap with the cwd when bootstrap exits 0', async () => {
    const { runStep } = makeRunStep({ statuses: [0] }); // bootstrap exits 0
    const { confirm } = makeConfirm(true);
    const { write } = makeStdout();

    let afterBootstrapCalled = false;
    let afterBootstrapRoot = null;

    await planInit({
      argv: [],
      exists: () => true, // .agents/ present — no install/sync
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
      afterBootstrap: async (root) => {
        afterBootstrapCalled = true;
        afterBootstrapRoot = root;
      },
    });

    assert.equal(
      afterBootstrapCalled,
      true,
      'afterBootstrap must be called when bootstrap exits 0',
    );
    assert.equal(typeof afterBootstrapRoot, 'string');
  });

  it('does not call afterBootstrap when bootstrap exits non-zero', async () => {
    const { runStep } = makeRunStep({ statuses: [1] }); // bootstrap fails
    const { confirm } = makeConfirm(true);
    const { write } = makeStdout();

    let afterBootstrapCalled = false;

    const result = await planInit({
      argv: [],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
      afterBootstrap: async () => {
        afterBootstrapCalled = true;
      },
    });

    assert.equal(
      afterBootstrapCalled,
      false,
      'afterBootstrap must not run when bootstrap fails',
    );
    assert.equal(result.exitCode, 1);
  });

  it('does not call afterBootstrap on the files-only path', async () => {
    const { runStep } = makeRunStep();
    const { confirm } = makeConfirm(false); // files-only
    const { write } = makeStdout();

    let afterBootstrapCalled = false;

    await planInit({
      argv: [],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
      afterBootstrap: async () => {
        afterBootstrapCalled = true;
      },
    });

    assert.equal(
      afterBootstrapCalled,
      false,
      'afterBootstrap must not run on the files-only path',
    );
  });

  it('exits 1 when the init tail reports ok: false (doctor gate failed)', async () => {
    const { runStep } = makeRunStep({ statuses: [0] }); // bootstrap exits 0
    const { confirm } = makeConfirm(true);
    const { write } = makeStdout();

    const result = await planInit({
      argv: [],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
      afterBootstrap: async () => ({ ok: false }),
    });

    assert.equal(result.ranBootstrap, true);
    assert.equal(
      result.exitCode,
      1,
      'a failed init tail must propagate a non-zero exit code',
    );
  });

  it('exits 0 when the init tail reports ok: true', async () => {
    const { runStep } = makeRunStep({ statuses: [0] });
    const { confirm } = makeConfirm(true);
    const { write } = makeStdout();

    const result = await planInit({
      argv: [],
      exists: () => true,
      runStep,
      confirm,
      stdout: write,
      isTTY: true,
      afterBootstrap: async () => ({ ok: true }),
    });

    assert.equal(result.exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// Bin dispatch integration — mandrel init --help reaches the module
// ---------------------------------------------------------------------------

describe('mandrel init — bin dispatch integration', () => {
  it('dispatches `mandrel init --help` to the module and exits 0', async () => {
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

// ---------------------------------------------------------------------------
// defaultConfirm — prompt-erase regression guard
// ---------------------------------------------------------------------------

describe('init — defaultConfirm readline options', () => {
  it('creates the readline interface with terminal:false so the pre-written prompt is not erased', async () => {
    let captured;
    const createInterface = (opts) => {
      captured = opts;
      return { question: async () => 'y', close: () => {} };
    };
    const result = await defaultConfirm({ createInterface });
    // The load-bearing guard: terminal mode must be off. With it on, readline
    // emits cursor-erase escapes that wipe the `[Y/n]:` prompt line.
    assert.equal(
      captured.terminal,
      false,
      'defaultConfirm must pass terminal:false to readline.createInterface',
    );
    assert.equal(result, true, 'a "y" answer resolves to true (configure)');
  });

  it('treats an explicit "no" as decline and bare Enter as the yes default', async () => {
    const make = (answer) => ({
      createInterface: () => ({
        question: async () => answer,
        close: () => {},
      }),
    });
    assert.equal(await defaultConfirm(make('n')), false);
    assert.equal(await defaultConfirm(make('no')), false);
    assert.equal(await defaultConfirm(make('')), true);
    assert.equal(await defaultConfirm(make('y')), true);
  });
});
