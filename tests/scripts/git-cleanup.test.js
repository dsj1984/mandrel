import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildAllowlistDecider,
  buildGlobFilter,
  buildJsonEnvelope,
  classifyLatestPr,
  computeExitCode,
  computeProtectedReason,
  computeProtectedSet,
  executeCleanup,
  executeFastForward,
  executePrune,
  executeStashes,
  parseCleanupArgs,
  parsePrunedRefs,
  parseStashList,
  planCleanup,
  planFastForward,
  planStashes,
  probeAllPrs,
  probeAncestry,
  probeLatestPr,
  probeMergedPr,
  renderDryRun,
  renderExecutionLine,
  renderExecutionSummary,
  renderLatestPrSkipLine,
  renderNotMergedSkipLine,
  renderPruneLine,
  stashRefIndex,
} from '../../.agents/scripts/git-cleanup.js';
import { decideBranchPhase } from '../../.agents/scripts/lib/orchestration/git-cleanup/phases/phase-drivers.js';
import { renderCandidateList } from '../../.agents/scripts/lib/orchestration/git-cleanup/phases/render.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

describe('git-cleanup.parseCleanupArgs', () => {
  it('defaults to dry-run with no flags', () => {
    const out = parseCleanupArgs([]);
    assert.equal(out.dryRun, true);
    assert.equal(out.execute, false);
    assert.equal(out.remote, false);
    assert.equal(out.json, false);
    assert.deepEqual(out.include, []);
    assert.deepEqual(out.exclude, []);
  });

  it('--execute flips dryRun off', () => {
    const out = parseCleanupArgs(['--execute']);
    assert.equal(out.execute, true);
    assert.equal(out.dryRun, false);
  });

  it('--dry-run wins when both flags are passed (safer choice)', () => {
    const out = parseCleanupArgs(['--execute', '--dry-run']);
    assert.equal(out.dryRun, true);
    assert.equal(out.execute, false);
  });

  it('defaults all four phases to active when no phase flag is set', () => {
    const out = parseCleanupArgs([]);
    assert.deepEqual(out.phases, {
      fastForwardMain: true,
      pruneRemotes: true,
      branches: true,
      stashes: true,
    });
  });

  it('narrows to only the requested phases when phase flags are passed', () => {
    const out = parseCleanupArgs(['--stashes', '--branches']);
    assert.deepEqual(out.phases, {
      fastForwardMain: false,
      pruneRemotes: false,
      branches: true,
      stashes: true,
    });
  });

  it('--yes flips the non-interactive flag', () => {
    const out = parseCleanupArgs(['--yes']);
    assert.equal(out.yes, true);
  });

  it('--drop-stashes is repeatable', () => {
    const out = parseCleanupArgs([
      '--drop-stashes',
      'stash@{0}',
      '--drop-stashes',
      'stash@{2}',
    ]);
    assert.deepEqual(out.dropStashes, ['stash@{0}', 'stash@{2}']);
  });

  it('parses --remote, --json, --base, --cwd, repeated --include / --exclude', () => {
    const out = parseCleanupArgs([
      '--execute',
      '--remote',
      '--json',
      '--include',
      'fix/*',
      '--include',
      'chore/*',
      '--exclude',
      'fix/keep',
      '--base',
      'develop',
      '--cwd',
      '/tmp/repo',
    ]);
    assert.equal(out.remote, true);
    assert.equal(out.json, true);
    assert.equal(out.base, 'develop');
    assert.equal(out.cwd, '/tmp/repo');
    assert.deepEqual(out.include, ['fix/*', 'chore/*']);
    assert.deepEqual(out.exclude, ['fix/keep']);
  });
});

describe('git-cleanup.buildGlobFilter', () => {
  it('allows everything when both lists are empty', () => {
    const f = buildGlobFilter();
    assert.equal(f('any/branch'), true);
  });

  it('include-only restricts to matching branches', () => {
    const f = buildGlobFilter({ include: ['fix/*'] });
    assert.equal(f('fix/a'), true);
    assert.equal(f('feat/a'), false);
  });

  it('exclude always wins against include', () => {
    const f = buildGlobFilter({
      include: ['fix/*'],
      exclude: ['fix/keep-me'],
    });
    assert.equal(f('fix/normal'), true);
    assert.equal(f('fix/keep-me'), false);
  });

  it('multiple include globs union', () => {
    const f = buildGlobFilter({ include: ['fix/*', 'chore/*'] });
    assert.equal(f('fix/a'), true);
    assert.equal(f('chore/a'), true);
    assert.equal(f('feat/a'), false);
  });
});

describe('git-cleanup.computeProtectedSet', () => {
  it('always includes baseBranch + currentBranch + configured names', () => {
    const set = computeProtectedSet({
      baseBranch: 'main',
      currentBranch: 'feature/wip',
      configured: ['release', 'staging'],
    });
    assert.equal(set.has('main'), true);
    assert.equal(set.has('feature/wip'), true);
    assert.equal(set.has('release'), true);
    assert.equal(set.has('staging'), true);
  });

  it('tolerates null/undefined currentBranch + empty configured', () => {
    const set = computeProtectedSet({
      baseBranch: 'main',
      currentBranch: null,
      configured: [],
    });
    assert.deepEqual([...set], ['main']);
  });
});

describe('git-cleanup.computeProtectedReason', () => {
  const ctx = (branch) => ({
    baseBranch: 'main',
    currentBranch: 'fix/wip',
    configured: ['release'],
    branch,
  });

  it('returns protected for the base branch', () => {
    assert.equal(computeProtectedReason(ctx('main')), 'protected');
  });

  it('returns protected for configured-protected branches', () => {
    assert.equal(computeProtectedReason(ctx('release')), 'protected');
  });

  it('returns current-head for the current branch when not also base/configured', () => {
    assert.equal(computeProtectedReason(ctx('fix/wip')), 'current-head');
  });

  it('returns null for reapable branches', () => {
    assert.equal(computeProtectedReason(ctx('feat/x')), null);
  });

  it('prefers protected over current-head when the same name appears in both', () => {
    const reason = computeProtectedReason({
      baseBranch: 'main',
      currentBranch: 'main',
      configured: [],
      branch: 'main',
    });
    assert.equal(reason, 'protected');
  });

  it('tolerates a missing/empty branch', () => {
    assert.equal(computeProtectedReason(ctx('')), null);
    assert.equal(
      computeProtectedReason({ baseBranch: 'main', branch: null }),
      null,
    );
  });
});

describe('git-cleanup.planCleanup', () => {
  const baseCtx = (overrides) => ({
    cwd: '/repo',
    baseBranch: 'main',
    localLister: () => ['fix/a', 'fix/b', 'main', 'feat/wip'],
    mergedLister: () => [],
    currentBranchFn: () => 'main',
    protectedConfigFn: () => [],
    worktreesFn: () => new Map(),
    prProbe: () => null,
    filter: () => true,
    ...overrides,
  });

  it('detects squash-merged branches via gh probe', () => {
    const plan = planCleanup(
      baseCtx({
        prProbe: (b) =>
          b === 'fix/a'
            ? { number: 101, mergedAt: '2026-05-01T00:00:00Z' }
            : null,
      }),
    );
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].branch, 'fix/a');
    assert.equal(plan.candidates[0].prNumber, 101);
    assert.equal(plan.candidates[0].detectedBy, 'gh');
  });

  it('falls back to git branch --merged when gh returns nothing', () => {
    const plan = planCleanup(
      baseCtx({
        mergedLister: () => ['fix/b'],
        prProbe: () => null,
      }),
    );
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].branch, 'fix/b');
    assert.equal(plan.candidates[0].prNumber, null);
    assert.equal(plan.candidates[0].detectedBy, 'git-merged');
  });

  it('splits the current-HEAD skip out of the protected bucket', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['main', 'fix/current', 'release', 'fix/ok'],
        currentBranchFn: () => 'fix/current',
        protectedConfigFn: () => ['release'],
        prProbe: () => ({ number: 1, mergedAt: null }),
      }),
    );
    const candidates = plan.candidates.map((c) => c.branch);
    assert.deepEqual(candidates, ['fix/ok']);
    const protectedSkipped = plan.skipped
      .filter((s) => s.reason === 'protected')
      .map((s) => s.branch);
    assert.deepEqual(protectedSkipped.sort(), ['main', 'release']);
    const currentHeadSkipped = plan.skipped
      .filter((s) => s.reason === 'current-head')
      .map((s) => s.branch);
    assert.deepEqual(currentHeadSkipped, ['fix/current']);
  });

  it('annotates attached worktrees', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['fix/wt'],
        prProbe: () => ({ number: 7, mergedAt: '2026-05-09T00:00:00Z' }),
        worktreesFn: () =>
          new Map([
            ['fix/wt', { path: '/repo/.worktrees/fix-wt', branch: 'fix/wt' }],
          ]),
      }),
    );
    assert.equal(plan.candidates[0].hasWorktree, true);
    assert.equal(plan.candidates[0].worktreePath, '/repo/.worktrees/fix-wt');
  });

  it('applies the glob filter before probing PRs', () => {
    let probes = 0;
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['fix/a', 'chore/b', 'feat/c'],
        prProbe: () => {
          probes += 1;
          return { number: 1, mergedAt: null };
        },
        filter: buildGlobFilter({ include: ['fix/*'] }),
      }),
    );
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].branch, 'fix/a');
    assert.equal(probes, 1, 'should only probe gh for filter-passing branches');
    const filtered = plan.skipped
      .filter((s) => s.reason === 'filtered')
      .map((s) => s.branch);
    assert.deepEqual(filtered.sort(), ['chore/b', 'feat/c']);
  });

  it('exclude takes precedence over include', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['fix/a', 'fix/keep'],
        prProbe: () => ({ number: 1, mergedAt: null }),
        filter: buildGlobFilter({
          include: ['fix/*'],
          exclude: ['fix/keep'],
        }),
      }),
    );
    assert.deepEqual(
      plan.candidates.map((c) => c.branch),
      ['fix/a'],
    );
  });

  it('local candidates carry localExists: true by default', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['fix/a'],
        prProbe: () => ({ number: 1, mergedAt: null }),
      }),
    );
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].localExists, true);
  });

  it('does NOT enumerate remote-only branches by default', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['fix/local'],
        remoteLister: () => ['fix/remote-only'],
        prProbe: () => ({ number: 1, mergedAt: null }),
      }),
    );
    const branches = plan.candidates.map((c) => c.branch).sort();
    assert.deepEqual(branches, ['fix/local']);
  });

  it('enumerates remote-only merged branches when includeRemoteOnly=true', () => {
    const plan = planCleanup(
      baseCtx({
        includeRemoteOnly: true,
        localLister: () => [],
        remoteLister: () => ['fix/remote-only', 'main'],
        prProbe: (b) =>
          b === 'fix/remote-only'
            ? { number: 42, mergedAt: '2026-05-18T00:00:00Z' }
            : null,
      }),
    );
    assert.equal(plan.candidates.length, 1);
    const cand = plan.candidates[0];
    assert.equal(cand.branch, 'fix/remote-only');
    assert.equal(cand.detectedBy, 'remote-only');
    assert.equal(cand.localExists, false);
    assert.equal(cand.hasWorktree, false);
    assert.equal(cand.prNumber, 42);
  });

  it('remote-only pass de-duplicates against the local enumeration', () => {
    let remoteProbeCount = 0;
    const plan = planCleanup(
      baseCtx({
        includeRemoteOnly: true,
        localLister: () => ['fix/both'],
        remoteLister: () => ['fix/both'],
        prProbe: (b) => {
          if (b === 'fix/both') remoteProbeCount += 1;
          return { number: 1, mergedAt: null };
        },
      }),
    );
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].localExists, true);
    assert.equal(
      remoteProbeCount,
      1,
      'should probe once (from the local pass) and skip remote-only entirely',
    );
  });

  it('remote-only pass respects the protected reason and the glob filter', () => {
    const plan = planCleanup(
      baseCtx({
        includeRemoteOnly: true,
        localLister: () => [],
        remoteLister: () => ['main', 'release', 'fix/skip', 'fix/ok'],
        protectedConfigFn: () => ['release'],
        filter: buildGlobFilter({
          include: ['fix/*'],
          exclude: ['fix/skip'],
        }),
        prProbe: () => ({ number: 1, mergedAt: null }),
      }),
    );
    const branches = plan.candidates.map((c) => c.branch);
    assert.deepEqual(branches, ['fix/ok']);
  });

  it('remote-only pass records — never drops — a branch without a merged PR', () => {
    // Story #5188: a `no-pr` verdict used to `continue` with no record at
    // all. It now falls through the ancestry / content-equivalence cascade
    // and lands in `skipped[]` when neither signal fires.
    const plan = planCleanup(
      baseCtx({
        includeRemoteOnly: true,
        localLister: () => [],
        remoteLister: () => ['fix/no-pr'],
        remoteMergedLister: () => [],
        contentEquivalentFn: () => ({ supported: true, equivalent: false }),
        branchLastCommitFn: () => null,
        refExistsFn: () => false,
        prProbe: () => null,
      }),
    );
    assert.deepEqual(plan.candidates, []);
    assert.deepEqual(
      plan.skipped.map((s) => ({ branch: s.branch, reason: s.reason })),
      [{ branch: 'fix/no-pr', reason: 'not-merged' }],
    );
  });
});

