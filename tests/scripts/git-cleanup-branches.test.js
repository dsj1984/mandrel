import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildGlobFilter,
  buildJsonEnvelope,
  computeExitCode,
  computeProtectedSet,
  executeCleanup,
  parseCleanupArgs,
  parsePrunedRefs,
  planCleanup,
  probeMergedPr,
  renderDryRun,
  renderExecutionLine,
  renderExecutionSummary,
  renderPruneLine,
} from '../../.agents/scripts/git-cleanup-branches.js';

describe('git-cleanup-branches.parseCleanupArgs', () => {
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

describe('git-cleanup-branches.buildGlobFilter', () => {
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

describe('git-cleanup-branches.computeProtectedSet', () => {
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

describe('git-cleanup-branches.planCleanup', () => {
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

  it('skips protected refs: main, current HEAD, configured', () => {
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
    const skipped = plan.skipped
      .filter((s) => s.reason === 'protected')
      .map((s) => s.branch);
    assert.deepEqual(skipped.sort(), ['fix/current', 'main', 'release']);
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
});

describe('git-cleanup-branches.executeCleanup', () => {
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

describe('git-cleanup-branches.parsePrunedRefs', () => {
  it('extracts each `* [pruned] <remote>/<ref>` line, stripping the prefix', () => {
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

  it('tolerates empty / null stdout', () => {
    assert.deepEqual(parsePrunedRefs('', 'origin'), []);
    assert.deepEqual(parsePrunedRefs(null, 'origin'), []);
  });
});

describe('git-cleanup-branches.computeExitCode', () => {
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

describe('git-cleanup-branches.buildJsonEnvelope', () => {
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

describe('git-cleanup-branches.probeMergedPr', () => {
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

describe('git-cleanup-branches renderers', () => {
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
