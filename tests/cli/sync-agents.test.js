// tests/cli/sync-agents.test.js
/**
 * Unit tests for lib/cli/sync-agents.js (Story #4528 / #4530).
 *
 * Exact sibling of tests/cli/sync-commands.test.js — same coverage shape,
 * targeting the role-agent tree instead of the command tree.
 *
 * AC coverage:
 *   1. The wrapper delegates to .agents/scripts/sync-claude-agents.js — it
 *      does not reimplement the sync logic.
 *   2. When the sync script exits 0, `run()` returns without calling
 *      process.exit.
 *   3. When the sync script exits non-zero, `run()` calls process.exit with
 *      that code.
 *   4. `mandrel sync-agents` (bin dispatch integration) exits 0 against the
 *      real sync script and real filesystem.
 *   5. The marker-gated refusal check (identical shape to sync-commands.js).
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
  'sync-claude-agents.js',
);

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

let run;

before(async () => {
  const mod = await import('../../lib/cli/sync-agents.js');
  run = mod.default;
});

// ---------------------------------------------------------------------------
// Unit — delegation contract
// ---------------------------------------------------------------------------

describe('sync-agents — delegates to sync-claude-agents.js', () => {
  it('passes the sync script path as the first argument to the runner', () => {
    let capturedArgs;
    const fakeRunner = (cmd, args, _opts) => {
      capturedArgs = { cmd, args };
      return { status: 0 };
    };

    run([], { runner: fakeRunner });

    assert.equal(capturedArgs.cmd, process.execPath);
    assert.ok(
      capturedArgs.args[0].endsWith('sync-claude-agents.js'),
      `Expected sync-claude-agents.js, got: ${capturedArgs.args[0]}`,
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

describe('sync-agents — exit-code forwarding', () => {
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
// Unit — marker-gated refusal (Story #4526 / #4530)
// ---------------------------------------------------------------------------

const CONSUMER_ROOT = path.join(path.sep, 'consumer');

/** Minimal readFileSync-only fs fake keyed by absolute path. */
function makeFsFake(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    readFileSync(p, _enc) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
  };
}

describe('sync-agents — refuses on a marker/own-version mismatch', () => {
  it('does not invoke the runner and exits 1 when the marker disagrees with ownVersion', () => {
    const fs = makeFsFake({
      [path.join(CONSUMER_ROOT, '.agents', '.mandrel-version')]: '1.87.0\n',
    });
    let runnerCalled = false;
    const errLines = [];
    let exitCode;

    run([], {
      runner: () => {
        runnerCalled = true;
        return { status: 0 };
      },
      cwd: () => CONSUMER_ROOT,
      fs,
      ownVersion: '2.0.0',
      writeErr: (s) => errLines.push(s),
      exit: (code) => {
        exitCode = code;
      },
    });

    assert.equal(runnerCalled, false, 'the real sync script must not run');
    assert.equal(exitCode, 1);
    const joined = errLines.join('');
    assert.match(joined, /v1\.87\.0/);
    assert.match(joined, /v2\.0\.0/);
    assert.match(joined, /mandrel sync/);
  });

  it('invokes the runner when the marker matches ownVersion', () => {
    const fs = makeFsFake({
      [path.join(CONSUMER_ROOT, '.agents', '.mandrel-version')]: '2.0.0\n',
    });
    let runnerCalled = false;

    run([], {
      runner: () => {
        runnerCalled = true;
        return { status: 0 };
      },
      cwd: () => CONSUMER_ROOT,
      fs,
      ownVersion: '2.0.0',
      writeErr: () => {},
      exit: () => {
        throw new Error('exit must not be called on a clean match');
      },
    });

    assert.equal(runnerCalled, true);
  });
});

describe('sync-agents — falls back to agents-drift when the marker is absent', () => {
  it('refuses when the marker is absent and the drift fallback reports dirty', () => {
    const fs = makeFsFake({});
    let runnerCalled = false;
    const errLines = [];
    let exitCode;

    run([], {
      runner: () => {
        runnerCalled = true;
        return { status: 0 };
      },
      cwd: () => CONSUMER_ROOT,
      fs,
      ownVersion: '2.0.0',
      checkAgentsDrift: () => ({
        ok: false,
        detail:
          '.agents/agents/story-worker.md differs from the installed package payload',
      }),
      writeErr: (s) => errLines.push(s),
      exit: (code) => {
        exitCode = code;
      },
    });

    assert.equal(runnerCalled, false);
    assert.equal(exitCode, 1);
    assert.match(
      errLines.join(''),
      /differs from the installed package payload/,
    );
  });

  it('proceeds when the marker is absent but the drift fallback reports clean', () => {
    const fs = makeFsFake({});
    let runnerCalled = false;

    run([], {
      runner: () => {
        runnerCalled = true;
        return { status: 0 };
      },
      cwd: () => CONSUMER_ROOT,
      fs,
      ownVersion: '2.0.0',
      checkAgentsDrift: () => ({ ok: true, detail: 'clean' }),
      writeErr: () => {},
      exit: () => {
        throw new Error('exit must not be called when drift is clean');
      },
    });

    assert.equal(runnerCalled, true);
  });
});

// ---------------------------------------------------------------------------
// Integration — bin dispatch: mandrel sync-agents exits 0
// ---------------------------------------------------------------------------

describe('mandrel sync-agents — bin dispatch integration', () => {
  it('exits 0 when dispatched via bin/mandrel.js', () => {
    const result = spawnSync(process.execPath, [BIN, 'sync-agents'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(
      result.status,
      0,
      `mandrel sync-agents exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  });
});
