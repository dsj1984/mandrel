import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
  probeLatestPr,
  probeMergedPr,
  renderDryRun,
  renderExecutionLine,
  renderExecutionSummary,
  renderLatestPrSkipLine,
  renderPruneLine,
  stashRefIndex,
} from '../../.agents/scripts/git-cleanup.js';

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

  it('remote-only pass skips branches without a merged PR', () => {
    const plan = planCleanup(
      baseCtx({
        includeRemoteOnly: true,
        localLister: () => [],
        remoteLister: () => ['fix/no-pr'],
        prProbe: () => null,
      }),
    );
    assert.deepEqual(plan.candidates, []);
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

  it('skips local delete when worktree removal fails', () => {
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
      removeWorktreeFn: () => ({ ok: false, dirty: true, stderr: 'boom' }),
      deleteLocalFn: () => {
        throw new Error('should not run');
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].scope, 'worktree');
    assert.equal(result.local.length, 0);
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
    let pruneCalls = 0;
    const result = executeCleanup({
      candidates: [
        baseCand({
          branch: 'fix/wt',
          hasWorktree: true,
          worktreePath: '/wt/fix-wt',
        }),
      ],
      cwd: '/repo',
      remote: true,
      removeWorktreeFn: () => ({ ok: false, dirty: true, stderr: 'boom' }),
      deleteLocalFn: () => {
        throw new Error('should not run');
      },
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

  it('checks out base when current branch differs, then merges', () => {
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
    assert.deepEqual(order, ['checkout:main', 'merge:origin/main']);
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
      ...baseArgs({ branchTipShaFn: () => 'newshaXYZ' }),
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
    const index = probeAllPrs('/repo', () =>
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
    const index = probeAllPrs('/repo', () =>
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
    const index = probeAllPrs('/repo', () =>
      JSON.stringify([{ number: 7, state: 'merged', headRefName: 'fix/a' }]),
    );
    const row = index.get('fix/a');
    assert.equal(row.state, 'MERGED');
    assert.equal(row.mergedAt, null);
    assert.equal(row.closedAt, null);
    assert.equal(row.headRefOid, null);
  });

  it('returns an empty Map on empty / whitespace / malformed / non-array output', () => {
    assert.equal(probeAllPrs('/repo', () => '').size, 0);
    assert.equal(probeAllPrs('/repo', () => '   ').size, 0);
    assert.equal(probeAllPrs('/repo', () => '{not json').size, 0);
    assert.equal(probeAllPrs('/repo', () => '{"not":"array"}').size, 0);
  });

  it('skips rows with a missing or non-string headRefName', () => {
    const index = probeAllPrs('/repo', () =>
      JSON.stringify([
        { number: 1, state: 'MERGED' },
        { number: 2, state: 'MERGED', headRefName: 42 },
        { number: 3, state: 'MERGED', headRefName: 'fix/ok' },
      ]),
    );
    assert.equal(index.size, 1);
    assert.equal(index.get('fix/ok').number, 3);
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
