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

const ENOENT = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

/**
 * A `readFileSync` stub over an in-memory project: repo-relative path →
 * contents. Any other path throws ENOENT, as an absent file would.
 *
 * @param {Record<string, string>} files
 * @returns {(file: string) => string}
 */
const projectWith = (files) => (file) => {
  const rel = path.relative(PROJECT_ROOT, file).split(path.sep).join('/');
  if (Object.hasOwn(files, rel)) return files[rel];
  throw ENOENT();
};

/**
 * @param {Record<string, string>|null} scripts `scripts`, or null to omit it.
 * @param {Record<string, string>} [extra] Other project files.
 */
const runWith = (scripts, extra = {}) =>
  check.run({
    projectRoot: PROJECT_ROOT,
    readFile: projectWith({
      'package.json': JSON.stringify({
        name: 'consumer',
        ...(scripts === null ? {} : { scripts }),
      }),
      ...extra,
    }),
  });

/** @param {string|null} testScript `scripts.test`, or null to omit it. */
const run = (testScript) =>
  runWith(testScript === null ? {} : { test: testScript });

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
        throw ENOENT();
      },
    });

    assert.equal(result.ok, true);
    assert.ok(result.remedy.includes('evidence-gate.js'));
  });
});

// Story #5477 — digest § 5 picks the credited run by the predicate close
// registers `coverage-capture` on, and a pre-push hook that runs typecheck or
// lint outside `evidence-gate.js` leaves close to re-run them. Both are
// reported, never failed.
describe('doctor check: test-credit-path names the depositor and the hook gap (#5477)', () => {
  const VITEST_WITH_COVERAGE = {
    test: 'vitest run',
    'test:coverage': 'vitest run --coverage',
  };

  it('AC-4: CRAP on + test:coverage → the credited run is the coverage capture, with its command', () => {
    const result = runWith(VITEST_WITH_COVERAGE);

    assert.equal(result.ok, true);
    assert.match(result.detail, /credited run is the coverage capture/);
    assert.ok(
      result.detail.includes(
        'node .agents/scripts/coverage-capture.js --cwd <workCwd>',
      ),
      result.detail,
    );
    // The capture is the one run: no evidence-gate `npm test` is prescribed.
    assert.ok(!result.detail.includes('-- npm test'), result.detail);
    assert.equal(result.remedy, undefined);
  });

  it('CRAP defaults on when .agentrc.json does not name it', () => {
    const result = runWith(VITEST_WITH_COVERAGE, {
      '.agentrc.json': JSON.stringify({ delivery: {} }),
    });
    assert.match(result.detail, /coverage capture/);
  });

  it('CRAP disabled (local override wins) → back to the evidence-gate depositor', () => {
    const result = runWith(VITEST_WITH_COVERAGE, {
      '.agentrc.json': JSON.stringify({
        delivery: { quality: { gates: { crap: { enabled: true } } } },
      }),
      '.agentrc.local.json': JSON.stringify({
        delivery: { quality: { gates: { crap: { enabled: false } } } },
      }),
    });
    assert.ok(!result.detail.includes('coverage-capture.js'), result.detail);
    assert.ok(result.remedy.includes('--gate test'), result.remedy);
  });

  it('AC-4: a pre-push hook running typecheck/lint without evidence-gate.js leaves close to re-run them', () => {
    const result = runWith(VITEST_WITH_COVERAGE, {
      '.husky/pre-push': '#!/bin/sh\nnpm run typecheck\nnpm run lint\n',
    });

    assert.equal(result.ok, true, 'advisory: the check never fails');
    assert.match(result.detail, /\.husky\/pre-push/);
    assert.match(result.detail, /close re-runs them/);
    assert.ok(result.remedy.includes('evidence-gate.js'), result.remedy);
    assert.ok(result.detail.includes(result.remedy), 'the remedy rides detail');
  });

  it('reports a hook that already wraps its gates as depositing', () => {
    const result = runWith(VITEST_WITH_COVERAGE, {
      '.husky/pre-push':
        'node .agents/scripts/evidence-gate.js --gate lint -- npm run lint\n',
    });
    assert.match(result.detail, /deposits evidence close can credit/);
    assert.equal(result.remedy, undefined);
  });

  it('falls back to .git/hooks/pre-push and ignores a hook with no gate', () => {
    const result = runWith(VITEST_WITH_COVERAGE, {
      '.git/hooks/pre-push': '#!/bin/sh\necho pushing\n',
    });
    assert.match(result.detail, /\.git\/hooks\/pre-push. runs no typecheck/);
    assert.equal(result.remedy, undefined);
  });

  it('names an absent hook without inventing a remedy', () => {
    const result = runWith(VITEST_WITH_COVERAGE);
    assert.match(result.detail, /no pre-push hook found/);
  });

  it('joins both remedies when the runner and the hook both need one', () => {
    const result = runWith(
      { test: 'jest' },
      { '.husky/pre-push': 'npx tsc --noEmit\n' },
    );
    assert.ok(result.remedy.includes('--gate test'));
    assert.ok(result.remedy.includes('<typecheck|lint>'));
  });
});
