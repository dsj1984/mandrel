import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/baseline-drift-main-checkout.js';

/**
 * Tests for the `baseline-drift-main-checkout` check (Task #1303 under
 * Story #1286). Drives `check.detect(state)` directly with fixture states.
 *
 * Contract under test:
 *   1. Returns a Finding with severity 'blocker' when story-close is about
 *      to run against the main checkout while a corresponding worktree
 *      exists.
 *   2. Returns null when cwd is the expected worktree path.
 *   3. Returns null when no matching worktree exists (operator is in
 *      single-tree mode or working on a non-story branch).
 *   4. `fixCommand` prints the `cd <worktree>` recipe.
 */

function makeState({ headRef, cwd, worktreePaths }, overrides = {}) {
  return {
    scope: 'story-close',
    cwd,
    git: { headRef },
    fs: { worktreePaths },
    env: {},
    ...overrides,
  };
}

describe('check: baseline-drift-main-checkout', () => {
  it('exposes the expected contract metadata', () => {
    assert.equal(check.id, 'baseline-drift-main-checkout');
    assert.equal(check.severity, 'blocker');
    assert.equal(check.autoCorrect, 'refuse-and-print');
    assert.ok(check.scope.includes('story-close'));
    assert.equal(typeof check.detect, 'function');
    assert.equal(check.fix, undefined);
  });

  it('returns null when headRef is not a story branch', () => {
    const state = makeState({
      headRef: 'main',
      cwd: '/repo',
      worktreePaths: ['/repo/.worktrees/story-1286'],
    });
    assert.equal(check.detect(state), null);
  });

  it('returns null when no worktree exists for the active story branch', () => {
    // headRef IS a story branch, but there is no matching worktree under
    // .worktrees/ — operator is in single-tree mode. The check can't say
    // anything definitive, so it stays quiet.
    const state = makeState({
      headRef: 'story-1286',
      cwd: '/repo',
      worktreePaths: ['/repo/.worktrees/story-9999'],
    });
    assert.equal(check.detect(state), null);
  });

  it('returns null when worktreePaths is empty', () => {
    const state = makeState({
      headRef: 'story-1286',
      cwd: '/repo',
      worktreePaths: [],
    });
    assert.equal(check.detect(state), null);
  });

  it('returns null when cwd IS the expected worktree path', () => {
    const wt = '/repo/.worktrees/story-1286';
    const state = makeState({
      headRef: 'story-1286',
      cwd: wt,
      worktreePaths: [wt],
    });
    assert.equal(check.detect(state), null);
  });

  it('returns a blocker Finding when cwd is the main checkout while worktree exists', () => {
    const wt = '/repo/.worktrees/story-1286';
    const state = makeState({
      headRef: 'story-1286',
      cwd: '/repo',
      worktreePaths: [wt],
    });
    const finding = check.detect(state);
    assert.ok(finding, 'expected a finding when cwd drifts from worktree');
    assert.equal(finding.id, 'baseline-drift-main-checkout');
    assert.equal(finding.severity, 'blocker');
    assert.equal(finding.scope, 'story-close');
    assert.ok(finding.summary.includes('story-1286'));
    assert.ok(finding.detail.includes(wt));
    assert.ok(finding.detail.includes('/repo'));
  });

  it('fixCommand prints `cd <worktree>` recipe', () => {
    const wt = '/repo/.worktrees/story-1286';
    const state = makeState({
      headRef: 'story-1286',
      cwd: '/repo',
      worktreePaths: [wt],
    });
    const finding = check.detect(state);
    assert.ok(finding);
    assert.equal(finding.fixCommand, `cd "${wt}"`);
  });

  it('accepts the legacy story/epic-<id>/<n> branch shape', () => {
    const wt = '/repo/.worktrees/story-1286';
    const state = makeState({
      headRef: 'story/epic-1143/1286',
      cwd: '/repo',
      worktreePaths: [wt],
    });
    // Legacy ref doesn't match worktree basename → no worktree match → null.
    // But it should also not crash on the regex.
    assert.equal(check.detect(state), null);
  });

  it('treats path differences with trailing separators as the same path', () => {
    const wt = '/repo/.worktrees/story-1286';
    // path.resolve normalizes the trailing slash on both POSIX and Windows.
    const cwdWithSlash = `${wt}${path.sep}`;
    const state = makeState({
      headRef: 'story-1286',
      cwd: cwdWithSlash,
      worktreePaths: [wt],
    });
    assert.equal(check.detect(state), null);
  });
});
