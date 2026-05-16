import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BDD_RUNNER_TAG_TABLE,
  verifyBddRunnerPendingTag,
} from '../.agents/scripts/lib/bdd-runner-detect.js';

/**
 * Unit tests for `verifyBddRunnerPendingTag` — the package.json scan that
 * decides whether the acceptance-spec records a verified pending tag
 * (features-first ordering) or falls back to dependencies-first.
 *
 * The function is pure: it only reads `package.json`. Tests stub the file
 * read via the `readPkg` injection so they exercise every branch without
 * touching disk.
 */
describe('bdd-runner-detect:verifyBddRunnerPendingTag', () => {
  it('records the verified tag when a known runner is in dependencies', async () => {
    const result = await verifyBddRunnerPendingTag({
      cwd: '/repo',
      readPkg: async () =>
        JSON.stringify({
          name: 'sample',
          dependencies: { 'playwright-bdd': '^1.0.0' },
        }),
    });
    assert.equal(result.runner, 'playwright-bdd');
    assert.equal(result.pendingTag, '@skip');
    assert.equal(result.supported, true);
    assert.equal(result.fallback, false);
  });

  it('records the verified tag when a known runner is in devDependencies', async () => {
    const result = await verifyBddRunnerPendingTag({
      cwd: '/repo',
      readPkg: async () =>
        JSON.stringify({
          devDependencies: { '@cucumber/cucumber': '^11.0.0' },
        }),
    });
    assert.equal(result.runner, '@cucumber/cucumber');
    assert.equal(result.pendingTag, '@skip');
    assert.equal(result.supported, true);
    assert.equal(result.fallback, false);
  });

  it('falls back to dependencies-first when no BDD runner is detected', async () => {
    const result = await verifyBddRunnerPendingTag({
      cwd: '/repo',
      readPkg: async () => JSON.stringify({ dependencies: { lodash: '*' } }),
    });
    assert.equal(result.runner, null);
    assert.equal(result.pendingTag, null);
    assert.equal(result.supported, false);
    assert.equal(result.fallback, true);
    assert.equal(result.reason, 'no-bdd-runner-detected');
  });

  it('falls back when package.json is missing (ENOENT)', async () => {
    const result = await verifyBddRunnerPendingTag({
      cwd: '/repo',
      readPkg: async () => {
        const err = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      },
    });
    assert.equal(result.fallback, true);
    assert.equal(result.reason, 'package-json-missing');
  });

  it('falls back when package.json is unparseable', async () => {
    const result = await verifyBddRunnerPendingTag({
      cwd: '/repo',
      readPkg: async () => '{ not valid json',
    });
    assert.equal(result.fallback, true);
    assert.match(result.reason, /^package-json-parse-error:/);
  });

  it('exposes the runner→tag lookup table for downstream callers', () => {
    assert.ok(Object.hasOwn(BDD_RUNNER_TAG_TABLE, 'playwright-bdd'));
    assert.ok(Object.hasOwn(BDD_RUNNER_TAG_TABLE, '@cucumber/cucumber'));
    // Table is frozen — guard against accidental mutation by callers.
    assert.throws(() => {
      BDD_RUNNER_TAG_TABLE['some-new-runner'] = '@skip';
    });
  });
});
