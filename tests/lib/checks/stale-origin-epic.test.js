import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/stale-origin-epic.js';

/**
 * Unit tests for the stale-origin-epic check. Drives detect(state)
 * directly with fixture state objects — no git or filesystem probes.
 */

/** Build a fixture state object scoped to story-close. */
function makeState(syncMap) {
  return {
    scope: 'story-close',
    git: { epicBranchSync: syncMap },
    fs: {},
    env: {},
  };
}

describe('stale-origin-epic check', () => {
  it('returns a blocker Finding when local epic/<id> is ahead of origin', async () => {
    const state = makeState({
      'epic/1143': {
        local: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        remote: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ahead: true,
      },
    });
    const finding = await check.detect(state);
    assert.ok(finding, 'expected a Finding');
    assert.equal(finding.severity, 'blocker');
    assert.equal(finding.id, 'stale-origin-epic');
    assert.equal(finding.autoCorrectable, false);
    assert.match(finding.summary, /epic\/1143/);
  });

  it('returns null when local epic/<id> matches origin/epic/<id>', async () => {
    const state = makeState({
      'epic/1143': {
        local: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        remote: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ahead: false,
      },
    });
    const finding = await check.detect(state);
    assert.equal(finding, null);
  });

  it('returns null when the remote epic ref does not exist yet', async () => {
    // pre-push epic — story-close.js handles the initial push path.
    const state = makeState({
      'epic/9999': {
        local: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        remote: null,
        ahead: false,
      },
    });
    const finding = await check.detect(state);
    assert.equal(finding, null);
  });

  it('returns null when there are no epic branches at all', async () => {
    const state = makeState({});
    const finding = await check.detect(state);
    assert.equal(finding, null);
  });

  it('fixCommand contains the literal git fetch origin invocation', async () => {
    const state = makeState({
      'epic/1143': {
        local: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        remote: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ahead: true,
      },
    });
    const finding = await check.detect(state);
    assert.ok(finding);
    assert.match(finding.fixCommand, /git fetch origin/);
  });

  it('declares the contract metadata correctly', () => {
    assert.equal(check.id, 'stale-origin-epic');
    assert.equal(check.severity, 'blocker');
    assert.equal(check.autoCorrect, 'refuse-and-print');
    assert.ok(check.scope.includes('story-close'));
    assert.ok(check.scope.includes('retro'));
  });
});
