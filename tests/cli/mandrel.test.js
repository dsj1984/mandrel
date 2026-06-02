/**
 * tests/cli/mandrel.test.js — unit tests for bin/mandrel.js dispatch routing
 *
 * Tests are process-spawn based so we can assert on exit codes and stderr
 * without importing the entry point directly (it calls process.exit).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'mandrel.js');
const LIB_CLI = path.join(REPO_ROOT, 'lib', 'cli');

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

/** Write a temporary subcommand module and return its cleanup function. */
function writeTempSub(name, content) {
  const file = path.join(LIB_CLI, `${name}.js`);
  fs.writeFileSync(file, content, 'utf8');
  return () => {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  };
}

describe('mandrel CLI — no subcommand', () => {
  it('exits 1 when called with no arguments', () => {
    const { status } = runMandrel([]);
    assert.equal(status, 1);
  });

  it('prints usage to stderr when called with no arguments', () => {
    const { stderr } = runMandrel([]);
    assert.match(stderr, /Usage: mandrel <subcommand>/);
  });
});

describe('mandrel CLI — unknown subcommand', () => {
  it('exits 1 for an unrecognised subcommand', () => {
    const { status } = runMandrel(['unknown-sub']);
    assert.equal(status, 1);
  });

  it('names the bad subcommand in the error output', () => {
    const { stderr } = runMandrel(['unknown-sub']);
    assert.match(stderr, /unknown-sub/);
  });

  it('includes usage hint in the error output', () => {
    const { stderr } = runMandrel(['does-not-exist']);
    assert.match(stderr, /Usage:/);
  });
});

describe('mandrel CLI — convention-based dispatch', () => {
  let cleanup;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it('dispatches to lib/cli/<name>.js by path convention', () => {
    cleanup = writeTempSub(
      '_test-sub',
      `export default function run() { process.stdout.write('dispatched\\n'); }`,
    );
    const { status, stdout } = runMandrel(['_test-sub']);
    assert.equal(status, 0);
    assert.match(stdout, /dispatched/);
  });

  it('passes remaining argv to the subcommand', () => {
    cleanup = writeTempSub(
      '_test-argv',
      `export default function run(argv) { process.stdout.write(argv.join(',') + '\\n'); }`,
    );
    const { status, stdout } = runMandrel(['_test-argv', 'a', 'b']);
    assert.equal(status, 0);
    assert.match(stdout, /a,b/);
  });

  it('exits 1 when the module exists but has no default export function', () => {
    cleanup = writeTempSub('_test-no-default', `export const notDefault = 42;`);
    const { status, stderr } = runMandrel(['_test-no-default']);
    assert.equal(status, 1);
    assert.match(stderr, /does not export a default function/);
  });
});
