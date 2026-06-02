// tests/cli/sync-commands.test.js
/**
 * Unit tests for lib/cli/sync-commands.js
 *
 * AC coverage:
 *   1. The wrapper delegates to .agents/scripts/sync-claude-commands.js — it
 *      does not reimplement the sync logic.
 *   2. When the sync script exits 0, `run()` returns without calling
 *      process.exit.
 *   3. When the sync script exits non-zero, `run()` calls process.exit with
 *      that code.
 *   4. `mandrel sync-commands` (bin dispatch integration) exits 0 against the
 *      real sync script and real filesystem.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'mandrel.js');
const SYNC_SCRIPT = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'sync-claude-commands.js',
);

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

let run;

before(async () => {
  const mod = await import('../../lib/cli/sync-commands.js');
  run = mod.default;
});

// ---------------------------------------------------------------------------
// Unit — delegation contract
// ---------------------------------------------------------------------------

describe('sync-commands — delegates to sync-claude-commands.js', () => {
  it('passes the sync script path as the first argument to the runner', () => {
    let capturedArgs;
    const fakeRunner = (cmd, args, _opts) => {
      capturedArgs = { cmd, args };
      return { status: 0 };
    };

    run([], { runner: fakeRunner });

    assert.equal(capturedArgs.cmd, process.execPath);
    assert.ok(
      capturedArgs.args[0].endsWith('sync-claude-commands.js'),
      `Expected sync-claude-commands.js, got: ${capturedArgs.args[0]}`,
    );
    assert.equal(capturedArgs.args[0], SYNC_SCRIPT);
  });

  it('passes stdio: inherit so output reaches the terminal', () => {
    let capturedOpts;
    const fakeRunner = (_cmd, _args, opts) => {
      capturedOpts = opts;
      return { status: 0 };
    };

    run([], { runner: fakeRunner });

    assert.equal(capturedOpts.stdio, 'inherit');
  });
});

// ---------------------------------------------------------------------------
// Unit — exit-code forwarding
// ---------------------------------------------------------------------------

describe('sync-commands — exit-code forwarding', () => {
  let originalExit;
  let exitCalled;
  let exitCode;

  before(() => {
    originalExit = process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
    exitCalled = false;
    exitCode = undefined;
  });

  it('does not call process.exit when the sync script exits 0', () => {
    exitCalled = false;
    process.exit = (code) => {
      exitCalled = true;
      exitCode = code;
    };

    const fakeRunner = () => ({ status: 0 });
    run([], { runner: fakeRunner });

    assert.equal(
      exitCalled,
      false,
      'process.exit must not be called on exit 0',
    );
  });

  it('calls process.exit with the runner exit code on non-zero exit', () => {
    exitCalled = false;
    process.exit = (code) => {
      exitCalled = true;
      exitCode = code;
    };

    const fakeRunner = () => ({ status: 2 });
    run([], { runner: fakeRunner });

    assert.equal(
      exitCalled,
      true,
      'process.exit must be called on non-zero exit',
    );
    assert.equal(exitCode, 2);
  });

  it('falls back to exit code 1 when runner returns status null', () => {
    exitCalled = false;
    process.exit = (code) => {
      exitCalled = true;
      exitCode = code;
    };

    const fakeRunner = () => ({ status: null });
    run([], { runner: fakeRunner });

    assert.equal(exitCalled, true);
    assert.equal(exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// Integration — bin dispatch: mandrel sync-commands exits 0
// ---------------------------------------------------------------------------

describe('mandrel sync-commands — bin dispatch integration', () => {
  it('exits 0 when dispatched via bin/mandrel.js', () => {
    const result = spawnSync(process.execPath, [BIN, 'sync-commands'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(
      result.status,
      0,
      `mandrel sync-commands exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  });
});
