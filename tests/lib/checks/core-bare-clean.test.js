import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/core-bare-clean.js';

/**
 * Unit tests for the core-bare-clean check. Drives detect(state)
 * directly with fixture state objects.
 */

function makeState(coreBare) {
  return {
    scope: 'story-close',
    git: { coreBare },
    fs: {},
    env: {},
  };
}

describe('core-bare-clean check', () => {
  it('returns a blocker Finding when core.bare is the literal string "true"', async () => {
    const finding = await check.detect(makeState('true'));
    assert.ok(finding);
    assert.equal(finding.severity, 'blocker');
    assert.equal(finding.id, 'core-bare-clean');
    assert.equal(finding.autoCorrectable, false);
  });

  it('returns null when core.bare is "false"', async () => {
    const finding = await check.detect(makeState('false'));
    assert.equal(finding, null);
  });

  it('returns null when core.bare is unset (null)', async () => {
    const finding = await check.detect(makeState(null));
    assert.equal(finding, null);
  });

  it('returns null when core.bare is undefined (key absent)', async () => {
    const state = { scope: 'story-close', git: {}, fs: {}, env: {} };
    const finding = await check.detect(state);
    assert.equal(finding, null);
  });

  it('fixCommand cites cleanGitEnv and the manual git config --unset fallback', async () => {
    const finding = await check.detect(makeState('true'));
    assert.ok(finding);
    assert.match(finding.fixCommand, /git config --unset core\.bare/);
    assert.match(finding.fixCommand, /cleanGitEnv/);
  });

  it('declares the contract metadata correctly', () => {
    assert.equal(check.id, 'core-bare-clean');
    assert.equal(check.severity, 'blocker');
    assert.equal(check.autoCorrect, 'refuse-and-print');
    assert.ok(check.scope.includes('story-close'));
  });
});
