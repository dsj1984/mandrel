/**
 * Unit tests for the pure decide* functions in `phase-drivers.js`
 * (Story #2994 CRAP-30+ refactor).
 *
 * These tests cover every branch of the decision logic without any
 * git, prompt, or filesystem I/O. The companion impure executeXPhase
 * functions are exercised through the existing integration suites
 * (`tests/scripts/git-cleanup*.test.js`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decideBranchPhase,
  decideFastForwardPhase,
  decideStashPhase,
} from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/phase-drivers.js';

// ---------------------------------------------------------------------
// decideFastForwardPhase
// ---------------------------------------------------------------------

describe('decideFastForwardPhase', () => {
  const cwd = '/repo';
  const baseBranch = 'main';

  it('returns skip when the plan is not runnable (with reason and behind)', () => {
    const plan = { runnable: false, reason: 'dirty-tree', behind: 0 };
    const action = decideFastForwardPhase({
      plan,
      opts: {},
      baseBranch,
      cwd,
    });
    assert.equal(action.kind, 'skip');
    assert.deepEqual(action.result, {
      ok: true,
      applied: false,
      skipped: true,
      reason: 'dirty-tree',
      behind: 0,
    });
    assert.match(action.logMessage, /skipped: dirty-tree/);
  });

  it('skip path defaults behind to 0 when plan omits it', () => {
    const plan = { runnable: false, reason: 'no-upstream' };
    const action = decideFastForwardPhase({
      plan,
      opts: {},
      baseBranch,
      cwd,
    });
    assert.equal(action.result.behind, 0);
  });

  it('returns dry-run action when --dry-run is set on a runnable plan', () => {
    const plan = { runnable: true, behind: 3 };
    const action = decideFastForwardPhase({
      plan,
      opts: { dryRun: true },
      baseBranch,
      cwd,
    });
    assert.equal(action.kind, 'dry-run');
    assert.deepEqual(action.result, {
      ok: true,
      applied: false,
      skipped: true,
      reason: 'dry-run',
      behind: 3,
    });
    assert.match(action.logMessage, /DRY RUN.*main.*3 commit/);
  });

  it('returns prompt-then-execute when interactive (no --yes)', () => {
    const plan = { runnable: true, behind: 5 };
    const action = decideFastForwardPhase({
      plan,
      opts: {},
      baseBranch,
      cwd,
    });
    assert.equal(action.kind, 'prompt-then-execute');
    assert.match(action.promptMessage, /Fast-forward main by 5 commit/);
    assert.deepEqual(action.declinedResult, {
      ok: true,
      applied: false,
      skipped: true,
      reason: 'declined',
      behind: 5,
    });
    assert.deepEqual(action.executeArgs, { cwd, baseBranch, plan });
  });

  it('returns execute (no prompt) when --yes is set', () => {
    const plan = { runnable: true, behind: 1 };
    const action = decideFastForwardPhase({
      plan,
      opts: { yes: true },
      baseBranch,
      cwd,
    });
    assert.equal(action.kind, 'execute');
    assert.deepEqual(action.executeArgs, { cwd, baseBranch, plan });
  });
});

// ---------------------------------------------------------------------
// decideBranchPhase
// ---------------------------------------------------------------------

describe('decideBranchPhase', () => {
  const cwd = '/repo';

  it('returns dry-run when --dry-run is set, even with candidates', () => {
    const plan = { candidates: [{ name: 'feature/x' }] };
    const action = decideBranchPhase({ plan, opts: { dryRun: true }, cwd });
    assert.equal(action.kind, 'dry-run');
    assert.deepEqual(action.result, { plan, result: null });
  });

  it('returns dry-run when --dry-run set and candidates is empty', () => {
    const plan = { candidates: [] };
    const action = decideBranchPhase({ plan, opts: { dryRun: true }, cwd });
    assert.equal(action.kind, 'dry-run');
    assert.deepEqual(action.result, { plan, result: null });
  });

  it('returns no-candidates when plan is empty and not dry-run', () => {
    const plan = { candidates: [] };
    const action = decideBranchPhase({ plan, opts: {}, cwd });
    assert.equal(action.kind, 'no-candidates');
    assert.deepEqual(action.result, { plan, result: null });
  });

  it('returns prompt-then-execute when interactive with candidates', () => {
    const plan = { candidates: [{ name: 'a' }, { name: 'b' }] };
    const action = decideBranchPhase({ plan, opts: {}, cwd });
    assert.equal(action.kind, 'prompt-then-execute');
    assert.match(action.promptMessage, /Reap 2 merged branch\(es\)\?/);
    assert.deepEqual(action.declinedResult, {
      plan,
      result: null,
      declined: true,
    });
    assert.deepEqual(action.executeArgs, {
      candidates: plan.candidates,
      cwd,
      remote: undefined,
    });
  });

  it('prompt message mentions "including origin" when --remote is set', () => {
    const plan = { candidates: [{ name: 'a' }] };
    const action = decideBranchPhase({ plan, opts: { remote: true }, cwd });
    assert.equal(action.kind, 'prompt-then-execute');
    assert.match(action.promptMessage, /including origin/);
    assert.equal(action.executeArgs.remote, true);
  });

  it('returns execute when --yes is set with candidates', () => {
    const plan = { candidates: [{ name: 'c' }] };
    const action = decideBranchPhase({
      plan,
      opts: { yes: true, remote: true },
      cwd,
    });
    assert.equal(action.kind, 'execute');
    assert.deepEqual(action.executeArgs, {
      candidates: plan.candidates,
      cwd,
      remote: true,
    });
  });
});

// ---------------------------------------------------------------------
// decideStashPhase
// ---------------------------------------------------------------------

describe('decideStashPhase', () => {
  const cwd = '/repo';

  it('returns no-stashes when stash list is empty', () => {
    const action = decideStashPhase({ stashes: [], opts: {}, cwd });
    assert.equal(action.kind, 'no-stashes');
    assert.deepEqual(action.result, { ok: true, actions: [], failures: [] });
  });

  it('returns dry-run with keep-actions for every stash on --dry-run', () => {
    const stashes = [
      { ref: 'stash@{0}', createdAt: '2026-01-01', message: 'wip a' },
      { ref: 'stash@{1}', createdAt: '2026-01-02', message: 'wip b' },
    ];
    const action = decideStashPhase({
      stashes,
      opts: { dryRun: true },
      cwd,
    });
    assert.equal(action.kind, 'dry-run');
    assert.deepEqual(action.result, {
      ok: true,
      actions: [
        { ref: 'stash@{0}', action: 'keep' },
        { ref: 'stash@{1}', action: 'keep' },
      ],
      failures: [],
    });
    assert.equal(action.stashes, stashes);
  });

  it('returns execute-allowlist when --yes is set', () => {
    const stashes = [{ ref: 'stash@{0}', createdAt: 'x', message: 'm' }];
    const action = decideStashPhase({
      stashes,
      opts: { yes: true, dropStashes: ['stash@{0}'] },
      cwd,
    });
    assert.equal(action.kind, 'execute-allowlist');
    assert.deepEqual(action.executeArgs, {
      cwd,
      stashes,
      allowlist: ['stash@{0}'],
    });
  });

  it('returns execute-allowlist when --json is set', () => {
    const stashes = [{ ref: 'stash@{0}', createdAt: 'x', message: 'm' }];
    const action = decideStashPhase({
      stashes,
      opts: { json: true },
      cwd,
    });
    assert.equal(action.kind, 'execute-allowlist');
    assert.equal(action.executeArgs.allowlist, undefined);
  });

  it('returns execute-interactive when neither --yes nor --json', () => {
    const stashes = [{ ref: 'stash@{0}', createdAt: 'x', message: 'm' }];
    const action = decideStashPhase({ stashes, opts: {}, cwd });
    assert.equal(action.kind, 'execute-interactive');
    assert.deepEqual(action.executeArgs, { cwd, stashes });
  });

  it('--yes takes precedence over interactive even without dropStashes', () => {
    const stashes = [{ ref: 'stash@{0}', createdAt: 'x', message: 'm' }];
    const action = decideStashPhase({
      stashes,
      opts: { yes: true },
      cwd,
    });
    assert.equal(action.kind, 'execute-allowlist');
    assert.equal(action.executeArgs.allowlist, undefined);
  });
});