describe('git-cleanup.planCleanup content-merged detection (Story #4395)', () => {
  const baseCtx = (overrides) => ({
    cwd: '/repo',
    baseBranch: 'main',
    localLister: () => ['story-4200'],
    mergedLister: () => [],
    currentBranchFn: () => 'main',
    protectedConfigFn: () => [],
    worktreesFn: () => new Map(),
    prProbe: () => null,
    branchTipShaFn: () => null,
    refExistsFn: () => false,
    branchLastCommitFn: () => '2026-06-01T00:00:00Z',
    filter: () => true,
    ...overrides,
  });

  it('classifies a squash-orphaned branch as content-merged when the probe reports equivalent: true', () => {
    const plan = planCleanup(
      baseCtx({
        contentEquivalentFn: () => ({ supported: true, equivalent: true }),
      }),
    );
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].branch, 'story-4200');
    assert.equal(plan.candidates[0].detectedBy, 'content-merged');
    assert.equal(plan.candidates[0].prNumber, null);
  });

  it('keeps a genuinely-unmerged branch skipped as not-merged when the probe reports equivalent: false', () => {
    const plan = planCleanup(
      baseCtx({
        contentEquivalentFn: () => ({ supported: true, equivalent: false }),
      }),
    );
    assert.equal(plan.candidates.length, 0);
    const skip = plan.skipped.find((s) => s.branch === 'story-4200');
    assert.equal(skip.reason, 'not-merged');
  });

  it('keeps not-merged classification when the probe is unsupported (old git / conflict)', () => {
    const plan = planCleanup(
      baseCtx({
        contentEquivalentFn: () => ({ supported: false }),
      }),
    );
    assert.equal(plan.candidates.length, 0);
    const skip = plan.skipped.find((s) => s.branch === 'story-4200');
    assert.equal(skip.reason, 'not-merged');
  });

  it('records the last-commit timestamp on not-merged skips for the dry-run age line', () => {
    const plan = planCleanup(
      baseCtx({
        contentEquivalentFn: () => ({ supported: false }),
        branchLastCommitFn: () => '2026-05-01T00:00:00Z',
      }),
    );
    const skip = plan.skipped.find((s) => s.branch === 'story-4200');
    assert.equal(skip.lastCommitAt, '2026-05-01T00:00:00Z');
  });

  it('never probes content-equivalence when a gh or ancestry signal already matched', () => {
    let probeCalls = 0;
    const plan = planCleanup(
      baseCtx({
        prProbe: () => ({ number: 1, state: 'MERGED', headRefOid: null }),
        contentEquivalentFn: () => {
          probeCalls += 1;
          return { supported: true, equivalent: true };
        },
      }),
    );
    assert.equal(plan.candidates[0].detectedBy, 'gh');
    assert.equal(
      probeCalls,
      0,
      'content probe should be skipped once gh already matched',
    );
  });
});

describe('git-cleanup.planCleanup ancestry anchor union (Story #4395)', () => {
  const baseCtx = (overrides) => ({
    cwd: '/repo',
    baseBranch: 'main',
    localLister: () => ['story-4200'],
    currentBranchFn: () => 'main',
    protectedConfigFn: () => [],
    worktreesFn: () => new Map(),
    prProbe: () => null,
    branchTipShaFn: () => null,
    contentEquivalentFn: () => ({ supported: false }),
    filter: () => true,
    ...overrides,
  });

  it('unions git-merged against origin/<base> when the remote-tracking ref exists', () => {
    const mergedCalls = [];
    const plan = planCleanup(
      baseCtx({
        mergedLister: (_cwd, base) => {
          mergedCalls.push(base);
          return base === 'origin/main' ? ['story-4200'] : [];
        },
        refExistsFn: (_cwd, ref) => ref === 'origin/main',
      }),
    );
    assert.deepEqual(mergedCalls, ['main', 'origin/main']);
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].detectedBy, 'git-merged');
  });

  it('does not consult origin/<base> when the remote-tracking ref is absent', () => {
    const mergedCalls = [];
    const plan = planCleanup(
      baseCtx({
        mergedLister: (_cwd, base) => {
          mergedCalls.push(base);
          return [];
        },
        refExistsFn: () => false,
      }),
    );
    assert.deepEqual(mergedCalls, ['main']);
    assert.equal(plan.candidates.length, 0);
  });
});

describe('git-cleanup.planCleanup gh degradation (Story #4395)', () => {
  const baseCtx = (overrides) => ({
    cwd: '/repo',
    baseBranch: 'main',
    localLister: () => ['fix/a'],
    mergedLister: () => [],
    currentBranchFn: () => 'main',
    protectedConfigFn: () => [],
    worktreesFn: () => new Map(),
    branchTipShaFn: () => null,
    refExistsFn: () => false,
    contentEquivalentFn: () => ({ supported: false }),
    filter: () => true,
    ...overrides,
  });

  function quietLogger() {
    const warnings = [];
    return { warnings, logger: { warn: (m) => warnings.push(m) } };
  }

  it('a throwing bulk-index probe degrades to git-only signals instead of crashing', () => {
    const { warnings, logger } = quietLogger();
    const plan = planCleanup(
      baseCtx({
        logger,
        prIndexFn: () => {
          throw new Error('gh: authentication failed');
        },
      }),
    );
    assert.equal(plan.ghDegraded, true);
    assert.equal(plan.candidates.length, 0);
    const skip = plan.skipped.find((s) => s.branch === 'fix/a');
    assert.equal(skip.reason, 'not-merged');
    assert.equal(warnings.length, 1, 'exactly one warning should be logged');
    assert.match(warnings[0], /gh probe failed/);
  });

  it('a throwing per-branch fallback probe degrades without aborting the run', () => {
    const { warnings, logger } = quietLogger();
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['fix/a', 'fix/b'],
        logger,
        prIndexFn: () => new Map(),
        prFallback: () => {
          throw new Error('rate limited');
        },
      }),
    );
    assert.equal(plan.ghDegraded, true);
    assert.equal(
      warnings.length,
      1,
      'degradation warning fires once, not per branch',
    );
  });

  it('does not degrade when the caller injects its own prProbe', () => {
    const plan = planCleanup(
      baseCtx({
        prProbe: () => null,
        prIndexFn: () => {
          throw new Error('should never be called');
        },
      }),
    );
    assert.equal(plan.ghDegraded, false);
  });

  it('ghDegraded defaults to false on a clean run', () => {
    const plan = planCleanup(
      baseCtx({
        prProbe: () => null,
      }),
    );
    assert.equal(plan.ghDegraded, false);
  });
});

