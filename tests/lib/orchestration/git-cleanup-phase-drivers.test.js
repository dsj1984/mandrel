/**
 * The git-cleanup phase drivers, tested through the four exported
 * `run*Phase` sequencers — the only surface `cli.js` calls. Each driver's
 * decide/execute halves are module-private, so every branch of the decision
 * logic is reached from the run function with the trailing `deps` bag
 * standing in for git (`fetchFn`, `deleteLocalFn`, `pruneFn`,
 * `stashListerFn`, …) and readline (`prompt`, `promptStash`). No test here
 * spawns git or reads stdin.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  runBranchPhase,
  runFastForwardPhase,
  runPrunePhase,
  runStashPhase,
} from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/phase-drivers.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const ok = () => ({ ok: true });
const quiet = { info() {}, warn() {}, error() {} };
const never = () => assert.fail('prompt must not be asked');

// ---------------------------------------------------------------------
// Fast-forward phase
// ---------------------------------------------------------------------

/** FF seams for a clean tree `behind` commits behind its remote. */
function ffSeams({ behind = 2, current = 'main', ...overrides } = {}) {
  const calls = { checkout: [], merge: [] };
  const seams = {
    isCleanFn: () => true,
    fetchFn: () => ok(),
    currentBranchFn: () => current,
    canFastForwardFn: () => ({ ok: true, behind }),
    checkoutFn: (_cwd, branch) => {
      calls.checkout.push(branch);
      return ok();
    },
    mergeFn: (_cwd, ref) => {
      calls.merge.push(ref);
      return ok();
    },
    logger: quiet,
    ...overrides,
  };
  return { seams, calls };
}

