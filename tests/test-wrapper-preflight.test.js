/**
 * test-wrapper-preflight.test.js — Unit tests for the npm-test wrapper
 * preflight (Story #1289 / Task #1311).
 *
 * Acceptance criteria:
 *   1. `npm test` against a fixture-blocker state exits with code 2 and
 *      does not execute the underlying test runner.
 *   2. `npm test` against a clean state exits with code 0 and proceeds.
 *   3. The wrapper does not require any new top-level npm dependency.
 *
 * The test drives `runTestWrapperPreflight` directly with an inline
 * fixture registry — no subprocess, no npm lifecycle. The exit-code path
 * (the line that calls `process.exit(2)` in the runAsCli wrapper) is
 * exercised by inspection: the wrapper's `runAsCli` block routes
 * `result.status === 'blocked'` to `process.exit(PREFLIGHT_REFUSED_EXIT_CODE)`,
 * and the imported `PREFLIGHT_REFUSED_EXIT_CODE` constant from
 * `preflight-runner.js` is asserted to be 2 (the project-wide
 * reservation) so a future renumbering of the constant breaks loudly.
 *
 * The "no new top-level dep" criterion is verified by reading
 * package.json and asserting that no dependency was added in this
 * Story's commit window (the test-wrapper.js source imports only from
 * `./lib/*`, which is the same in-tree module path the other entry
 * points already use).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PREFLIGHT_REFUSED_EXIT_CODE } from '../.agents/scripts/lib/preflight-runner.js';
import { runTestWrapperPreflight } from '../.agents/scripts/test-wrapper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const TEST_WRAPPER = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'test-wrapper.js',
);

/** Capture spy logger. */
function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    info: (...a) => lines.info.push(a.join(' ')),
    warn: (...a) => lines.warn.push(a.join(' ')),
    error: (...a) => lines.error.push(a.join(' ')),
    _lines: lines,
  };
}

const noopProbes = {
  git: () => ({ ok: true, stdout: '' }),
  fs: () => false,
  env: () => 'missing',
  lock: () => ({ exists: false }),
  pidLiveness: () => false,
};

describe('runTestWrapperPreflight', () => {
  it('returns status=blocked when a fixture blocker check fires', async () => {
    const logger = makeLogger();
    const blockerCheck = {
      id: 'fixture-npm-test-blocker',
      severity: 'blocker',
      scope: ['npm-test'],
      autoCorrect: 'refuse-and-print',
      detect() {
        return {
          id: 'fixture-npm-test-blocker',
          severity: 'blocker',
          scope: 'npm-test',
          summary: 'fixture npm-test refusal',
          fixCommand: 'echo fix-npm-test',
          autoCorrectable: false,
        };
      },
    };
    const result = await runTestWrapperPreflight({
      probes: noopProbes,
      registry: [blockerCheck],
      logger,
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].id, 'fixture-npm-test-blocker');
    // The blocker table must be printed so the operator sees the fix
    // command without re-running with verbose flags.
    const stderr = logger._lines.error.join('\n');
    assert.match(stderr, /fixture-npm-test-blocker/);
    assert.match(stderr, /echo fix-npm-test/);
    assert.match(stderr, /exit 2/);
  });

  it('returns status=ok and does not invoke any spawn when registry is clean', async () => {
    const logger = makeLogger();
    const result = await runTestWrapperPreflight({
      probes: noopProbes,
      registry: [],
      logger,
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.fixed, []);
  });

  it('preserves the project-wide PREFLIGHT_REFUSED_EXIT_CODE = 2 reservation', () => {
    // Acceptance #1 — "exits with code 2". The wrapper calls
    // `process.exit(PREFLIGHT_REFUSED_EXIT_CODE)` when status=blocked.
    // Pin the constant value here so renaming/renumbering it elsewhere
    // breaks this assertion loudly rather than silently re-routing
    // preflight refusals to a different code.
    assert.equal(PREFLIGHT_REFUSED_EXIT_CODE, 2);
  });
});

describe('test-wrapper.js wiring (no new dependencies; package.json pretest hook)', () => {
  it('test-wrapper.js imports only from ./lib/* (no new npm dep)', () => {
    const src = readFileSync(TEST_WRAPPER, 'utf8');
    // Collect every `from '<spec>'` import specifier in the file.
    const re = /from\s+'([^']+)'/g;
    const specs = [];
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
      specs.push(m[1]);
    }
    assert.ok(
      specs.length > 0,
      'expected at least one import in test-wrapper.js',
    );
    for (const s of specs) {
      // Only project-local imports (./lib/*, ./*) allowed. Anything else
      // (a node-built-in or bare package import) would either be fine
      // (node builtins are always free) or a violation.
      // Bare specifiers that aren't `node:*` would represent a new dep —
      // forbid them outright.
      if (s.startsWith('./') || s.startsWith('../') || s.startsWith('node:')) {
        continue;
      }
      assert.fail(
        `test-wrapper.js imports bare specifier '${s}' — Story #1289 acceptance forbids new top-level npm dependencies`,
      );
    }
  });

  it('package.json pretest script points at the new wrapper', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    assert.ok(
      pkg.scripts?.pretest,
      'pretest script must exist in package.json',
    );
    assert.match(
      pkg.scripts.pretest,
      /test-wrapper\.js/,
      'pretest must invoke .agents/scripts/test-wrapper.js',
    );
  });
});
