// lib/cli/__tests__/registry-test-credit-path.test.js
/**
 * Story #5324 — the `test-credit-path` doctor check.
 *
 * The close `test` gate spawns the literal `npm test`, and mandrel's own
 * runner deposits that gate's credit as a side effect of a green full run.
 * A consumer whose `npm test` is `vitest run` or `jest` never reaches that
 * code: it deposits nothing and prints nothing, so the gap is invisible until
 * close re-runs the whole suite. This check makes the gap visible at setup and
 * names the runner-agnostic deposit command as its remedy.
 *
 * Tier: unit (testing-standards § Unit). The check's `projectRoot` and
 * `readFile` seams are injected, so nothing here reads the real filesystem,
 * spawns a process, or writes under temp/.
 *
 * Security (security-baseline § Data Leakage & Logging): fixtures carry only
 * package-script strings; no tokens, paths outside the fixture, or PII.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { registry } from '../registry.js';

const check = registry.find((entry) => entry.name === 'test-credit-path');
const PROJECT_ROOT = path.resolve('/consumer');

/**
 * A `readFileSync` stub answering only for the project's `package.json`.
 *
 * @param {string|null} testScript `scripts.test`, or null to omit it entirely.
 * @returns {(file: string, encoding: string) => string}
 */
const packageJsonWith = (testScript) => (file) => {
  assert.equal(file, path.join(PROJECT_ROOT, 'package.json'));
  const scripts = testScript === null ? {} : { test: testScript };
  return JSON.stringify({ name: 'consumer', scripts });
};

const run = (testScript) =>
  check.run({
    projectRoot: PROJECT_ROOT,
    readFile: packageJsonWith(testScript),
  });

describe('doctor check: test-credit-path', () => {
  it('is registered as an advisory check', () => {
    assert.ok(check, 'the registry must carry a test-credit-path entry');
    assert.equal(check.advisory, true);
  });

  it('reports a test script that reaches mandrel runner as self-depositing', () => {
    const result = run('node .agents/scripts/run-tests.js');

    assert.equal(result.ok, true);
    assert.match(result.detail, /node \.agents\/scripts\/run-tests\.js/);
    assert.match(result.detail, /reaches mandrel's runner/);
    assert.match(result.detail, /deposits the close `test` credit/);
    // Nothing to act on: the bare run already earns the credit.
    assert.equal(result.remedy, undefined);
  });

  it('reports a project on its own runner as depositing nothing, with the runner-agnostic remedy', () => {
    const result = run('vitest run');

    // Still a pass: running vitest is a supported setup, not a broken install.
    assert.equal(result.ok, true);
    assert.match(result.detail, /vitest run/);
    assert.match(
      result.detail,
      /deposits no close `test` credit and prints nothing/,
    );

    assert.equal(typeof result.remedy, 'string');
    for (const fragment of [
      'evidence-gate.js',
      '--standalone',
      '--gate test',
      '-- npm test',
    ]) {
      assert.ok(
        result.remedy.includes(fragment),
        `the remedy must name ${fragment} — it is the deposit that works on any runner`,
      );
    }
    // The doctor prints `detail` for a passing check, so the command has to
    // ride there too or the remedy is never seen.
    assert.ok(
      result.remedy.length > 0 && result.detail.includes(result.remedy),
    );
  });

  it('treats jest the same way it treats vitest — the rule is "not mandrel runner"', () => {
    const result = run('jest --ci');

    assert.equal(result.ok, true);
    assert.match(result.detail, /jest --ci/);
    assert.match(result.detail, /run-tests\.js/);
    assert.ok(result.remedy.includes('evidence-gate.js'));
  });

  it('carries the remedy when there is no test script at all', () => {
    const result = run(null);

    assert.equal(result.ok, true);
    assert.match(result.detail, /no `test` script in package.json/);
    assert.ok(result.remedy.includes('-- npm test'));
  });

  it('carries the remedy when package.json is unreadable', () => {
    const result = check.run({
      projectRoot: PROJECT_ROOT,
      readFile: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });

    assert.equal(result.ok, true);
    assert.ok(result.remedy.includes('evidence-gate.js'));
  });
});