describe('runFastForwardPhase', () => {
  it('skips a non-runnable plan with its reason and a zero behind', async () => {
    const { seams, calls } = ffSeams({ isCleanFn: () => false });
    const out = await runFastForwardPhase({ yes: true }, '/repo', 'main', {
      ...seams,
      prompt: never,
    });
    assert.deepEqual(out, {
      ok: true,
      applied: false,
      skipped: true,
      reason: 'dirty-tree',
      behind: 0,
    });
    assert.deepEqual(calls.merge, []);
  });

  it('keeps the plan behind count on an already-up-to-date skip', async () => {
    const { seams } = ffSeams({ behind: 0 });
    const out = await runFastForwardPhase({}, '/repo', 'main', {
      ...seams,
      prompt: never,
    });
    assert.equal(out.reason, 'already-up-to-date');
    assert.equal(out.behind, 0);
  });

  it('reports the would-be fast-forward under --dry-run without merging', async () => {
    const { seams, calls } = ffSeams({ behind: 3 });
    const out = await runFastForwardPhase({ dryRun: true }, '/repo', 'main', {
      ...seams,
      prompt: never,
    });
    assert.deepEqual(out, {
      ok: true,
      applied: false,
      skipped: true,
      reason: 'dry-run',
      behind: 3,
    });
    assert.deepEqual(calls.merge, []);
  });

  it('asks before merging and returns the declined result on "no"', async () => {
    const { seams, calls } = ffSeams({ behind: 5 });
    const asked = [];
    const out = await runFastForwardPhase({}, '/repo', 'main', {
      ...seams,
      prompt: async (q) => {
        asked.push(q);
        return false;
      },
    });
    assert.match(asked[0], /Fast-forward main by 5 commit/);
    assert.deepEqual(out, {
      ok: true,
      applied: false,
      skipped: true,
      reason: 'declined',
      behind: 5,
    });
    assert.deepEqual(calls.merge, []);
  });

  it('merges after a "yes" and restores the branch it moved off', async () => {
    const { seams, calls } = ffSeams({ behind: 1, current: 'feature' });
    const out = await runFastForwardPhase({}, '/repo', 'main', {
      ...seams,
      prompt: async () => true,
    });
    assert.deepEqual(out, {
      ok: true,
      applied: true,
      skipped: false,
      behind: 1,
    });
    assert.deepEqual(calls.checkout, ['main', 'feature']);
    assert.deepEqual(calls.merge, ['origin/main']);
  });

  it('merges unattended under --yes', async () => {
    const { seams, calls } = ffSeams({ behind: 2 });
    const out = await runFastForwardPhase({ yes: true }, '/repo', 'main', {
      ...seams,
      prompt: never,
    });
    assert.equal(out.applied, true);
    assert.deepEqual(calls.merge, ['origin/main']);
  });

  it('surfaces a failed merge as ok:false rather than throwing', async () => {
    const { seams } = ffSeams({
      mergeFn: () => ({ ok: false, stderr: 'diverged' }),
    });
    const out = await runFastForwardPhase({ yes: true }, '/repo', 'main', {
      ...seams,
      prompt: never,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'merge-failed');
  });
});

// ---------------------------------------------------------------------
// Prune phase
// ---------------------------------------------------------------------

describe('runPrunePhase', () => {
  const pruned = (refs) => () => ({ ok: true, pruned: refs });

  it('never prunes under --dry-run', async () => {
    const out = await runPrunePhase({ dryRun: true }, '/repo', {
      prompt: never,
      pruneFn: () => assert.fail('must not prune'),
    });
    assert.deepEqual(out, {
      ok: true,
      attempted: false,
      remote: 'origin',
      pruned: [],
    });
  });

  it('returns the declined result when the operator says no', async () => {
    const out = await runPrunePhase({}, '/repo', {
      prompt: async (q) => {
        assert.match(q, /git fetch --prune origin/);
        return false;
      },
      pruneFn: () => assert.fail('must not prune'),
    });
    assert.deepEqual(out, {
      ok: true,
      attempted: false,
      remote: 'origin',
      pruned: [],
      reason: 'declined',
    });
  });

  it('prunes after a "yes"', async () => {
    const out = await runPrunePhase({}, '/repo', {
      prompt: async () => true,
      pruneFn: pruned(['story-1']),
      logger: quiet,
    });
    assert.deepEqual(out, {
      ok: true,
      attempted: true,
      remote: 'origin',
      pruned: ['story-1'],
    });
  });

  it('prunes unattended under --yes', async () => {
    const out = await runPrunePhase({ yes: true }, '/repo', {
      prompt: never,
      pruneFn: pruned([]),
      logger: quiet,
    });
    assert.equal(out.attempted, true);
    assert.deepEqual(out.pruned, []);
  });
});

// ---------------------------------------------------------------------
// Branch phase
// ---------------------------------------------------------------------

/**
 * planCleanup + executeCleanup seams. `merged` local branches are
 * git-merged candidates; `remoteOnly` names exist only on origin, merged.
 */
function branchSeams({ merged = [], remoteOnly = [], prProbe, ...rest } = {}) {
  const deleted = { local: [], remote: [] };
  const seams = {
    localLister: () => ['main', ...merged],
    mergedLister: () => merged,
    currentBranchFn: () => 'main',
    protectedConfigFn: () => [],
    worktreesFn: () => new Map(),
    prProbe: prProbe ?? (() => null),
    refExistsFn: () => false,
    remoteLister: () => remoteOnly,
    remoteMergedLister: () => remoteOnly,
    branchTipShaFn: () => null,
    contentEquivalentFn: () => ({ supported: false }),
    branchLastCommitFn: () => null,
    removeWorktreeFn: () => ok(),
    deleteLocalFn: (branch) => {
      deleted.local.push(branch);
      return { deleted: true };
    },
    deleteRemoteFn: (branch) => {
      deleted.remote.push(branch);
      return { deleted: true };
    },
    pruneRemoteFn: () => ({ ok: true, pruned: [] }),
    logger: quiet,
    ...rest,
  };
  return { seams, deleted };
}

describe('runBranchPhase', () => {
  it('lists but never reaps under --dry-run', async () => {
    const { seams, deleted } = branchSeams({ merged: ['fix/a'] });
    const out = await runBranchPhase({ dryRun: true }, '/repo', 'main', {
      ...seams,
      prompt: never,
    });
    assert.deepEqual(
      out.plan.candidates.map((c) => c.branch),
      ['fix/a'],
    );
    assert.equal(out.result, null);
    assert.deepEqual(deleted.local, []);
  });

  it('returns no result when nothing is merged', async () => {
    const { seams } = branchSeams();
    const out = await runBranchPhase({}, '/repo', 'main', {
      ...seams,
      prompt: never,
    });
    assert.deepEqual(out.plan.candidates, []);
    assert.equal(out.result, null);
  });

  it('treats remote-only candidates as nothing to reap without --remote', async () => {
    const { seams } = branchSeams({ remoteOnly: ['fix/remote-only'] });
    const out = await runBranchPhase({}, '/repo', 'main', {
      ...seams,
      prompt: never,
    });
    assert.equal(out.plan.candidates[0].localExists, false);
    assert.equal(out.result, null);
  });

  it('counts remote-only candidates once --remote is set', async () => {
    const { seams, deleted } = branchSeams({ remoteOnly: ['fix/remote-only'] });
    const asked = [];
    const out = await runBranchPhase({ remote: true }, '/repo', 'main', {
      ...seams,
      prompt: async (q) => {
        asked.push(q);
        return true;
      },
    });
    assert.match(asked[0], /Reap 1 merged branch\(es\) \(including origin\)\?/);
    assert.deepEqual(deleted.remote, ['fix/remote-only']);
    assert.equal(out.result.ok, true);
  });

  it('excludes remote-only candidates from the prompt count without --remote', async () => {
    const { seams } = branchSeams({
      merged: ['fix/local'],
      remoteOnly: ['fix/remote-only'],
    });
    const asked = [];
    await runBranchPhase({}, '/repo', 'main', {
      ...seams,
      prompt: async (q) => {
        asked.push(q);
        return false;
      },
    });
    assert.match(asked[0], /Reap 1 merged branch\(es\)\?/);
    assert.doesNotMatch(asked[0], /content-merged/);
  });

  it('calls out content-merged candidates as a weaker signal', async () => {
    const { seams } = branchSeams({
      merged: ['fix/a'],
      localLister: () => ['main', 'fix/a', 'story-4200'],
      contentEquivalentFn: ({ branch }) =>
        branch === 'story-4200'
          ? { supported: true, equivalent: true }
          : { supported: false },
    });
    const asked = [];
    await runBranchPhase({}, '/repo', 'main', {
      ...seams,
      prompt: async (q) => {
        asked.push(q);
        return false;
      },
    });
    assert.match(
      asked[0],
      /Reap 2 merged branch\(es\) \(1 content-merged — weaker signal, verify before confirming\)\?/,
    );
  });

  it('returns the declined result when the operator says no', async () => {
    const { seams, deleted } = branchSeams({ merged: ['fix/a', 'fix/b'] });
    const out = await runBranchPhase({}, '/repo', 'main', {
      ...seams,
      prompt: async () => false,
    });
    assert.equal(out.declined, true);
    assert.equal(out.result, null);
    assert.deepEqual(deleted.local, []);
  });

  it('reaps after a "yes" and returns {plan, result}', async () => {
    const { seams, deleted } = branchSeams({ merged: ['story-1'] });
    const out = await runBranchPhase({}, '/repo', 'main', {
      ...seams,
      prompt: async () => true,
    });
    assert.deepEqual(deleted.local, ['story-1']);
    assert.equal(out.result.ok, true);
    assert.deepEqual(
      out.result.local.map((r) => r.branch),
      ['story-1'],
    );
  });

  it('reaps unattended under --yes and reports a failed delete without throwing', async () => {
    const { seams } = branchSeams({
      merged: ['story-2'],
      deleteLocalFn: () => ({
        deleted: false,
        reason: 'not-merged',
        stderr: 'not fully merged',
      }),
    });
    const out = await runBranchPhase({ yes: true }, '/repo', 'main', {
      ...seams,
      prompt: never,
    });
    assert.equal(out.result.ok, false);
  });

  it('withholds content-merged remote deletes under --yes unless opted in', async () => {
    const contentMerged = {
      remoteOnly: ['story-4200'],
      contentEquivalentFn: () => ({ supported: true, equivalent: true }),
      remoteMergedLister: () => [],
    };
    const guarded = branchSeams(contentMerged);
    await runBranchPhase({ yes: true, remote: true }, '/repo', 'main', {
      ...guarded.seams,
      prompt: never,
    });
    assert.deepEqual(guarded.deleted.remote, []);

    const optedIn = branchSeams(contentMerged);
    await runBranchPhase(
      { yes: true, remote: true, includeContentMerged: true },
      '/repo',
      'main',
      { ...optedIn.seams, prompt: never },
    );
    assert.deepEqual(optedIn.deleted.remote, ['story-4200']);
  });
});

// ---------------------------------------------------------------------
// Stash phase
// ---------------------------------------------------------------------

const STASHES = [
  { ref: 'stash@{0}', createdAt: '2026-01-01', message: 'keep me' },
  { ref: 'stash@{1}', createdAt: '2026-01-02', message: 'drop me' },
];

function stashSeams() {
  const dropped = [];
  const seams = {
    stashListerFn: () => STASHES,
    dropFn: (ref) => {
      dropped.push(ref);
      return ok();
    },
    logger: quiet,
  };
  return { seams, dropped };
}

describe('runStashPhase', () => {
  it('short-circuits with an empty result when no stashes exist', async () => {
    const cwd = makeTempDir('stash-run-');
    const out = await runStashPhase({ dryRun: false, yes: true }, cwd);
    assert.deepEqual(out, { ok: true, actions: [], failures: [] });
  });

  it('keeps every stash under --dry-run', async () => {
    const { seams, dropped } = stashSeams();
    const out = await runStashPhase({ dryRun: true }, '/repo', seams);
    assert.deepEqual(out, {
      ok: true,
      actions: [
        { ref: 'stash@{0}', action: 'keep' },
        { ref: 'stash@{1}', action: 'keep' },
      ],
      failures: [],
    });
    assert.deepEqual(dropped, []);
  });

  it('drops only the allowlisted refs under --yes, high index first', async () => {
    const { seams, dropped } = stashSeams();
    const out = await runStashPhase(
      { yes: true, dropStashes: ['stash@{1}'] },
      '/repo',
      seams,
    );
    assert.equal(out.ok, true);
    assert.deepEqual(dropped, ['stash@{1}']);
    assert.deepEqual(
      out.actions.map((a) => [a.ref, a.action]),
      [
        ['stash@{1}', 'drop'],
        ['stash@{0}', 'keep'],
      ],
    );
  });

  it('keeps every stash under --json with no allowlist', async () => {
    const { seams, dropped } = stashSeams();
    const out = await runStashPhase({ json: true }, '/repo', seams);
    assert.deepEqual(
      out.actions.map((a) => a.action),
      ['keep', 'keep'],
    );
    assert.deepEqual(dropped, []);
  });

  it('asks per stash when interactive', async () => {
    const { seams, dropped } = stashSeams();
    const asked = [];
    const out = await runStashPhase({}, '/repo', {
      ...seams,
      promptStash: (entry) => {
        asked.push(entry.ref);
        return entry.ref === 'stash@{1}' ? 'drop' : 'keep';
      },
    });
    assert.deepEqual(asked, ['stash@{1}', 'stash@{0}']);
    assert.deepEqual(dropped, ['stash@{1}']);
    assert.equal(out.ok, true);
  });
});
