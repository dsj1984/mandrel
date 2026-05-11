import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/worktree-residue-biome.js';

/**
 * Tests for the `worktree-residue-biome` check (Task #1301 under Story
 * #1286). Drives `check.detect(state)` directly with a fixture state — no
 * worktree, no disk IO. The disk-walk behavior belongs to `state.js`'s
 * `fs.worktreeBiomeOrphans` projection and is covered separately by
 * state.test.js.
 *
 * Contract under test:
 *   1. Returns a Finding with severity 'blocker' listing each orphan path.
 *   2. Returns null when `.worktrees/` is empty or has no nested biome.json.
 *   3. The Finding's `fixCommand` prints a literal `rm -rf` recipe for
 *      every orphan path so the operator can copy-paste it.
 */

function makeState(orphans, overrides = {}) {
  return {
    scope: 'story-close',
    cwd: '/repo',
    git: {},
    fs: { worktreeBiomeOrphans: orphans },
    env: {},
    ...overrides,
  };
}

describe('check: worktree-residue-biome', () => {
  it('exposes the expected contract metadata', () => {
    assert.equal(check.id, 'worktree-residue-biome');
    assert.equal(check.severity, 'blocker');
    assert.equal(check.autoCorrect, 'refuse-and-print');
    assert.ok(check.scope.includes('story-close'));
    assert.ok(check.scope.includes('epic-deliver'));
    assert.equal(typeof check.detect, 'function');
    // refuse-and-print contract: no fix() body.
    assert.equal(check.fix, undefined);
  });

  it('returns null when no orphans are present (empty array)', () => {
    const state = makeState([]);
    assert.equal(check.detect(state), null);
  });

  it('returns null when the fs projection has no orphans key', () => {
    // Defensive: the check should not crash on a state object that
    // omits the worktreeBiomeOrphans key (e.g. an out-of-scope caller).
    const state = {
      scope: 'story-close',
      cwd: '/repo',
      git: {},
      fs: {},
      env: {},
    };
    assert.equal(check.detect(state), null);
  });

  it('returns a Finding with severity:blocker when one orphan is present', () => {
    const orphan = '/repo/.worktrees/story-1234';
    const finding = check.detect(makeState([orphan]));
    assert.ok(finding, 'expected a finding when an orphan is present');
    assert.equal(finding.id, 'worktree-residue-biome');
    assert.equal(finding.severity, 'blocker');
    assert.equal(finding.scope, 'story-close');
    assert.ok(finding.summary.includes('1 orphan'));
    assert.ok(finding.detail.includes(orphan));
    assert.equal(finding.autoCorrectable, false);
  });

  it('lists every orphan path in the Finding detail (>1 orphan)', () => {
    const orphans = [
      '/repo/.worktrees/story-1101',
      '/repo/.worktrees/story-1102',
      '/repo/.worktrees/story-1103',
    ];
    const finding = check.detect(makeState(orphans));
    assert.ok(finding);
    assert.ok(finding.summary.includes('3 orphan'));
    for (const p of orphans) {
      assert.ok(
        finding.detail.includes(p),
        `detail must list orphan path ${p}`,
      );
    }
  });

  it('fixCommand prints `rm -rf <path>` for each orphan', () => {
    const orphans = [
      '/repo/.worktrees/story-1101',
      '/repo/.worktrees/story-1102',
    ];
    const finding = check.detect(makeState(orphans));
    assert.ok(finding);
    for (const p of orphans) {
      assert.ok(
        finding.fixCommand.includes(`rm -rf "${p}"`),
        `fixCommand must include the rm -rf recipe for ${p}`,
      );
    }
  });

  it('fixCommand chains multiple orphans with && so it pastes as one line', () => {
    const orphans = ['/repo/.worktrees/story-a', '/repo/.worktrees/story-b'];
    const finding = check.detect(makeState(orphans));
    assert.ok(finding);
    assert.ok(
      finding.fixCommand.includes('&&'),
      'multi-orphan fix command must chain with &&',
    );
  });
});
