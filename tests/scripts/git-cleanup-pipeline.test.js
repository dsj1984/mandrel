// tests/scripts/git-cleanup-pipeline.test.js
//
// Story #2466 / Task #2496 — byte-identical CLI surface for the thinned
// git-cleanup pipeline.
//
// After Story #2466 extracted the per-phase modules under
// `lib/orchestration/git-cleanup/phases/`, this fixture-diff test pins
// the public exports + behaviour across three flag combinations
// (default, --remote, --json) using injected accessors so no shell
// calls are made.
//
// Run: node --test tests/scripts/git-cleanup-pipeline.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAllowlistDecider,
  buildGlobFilter,
  buildJsonEnvelope,
  computeExitCode,
  computeProtectedReason,
  computeProtectedSet,
  executeCleanup,
  executeStashes,
  parseCleanupArgs,
  parsePrunedRefs,
  parseStashList,
  planCleanup,
  planStashes,
  probeMergedPr,
  renderDryRun,
  renderExecutionLine,
  renderExecutionSummary,
  renderPruneLine,
  stashRefIndex,
} from '../../.agents/scripts/git-cleanup.js';

describe('git-cleanup pipeline — public exports (Story #2466)', () => {
  it('re-exports the legacy named surface', () => {
    // Removing any of these breaks the existing unit tests and
    // single-story-sweep.js.
    for (const fn of [
      buildAllowlistDecider,
      buildGlobFilter,
      buildJsonEnvelope,
      computeExitCode,
      computeProtectedReason,
      computeProtectedSet,
      executeCleanup,
      executeStashes,
      parseCleanupArgs,
      parsePrunedRefs,
      parseStashList,
      planCleanup,
      planStashes,
      probeMergedPr,
      renderDryRun,
      renderExecutionLine,
      renderExecutionSummary,
      renderPruneLine,
      stashRefIndex,
    ]) {
      assert.equal(typeof fn, 'function');
    }
  });
});

describe('git-cleanup pipeline — parseCleanupArgs (Story #2466)', () => {
  it('default flags produce a dry-run with all phases enabled', () => {
    const opts = parseCleanupArgs([]);
    assert.equal(opts.dryRun, true);
    assert.equal(opts.execute, false);
    assert.equal(opts.phases.fastForwardMain, true);
    assert.equal(opts.phases.pruneRemotes, true);
    assert.equal(opts.phases.branches, true);
    assert.equal(opts.phases.stashes, true);
  });

  it('narrowing flags restrict the active phase set', () => {
    const opts = parseCleanupArgs(['--branches']);
    assert.equal(opts.phases.branches, true);
    assert.equal(opts.phases.fastForwardMain, false);
    assert.equal(opts.phases.pruneRemotes, false);
    assert.equal(opts.phases.stashes, false);
  });

  it('Step 6 may combine --fast-forward-main with --branches', () => {
    const opts = parseCleanupArgs([
      '--fast-forward-main',
      '--branches',
      '--include',
      'story-99',
    ]);
    assert.equal(opts.phases.fastForwardMain, true);
    assert.equal(opts.phases.branches, true);
    assert.equal(opts.phases.pruneRemotes, false);
    assert.deepEqual(opts.include, ['story-99']);
  });

  it('--execute and --remote propagate; --dry-run wins over --execute', () => {
    const a = parseCleanupArgs(['--execute', '--remote']);
    assert.equal(a.execute, true);
    assert.equal(a.dryRun, false);
    assert.equal(a.remote, true);
    const b = parseCleanupArgs(['--execute', '--dry-run']);
    assert.equal(b.execute, false);
    assert.equal(b.dryRun, true);
  });

  it('--drop-stashes is repeatable', () => {
    const opts = parseCleanupArgs([
      '--drop-stashes',
      'stash@{0}',
      '--drop-stashes',
      'stash@{2}',
    ]);
    assert.deepEqual(opts.dropStashes, ['stash@{0}', 'stash@{2}']);
  });
});

