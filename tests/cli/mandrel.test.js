/**
 * tests/cli/mandrel.test.js — unit tests for bin/mandrel.js dispatch routing
 *
 * Tests are process-spawn based so we can assert on exit codes and stdout/stderr
 * without importing the entry point directly (it calls process.exit).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'mandrel.js');

/** Run the mandrel bin synchronously and return { status, stdout, stderr }. */
function runMandrel(args = [], env = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// Help / version output (B6)
// ---------------------------------------------------------------------------

describe('mandrel CLI — bare invocation prints help', () => {
  it('exits 0 when called with no arguments', () => {
    const { status } = runMandrel([]);
    assert.equal(status, 0);
  });

  it('prints subcommand list to stdout for bare invocation', () => {
    const { stdout } = runMandrel([]);
    assert.match(stdout, /Usage: mandrel <subcommand>/);
    assert.match(stdout, /sync\s/);
    assert.match(stdout, /doctor\s/);
    assert.match(stdout, /update\s/);
    assert.match(stdout, /uninstall\s/);
  });
});

describe('mandrel CLI — --help / -h', () => {
  it('--help exits 0', () => {
    const { status } = runMandrel(['--help']);
    assert.equal(status, 0);
  });

  it('--help prints subcommand list to stdout', () => {
    const { stdout } = runMandrel(['--help']);
    assert.match(stdout, /Usage: mandrel <subcommand>/);
    assert.match(stdout, /sync\s/);
    assert.match(stdout, /doctor\s/);
  });

  it('-h exits 0', () => {
    const { status } = runMandrel(['-h']);
    assert.equal(status, 0);
  });

  it('-h output matches --help output', () => {
    const help = runMandrel(['--help']).stdout;
    const h = runMandrel(['-h']).stdout;
    assert.equal(h, help);
  });
});

describe('mandrel CLI — --version', () => {
  it('exits 0', () => {
    const { status } = runMandrel(['--version']);
    assert.equal(status, 0);
  });

  it('prints a semver string to stdout', () => {
    const { stdout } = runMandrel(['--version']);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});

// ---------------------------------------------------------------------------
// Unknown-subcommand rejection (B6)
// ---------------------------------------------------------------------------

describe('mandrel CLI — unknown subcommand', () => {
  it('exits 1 for an unrecognised subcommand', () => {
    const { status } = runMandrel(['unknown-sub']);
    assert.equal(status, 1);
  });

  it('names the bad subcommand in stderr', () => {
    const { stderr } = runMandrel(['unknown-sub']);
    assert.match(stderr, /unknown-sub/);
  });

  it('lists available subcommands in stderr', () => {
    const { stderr } = runMandrel(['does-not-exist']);
    assert.match(stderr, /Available subcommands:/);
  });

  it('does NOT dispatch registry.js as a subcommand', () => {
    const { status, stderr } = runMandrel(['registry']);
    assert.equal(status, 1);
    assert.match(stderr, /unknown subcommand/);
  });

  it('does NOT dispatch version-check.js as a subcommand', () => {
    const { status, stderr } = runMandrel(['version-check']);
    assert.equal(status, 1);
    assert.match(stderr, /unknown subcommand/);
  });

  it('suggests a did-you-mean hint for typos', () => {
    const { stderr } = runMandrel(['dcotor']);
    // "dcotor" is within edit distance 2 of "doctor"
    assert.match(stderr, /Did you mean/i);
  });
});

// ---------------------------------------------------------------------------
// Unknown-flag rejection per subcommand (B6)
// ---------------------------------------------------------------------------

describe('mandrel CLI — unknown-flag rejection', () => {
  it('rejects unknown flags for "update" and exits 1', () => {
    const { status, stderr } = runMandrel(['update', '--dryrun']);
    assert.equal(status, 1);
    assert.match(stderr, /unknown flag/);
    assert.match(stderr, /--dryrun/);
  });

  it('includes the known flags in the error message', () => {
    const { stderr } = runMandrel(['update', '--dryrun']);
    assert.match(stderr, /Known flags:/);
    assert.match(stderr, /--dry-run/);
  });

  it('rejects unknown flags for "sync" and exits 1', () => {
    const { status, stderr } = runMandrel(['sync', '--unknown-flag']);
    assert.equal(status, 1);
    assert.match(stderr, /unknown flag/);
  });

  it('rejects "--force" for "sync" (no longer a known flag — sync never read it)', () => {
    const { status, stderr } = runMandrel(['sync', '--force']);
    assert.equal(status, 1);
    assert.match(stderr, /unknown flag/);
    assert.match(stderr, /--force/);
  });

  it('rejects unknown flags for "doctor" and exits 1', () => {
    const { status, stderr } = runMandrel(['doctor', '--verbose']);
    assert.equal(status, 1);
    assert.match(stderr, /unknown flag/);
  });

  it('rejects unknown flags for "uninstall" and exits 1', () => {
    const { status, stderr } = runMandrel(['uninstall', '--badFlag']);
    assert.equal(status, 1);
    assert.match(stderr, /unknown flag/);
  });

  it('accepts known flags for "update" (--dry-run)', () => {
    // --dry-run is known; should NOT be rejected by the flag validator
    // (it may error later when resolveTargetVersion seam is absent, but
    // that is a different failure, not a flag-rejection failure)
    const { stderr } = runMandrel(['update', '--dry-run']);
    assert.doesNotMatch(stderr, /unknown flag/);
  });

  it('accepts known flags for "migrate" (--from, --to)', () => {
    const { stderr } = runMandrel([
      'migrate',
      '--from',
      '1.0.0',
      '--to',
      '1.1.0',
    ]);
    assert.doesNotMatch(stderr, /unknown flag/);
  });
});

// ---------------------------------------------------------------------------
// Allowlist — non-command modules are NOT dispatchable (B6)
// ---------------------------------------------------------------------------

describe('mandrel CLI — allowlist dispatch only', () => {
  it('does not dispatch any non-registered path even if the file exists', () => {
    // init.js exists but is in SUBCOMMANDS; registry.js exists but is not
    const { status } = runMandrel(['registry']);
    assert.equal(status, 1);
  });

  it('dispatches all registered real subcommands (smoke: sync --dry-run)', () => {
    // sync --dry-run is a known subcommand + known flag — should not be
    // flag-rejected; any failure beyond that is about the sync logic, not dispatch
    const { stderr } = runMandrel(['sync', '--dry-run']);
    assert.doesNotMatch(stderr, /unknown subcommand/);
    assert.doesNotMatch(stderr, /unknown flag/);
  });
});