describe('git-cleanup.executeCleanup', () => {
  const baseCand = (overrides) => ({
    branch: 'fix/a',
    prNumber: 1,
    mergedAt: '2026-05-01T00:00:00Z',
    hasWorktree: false,
    worktreePath: null,
    detectedBy: 'gh',
    ...overrides,
  });

  it('reaps worktree before local branch when attached', () => {
    const order = [];
    const result = executeCleanup({
      candidates: [
        baseCand({
          branch: 'fix/wt',
          hasWorktree: true,
          worktreePath: '/wt/fix-wt',
        }),
      ],
      cwd: '/repo',
      remote: false,
      removeWorktreeFn: (p) => {
        order.push(`wt:${p}`);
        return { ok: true, dirty: false };
      },
      deleteLocalFn: (b) => {
        order.push(`local:${b}`);
        return { deleted: true, reason: 'deleted' };
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.deepEqual(order, ['wt:/wt/fix-wt', 'local:fix/wt']);
    assert.equal(result.ok, true);
  });

  it('still deletes the local ref when worktree removal fails (Story #3598 decouple)', () => {
    // Ref-reap is decoupled from worktree-reap: the merged ref is deleted
    // even when the directory could not be removed. A non-lock-class
    // worktree failure remains a hard failure on the worktree scope.
    let localDeleted = false;
    const result = executeCleanup({
      candidates: [
        baseCand({
          branch: 'fix/wt',
          hasWorktree: true,
          worktreePath: '/wt/fix-wt',
        }),
      ],
      cwd: '/repo',
      remote: false,
      removeWorktreeFn: () => ({
        ok: false,
        dirty: true,
        lockClass: false,
        stderr: 'boom',
      }),
      deleteLocalFn: () => {
        localDeleted = true;
        return { deleted: true, reason: 'deleted' };
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(localDeleted, true, 'local ref reaped despite worktree fail');
    assert.equal(result.local.length, 1);
    assert.equal(result.local[0].ok, true);
    // Non-lock-class worktree failure is still a hard failure.
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].scope, 'worktree');
    assert.equal(result.deferred.length, 0);
  });

  it('records dirty-but-forced worktrees and continues', () => {
    const warned = [];
    const result = executeCleanup({
      candidates: [
        baseCand({
          branch: 'fix/wt',
          hasWorktree: true,
          worktreePath: '/wt/fix-wt',
        }),
      ],
      cwd: '/repo',
      remote: false,
      removeWorktreeFn: () => ({ ok: true, dirty: true }),
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      logger: { info() {}, warn: (m) => warned.push(m), error() {} },
    });
    assert.equal(result.ok, true);
    assert.equal(result.worktrees[0].dirty, true);
    assert.match(warned[0], /dirty worktree force-removed/);
  });

  it('skips remote reap unless remote=true', () => {
    let remoteCalls = 0;
    const result = executeCleanup({
      candidates: [baseCand({ branch: 'fix/a' })],
      cwd: '/repo',
      remote: false,
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      deleteRemoteFn: () => {
        remoteCalls += 1;
        return { deleted: true, reason: 'deleted' };
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(remoteCalls, 0);
    assert.equal(result.remote.length, 0);
    assert.equal(result.ok, true);
  });

  it('reaps remote when remote=true and reports alreadyGone idempotently', () => {
    const result = executeCleanup({
      candidates: [baseCand({ branch: 'fix/a' })],
      cwd: '/repo',
      remote: true,
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      deleteRemoteFn: () => ({ deleted: true, reason: 'not-found' }),
      pruneRemoteFn: () => ({ ok: true, pruned: [] }),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(result.ok, true);
    assert.equal(result.remote.length, 1);
    assert.equal(result.remote[0].alreadyGone, true);
    assert.equal(result.remote[0].ok, true);
  });

  it('runs `git remote prune` once after remote deletes and surfaces pruned refs', () => {
    let pruneCalls = 0;
    let capturedRemote = null;
    const result = executeCleanup({
      candidates: [
        baseCand({ branch: 'fix/a' }),
        baseCand({ branch: 'fix/b' }),
      ],
      cwd: '/repo',
      remote: true,
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      deleteRemoteFn: () => ({ deleted: true, reason: 'not-found' }),
      pruneRemoteFn: (_cwd, remoteName) => {
        pruneCalls += 1;
        capturedRemote = remoteName;
        return { ok: true, pruned: ['fix/a', 'fix/b'] };
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(pruneCalls, 1, 'prune should run exactly once');
    assert.equal(capturedRemote, 'origin');
    assert.equal(result.ok, true);
    assert.deepEqual(result.prune?.pruned, ['fix/a', 'fix/b']);
    assert.equal(result.prune?.attempted, true);
  });

  it('skips prune when remote=false (no remote attempts made)', () => {
    let pruneCalls = 0;
    const result = executeCleanup({
      candidates: [baseCand({ branch: 'fix/a' })],
      cwd: '/repo',
      remote: false,
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      pruneRemoteFn: () => {
        pruneCalls += 1;
        return { ok: true, pruned: [] };
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(pruneCalls, 0);
    assert.equal(result.prune, null);
  });

  it('skips prune when remote=true but no candidates produced remote attempts', () => {
    // A candidate with no worktree and a remote-only `localExists: false`
    // skips the remote delete, so no remote attempts are produced and
    // prune does not run.
    let pruneCalls = 0;
    const result = executeCleanup({
      candidates: [],
      cwd: '/repo',
      remote: true,
      pruneRemoteFn: () => {
        pruneCalls += 1;
        return { ok: true, pruned: [] };
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(pruneCalls, 0, 'no remote attempts means no prune');
    assert.equal(result.prune, null);
  });

  it('records prune failure into failures[] and flips ok=false', () => {
    const result = executeCleanup({
      candidates: [baseCand({ branch: 'fix/a' })],
      cwd: '/repo',
      remote: true,
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      deleteRemoteFn: () => ({ deleted: true, reason: 'deleted' }),
      pruneRemoteFn: () => ({ ok: false, pruned: [], stderr: 'prune-boom' }),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(result.ok, false);
    const pruneFailure = result.failures.find((f) => f.scope === 'prune');
    assert.ok(pruneFailure, 'expected a prune-scoped failure');
    assert.equal(pruneFailure.stderr, 'prune-boom');
  });

  it('respects a non-default remoteName when pruning', () => {
    let capturedRemote = null;
    executeCleanup({
      candidates: [baseCand({ branch: 'fix/a' })],
      cwd: '/repo',
      remote: true,
      remoteName: 'upstream',
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      deleteRemoteFn: () => ({ deleted: true, reason: 'deleted' }),
      pruneRemoteFn: (_cwd, remoteName) => {
        capturedRemote = remoteName;
        return { ok: true, pruned: [] };
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(capturedRemote, 'upstream');
  });

  it('skips deleteLocalFn for remote-only (localExists: false) candidates', () => {
    let localCalls = 0;
    let remoteCalls = 0;
    const result = executeCleanup({
      candidates: [
        baseCand({
          branch: 'fix/remote-only',
          detectedBy: 'remote-only',
          localExists: false,
        }),
      ],
      cwd: '/repo',
      remote: true,
      deleteLocalFn: () => {
        localCalls += 1;
        return { deleted: false, reason: 'not-found' };
      },
      deleteRemoteFn: () => {
        remoteCalls += 1;
        return { deleted: true, reason: 'deleted' };
      },
      pruneRemoteFn: () => ({ ok: true, pruned: [] }),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(localCalls, 0, 'deleteLocalFn must not run for remote-only');
    assert.equal(remoteCalls, 1, 'deleteRemoteFn still runs');
    assert.equal(result.local.length, 0, 'no local result row for remote-only');
    assert.equal(result.remote.length, 1);
    assert.equal(result.remote[0].ok, true);
    assert.equal(result.ok, true);
  });

  it('still runs prune when remote-only candidates produced remote attempts', () => {
    let pruneCalls = 0;
    const result = executeCleanup({
      candidates: [
        baseCand({
          branch: 'fix/remote-only',
          detectedBy: 'remote-only',
          localExists: false,
        }),
      ],
      cwd: '/repo',
      remote: true,
      deleteLocalFn: () => {
        throw new Error('should not run');
      },
      deleteRemoteFn: () => ({ deleted: true, reason: 'deleted' }),
      pruneRemoteFn: () => {
        pruneCalls += 1;
        return { ok: true, pruned: ['fix/remote-only'] };
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(pruneCalls, 1);
    assert.equal(result.prune?.attempted, true);
  });

  it('aggregates failures across scopes and flips ok=false', () => {
    const result = executeCleanup({
      candidates: [
        baseCand({ branch: 'fix/a' }),
        baseCand({ branch: 'fix/b' }),
      ],
      cwd: '/repo',
      remote: true,
      deleteLocalFn: (b) =>
        b === 'fix/a'
          ? { deleted: true, reason: 'deleted' }
          : { deleted: false, reason: 'error', stderr: 'boom' },
      deleteRemoteFn: () => ({
        deleted: false,
        reason: 'error',
        stderr: 'remote-boom',
      }),
      pruneRemoteFn: () => ({ ok: true, pruned: [] }),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(result.ok, false);
    // fix/a: local ok, remote fail. fix/b: local fail (remote skipped).
    assert.equal(result.failures.length, 2);
    const scopes = result.failures.map((f) => f.scope).sort();
    assert.deepEqual(scopes, ['local', 'remote']);
  });
});

describe('git-cleanup.parsePrunedRefs', () => {
  it('extracts each `- [deleted] (none) -> <remote>/<ref>` line from `git fetch --prune` stderr', () => {
    const stderr = [
      'From https://github.com/example/repo',
      ' - [deleted]           (none)     -> origin/story-1476',
      ' - [deleted]           (none)     -> origin/fix/keep',
    ].join('\n');
    assert.deepEqual(parsePrunedRefs(stderr, 'origin'), [
      'story-1476',
      'fix/keep',
    ]);
  });

  it('extracts each `* [pruned] <remote>/<ref>` line from legacy `git remote prune` output', () => {
    const stdout = [
      'Pruning origin',
      'URL: https://github.com/example/repo.git',
      ' * [pruned] origin/story-1476',
      ' * [pruned] origin/fix/keep',
    ].join('\n');
    assert.deepEqual(parsePrunedRefs(stdout, 'origin'), [
      'story-1476',
      'fix/keep',
    ]);
  });

  it('returns [] when nothing was pruned', () => {
    const stdout = ['Pruning origin', 'URL: https://example.com/repo'].join(
      '\n',
    );
    assert.deepEqual(parsePrunedRefs(stdout, 'origin'), []);
  });

  it('leaves the ref name untouched when it does not start with the remote prefix', () => {
    assert.deepEqual(parsePrunedRefs(' * [pruned] weird/branch', 'origin'), [
      'weird/branch',
    ]);
  });

  it('tolerates empty / null output', () => {
    assert.deepEqual(parsePrunedRefs('', 'origin'), []);
    assert.deepEqual(parsePrunedRefs(null, 'origin'), []);
  });
});

describe('git-cleanup.computeExitCode', () => {
  it('returns 2 when no candidates matched', () => {
    assert.equal(computeExitCode({ candidates: [] }, null), 2);
  });

  it('returns 1 when execute produced failures', () => {
    assert.equal(
      computeExitCode({ candidates: [{ branch: 'fix/a' }] }, { ok: false }),
      1,
    );
  });

  it('returns 0 when execute succeeded', () => {
    assert.equal(
      computeExitCode({ candidates: [{ branch: 'fix/a' }] }, { ok: true }),
      0,
    );
  });

  it('returns 0 on a dry-run with candidates (no result)', () => {
    assert.equal(
      computeExitCode({ candidates: [{ branch: 'fix/a' }] }, null),
      0,
    );
  });
});

describe('git-cleanup.buildJsonEnvelope', () => {
  const plan = {
    candidates: [{ branch: 'fix/a', prNumber: 1, hasWorktree: false }],
    skipped: [{ branch: 'main', reason: 'protected' }],
  };

  it('returns the dry-run shape when no result is provided', () => {
    const env = buildJsonEnvelope({
      dryRun: true,
      baseBranch: 'main',
      plan,
    });
    assert.equal(env.dryRun, true);
    assert.equal(env.baseBranch, 'main');
    assert.deepEqual(env.candidates, plan.candidates);
    assert.deepEqual(env.skipped, plan.skipped);
    assert.deepEqual(env.local, []);
    assert.deepEqual(env.remote, []);
    assert.deepEqual(env.worktrees, []);
    assert.equal(env.prune, null);
    assert.deepEqual(env.failures, []);
    assert.equal(env.ok, true);
  });

  it('passes through executeCleanup result fields when provided', () => {
    const result = {
      worktrees: [{ path: '/wt/a', ok: true, dirty: false }],
      local: [{ branch: 'fix/a', ok: true }],
      remote: [{ branch: 'fix/a', ok: true, alreadyGone: true }],
      prune: {
        attempted: true,
        ok: true,
        remote: 'origin',
        pruned: ['fix/a'],
      },
      failures: [],
      ok: true,
    };
    const env = buildJsonEnvelope({
      dryRun: false,
      baseBranch: 'develop',
      plan,
      result,
    });
    assert.equal(env.dryRun, false);
    assert.equal(env.baseBranch, 'develop');
    assert.deepEqual(env.worktrees, result.worktrees);
    assert.deepEqual(env.local, result.local);
    assert.deepEqual(env.remote, result.remote);
    assert.deepEqual(env.prune, result.prune);
    assert.equal(env.ok, true);
  });

  it('reports ok=false when the result has failures', () => {
    const env = buildJsonEnvelope({
      dryRun: false,
      baseBranch: 'main',
      plan,
      result: {
        worktrees: [],
        local: [],
        remote: [],
        failures: [{ branch: 'fix/a', scope: 'local' }],
        ok: false,
      },
    });
    assert.equal(env.ok, false);
    assert.equal(env.failures.length, 1);
  });

  it('defaults ghDegraded to false when the plan omits it', () => {
    const env = buildJsonEnvelope({ dryRun: true, baseBranch: 'main', plan });
    assert.equal(env.ghDegraded, false);
  });

  it('carries plan.ghDegraded through to the envelope (Story #4395)', () => {
    const env = buildJsonEnvelope({
      dryRun: true,
      baseBranch: 'main',
      plan: { ...plan, ghDegraded: true },
    });
    assert.equal(env.ghDegraded, true);
  });
});

describe('git-cleanup.probeMergedPr', () => {
  it('returns the PR row when gh returns a non-empty merged array', () => {
    const out = probeMergedPr('fix/a', '/repo', () =>
      JSON.stringify([{ number: 42, mergedAt: '2026-05-01T00:00:00Z' }]),
    );
    assert.deepEqual(out, { number: 42, mergedAt: '2026-05-01T00:00:00Z' });
  });

  it('returns null when gh returns an empty array', () => {
    const out = probeMergedPr('fix/a', '/repo', () => '[]');
    assert.equal(out, null);
  });

  it('returns null when gh returns an empty / whitespace string', () => {
    assert.equal(
      probeMergedPr('fix/a', '/repo', () => ''),
      null,
    );
    assert.equal(
      probeMergedPr('fix/a', '/repo', () => '   '),
      null,
    );
  });

  it('returns null on malformed JSON (does not throw)', () => {
    assert.equal(
      probeMergedPr('fix/a', '/repo', () => '{not json'),
      null,
    );
  });

  it('coerces a missing mergedAt to null', () => {
    const out = probeMergedPr('fix/a', '/repo', () =>
      JSON.stringify([{ number: 7 }]),
    );
    assert.deepEqual(out, { number: 7, mergedAt: null });
  });

  it('coerces a non-numeric number field to 0', () => {
    const out = probeMergedPr('fix/a', '/repo', () =>
      JSON.stringify([{ number: 'abc', mergedAt: null }]),
    );
    assert.equal(out.number, 0);
  });

  it('passes the correct gh argv (head=branch, state=merged, json fields)', () => {
    let captured;
    probeMergedPr('feat/x', '/cwd', (args, { cwd }) => {
      captured = { args, cwd };
      return '[]';
    });
    assert.equal(captured.cwd, '/cwd');
    assert.deepEqual(captured.args, [
      'pr',
      'list',
      '--head',
      'feat/x',
      '--state',
      'merged',
      '--json',
      'number,mergedAt',
      '--limit',
      '1',
    ]);
  });
});

describe('git-cleanup renderers', () => {
  it('renderDryRun lists candidates with PR number + worktree note', () => {
    const lines = renderDryRun({
      candidates: [
        {
          branch: 'fix/a',
          prNumber: 1471,
          hasWorktree: true,
          worktreePath: '/wt/fix-a',
          detectedBy: 'gh',
        },
      ],
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /DRY RUN \(nothing deleted\) — 1 candidate/);
    assert.match(lines[1], /fix\/a — PR #1471 \(worktree: \/wt\/fix-a\)/);
  });

  it('renderDryRun says "no merged branches" when empty', () => {
    const lines = renderDryRun({ candidates: [] });
    assert.match(lines[1], /no merged branches to clean up/);
  });

  it('renderDryRun promises "nothing deleted" unless the caller opts into execute', () => {
    const plan = { candidates: [{ branch: 'fix/a', prNumber: 1 }] };
    assert.match(
      renderDryRun(plan)[0],
      /DRY RUN \(nothing deleted\) — 1 candidate\(s\)/,
    );
    assert.match(
      renderDryRun(plan, { execute: true })[0],
      /EXECUTE — 1 candidate\(s\) to reap/,
    );
  });

  it('renderDryRun marks remote-only candidates with a (remote-only) note', () => {
    const lines = renderDryRun({
      candidates: [
        {
          branch: 'fix/remote-only',
          prNumber: 99,
          hasWorktree: false,
          worktreePath: null,
          detectedBy: 'remote-only',
          localExists: false,
        },
      ],
    });
    assert.match(lines[1], /fix\/remote-only — PR #99 \(remote-only\)/);
  });

  it('renderDryRun emits a current-head remediation hint with the base branch', () => {
    const lines = renderDryRun(
      {
        candidates: [],
        skipped: [{ branch: 'feat/wip', reason: 'current-head' }],
      },
      { baseBranch: 'main' },
    );
    const hint = lines.find((l) => /current HEAD/.test(l));
    assert.ok(hint, 'expected a current-head hint line');
    assert.match(hint, /feat\/wip/);
    assert.match(hint, /checkout main first/);
  });

  it('renderDryRun falls back to a generic checkout hint when baseBranch is omitted', () => {
    const lines = renderDryRun({
      candidates: [],
      skipped: [{ branch: 'feat/wip', reason: 'current-head' }],
    });
    const hint = lines.find((l) => /current HEAD/.test(l));
    assert.ok(hint);
    assert.match(hint, /checkout the base branch first/);
  });

  it('renderDryRun does not emit a current-head hint when no current-head skip is present', () => {
    const lines = renderDryRun(
      {
        candidates: [],
        skipped: [{ branch: 'main', reason: 'protected' }],
      },
      { baseBranch: 'main' },
    );
    const hint = lines.find((l) => /current HEAD/.test(l));
    assert.equal(hint, undefined);
  });

  it('renderExecutionLine annotates already-gone remote', () => {
    const out = renderExecutionLine(
      { branch: 'fix/a', ok: true, alreadyGone: true },
      'remote',
    );
    assert.match(out, /✅/);
    assert.match(out, /already gone/);
  });

  it('renderExecutionLine annotates forced-dirty worktree', () => {
    const out = renderExecutionLine(
      { path: '/wt/fix-a', ok: true, dirty: true },
      'worktree',
    );
    assert.match(out, /forced — was dirty/);
  });

  it('renderExecutionSummary reports success counts when ok', () => {
    const out = renderExecutionSummary({
      ok: true,
      local: [1, 2],
      remote: [1],
      worktrees: [1],
      prune: null,
      failures: [],
    });
    assert.match(out, /Reaped 2 local \+ 1 remote \+ 1 worktree/);
  });

  it('renderExecutionSummary appends stale-tracking-ref count when prune dropped some', () => {
    const out = renderExecutionSummary({
      ok: true,
      local: [1],
      remote: [1],
      worktrees: [],
      prune: {
        attempted: true,
        ok: true,
        remote: 'origin',
        pruned: ['a', 'b'],
      },
      failures: [],
    });
    assert.match(out, /2 stale tracking ref/);
  });

  it('renderPruneLine returns null when no prune was attempted', () => {
    assert.equal(renderPruneLine(null), null);
    assert.equal(renderPruneLine({ attempted: false }), null);
  });

  it('renderPruneLine reports "no stale refs" when pruned[] is empty', () => {
    const out = renderPruneLine({
      attempted: true,
      ok: true,
      remote: 'origin',
      pruned: [],
    });
    assert.match(out, /no stale refs/);
  });

  it('renderPruneLine lists dropped refs prefixed with the remote name', () => {
    const out = renderPruneLine({
      attempted: true,
      ok: true,
      remote: 'origin',
      pruned: ['story-1476', 'fix/keep'],
    });
    assert.match(out, /dropped 2 stale ref/);
    assert.match(out, /origin\/story-1476/);
    assert.match(out, /origin\/fix\/keep/);
  });

  it('renderPruneLine flags failure with the stderr message', () => {
    const out = renderPruneLine({
      attempted: true,
      ok: false,
      remote: 'origin',
      pruned: [],
      stderr: 'fatal: no such remote',
    });
    assert.match(out, /❌/);
    assert.match(out, /fatal: no such remote/);
  });

  it('renderExecutionSummary reports failure count when not ok', () => {
    const out = renderExecutionSummary({
      ok: false,
      local: [],
      remote: [],
      worktrees: [],
      failures: [{}, {}],
    });
    assert.match(out, /2 failure\(s\)/);
  });
});

describe('git-cleanup.planFastForward', () => {
  const baseCtx = (overrides) => ({
    cwd: '/repo',
    baseBranch: 'main',
    isCleanFn: () => true,
    currentBranchFn: () => 'main',
    fetchFn: () => ({ ok: true }),
    canFastForwardFn: () => ({ ok: true, behind: 3 }),
    ...overrides,
  });

  it('returns runnable when tree is clean and remote is ahead', () => {
    const plan = planFastForward(baseCtx());
    assert.equal(plan.runnable, true);
    assert.equal(plan.behind, 3);
    assert.equal(plan.currentBranch, 'main');
  });

  it('returns dirty-tree when the working tree is not clean', () => {
    const plan = planFastForward(baseCtx({ isCleanFn: () => false }));
    assert.equal(plan.runnable, false);
    assert.equal(plan.reason, 'dirty-tree');
  });

  it('returns not-fast-forward when local has diverged commits', () => {
    const plan = planFastForward(
      baseCtx({
        canFastForwardFn: () => ({
          ok: false,
          behind: 1,
          reason: 'not-fast-forward',
        }),
      }),
    );
    assert.equal(plan.runnable, false);
    assert.equal(plan.reason, 'not-fast-forward');
  });

  it('returns already-up-to-date when behind=0', () => {
    const plan = planFastForward(
      baseCtx({ canFastForwardFn: () => ({ ok: true, behind: 0 }) }),
    );
    assert.equal(plan.runnable, false);
    assert.equal(plan.reason, 'already-up-to-date');
    assert.equal(plan.behind, 0);
  });

  it('returns fetch-failed when the remote fetch errors', () => {
    const plan = planFastForward(
      baseCtx({ fetchFn: () => ({ ok: false, stderr: 'no remote' }) }),
    );
    assert.equal(plan.runnable, false);
    assert.equal(plan.reason, 'fetch-failed');
  });
});

describe('git-cleanup.executeFastForward', () => {
  const runnablePlan = (overrides) => ({
    runnable: true,
    behind: 2,
    currentBranch: 'main',
    ...overrides,
  });

  it('reports skipped without mutating when plan.runnable=false', () => {
    let merged = false;
    const res = executeFastForward({
      cwd: '/repo',
      baseBranch: 'main',
      plan: { runnable: false, reason: 'dirty-tree' },
      checkoutFn: () => ({ ok: true }),
      mergeFn: () => {
        merged = true;
        return { ok: true };
      },
      logger: { info() {}, warn() {} },
    });
    assert.equal(res.ok, true);
    assert.equal(res.applied, false);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'dirty-tree');
    assert.equal(merged, false);
  });

  it('checks out base when current branch differs, merges, then restores the branch', () => {
    // The checkout is a means to run `merge --ff-only`, not a licence to
    // relocate the operator: this phase runs from the MAIN checkout, which
    // may be parked on unrelated work, and the close tail can reach it long
    // after the operator walked away.
    const order = [];
    const res = executeFastForward({
      cwd: '/repo',
      baseBranch: 'main',
      plan: runnablePlan({ currentBranch: 'story-1' }),
      checkoutFn: (_c, b) => {
        order.push(`checkout:${b}`);
        return { ok: true };
      },
      mergeFn: (_c, ref) => {
        order.push(`merge:${ref}`);
        return { ok: true };
      },
      logger: { info() {}, warn() {} },
    });
    assert.equal(res.applied, true);
    assert.deepEqual(order, [
      'checkout:main',
      'merge:origin/main',
      'checkout:story-1',
    ]);
  });

  it('restores the original branch even when the merge fails', () => {
    const order = [];
    const res = executeFastForward({
      cwd: '/repo',
      baseBranch: 'main',
      plan: runnablePlan({ currentBranch: 'story-1' }),
      checkoutFn: (_c, b) => {
        order.push(`checkout:${b}`);
        return { ok: true };
      },
      mergeFn: () => ({ ok: false, stderr: 'diverged' }),
      logger: { info() {}, warn() {} },
    });
    assert.equal(res.ok, false);
    assert.deepEqual(order, ['checkout:main', 'checkout:story-1']);
  });

  it('keeps the fast-forward successful when the restore checkout fails', () => {
    // The base branch IS fast-forwarded at this point; a failed restore is a
    // warning, not a reason to report the phase as failed.
    const warnings = [];
    const res = executeFastForward({
      cwd: '/repo',
      baseBranch: 'main',
      plan: runnablePlan({ currentBranch: 'story-1' }),
      checkoutFn: (_c, b) =>
        b === 'main' ? { ok: true } : { ok: false, stderr: 'gone' },
      mergeFn: () => ({ ok: true }),
      logger: { info() {}, warn: (m) => warnings.push(m) },
    });
    assert.equal(res.ok, true);
    assert.equal(res.applied, true);
    assert.ok(warnings.some((w) => /restoring story-1 failed/.test(w)));
  });

  it('skips checkout when already on base branch', () => {
    let checkoutCalls = 0;
    executeFastForward({
      cwd: '/repo',
      baseBranch: 'main',
      plan: runnablePlan({ currentBranch: 'main' }),
      checkoutFn: () => {
        checkoutCalls += 1;
        return { ok: true };
      },
      mergeFn: () => ({ ok: true }),
      logger: { info() {}, warn() {} },
    });
    assert.equal(checkoutCalls, 0);
  });

  it('reports merge-failed and ok=false when --ff-only fails', () => {
    const res = executeFastForward({
      cwd: '/repo',
      baseBranch: 'main',
      plan: runnablePlan(),
      checkoutFn: () => ({ ok: true }),
      mergeFn: () => ({ ok: false, stderr: 'not a fast-forward' }),
      logger: { info() {}, warn() {} },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'merge-failed');
  });
});

describe('git-cleanup.executePrune', () => {
  it('returns the pruned refs from the injected pruner', () => {
    const res = executePrune({
      cwd: '/repo',
      pruneFn: () => ({ ok: true, pruned: ['a', 'b'] }),
      logger: { info() {}, warn() {} },
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.pruned, ['a', 'b']);
    assert.equal(res.remote, 'origin');
    assert.equal(res.attempted, true);
  });

  it('surfaces pruner failure with stderr', () => {
    const res = executePrune({
      cwd: '/repo',
      pruneFn: () => ({ ok: false, pruned: [], stderr: 'boom' }),
      logger: { info() {}, warn() {} },
    });
    assert.equal(res.ok, false);
    assert.equal(res.stderr, 'boom');
  });

  it('respects a non-default remoteName', () => {
    let capturedRemote = null;
    executePrune({
      cwd: '/repo',
      remoteName: 'upstream',
      pruneFn: (_c, r) => {
        capturedRemote = r;
        return { ok: true, pruned: [] };
      },
      logger: { info() {}, warn() {} },
    });
    assert.equal(capturedRemote, 'upstream');
  });
});

describe('git-cleanup.parseStashList', () => {
  it('parses ref|createdAt|message rows', () => {
    const stdout = [
      'stash@{0}|2026-05-15 10:00:00 -0500|WIP on story-1: abc',
      'stash@{1}|2026-05-14 09:00:00 -0500|On main: scratch',
    ].join('\n');
    const out = parseStashList(stdout);
    assert.equal(out.length, 2);
    assert.equal(out[0].ref, 'stash@{0}');
    assert.equal(out[0].createdAt, '2026-05-15 10:00:00 -0500');
    assert.equal(out[0].message, 'WIP on story-1: abc');
  });

  it('skips malformed rows and empty input', () => {
    assert.deepEqual(parseStashList(''), []);
    assert.deepEqual(parseStashList(null), []);
    assert.deepEqual(parseStashList('no-pipes-here'), []);
  });

  it('handles messages containing pipe characters', () => {
    const out = parseStashList('stash@{0}|2026-05-15|WIP: a | b | c');
    assert.equal(out[0].message, 'WIP: a | b | c');
  });
});

describe('git-cleanup.stashRefIndex', () => {
  it('extracts the numeric index from stash@{N}', () => {
    assert.equal(stashRefIndex('stash@{0}'), 0);
    assert.equal(stashRefIndex('stash@{42}'), 42);
  });

  it('returns -1 for unparseable refs', () => {
    assert.equal(stashRefIndex(''), -1);
    assert.equal(stashRefIndex(null), -1);
    assert.equal(stashRefIndex('not-a-stash'), -1);
  });
});

describe('git-cleanup.planStashes', () => {
  it('returns the stash list from the injected lister', () => {
    const out = planStashes({
      cwd: '/repo',
      stashListerFn: () => [{ ref: 'stash@{0}', createdAt: 't', message: 'm' }],
    });
    assert.equal(out.stashes.length, 1);
    assert.equal(out.stashes[0].ref, 'stash@{0}');
  });
});

describe('git-cleanup.buildAllowlistDecider', () => {
  it('drops refs that appear in the allowlist, keeps others', () => {
    const decide = buildAllowlistDecider(['stash@{0}', 'stash@{2}']);
    assert.equal(decide({ ref: 'stash@{0}' }), 'drop');
    assert.equal(decide({ ref: 'stash@{1}' }), 'keep');
    assert.equal(decide({ ref: 'stash@{2}' }), 'drop');
  });

  it('keeps everything when the allowlist is empty', () => {
    const decide = buildAllowlistDecider([]);
    assert.equal(decide({ ref: 'stash@{0}' }), 'keep');
  });
});

describe('git-cleanup.executeStashes', () => {
  const stashes = [
    { ref: 'stash@{0}', createdAt: 't0', message: 'm0' },
    { ref: 'stash@{1}', createdAt: 't1', message: 'm1' },
    { ref: 'stash@{2}', createdAt: 't2', message: 'm2' },
  ];

  it('drops stashes high-index-first so indices stay stable', () => {
    const order = [];
    executeStashes({
      cwd: '/repo',
      stashes,
      decideFn: () => 'drop',
      dropFn: (ref) => {
        order.push(ref);
        return { ok: true };
      },
      logger: { info() {}, warn() {} },
    });
    assert.deepEqual(order, ['stash@{2}', 'stash@{1}', 'stash@{0}']);
  });

  it('honours per-stash keep decisions without calling dropFn', () => {
    let dropCalls = 0;
    const res = executeStashes({
      cwd: '/repo',
      stashes,
      decideFn: (s) => (s.ref === 'stash@{1}' ? 'drop' : 'keep'),
      dropFn: () => {
        dropCalls += 1;
        return { ok: true };
      },
      logger: { info() {}, warn() {} },
    });
    assert.equal(dropCalls, 1);
    assert.equal(res.actions.filter((a) => a.action === 'drop').length, 1);
    assert.equal(res.actions.filter((a) => a.action === 'keep').length, 2);
  });

  it('short-circuits the loop on a quit decision', () => {
    let dropCalls = 0;
    const res = executeStashes({
      cwd: '/repo',
      stashes,
      decideFn: (s) => (s.ref === 'stash@{2}' ? 'quit' : 'drop'),
      dropFn: () => {
        dropCalls += 1;
        return { ok: true };
      },
      logger: { info() {}, warn() {} },
    });
    assert.equal(dropCalls, 0);
    assert.equal(
      res.actions.every((a) => a.action === 'quit'),
      true,
    );
  });

  it('records drop failures and flips ok=false', () => {
    const res = executeStashes({
      cwd: '/repo',
      stashes: [stashes[0]],
      decideFn: () => 'drop',
      dropFn: () => ({ ok: false, stderr: 'boom' }),
      logger: { info() {}, warn() {} },
    });
    assert.equal(res.ok, false);
    assert.equal(res.failures.length, 1);
    assert.equal(res.failures[0].ref, 'stash@{0}');
  });

  it('routes --drop-stashes <ref> through the allowlist decider', () => {
    const decide = buildAllowlistDecider(['stash@{1}']);
    let dropped = null;
    executeStashes({
      cwd: '/repo',
      stashes,
      decideFn: decide,
      dropFn: (ref) => {
        dropped = ref;
        return { ok: true };
      },
      logger: { info() {}, warn() {} },
    });
    assert.equal(dropped, 'stash@{1}');
  });
});

describe('git-cleanup.computeExitCode multi-phase', () => {
  it('returns 1 when any phase reports a failure', () => {
    assert.equal(
      computeExitCode({
        fastForward: { ok: false },
        prune: { ok: true, pruned: [] },
      }),
      1,
    );
    assert.equal(
      computeExitCode({
        stashes: { ok: false, actions: [] },
      }),
      1,
    );
  });

  it('returns 2 when no phase produced work and none failed', () => {
    const code = computeExitCode({
      fastForward: { ok: true, applied: false },
      prune: { ok: true, pruned: [] },
      branchesPlan: { candidates: [] },
      stashes: { ok: true, actions: [{ action: 'keep' }] },
    });
    assert.equal(code, 2);
  });

  it('returns 0 when at least one phase produced work', () => {
    const code = computeExitCode({
      fastForward: { ok: true, applied: true },
    });
    assert.equal(code, 0);
  });

  it('returns 0 when stashes were dropped', () => {
    const code = computeExitCode({
      stashes: {
        ok: true,
        actions: [{ action: 'drop', dropped: true }],
      },
    });
    assert.equal(code, 0);
  });

  it('returns 0 when prune dropped stale refs', () => {
    const code = computeExitCode({
      prune: { ok: true, pruned: ['stale'] },
    });
    assert.equal(code, 0);
  });
});

describe('git-cleanup.buildJsonEnvelope multi-phase', () => {
  it('surfaces fastForward, prune, and stashes blocks in the envelope', () => {
    const env = buildJsonEnvelope({
      dryRun: false,
      baseBranch: 'main',
      plan: { candidates: [], skipped: [] },
      fastForward: { ok: true, applied: true, behind: 2 },
      prune: { ok: true, attempted: true, remote: 'origin', pruned: ['a'] },
      stashes: { ok: true, actions: [{ ref: 'stash@{0}', action: 'keep' }] },
    });
    assert.equal(env.fastForward.applied, true);
    assert.equal(env.prune.pruned[0], 'a');
    assert.equal(env.stashes.actions[0].ref, 'stash@{0}');
  });
});

describe('git-cleanup.probeLatestPr', () => {
  it('passes the correct gh argv (state=all, json fields include state + headRefOid)', () => {
    let captured;
    probeLatestPr('feat/x', '/cwd', (args, { cwd }) => {
      captured = { args, cwd };
      return '[]';
    });
    assert.equal(captured.cwd, '/cwd');
    assert.deepEqual(captured.args, [
      'pr',
      'list',
      '--head',
      'feat/x',
      '--state',
      'all',
      '--json',
      'number,state,mergedAt,closedAt,headRefOid',
      '--limit',
      '1',
    ]);
  });

  it('returns null when gh returns an empty array', () => {
    assert.equal(
      probeLatestPr('fix/a', '/repo', () => '[]'),
      null,
    );
  });

  it('returns null when gh returns an empty / whitespace string', () => {
    assert.equal(
      probeLatestPr('fix/a', '/repo', () => ''),
      null,
    );
    assert.equal(
      probeLatestPr('fix/a', '/repo', () => '   '),
      null,
    );
  });

  it('returns null on malformed JSON (does not throw)', () => {
    assert.equal(
      probeLatestPr('fix/a', '/repo', () => '{not json'),
      null,
    );
  });

  it('returns the latest MERGED row with headRefOid for the tip cross-check', () => {
    const out = probeLatestPr('fix/a', '/repo', () =>
      JSON.stringify([
        {
          number: 42,
          state: 'MERGED',
          mergedAt: '2026-05-18T15:24:18Z',
          closedAt: '2026-05-18T15:24:18Z',
          headRefOid: '4c1a9798e2e44a642349ecf79f4a4fc9c682f088',
        },
      ]),
    );
    assert.deepEqual(out, {
      number: 42,
      state: 'MERGED',
      mergedAt: '2026-05-18T15:24:18Z',
      closedAt: '2026-05-18T15:24:18Z',
      headRefOid: '4c1a9798e2e44a642349ecf79f4a4fc9c682f088',
    });
  });

  it('preserves CLOSED-not-merged rows so the planner can skip them', () => {
    const out = probeLatestPr('release-please/foo', '/repo', () =>
      JSON.stringify([
        {
          number: 2456,
          state: 'CLOSED',
          mergedAt: null,
          closedAt: '2026-05-18T16:01:24Z',
          headRefOid: 'abc1234567890',
        },
      ]),
    );
    assert.equal(out.state, 'CLOSED');
    assert.equal(out.mergedAt, null);
    assert.equal(out.closedAt, '2026-05-18T16:01:24Z');
  });

  it('preserves OPEN rows so the planner can skip them', () => {
    const out = probeLatestPr('feat/in-progress', '/repo', () =>
      JSON.stringify([
        {
          number: 9,
          state: 'OPEN',
          mergedAt: null,
          closedAt: null,
          headRefOid: 'def4567890abc',
        },
      ]),
    );
    assert.equal(out.state, 'OPEN');
  });

  it('coerces missing optional fields to null', () => {
    const out = probeLatestPr('fix/a', '/repo', () =>
      JSON.stringify([{ number: 7, state: 'MERGED' }]),
    );
    assert.equal(out.mergedAt, null);
    assert.equal(out.closedAt, null);
    assert.equal(out.headRefOid, null);
  });
});

describe('git-cleanup.classifyLatestPr (four-state matrix)', () => {
  const baseArgs = (overrides = {}) => ({
    branch: 'fix/a',
    cwd: '/repo',
    remoteName: 'origin',
    localExists: true,
    branchTipShaFn: () => null,
    // Placeholder SHAs never resolve against a real object DB, so every
    // case injects its ancestry outcome rather than letting the default
    // probe spawn git and fail closed to `unverifiable`.
    ancestryFn: () => ({ outcome: 'not-ancestor' }),
    ...overrides,
  });

  it('returns no-pr when prInfo is null', () => {
    const v = classifyLatestPr({ ...baseArgs(), prInfo: null });
    assert.equal(v.kind, 'no-pr');
  });

  it('emits skip with latest-pr-open for OPEN PRs', () => {
    const v = classifyLatestPr({
      ...baseArgs(),
      prInfo: { number: 9, state: 'OPEN' },
    });
    assert.equal(v.kind, 'skip');
    assert.equal(v.reason, 'latest-pr-open');
    assert.equal(v.prNumber, 9);
  });

  it('emits skip with latest-pr-closed-not-merged for CLOSED PRs', () => {
    const v = classifyLatestPr({
      ...baseArgs(),
      prInfo: { number: 2456, state: 'CLOSED' },
    });
    assert.equal(v.kind, 'skip');
    assert.equal(v.reason, 'latest-pr-closed-not-merged');
    assert.equal(v.prNumber, 2456);
  });

  it('emits candidate for MERGED PR when tip matches headRefOid', () => {
    const v = classifyLatestPr({
      ...baseArgs({ branchTipShaFn: () => 'abc1234' }),
      prInfo: { number: 1, state: 'MERGED', headRefOid: 'abc1234' },
    });
    assert.equal(v.kind, 'candidate');
    assert.equal(v.prInfo.number, 1);
  });

  it('emits skip with tip-diverged-from-merge when MERGED but tip moved', () => {
    const v = classifyLatestPr({
      ...baseArgs({
        branchTipShaFn: () => 'newshaXYZ',
        ancestryFn: () => ({ outcome: 'not-ancestor' }),
      }),
      prInfo: {
        number: 2447,
        state: 'MERGED',
        headRefOid: 'mergedshaABC',
      },
    });
    assert.equal(v.kind, 'skip');
    assert.equal(v.reason, 'tip-diverged-from-merge');
    assert.equal(v.tipSha, 'newshaXYZ');
    assert.equal(v.mergedSha, 'mergedshaABC');
  });

  it('emits candidate when MERGED row has no headRefOid (tip check skipped)', () => {
    const v = classifyLatestPr({
      ...baseArgs(),
      prInfo: { number: 1, state: 'MERGED', headRefOid: null },
    });
    assert.equal(v.kind, 'candidate');
  });

  it('treats legacy prInfo without state as MERGED for backwards compatibility', () => {
    const v = classifyLatestPr({
      ...baseArgs(),
      prInfo: { number: 1, mergedAt: '2026-05-01T00:00:00Z' },
    });
    assert.equal(v.kind, 'candidate');
  });

  it('emits skip with latest-pr-unknown-state for unrecognized states', () => {
    const v = classifyLatestPr({
      ...baseArgs(),
      prInfo: { number: 1, state: 'WEIRD' },
    });
    assert.equal(v.kind, 'skip');
    assert.equal(v.reason, 'latest-pr-unknown-state');
  });
});

describe('git-cleanup.probeAncestry (tri-state, fails closed)', () => {
  const spawnStub =
    (plan) =>
    (_cwd, ...args) => {
      if (args[0] === 'rev-parse') {
        return (
          plan.revParse?.(args.at(-1)) ?? { status: 0, stdout: '', stderr: '' }
        );
      }
      return plan.isAncestor ?? { status: 0, stdout: '', stderr: '' };
    };

  it('maps git exit 0 to ancestor', () => {
    const out = probeAncestry({
      cwd: '/repo',
      ancestorSha: 'aaaaaaa',
      descendantSha: 'bbbbbbb',
      spawn: spawnStub({ isAncestor: { status: 0, stdout: '', stderr: '' } }),
    });
    assert.deepEqual(out, { outcome: 'ancestor' });
  });

  it('maps git exit 1 to not-ancestor', () => {
    const out = probeAncestry({
      cwd: '/repo',
      ancestorSha: 'aaaaaaa',
      descendantSha: 'bbbbbbb',
      spawn: spawnStub({ isAncestor: { status: 1, stdout: '', stderr: '' } }),
    });
    assert.deepEqual(out, { outcome: 'not-ancestor' });
  });

  it('maps git exit 128 to error, never to not-ancestor', () => {
    const out = probeAncestry({
      cwd: '/repo',
      ancestorSha: 'aaaaaaa',
      descendantSha: 'bbbbbbb',
      spawn: spawnStub({
        isAncestor: {
          status: 128,
          stdout: '',
          stderr: 'fatal: Not a valid commit name bbbbbbb\n',
        },
      }),
    });
    assert.equal(out.outcome, 'error');
    assert.notEqual(out.outcome, 'not-ancestor');
    assert.match(out.reason, /Not a valid commit name/);
  });

  it('fails closed when the merged SHA is absent from the local object DB', () => {
    const seen = [];
    const out = probeAncestry({
      cwd: '/repo',
      ancestorSha: 'aaaaaaa',
      descendantSha: 'deadbee',
      spawn: (_cwd, ...args) => {
        seen.push(args[0]);
        if (args[0] === 'rev-parse') {
          return args.at(-1).startsWith('deadbee')
            ? { status: 1, stdout: '', stderr: '' }
            : { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(out.outcome, 'error');
    assert.match(out.reason, /unresolvable rev deadbee/);
    // The guard runs BEFORE the comparison — a missing rev never reaches
    // `merge-base`, whose empty-stdout 128 is what misreads as "no delta".
    assert.ok(
      !seen.includes('merge-base'),
      'merge-base must not run once a rev fails to resolve',
    );
  });

  it('guards both revs with rev-parse before comparing', () => {
    const verified = [];
    probeAncestry({
      cwd: '/repo',
      ancestorSha: 'aaaaaaa',
      descendantSha: 'bbbbbbb',
      spawn: (_cwd, ...args) => {
        if (args[0] === 'rev-parse') verified.push(args.at(-1));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(verified, ['aaaaaaa^{commit}', 'bbbbbbb^{commit}']);
  });
});

describe('git-cleanup.classifyLatestPr ancestry taxonomy', () => {
  const args = (ancestryFn) => ({
    branch: 'story-1',
    cwd: '/repo',
    remoteName: 'origin',
    localExists: true,
    branchTipShaFn: () => 'tipsha1',
    ancestryFn,
    prInfo: { number: 1840, state: 'MERGED', headRefOid: 'mergedsha1' },
  });

  it('reaps a tip that is a strict ancestor of the merged head', () => {
    const v = classifyLatestPr(args(() => ({ outcome: 'ancestor' })));
    assert.equal(v.kind, 'candidate');
    assert.equal(v.reason, 'tip-behind-merge');
    assert.equal(v.tipSha, 'tipsha1');
    assert.equal(v.mergedSha, 'mergedsha1');
  });

  it('keeps the force-push skip when the tip is not an ancestor', () => {
    const v = classifyLatestPr(args(() => ({ outcome: 'not-ancestor' })));
    assert.equal(v.kind, 'skip');
    assert.equal(v.reason, 'tip-diverged-from-merge');
  });

  it('skips unverifiable — not tip-diverged — when ancestry errors', () => {
    const v = classifyLatestPr(
      args(() => ({ outcome: 'error', reason: 'unresolvable rev mergedsha1' })),
    );
    assert.equal(v.kind, 'skip');
    assert.equal(v.reason, 'unverifiable');
    assert.notEqual(v.reason, 'tip-diverged-from-merge');
    assert.equal(v.detail, 'unresolvable rev mergedsha1');
    assert.equal(v.prNumber, 1840);
  });

  it('passes the tip and merged head to the probe in ancestor->descendant order', () => {
    let seen = null;
    classifyLatestPr(
      args((a) => {
        seen = a;
        return { outcome: 'ancestor' };
      }),
    );
    assert.equal(seen.ancestorSha, 'tipsha1');
    assert.equal(seen.descendantSha, 'mergedsha1');
    assert.equal(seen.cwd, '/repo');
  });
});

describe('git-cleanup.planCleanup latest-PR-state integration', () => {
  const baseCtx = (overrides) => ({
    cwd: '/repo',
    baseBranch: 'main',
    localLister: () => [],
    mergedLister: () => [],
    currentBranchFn: () => 'main',
    protectedConfigFn: () => [],
    worktreesFn: () => new Map(),
    prProbe: () => null,
    branchTipShaFn: () => null,
    filter: () => true,
    ...overrides,
  });

  it('reaps a MERGED-latest branch when the tip matches headRefOid', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['release-please/foo'],
        prProbe: () => ({
          number: 2447,
          state: 'MERGED',
          mergedAt: '2026-05-18T15:24:18Z',
          headRefOid: 'sha-merged',
        }),
        branchTipShaFn: () => 'sha-merged',
      }),
    );
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].branch, 'release-please/foo');
    assert.equal(plan.candidates[0].prNumber, 2447);
  });

  it('skips a MERGED-latest branch with tip-diverged-from-merge when tip moved', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['release-please/foo'],
        prProbe: () => ({
          number: 2447,
          state: 'MERGED',
          headRefOid: 'sha-merged',
        }),
        branchTipShaFn: () => 'sha-newer',
        ancestryFn: () => ({ outcome: 'not-ancestor' }),
      }),
    );
    assert.equal(plan.candidates.length, 0);
    const skip = plan.skipped.find(
      (s) => s.reason === 'tip-diverged-from-merge',
    );
    assert.ok(skip, 'expected a tip-diverged-from-merge skip');
    assert.equal(skip.branch, 'release-please/foo');
    assert.equal(skip.tipSha, 'sha-newer');
    assert.equal(skip.mergedSha, 'sha-merged');
  });

  it('reaps a MERGED-latest branch whose tip is behind the merged head', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['story-1840'],
        prProbe: () => ({
          number: 1840,
          state: 'MERGED',
          mergedAt: '2026-08-27T10:00:00Z',
          headRefOid: 'sha-merged',
        }),
        branchTipShaFn: () => 'sha-stale',
        ancestryFn: () => ({ outcome: 'ancestor' }),
      }),
    );
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].branch, 'story-1840');
    assert.equal(plan.candidates[0].prNumber, 1840);
    assert.equal(plan.candidates[0].behindMerge, true);
  });

  it('marks a tip-matching candidate as not behind the merged head', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['story-1841'],
        prProbe: () => ({
          number: 1841,
          state: 'MERGED',
          headRefOid: 'sha-merged',
        }),
        branchTipShaFn: () => 'sha-merged',
      }),
    );
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].behindMerge, false);
  });

  it('skips as unverifiable when the merged head is absent locally', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['story-1842'],
        prProbe: () => ({
          number: 1842,
          state: 'MERGED',
          headRefOid: 'sha-gone',
        }),
        branchTipShaFn: () => 'sha-stale',
        ancestryFn: () => ({
          outcome: 'error',
          reason: 'unresolvable rev sha-gone',
        }),
      }),
    );
    assert.equal(plan.candidates.length, 0);
    const skip = plan.skipped.find((sk) => sk.reason === 'unverifiable');
    assert.ok(skip, 'expected an unverifiable skip');
    assert.equal(skip.branch, 'story-1842');
    assert.equal(skip.detail, 'unresolvable rev sha-gone');
    assert.equal(
      plan.skipped.find((sk) => sk.reason === 'tip-diverged-from-merge'),
      undefined,
      'an unresolvable merged head must never be labelled a force-push',
    );
  });

  it('skips a CLOSED-not-merged branch (the 2026-05-18 release-please case)', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['release-please/foo'],
        prProbe: () => ({
          number: 2456,
          state: 'CLOSED',
          mergedAt: null,
          closedAt: '2026-05-18T16:01:24Z',
        }),
      }),
    );
    assert.equal(plan.candidates.length, 0);
    const skip = plan.skipped.find(
      (s) => s.reason === 'latest-pr-closed-not-merged',
    );
    assert.ok(skip, 'expected a latest-pr-closed-not-merged skip');
    assert.equal(skip.prNumber, 2456);
  });

  it('skips an OPEN-latest branch with latest-pr-open', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['feat/in-progress'],
        prProbe: () => ({ number: 9, state: 'OPEN' }),
      }),
    );
    assert.equal(plan.candidates.length, 0);
    const skip = plan.skipped.find((s) => s.reason === 'latest-pr-open');
    assert.ok(skip);
  });

  it('git-merged fallback still works when no PR row exists', () => {
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['fix/no-pr'],
        mergedLister: () => ['fix/no-pr'],
        prProbe: () => null,
      }),
    );
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].detectedBy, 'git-merged');
  });

  it('remote-only walk also applies the latest-PR-state matrix', () => {
    const plan = planCleanup(
      baseCtx({
        includeRemoteOnly: true,
        localLister: () => [],
        remoteLister: () => [
          'release-please/foo',
          'release-please/bar',
          'release-please/baz',
        ],
        prProbe: (b) => {
          if (b === 'release-please/foo') {
            return {
              number: 2447,
              state: 'MERGED',
              headRefOid: 'sha-merged',
            };
          }
          if (b === 'release-please/bar') {
            return { number: 2456, state: 'CLOSED' };
          }
          return { number: 9, state: 'OPEN' };
        },
        branchTipShaFn: ({ branch }) =>
          branch === 'release-please/foo' ? 'sha-merged' : 'sha-other',
      }),
    );
    const branches = plan.candidates.map((c) => c.branch);
    assert.deepEqual(branches, ['release-please/foo']);
    const closedSkip = plan.skipped.find(
      (s) => s.reason === 'latest-pr-closed-not-merged',
    );
    assert.ok(
      closedSkip,
      'closed-not-merged remote-only ref should be skipped',
    );
    assert.equal(closedSkip.branch, 'release-please/bar');
    const openSkip = plan.skipped.find((s) => s.reason === 'latest-pr-open');
    assert.ok(openSkip);
    assert.equal(openSkip.branch, 'release-please/baz');
  });
});

describe('git-cleanup.probeAllPrs (Story #3333 bulk fetch)', () => {
  it('passes the correct single-spawn gh argv (state=all, includes headRefName)', () => {
    let captured;
    probeAllPrs(
      '/cwd',
      (args, { cwd }) => {
        captured = { args, cwd };
        return '[]';
      },
      500,
    );
    assert.equal(captured.cwd, '/cwd');
    assert.deepEqual(captured.args, [
      'pr',
      'list',
      '--state',
      'all',
      '--json',
      'number,state,mergedAt,closedAt,headRefOid,headRefName',
      '--limit',
      '500',
    ]);
  });

  it('indexes rows into a Map keyed by headRefName with probeLatestPr shape', () => {
    const { index } = probeAllPrs('/repo', () =>
      JSON.stringify([
        {
          number: 42,
          state: 'MERGED',
          mergedAt: '2026-05-18T15:24:18Z',
          closedAt: '2026-05-18T15:24:18Z',
          headRefOid: 'sha-merged',
          headRefName: 'fix/a',
        },
        {
          number: 9,
          state: 'OPEN',
          mergedAt: null,
          closedAt: null,
          headRefOid: 'sha-open',
          headRefName: 'feat/b',
        },
      ]),
    );
    assert.equal(index.size, 2);
    assert.deepEqual(index.get('fix/a'), {
      number: 42,
      state: 'MERGED',
      mergedAt: '2026-05-18T15:24:18Z',
      closedAt: '2026-05-18T15:24:18Z',
      headRefOid: 'sha-merged',
    });
    assert.equal(index.get('feat/b').state, 'OPEN');
  });

  it('keeps the first (newest) row when a head ref appears more than once', () => {
    const { index } = probeAllPrs('/repo', () =>
      JSON.stringify([
        { number: 200, state: 'OPEN', headRefName: 'release-please/foo' },
        { number: 100, state: 'MERGED', headRefName: 'release-please/foo' },
      ]),
    );
    assert.equal(index.size, 1);
    assert.equal(index.get('release-please/foo').number, 200);
    assert.equal(index.get('release-please/foo').state, 'OPEN');
  });

  it('uppercases state and coerces missing optional fields to null', () => {
    const { index } = probeAllPrs('/repo', () =>
      JSON.stringify([{ number: 7, state: 'merged', headRefName: 'fix/a' }]),
    );
    const row = index.get('fix/a');
    assert.equal(row.state, 'MERGED');
    assert.equal(row.mergedAt, null);
    assert.equal(row.closedAt, null);
    assert.equal(row.headRefOid, null);
  });

  it('returns an empty index on empty / whitespace / malformed / non-array output', () => {
    for (const stdout of ['', '   ', '{not json', '{"not":"array"}']) {
      const { index, complete } = probeAllPrs('/repo', () => stdout);
      assert.equal(index.size, 0, `index empty for ${JSON.stringify(stdout)}`);
      // Story #5283: an unusable page proves nothing about which head refs
      // have PRs, so the per-branch fallback must stay armed.
      assert.equal(
        complete,
        false,
        `an unusable page is never complete: ${JSON.stringify(stdout)}`,
      );
    }
  });

  it('skips rows with a missing or non-string headRefName', () => {
    const { index } = probeAllPrs('/repo', () =>
      JSON.stringify([
        { number: 1, state: 'MERGED' },
        { number: 2, state: 'MERGED', headRefName: 42 },
        { number: 3, state: 'MERGED', headRefName: 'fix/ok' },
      ]),
    );
    assert.equal(index.size, 1);
    assert.equal(index.get('fix/ok').number, 3);
  });

  it('reports complete only when the page returned fewer rows than its limit', () => {
    const rows = (n) =>
      JSON.stringify(
        Array.from({ length: n }, (_, i) => ({
          number: i + 1,
          state: 'MERGED',
          headRefName: `fix/${i}`,
        })),
      );
    // Two rows against a limit of 3: gh had room to return more and did
    // not, so every PR in the repo is on the page.
    assert.equal(probeAllPrs('/repo', () => rows(2), 3).complete, true);
    // Three rows against a limit of 3: the window is exactly full, so a
    // fourth PR may exist just past it.
    assert.equal(probeAllPrs('/repo', () => rows(3), 3).complete, false);
  });

  it('treats a parsed empty page as complete — a repo with no PRs at all', () => {
    const { index, complete } = probeAllPrs('/repo', () => '[]', 10);
    assert.equal(index.size, 0);
    assert.equal(complete, true);
  });
});

describe('git-cleanup.planCleanup bulk-index integration (Story #3333)', () => {
  const baseCtx = (overrides) => ({
    cwd: '/repo',
    baseBranch: 'main',
    mergedLister: () => [],
    currentBranchFn: () => 'main',
    protectedConfigFn: () => [],
    worktreesFn: () => new Map(),
    branchTipShaFn: () => null,
    filter: () => true,
    ...overrides,
  });

  it('fires the bulk index exactly once and reads each branch from the Map', () => {
    let indexCalls = 0;
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['fix/a', 'feat/b'],
        prIndexFn: () => {
          indexCalls += 1;
          return new Map([
            ['fix/a', { number: 1, state: 'MERGED', headRefOid: null }],
            ['feat/b', { number: 9, state: 'OPEN' }],
          ]);
        },
      }),
    );
    assert.equal(indexCalls, 1, 'bulk index should fire exactly once');
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].branch, 'fix/a');
    const openSkip = plan.skipped.find((s) => s.reason === 'latest-pr-open');
    assert.ok(openSkip);
    assert.equal(openSkip.branch, 'feat/b');
  });

  it('falls back to the per-branch probe only for refs absent from the bulk page', () => {
    const fallbackCalls = [];
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['fix/in-page', 'fix/absent'],
        prIndexFn: () =>
          new Map([
            ['fix/in-page', { number: 1, state: 'MERGED', headRefOid: null }],
          ]),
        prFallback: (branch) => {
          fallbackCalls.push(branch);
          return { number: 77, state: 'MERGED', headRefOid: null };
        },
      }),
    );
    // The in-page branch is served from the Map; only the absent branch
    // hits the per-branch fallback.
    assert.deepEqual(fallbackCalls, ['fix/absent']);
    const candidates = plan.candidates.map((c) => c.branch).sort();
    assert.deepEqual(candidates, ['fix/absent', 'fix/in-page']);
    assert.equal(
      plan.candidates.find((c) => c.branch === 'fix/in-page').prNumber,
      1,
    );
    assert.equal(
      plan.candidates.find((c) => c.branch === 'fix/absent').prNumber,
      77,
    );
  });

  it('does not fire the bulk index when a caller injects prProbe', () => {
    let indexCalls = 0;
    const plan = planCleanup(
      baseCtx({
        localLister: () => ['fix/a'],
        prIndexFn: () => {
          indexCalls += 1;
          return new Map();
        },
        prProbe: () => ({ number: 5, state: 'MERGED', headRefOid: null }),
      }),
    );
    assert.equal(indexCalls, 0, 'injected prProbe must bypass the bulk fetch');
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].prNumber, 5);
  });
});

