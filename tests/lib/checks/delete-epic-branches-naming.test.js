import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/delete-epic-branches-naming.js';

/**
 * Unit tests for the delete-epic-branches-naming check.
 */

function makeState(localBranches) {
  return {
    scope: 'story-close',
    git: { localBranches },
    fs: {},
    env: {},
  };
}

describe('delete-epic-branches-naming check', () => {
  it('returns a warning Finding when a branch matches flat story-NNNN', async () => {
    const state = makeState([
      'main',
      'epic/1143',
      'story-1287',
      'story/epic-1143/2',
    ]);
    const finding = await check.detect(state);
    assert.ok(finding);
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.id, 'delete-epic-branches-naming');
    assert.match(finding.fixCommand, /git branch -D story-1287/);
  });

  it('returns null when only nested story/epic-<id>/<n> branches exist', async () => {
    const state = makeState([
      'main',
      'epic/1143',
      'story/epic-1143/1',
      'story/epic-1143/2',
    ]);
    const finding = await check.detect(state);
    assert.equal(finding, null);
  });

  it('returns null when no local branches are listed', async () => {
    const state = makeState([]);
    const finding = await check.detect(state);
    assert.equal(finding, null);
  });

  it('collects all flat-named branches into the fixCommand', async () => {
    const state = makeState(['main', 'story-1287', 'story-1289', 'epic/1143']);
    const finding = await check.detect(state);
    assert.ok(finding);
    assert.match(finding.fixCommand, /story-1287/);
    assert.match(finding.fixCommand, /story-1289/);
    assert.match(finding.summary, /2 local branch/);
  });

  it('does not match story-1287-something or other adjacent patterns', async () => {
    const state = makeState([
      'main',
      'story-1287-followup',
      'story/epic-1143/3',
      'feature/story-1234',
    ]);
    const finding = await check.detect(state);
    assert.equal(finding, null);
  });

  it('declares the contract metadata correctly', () => {
    assert.equal(check.id, 'delete-epic-branches-naming');
    assert.equal(check.severity, 'warning');
    assert.equal(check.autoCorrect, 'refuse-and-print');
    assert.ok(check.scope.includes('story-close'));
  });
});