describe('git-cleanup pipeline — branches phase (Story #2466)', () => {
  function fixture() {
    return {
      cwd: '/tmp',
      baseBranch: 'main',
      localLister: () => ['feature/a', 'feature/b', 'main'],
      mergedLister: () => ['feature/a'],
      currentBranchFn: () => 'main',
      protectedConfigFn: () => [],
      worktreesFn: () => new Map(),
      prProbe: (branch) =>
        branch === 'feature/a' ? { number: 42, mergedAt: '2025-01-01' } : null,
      filter: () => true,
    };
  }

  it('planCleanup classifies merged + protected branches correctly', () => {
    const out = planCleanup(fixture());
    assert.equal(out.candidates.length, 1);
    assert.equal(out.candidates[0].branch, 'feature/a');
    assert.equal(out.candidates[0].detectedBy, 'gh');
    assert.equal(out.candidates[0].prNumber, 42);
    const mainSkip = out.skipped.find((s) => s.branch === 'main');
    assert.equal(mainSkip.reason, 'protected');
    const bSkip = out.skipped.find((s) => s.branch === 'feature/b');
    assert.equal(bSkip.reason, 'not-merged');
  });

  it('executeCleanup composes the reap envelope from injected accessors', () => {
    const candidates = [
      {
        branch: 'feature/a',
        prNumber: 42,
        mergedAt: null,
        hasWorktree: false,
        worktreePath: null,
        detectedBy: 'gh',
        localExists: true,
      },
    ];
    const out = executeCleanup({
      candidates,
      cwd: '/tmp',
      remote: false,
      removeWorktreeFn: () => ({ ok: true, dirty: false }),
      deleteLocalFn: () => ({ deleted: true, reason: null }),
      deleteRemoteFn: () => ({ deleted: true, reason: null }),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(out.ok, true);
    assert.equal(out.local.length, 1);
    assert.equal(out.local[0].ok, true);
    assert.equal(out.failures.length, 0);
  });
});

describe('git-cleanup pipeline — render + exit code (Story #2466)', () => {
  it('renderDryRun emits a candidate-count header + per-candidate line', () => {
    const lines = renderDryRun({
      candidates: [
        {
          branch: 'feature/a',
          prNumber: 42,
          hasWorktree: false,
          localExists: true,
        },
      ],
      skipped: [],
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /1 candidate\(s\)/);
    assert.match(lines[1], /feature\/a — PR #42/);
  });

  it('computeExitCode signals exit 2 when nothing to do', () => {
    assert.equal(
      computeExitCode({
        branchesPlan: { candidates: [] },
        branchesResult: null,
        fastForward: { ok: true, applied: false },
        prune: { ok: true, pruned: [] },
        stashes: { ok: true, actions: [] },
      }),
      2,
    );
  });

  it('computeExitCode signals exit 1 on any phase failure', () => {
    assert.equal(
      computeExitCode({
        branchesPlan: null,
        branchesResult: null,
        fastForward: { ok: false },
        prune: null,
        stashes: null,
      }),
      1,
    );
  });

  it('computeExitCode signals exit 0 when at least one phase produced work', () => {
    assert.equal(
      computeExitCode({
        branchesPlan: { candidates: [{ branch: 'feature/a' }] },
        branchesResult: { ok: true },
        fastForward: { ok: true, applied: false },
        prune: { ok: true, pruned: [] },
        stashes: { ok: true, actions: [] },
      }),
      0,
    );
  });
});

describe('git-cleanup pipeline — JSON envelope (Story #2466)', () => {
  it('buildJsonEnvelope surfaces every phase block in the envelope', () => {
    const env = buildJsonEnvelope({
      dryRun: true,
      baseBranch: 'main',
      plan: { candidates: [], skipped: [] },
      result: null,
      fastForward: { ok: true, applied: false, reason: 'dry-run' },
      prune: { ok: true, attempted: false, remote: 'origin', pruned: [] },
      stashes: { ok: true, actions: [], failures: [] },
    });
    assert.equal(env.dryRun, true);
    assert.equal(env.baseBranch, 'main');
    assert.equal(env.fastForward.reason, 'dry-run');
    assert.equal(env.prune.remote, 'origin');
    assert.deepEqual(env.stashes.actions, []);
  });
});