describe('git-cleanup.renderLatestPrSkipLine', () => {
  it('renders latest-pr-closed-not-merged with the PR number', () => {
    const line = renderLatestPrSkipLine({
      branch: 'release-please/foo',
      reason: 'latest-pr-closed-not-merged',
      prNumber: 2456,
    });
    assert.match(line, /release-please\/foo skipped/);
    assert.match(line, /PR #2456 was closed without merging/);
  });

  it('renders latest-pr-open with the PR number', () => {
    const line = renderLatestPrSkipLine({
      branch: 'feat/x',
      reason: 'latest-pr-open',
      prNumber: 9,
    });
    assert.match(line, /PR #9 is still open/);
  });

  it('renders unverifiable with short SHAs and the probe detail', () => {
    const line = renderLatestPrSkipLine({
      branch: 'story-1842',
      reason: 'unverifiable',
      prNumber: 1842,
      tipSha: 'abcdef1234567890',
      mergedSha: '1234567abcdef000',
      detail: 'unresolvable rev 1234567abcdef000',
    });
    assert.match(line, /story-1842 skipped/);
    assert.match(line, /cannot verify tip abcdef1/);
    assert.match(line, /PR #1842's merged 1234567/);
    assert.match(line, /unresolvable rev 1234567abcdef000/);
    // It must never borrow the force-push diagnosis or its remedy.
    assert.doesNotMatch(line, /force-push/);
    assert.doesNotMatch(line, /follow-up commit/);
  });

  it('renders unverifiable without a detail', () => {
    const line = renderLatestPrSkipLine({
      branch: 'story-1843',
      reason: 'unverifiable',
      tipSha: 'abcdef1234567890',
      mergedSha: '1234567abcdef000',
    });
    assert.match(line, /cannot verify tip abcdef1 against latest PR's merged/);
  });

  it('renders tip-diverged-from-merge with short SHAs', () => {
    const line = renderLatestPrSkipLine({
      branch: 'release-please/foo',
      reason: 'tip-diverged-from-merge',
      prNumber: 2447,
      tipSha: 'abcdef1234567890',
      mergedSha: '1234567abcdef000',
    });
    assert.match(line, /tip abcdef1/);
    assert.match(line, /1234567/);
    assert.match(line, /post-merge force-push/);
  });

  it('returns null for unrelated skip reasons', () => {
    assert.equal(
      renderLatestPrSkipLine({ branch: 'fix/a', reason: 'filtered' }),
      null,
    );
    assert.equal(
      renderLatestPrSkipLine({ branch: 'main', reason: 'protected' }),
      null,
    );
  });

  it('uses the "latest PR" fallback when no prNumber is available', () => {
    const line = renderLatestPrSkipLine({
      branch: 'fix/a',
      reason: 'latest-pr-closed-not-merged',
    });
    assert.match(line, /latest PR was closed without merging/);
  });
});

describe('git-cleanup.renderDryRun (latest-PR skip integration)', () => {
  it('appends skip lines for latest-pr family reasons', () => {
    const lines = renderDryRun(
      {
        candidates: [],
        skipped: [
          {
            branch: 'release-please/foo',
            reason: 'latest-pr-closed-not-merged',
            prNumber: 2456,
          },
        ],
      },
      { baseBranch: 'main' },
    );
    const skipLine = lines.find((l) =>
      /PR #2456 was closed without merging/.test(l),
    );
    assert.ok(skipLine);
  });

  it('renders multiple latest-PR skip lines together', () => {
    const lines = renderDryRun({
      candidates: [],
      skipped: [
        { branch: 'a', reason: 'latest-pr-open', prNumber: 1 },
        { branch: 'b', reason: 'latest-pr-closed-not-merged', prNumber: 2 },
        {
          branch: 'c',
          reason: 'tip-diverged-from-merge',
          prNumber: 3,
          tipSha: 'aaaaaaaaaaaa',
          mergedSha: 'bbbbbbbbbbbb',
        },
      ],
    });
    assert.ok(lines.find((l) => /a skipped — PR #1 is still open/.test(l)));
    assert.ok(
      lines.find((l) => /b skipped — PR #2 was closed without merging/.test(l)),
    );
    assert.ok(lines.find((l) => /c skipped — tip aaaaaaa/.test(l)));
  });
});

describe('git-cleanup.renderLatestPrSkipLine tip-diverged remediation hint (Story #4395)', () => {
  it('names both SHAs and a remediation path', () => {
    const line = renderLatestPrSkipLine({
      branch: 'release-please/foo',
      reason: 'tip-diverged-from-merge',
      prNumber: 2447,
      tipSha: 'abcdef1234567890',
      mergedSha: '1234567abcdef000',
    });
    assert.match(line, /branch -D release-please\/foo/);
    assert.match(line, /pushing the follow-up commit/);
  });
});

describe('git-cleanup.renderNotMergedSkipLine (Story #4395)', () => {
  const NOW = Date.parse('2026-06-15T00:00:00Z');

  it('returns null for a non-not-merged skip', () => {
    assert.equal(
      renderNotMergedSkipLine({ branch: 'main', reason: 'protected' }),
      null,
    );
  });

  it('returns null for a null/undefined skip', () => {
    assert.equal(renderNotMergedSkipLine(null), null);
  });

  it('renders the branch name and a relative last-commit age', () => {
    const line = renderNotMergedSkipLine(
      {
        branch: 'story-4200',
        reason: 'not-merged',
        lastCommitAt: '2026-06-01T00:00:00Z',
      },
      { now: NOW },
    );
    assert.match(line, /story-4200 skipped — not merged/);
    assert.match(line, /14 days ago/);
  });

  it('renders "unknown" when lastCommitAt is missing', () => {
    const line = renderNotMergedSkipLine(
      { branch: 'story-4200', reason: 'not-merged', lastCommitAt: null },
      { now: NOW },
    );
    assert.match(line, /last commit: unknown/);
  });

  it('renders "today" for a same-day commit', () => {
    const line = renderNotMergedSkipLine(
      {
        branch: 'story-4200',
        reason: 'not-merged',
        lastCommitAt: '2026-06-15T00:00:00Z',
      },
      { now: NOW },
    );
    assert.match(line, /last commit: today/);
  });
});

describe('git-cleanup.renderDryRun not-merged skip-visibility integration (Story #4395)', () => {
  const NOW = Date.parse('2026-06-15T00:00:00Z');

  it('lists not-merged survivors instead of staying silent', () => {
    const lines = renderDryRun(
      {
        candidates: [],
        skipped: [
          {
            branch: 'story-4200',
            reason: 'not-merged',
            lastCommitAt: '2026-06-01T00:00:00Z',
          },
        ],
      },
      { baseBranch: 'main', now: NOW },
    );
    assert.ok(lines.find((l) => /story-4200 skipped — not merged/.test(l)));
  });

  it('appends a gh-degraded warning line when the plan reports ghDegraded: true', () => {
    const lines = renderDryRun({
      candidates: [],
      skipped: [],
      ghDegraded: true,
    });
    assert.ok(lines.find((l) => /gh probe degraded/.test(l)));
  });

  it('omits the gh-degraded line on a clean run', () => {
    const lines = renderDryRun({ candidates: [], skipped: [] });
    assert.equal(
      lines.find((l) => /gh probe degraded/.test(l)),
      undefined,
    );
  });
});

describe('git-cleanup.renderDryRun content-merged distinctness (Story #4395)', () => {
  it('annotates a content-merged candidate as a weaker signal', () => {
    const lines = renderDryRun({
      candidates: [
        {
          branch: 'story-4200',
          prNumber: null,
          hasWorktree: false,
          localExists: true,
          detectedBy: 'content-merged',
        },
      ],
      skipped: [],
    });
    assert.match(lines[1], /story-4200 — content-merged/);
    assert.match(lines[1], /weaker signal/);
  });

  it('does not annotate a gh or git-merged candidate', () => {
    const lines = renderDryRun({
      candidates: [
        {
          branch: 'fix/a',
          prNumber: 42,
          hasWorktree: false,
          localExists: true,
          detectedBy: 'gh',
        },
      ],
      skipped: [],
    });
    assert.doesNotMatch(lines[1], /weaker signal/);
  });
});

describe('git-cleanup.renderCandidateList — header states the run mode', () => {
  // Regression: the branches phase used to render this block through a
  // helper hardcoded to the dry-run header, so `--execute` printed
  // "DRY RUN (nothing deleted)" and then reaped every candidate. The
  // wording now comes from the phase's own opts bag, which is also what
  // the reap path reads.
  const plan = {
    candidates: [{ branch: 'fix/a', prNumber: 1, detectedBy: 'gh' }],
    skipped: [],
  };

  it('promises "nothing deleted" on a dry run', () => {
    const [header] = renderCandidateList({ plan, opts: { dryRun: true } });
    assert.match(header, /DRY RUN \(nothing deleted\) — 1 candidate\(s\)/);
  });

  it('announces the reap — never a dry run — under --execute', () => {
    const [header] = renderCandidateList({
      plan,
      opts: { dryRun: false, yes: true },
    });
    assert.match(header, /EXECUTE — 1 candidate\(s\) to reap/);
    assert.doesNotMatch(header, /DRY RUN|nothing deleted/);
  });

  it('treats an absent dryRun flag as execute, not as a preview', () => {
    const [header] = renderCandidateList({ plan, opts: {} });
    assert.doesNotMatch(header, /DRY RUN|nothing deleted/);
  });

  it('the dry-run and --execute headers differ', () => {
    const [preview] = renderCandidateList({ plan, opts: { dryRun: true } });
    const [reap] = renderCandidateList({ plan, opts: { dryRun: false } });
    assert.notEqual(preview, reap);
  });

  it('still renders the candidate rows and the current-head hint', () => {
    const lines = renderCandidateList({
      plan: {
        candidates: plan.candidates,
        skipped: [{ branch: 'feat/wip', reason: 'current-head' }],
      },
      opts: { dryRun: true },
      baseBranch: 'main',
    });
    assert.match(lines[1], /fix\/a — PR #1/);
    assert.match(
      lines.find((l) => /current HEAD/.test(l)),
      /checkout main first/,
    );
  });
});

describe('git-cleanup.renderDryRun behind-merge annotation', () => {
  const behind = {
    branch: 'story-1840',
    prNumber: 1840,
    hasWorktree: false,
    worktreePath: null,
    detectedBy: 'gh',
    localExists: true,
    behindMerge: true,
  };

  it('annotates a behind-the-merged-head candidate', () => {
    const lines = renderDryRun({ candidates: [behind], skipped: [] });
    const row = lines.find((l) => l.includes('story-1840'));
    assert.match(row, /PR #1840/);
    assert.match(row, /tip behind the merged head — content already landed/);
  });

  it('leaves a tip-matching candidate unannotated', () => {
    const lines = renderDryRun({
      candidates: [{ ...behind, behindMerge: false }],
      skipped: [],
    });
    const row = lines.find((l) => l.includes('story-1840'));
    assert.doesNotMatch(row, /tip behind the merged head/);
  });

  it('surfaces an unverifiable skip in the dry-run block', () => {
    const lines = renderDryRun({
      candidates: [],
      skipped: [
        {
          branch: 'story-1842',
          reason: 'unverifiable',
          prNumber: 1842,
          tipSha: 'abcdef1234567890',
          mergedSha: '1234567abcdef000',
          detail: 'unresolvable rev 1234567abcdef000',
        },
      ],
    });
    assert.ok(
      lines.some((l) => l.includes('cannot verify tip abcdef1')),
      'expected the unverifiable skip line in the dry-run block',
    );
  });
});

describe('git-cleanup remote-only no-PR cascade (Story #5188)', () => {
  // The remote-only walk used to `continue` on a `no-pr` verdict, recording
  // neither a candidate nor a skip. Every case below pins one arm of the
  // cascade that replaced it: ancestry, content-equivalence, unmerged.
  const remoteCtx = (overrides) => ({
    cwd: '/repo',
    baseBranch: 'main',
    includeRemoteOnly: true,
    localLister: () => [],
    mergedLister: () => [],
    remoteMergedLister: () => [],
    currentBranchFn: () => 'main',
    protectedConfigFn: () => [],
    worktreesFn: () => new Map(),
    prProbe: () => null,
    branchTipShaFn: () => null,
    ancestryFn: () => ({ outcome: 'error', reason: 'not probed' }),
    contentEquivalentFn: () => ({ supported: true, equivalent: false }),
    branchLastCommitFn: () => '2026-06-01T00:00:00Z',
    refExistsFn: () => false,
    filter: () => true,
    ...overrides,
  });

  it('AC-1: an ancestor of the base with no PR becomes a candidate whose detectedBy differs from the PR-detected one', () => {
    const plan = planCleanup(
      remoteCtx({
        remoteLister: () => ['fix/orphan'],
        remoteMergedLister: () => ['fix/orphan'],
      }),
    );
    assert.equal(plan.candidates.length, 1);
    const cand = plan.candidates[0];
    assert.equal(cand.branch, 'fix/orphan');
    assert.equal(cand.detectedBy, 'remote-git-merged');
    assert.notEqual(
      cand.detectedBy,
      'remote-only',
      'ancestry detection must be distinguishable from PR detection',
    );
    assert.equal(cand.localExists, false);
    assert.equal(cand.prNumber, null);
    assert.equal(cand.hasWorktree, false);
    assert.deepEqual(plan.skipped, []);
  });

  it('a content-equivalent branch with no PR becomes a content-merged candidate', () => {
    const plan = planCleanup(
      remoteCtx({
        remoteLister: () => ['fix/squashed'],
        contentEquivalentFn: () => ({ supported: true, equivalent: true }),
      }),
    );
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].detectedBy, 'content-merged');
    assert.equal(plan.candidates[0].localExists, false);
    assert.notEqual(plan.candidates[0].detectedBy, 'remote-only');
  });

  it('AC-2: a genuinely-unmerged branch with no PR is recorded as a not-merged skip', () => {
    const plan = planCleanup(
      remoteCtx({
        remoteLister: () => ['fix/live-work'],
      }),
    );
    assert.deepEqual(plan.candidates, []);
    assert.equal(plan.skipped.length, 1);
    const skip = plan.skipped[0];
    assert.equal(skip.branch, 'fix/live-work');
    assert.equal(skip.reason, 'not-merged');
    assert.equal(skip.localExists, false);
    assert.equal(skip.lastCommitAt, '2026-06-01T00:00:00Z');
  });

  it('AC-2: the dry-run render prints a visible line for that skip, marked remote-only', () => {
    const plan = planCleanup(
      remoteCtx({ remoteLister: () => ['fix/live-work'] }),
    );
    const lines = renderDryRun(plan, {
      now: Date.parse('2026-06-15T00:00:00Z'),
    });
    const line = lines.find((l) => l.includes('fix/live-work'));
    assert.ok(line, 'expected a visible skip line for the remote-only ref');
    assert.match(line, /not merged/);
    assert.match(line, /\(remote-only\)/);
    assert.match(line, /14 days ago/);
  });

  it('an inconclusive content probe keeps the branch as a not-merged skip, never silent', () => {
    const plan = planCleanup(
      remoteCtx({
        remoteLister: () => ['fix/unknown'],
        contentEquivalentFn: () => ({ supported: false }),
      }),
    );
    assert.deepEqual(plan.candidates, []);
    assert.equal(plan.skipped[0].reason, 'not-merged');
  });

  it('AC-3: the walk is total — every enumerated branch lands in exactly one collection', () => {
    const remoteBranches = [
      'fix/pr-merged',
      'fix/pr-open',
      'fix/ancestor',
      'fix/squashed',
      'fix/unmerged',
    ];
    const plan = planCleanup(
      remoteCtx({
        remoteLister: () => remoteBranches,
        remoteMergedLister: () => ['fix/ancestor'],
        prProbe: (b) => {
          if (b === 'fix/pr-merged') return { number: 7, state: 'MERGED' };
          if (b === 'fix/pr-open') return { number: 8, state: 'OPEN' };
          return null;
        },
        contentEquivalentFn: ({ branch }) => ({
          supported: true,
          equivalent: branch === 'origin/fix/squashed',
        }),
      }),
    );
    const seen = [
      ...plan.candidates.map((c) => c.branch),
      ...plan.skipped.map((s) => s.branch),
    ];
    assert.deepEqual(
      seen.slice().sort(),
      remoteBranches.slice().sort(),
      'no enumerated branch may be absent from both collections',
    );
    assert.equal(
      new Set(seen).size,
      seen.length,
      'no branch may be recorded twice',
    );
    assert.deepEqual(plan.candidates.map((c) => c.detectedBy).sort(), [
      'content-merged',
      'remote-git-merged',
      'remote-only',
    ]);
  });

  it('AC-3: protected and filtered remote refs stay out of both collections', () => {
    const plan = planCleanup(
      remoteCtx({
        remoteLister: () => ['main', 'chore/excluded', 'fix/unmerged'],
        filter: buildGlobFilter({ exclude: ['chore/*'] }),
      }),
    );
    assert.deepEqual(plan.candidates, []);
    assert.deepEqual(
      plan.skipped.map((s) => s.branch),
      ['fix/unmerged'],
    );
  });

  it('AC-4: git probes are handed the qualified origin/<branch> rev, not the bare short name', () => {
    const probedRevs = [];
    const lastCommitCalls = [];
    const plan = planCleanup(
      remoteCtx({
        remoteLister: () => ['fix/squashed', 'fix/unmerged'],
        // A fixture in which the bare short-name lookup fails, exactly as it
        // does in a real repo: only the qualified rev resolves.
        contentEquivalentFn: ({ branch }) => {
          probedRevs.push(branch);
          if (!branch.startsWith('origin/')) return { supported: false };
          return {
            supported: true,
            equivalent: branch === 'origin/fix/squashed',
          };
        },
        branchLastCommitFn: (_cwd, branch, opts) => {
          lastCommitCalls.push({ branch, opts });
          return '2026-06-01T00:00:00Z';
        },
      }),
    );
    assert.deepEqual(probedRevs, [
      'origin/fix/squashed',
      'origin/fix/unmerged',
    ]);
    assert.deepEqual(
      plan.candidates.map((c) => c.detectedBy),
      ['content-merged'],
      'the qualified rev must yield the content-equivalent verdict, not an inconclusive one',
    );
    assert.deepEqual(lastCommitCalls, [
      {
        branch: 'fix/unmerged',
        opts: { localExists: false, remoteName: 'origin' },
      },
    ]);
  });

  it('AC-4: the ancestry source is the remote listing, and honours the fresh origin/<base> anchor', () => {
    const anchors = [];
    const plan = planCleanup(
      remoteCtx({
        remoteLister: () => ['fix/remote-merged'],
        refExistsFn: (_cwd, ref) => ref === 'origin/main',
        remoteMergedLister: (_cwd, base, remoteName) => {
          anchors.push({ base, remoteName });
          return base === 'origin/main' ? ['fix/remote-merged'] : [];
        },
      }),
    );
    assert.deepEqual(anchors, [
      { base: 'main', remoteName: 'origin' },
      { base: 'origin/main', remoteName: 'origin' },
    ]);
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].detectedBy, 'remote-git-merged');
  });

  it('the local merged listing is never consulted for a remote-only branch', () => {
    // `git branch --merged` has no `-r`, so it can only ever hold local
    // names: a remote branch reaching the local set would be a false match.
    const plan = planCleanup(
      remoteCtx({
        remoteLister: () => ['fix/orphan'],
        mergedLister: () => ['fix/orphan'],
      }),
    );
    assert.deepEqual(plan.candidates, []);
    assert.equal(plan.skipped[0].reason, 'not-merged');
  });

  it('a custom remote name propagates to the rev, the listing and the skip', () => {
    const probedRevs = [];
    const plan = planCleanup(
      remoteCtx({
        remoteName: 'upstream',
        remoteLister: () => ['fix/orphan'],
        contentEquivalentFn: ({ branch }) => {
          probedRevs.push(branch);
          return { supported: false };
        },
        branchLastCommitFn: (_cwd, _branch, opts) => {
          assert.equal(opts.remoteName, 'upstream');
          return null;
        },
      }),
    );
    assert.deepEqual(probedRevs, ['upstream/fix/orphan']);
    assert.equal(plan.skipped[0].reason, 'not-merged');
  });
});

describe('git-cleanup remote-only --remote gate (Story #5188 AC-5)', () => {
  const cand = (detectedBy) => ({
    branch: 'fix/orphan',
    detectedBy,
    localExists: false,
    hasWorktree: false,
    worktreePath: null,
  });
  const run = (detectedBy, remote) => {
    const calls = { local: 0, remote: 0 };
    const result = executeCleanup({
      candidates: [cand(detectedBy)],
      cwd: '/repo',
      remote,
      deleteLocalFn: () => {
        calls.local += 1;
        return { deleted: false, reason: 'not-found' };
      },
      deleteRemoteFn: () => {
        calls.remote += 1;
        return { deleted: true, reason: 'deleted' };
      },
      pruneRemoteFn: () => ({ ok: true, pruned: [] }),
      logger: { info() {}, warn() {}, error() {} },
    });
    return { calls, result };
  };

  for (const detectedBy of ['remote-git-merged', 'content-merged']) {
    it(`no-ops on a ${detectedBy} remote-only candidate without --remote`, () => {
      const { calls, result } = run(detectedBy, false);
      assert.equal(calls.local, 0);
      assert.equal(calls.remote, 0, 'deletion still requires --remote');
      assert.equal(result.local.length, 0);
      assert.equal(result.remote.length, 0);
      assert.equal(result.ok, true);
    });

    it(`deletes the ${detectedBy} remote-only candidate once --remote is set`, () => {
      const { calls, result } = run(detectedBy, true);
      assert.equal(calls.local, 0);
      assert.equal(calls.remote, 1);
      assert.equal(result.remote.length, 1);
      assert.equal(result.ok, true);
    });
  }
});

// =====================================================================
// Story #5283 — the weak-signal remote guard, the bulk-index
// short-circuit, and the forwarded remote name.
// =====================================================================

describe('git-cleanup weak-signal remote guard (Story #5283)', () => {
  const contentMergedRemoteOnly = {
    branch: 'fix/orphan',
    detectedBy: 'content-merged',
    localExists: false,
    hasWorktree: false,
    worktreePath: null,
    prNumber: null,
  };
  const ghMergedRemoteOnly = {
    branch: 'fix/landed',
    detectedBy: 'gh',
    localExists: false,
    hasWorktree: false,
    worktreePath: null,
    prNumber: 7,
  };

  /**
   * Drive the real path an unattended run takes: the argv the operator
   * types goes through the real parser, the parsed options through the
   * real decision, and the decision's own `executeArgs` into the real
   * executor. Only the two destructive git calls are stubbed — everything
   * that decides *whether* to make them is production code, so a guard
   * that stopped being consulted would fail here.
   */
  function runUnattended(argv, candidates) {
    const opts = parseCleanupArgs(argv);
    const action = decideBranchPhase({
      plan: { candidates, skipped: [] },
      opts,
      cwd: '/repo',
    });
    assert.equal(action.kind, 'execute', '--yes must not stop to prompt');
    const deleted = [];
    const result = executeCleanup({
      ...action.executeArgs,
      deleteLocalFn: (branch) => {
        deleted.push({ scope: 'local', branch });
        return { deleted: true, reason: 'deleted' };
      },
      deleteRemoteFn: (branch, cwd, remote) => {
        deleted.push({ scope: 'remote', branch, cwd, remote });
        return { deleted: true, reason: 'deleted' };
      },
      pruneRemoteFn: () => ({ ok: true, pruned: [] }),
      logger: { info() {}, warn() {}, error() {} },
    });
    return { opts, deleted, result };
  }

  const UNATTENDED = ['--yes', '--remote', '--execute'];

  it('AC-1: withholds the remote delete of a content-merged candidate under --yes', () => {
    const { deleted, result } = runUnattended(UNATTENDED, [
      contentMergedRemoteOnly,
    ]);
    assert.deepEqual(
      deleted,
      [],
      'no `git push --delete` may be issued for a weak-signal candidate',
    );
    assert.equal(result.remote.length, 1, 'the candidate is still reported');
    assert.deepEqual(result.remote[0], {
      branch: 'fix/orphan',
      ok: true,
      skipped: true,
      reason: 'weak-signal-needs-confirmation',
      alreadyGone: false,
      detectedBy: 'content-merged',
    });
    assert.equal(result.ok, true, 'withholding is not a failure');
    assert.equal(
      result.prune,
      null,
      'nothing was deleted, so there is no stale tracking ref to prune',
    );
  });

  it('AC-1: the guard is scoped to the weak signal — a merged-PR candidate still goes', () => {
    const { deleted, result } = runUnattended(UNATTENDED, [
      contentMergedRemoteOnly,
      ghMergedRemoteOnly,
    ]);
    assert.deepEqual(
      deleted.map((d) => d.branch),
      ['fix/landed'],
    );
    const withheld = result.remote.filter((r) => r.skipped);
    assert.deepEqual(
      withheld.map((r) => r.branch),
      ['fix/orphan'],
    );
    assert.ok(result.prune, 'a real delete still triggers the prune');
  });

  it('AC-1: local deletion is untouched — only the remote ref is withheld', () => {
    const { deleted, result } = runUnattended(UNATTENDED, [
      { ...contentMergedRemoteOnly, branch: 'fix/local', localExists: true },
    ]);
    assert.deepEqual(deleted, [{ scope: 'local', branch: 'fix/local' }]);
    assert.equal(result.local.length, 1);
    assert.equal(result.remote[0].skipped, true);
  });

  it('AC-2: --include-content-merged deletes the same candidate', () => {
    const { opts, deleted, result } = runUnattended(
      [...UNATTENDED, '--include-content-merged'],
      [contentMergedRemoteOnly],
    );
    assert.equal(
      opts.includeContentMerged,
      true,
      'the parser runs with strict:false — an undeclared flag would be dropped silently',
    );
    assert.deepEqual(
      deleted.map((d) => ({ scope: d.scope, branch: d.branch })),
      [{ scope: 'remote', branch: 'fix/orphan' }],
    );
    assert.equal(result.remote[0].skipped, undefined);
    assert.equal(result.remote[0].ok, true);
  });

  it('AC-2: the flag is advertised in --help', () => {
    const help = execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, '.agents/scripts/git-cleanup.js'), '--help'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.match(help, /^ {2}--include-content-merged/m);
  });

  it('defaults to withholding: no flag means includeContentMerged false', () => {
    assert.equal(parseCleanupArgs([]).includeContentMerged, false);
    assert.equal(
      parseCleanupArgs(['--include-content-merged']).includeContentMerged,
      true,
    );
  });

  it('the interactive path does not arm the guard — the operator answered the prompt', () => {
    const action = decideBranchPhase({
      plan: { candidates: [contentMergedRemoteOnly], skipped: [] },
      opts: parseCleanupArgs(['--remote', '--execute']),
      cwd: '/repo',
    });
    assert.equal(action.kind, 'prompt-then-execute');
    assert.match(action.promptMessage, /1 content-merged — weaker signal/);
    assert.equal(action.executeArgs.skipWeakSignal, undefined);
  });

  it('renders a withheld remote entry as skipped, never as a completed reap', () => {
    const line = renderExecutionLine(
      {
        branch: 'fix/orphan',
        ok: true,
        skipped: true,
        reason: 'weak-signal-needs-confirmation',
      },
      'remote',
    );
    assert.doesNotMatch(line, /✅/);
    assert.match(line, /fix\/orphan — withheld/);
    assert.match(line, /--include-content-merged/);
  });

  it('the summary counts withheld remotes apart from reaped ones', () => {
    const summary = renderExecutionSummary({
      ok: true,
      local: [],
      remote: [
        { branch: 'fix/landed', ok: true },
        { branch: 'fix/orphan', ok: true, skipped: true },
      ],
      worktrees: [],
      failures: [],
    });
    assert.match(summary, /Reaped 0 local \+ 1 remote/);
    assert.match(summary, /1 remote delete\(s\) withheld/);
  });
});

describe('git-cleanup bulk PR index short-circuit (Story #5283 AC-3)', () => {
  const baseCtx = (overrides) => ({
    cwd: '/repo',
    baseBranch: 'main',
    mergedLister: () => [],
    currentBranchFn: () => 'main',
    protectedConfigFn: () => [],
    worktreesFn: () => new Map(),
    branchTipShaFn: () => null,
    contentEquivalentFn: () => ({ supported: false }),
    branchLastCommitFn: () => null,
    filter: () => true,
    localLister: () => ['fix/in-page', 'fix/no-pr'],
    ...overrides,
  });
  const page = () =>
    new Map([
      ['fix/in-page', { number: 1, state: 'MERGED', headRefOid: null }],
    ]);

  it('skips the per-branch fallback entirely when the bulk page was complete', () => {
    const fallbackCalls = [];
    const plan = planCleanup(
      baseCtx({
        prIndexFn: () => ({ index: page(), complete: true }),
        prFallback: (branch) => {
          fallbackCalls.push(branch);
          return null;
        },
      }),
    );
    assert.deepEqual(
      fallbackCalls,
      [],
      'a complete page already proves fix/no-pr has no PR',
    );
    // The short-circuit must change only the spawn count, not the verdict:
    // the PR-less branch still falls through to the git-only signals.
    assert.deepEqual(
      plan.candidates.map((c) => c.branch),
      ['fix/in-page'],
    );
    assert.equal(
      plan.skipped.find((sk) => sk.branch === 'fix/no-pr').reason,
      'not-merged',
    );
  });

  it('still falls back when the page was truncated', () => {
    const fallbackCalls = [];
    planCleanup(
      baseCtx({
        prIndexFn: () => ({ index: page(), complete: false }),
        prFallback: (branch) => {
          fallbackCalls.push(branch);
          return null;
        },
      }),
    );
    assert.deepEqual(fallbackCalls, ['fix/no-pr']);
  });

  it('a bare-Map index (pre-#5283 double) keeps the fallback armed', () => {
    const fallbackCalls = [];
    planCleanup(
      baseCtx({
        prIndexFn: () => page(),
        prFallback: (branch) => {
          fallbackCalls.push(branch);
          return null;
        },
      }),
    );
    assert.deepEqual(fallbackCalls, ['fix/no-pr']);
  });

  it('a throwing bulk probe leaves the fallback armed rather than claiming completeness', () => {
    const fallbackCalls = [];
    const plan = planCleanup(
      baseCtx({
        logger: { warn: () => {} },
        prIndexFn: () => {
          throw new Error('gh: authentication failed');
        },
        prFallback: (branch) => {
          fallbackCalls.push(branch);
          return null;
        },
      }),
    );
    assert.equal(plan.ghDegraded, true);
    assert.deepEqual(fallbackCalls, ['fix/in-page', 'fix/no-pr']);
  });
});

describe('git-cleanup remote-name forwarding (Story #5283 AC-4)', () => {
  it('targets the configured remote in the delete call, not origin', () => {
    const calls = [];
    const result = executeCleanup({
      candidates: [
        {
          branch: 'fix/orphan',
          detectedBy: 'gh',
          localExists: false,
          hasWorktree: false,
          worktreePath: null,
        },
      ],
      cwd: '/repo',
      remote: true,
      remoteName: 'upstream',
      // The seam receives the exact triple `git push <remote> --delete
      // <branch>` is built from, so a call that silently defaulted back to
      // `origin` — the pre-#5283 behaviour — is visible here.
      deleteRemoteFn: (branch, cwd, remote) => {
        calls.push({ branch, cwd, remote });
        return { deleted: true, reason: 'deleted' };
      },
      pruneRemoteFn: () => ({ ok: true, pruned: [] }),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.deepEqual(calls, [
      { branch: 'fix/orphan', cwd: '/repo', remote: 'upstream' },
    ]);
    assert.equal(result.ok, true);
  });
});
