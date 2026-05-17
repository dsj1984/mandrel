/**
 * epic-deliver-finalize.refresh.test.js — Story #2204 (Epic #2173, AC-4).
 *
 * Pins the contract introduced by the migration of finalize reconciliation
 * to the unified `refreshBaseline()` service (Story #2197):
 *
 *   1. `reconcileBaselinesOnEpicBranch` routes through `refreshBaseline()`
 *      for both `maintainability` and `crap`. It never imports or calls
 *      `regenerateMainFromTree()` directly.
 *   2. The default `fullScope` is `false` — finalize never rewrites rows
 *      outside the Epic diff unless the operator explicitly opts in.
 *   3. The CLI `--full-scope` flag flips `fullScope: true` through the
 *      `classifyFinalizeInvocation` → `runEpicDeliverFinalize` plumbing.
 *
 * The refresh-service is injected (`refreshBaselineFn`) so the test never
 * touches real `baselines/*.json` or git state.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  classifyFinalizeInvocation,
  reconcileBaselinesOnEpicBranch,
  runEpicDeliverFinalize,
} from '../../.agents/scripts/epic-deliver-finalize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function makeInjectedConfig({ miPath, crapPath } = {}) {
  return {
    project: { baseBranch: 'main' },
    agentSettings: {
      baseBranch: 'main',
      quality: {
        baselines: {
          maintainability: { path: miPath ?? 'baselines/maintainability.json' },
          crap: { path: crapPath ?? 'baselines/crap.json' },
        },
        maintainability: { targetDirs: ['.agents/scripts'] },
        crap: {
          targetDirs: ['.agents/scripts'],
          requireCoverage: false,
          coveragePath: 'coverage/coverage-final.json',
        },
      },
    },
    orchestration: {},
  };
}

function makeRefreshBaselineSpy() {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return {
      kind: opts.kind,
      writePath: opts.writePath,
      scope: { mode: opts.fullScope ? 'full' : 'diff', files: [] },
      envelope: { rows: [], rollup: {} },
      wrote: false,
    };
  };
  return { fn, calls };
}

function makeGitSpawnFn() {
  const calls = [];
  return {
    calls,
    fn: (_cwd, ...args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

const stubResolveConfig = (config) => () => config;
const stubGetBaselines = () => ({ agentSettings }) =>
  agentSettings.quality.baselines;
const stubGetQuality = () => ({ agentSettings }) => agentSettings.quality;

test('reconcileBaselinesOnEpicBranch defaults to diff-scope (fullScope=false)', async () => {
  const config = makeInjectedConfig();
  const refresh = makeRefreshBaselineSpy();
  const git = makeGitSpawnFn();

  const out = await reconcileBaselinesOnEpicBranch({
    epicId: 2173,
    cwd: REPO_ROOT,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    refreshBaselineFn: refresh.fn,
    resolveConfigFn: stubResolveConfig(config),
    getBaselinesFn: stubGetBaselines(config),
    getQualityFn: stubGetQuality(config),
    gitSpawnFn: git.fn,
  });

  // Both kinds invoked through refreshBaseline().
  assert.equal(refresh.calls.length, 2, 'expected one refresh per kind');
  const kinds = refresh.calls.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['crap', 'maintainability']);

  // Every refresh call defaults to diff-scope (fullScope === false).
  for (const call of refresh.calls) {
    assert.equal(
      call.fullScope,
      false,
      `${call.kind} refresh must default to diff-scope (fullScope=false)`,
    );
    assert.equal(call.baseRef, 'origin/main', 'baseRef defaults to origin/main');
    assert.equal(call.headRef, 'HEAD', 'headRef defaults to HEAD');
    assert.equal(typeof call.scorer, 'function', 'scorer adapter must be injected');
  }

  // No drift → no commit.
  assert.equal(out.committed, false);
  assert.equal(out.fullScope, false);
  assert.equal(out.refreshes.length, 2);
});

test('reconcileBaselinesOnEpicBranch forwards fullScope=true to every refresh', async () => {
  const config = makeInjectedConfig();
  const refresh = makeRefreshBaselineSpy();
  const git = makeGitSpawnFn();

  await reconcileBaselinesOnEpicBranch({
    epicId: 2173,
    cwd: REPO_ROOT,
    fullScope: true,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    refreshBaselineFn: refresh.fn,
    resolveConfigFn: stubResolveConfig(config),
    getBaselinesFn: stubGetBaselines(config),
    getQualityFn: stubGetQuality(config),
    gitSpawnFn: git.fn,
  });

  for (const call of refresh.calls) {
    assert.equal(
      call.fullScope,
      true,
      `${call.kind} refresh must receive fullScope=true when operator opts in`,
    );
  }
});

test('reconcileBaselinesOnEpicBranch commits when at least one refresh wrote drift', async () => {
  const config = makeInjectedConfig();
  const refreshCalls = [];
  const refreshFn = async (opts) => {
    refreshCalls.push(opts);
    // Maintainability wrote drift; crap did not.
    return {
      kind: opts.kind,
      writePath: opts.writePath,
      scope: { mode: 'diff', files: [] },
      envelope: { rows: [], rollup: {} },
      wrote: opts.kind === 'maintainability',
    };
  };
  const git = makeGitSpawnFn();

  const out = await reconcileBaselinesOnEpicBranch({
    epicId: 2173,
    cwd: REPO_ROOT,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    refreshBaselineFn: refreshFn,
    resolveConfigFn: stubResolveConfig(config),
    getBaselinesFn: stubGetBaselines(config),
    getQualityFn: stubGetQuality(config),
    gitSpawnFn: git.fn,
  });

  assert.equal(refreshCalls.length, 2);
  assert.equal(out.committed, true, 'should commit when any kind wrote drift');
  assert.equal(out.didChange, true);

  // Only the maintainability path is staged — crap had wrote=false.
  const addCalls = git.calls.filter((args) => args[0] === 'add');
  assert.equal(addCalls.length, 1, 'should stage exactly the drift kind');
  assert.ok(addCalls[0].some((a) => /maintainability\.json$/.test(a)));

  const commitCalls = git.calls.filter((args) => args[0] === 'commit');
  assert.equal(commitCalls.length, 1);
  assert.ok(
    commitCalls[0].some((a) => /baseline-refresh: epic-2173/.test(a)),
    'commit message must include epic-<id>',
  );
});

test('reconcileBaselinesOnEpicBranch catches refresh errors and reports non-fatal', async () => {
  const config = makeInjectedConfig();
  const refreshFn = async () => {
    throw new Error('boom');
  };

  const out = await reconcileBaselinesOnEpicBranch({
    epicId: 2173,
    cwd: REPO_ROOT,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    refreshBaselineFn: refreshFn,
    resolveConfigFn: stubResolveConfig(config),
    getBaselinesFn: stubGetBaselines(config),
    getQualityFn: stubGetQuality(config),
    gitSpawnFn: makeGitSpawnFn().fn,
  });

  assert.equal(out.committed, false);
  assert.equal(out.reason, 'error');
  assert.match(out.detail, /boom/);
});

test('classifyFinalizeInvocation: --full-scope flag flips fullScope=true', () => {
  const a = classifyFinalizeInvocation({ epic: '7' });
  assert.deepEqual(a, { kind: 'run', epicId: 7, fullScope: false });

  const b = classifyFinalizeInvocation({ epic: '7', 'full-scope': true });
  assert.deepEqual(b, { kind: 'run', epicId: 7, fullScope: true });
});

test('runEpicDeliverFinalize plumbs fullScope through to reconcileBaselinesFn', async () => {
  const reconcileCalls = [];
  const reconcileFn = async (args) => {
    reconcileCalls.push(args);
    return { committed: false, didChange: false, reason: 'no-change' };
  };
  const git = (function () {
    const routes = [
      { matcher: (args) => args[0] === 'fetch', response: { status: 0 } },
      { matcher: (args) => args[0] === 'merge-base', response: { status: 0 } },
      {
        matcher: (args) => args[0] === 'rev-list',
        response: { status: 0, stdout: '1' },
      },
      { matcher: (args) => args[0] === 'push', response: { status: 0 } },
    ];
    return (_cwd, ...args) => {
      for (const r of routes) {
        if (r.matcher(args)) {
          return {
            status: r.response.status ?? 0,
            stdout: r.response.stdout ?? '',
            stderr: r.response.stderr ?? '',
          };
        }
      }
      return { status: 0, stdout: '', stderr: '' };
    };
  })();

  const ghSpawnFn = () => ({
    status: 0,
    stdout: 'https://github.com/x/y/pull/1\n',
    stderr: '',
  });

  await runEpicDeliverFinalize({
    epicId: 2173,
    cwd: REPO_ROOT,
    fullScope: true,
    injectedProvider: {
      async getTicket(id) {
        return { id, title: 'T' };
      },
    },
    injectedConfig: {
      project: { baseBranch: 'main' },
      agentSettings: { baseBranch: 'main' },
      orchestration: {},
    },
    loggerImpl: { info: () => {}, warn: () => {}, error: () => {} },
    reconcileBaselinesFn: reconcileFn,
    reconcileAcceptanceSpecFn: async () => ({ ok: true, status: 'waived' }),
    gitSpawnFn: git,
    ghSpawnFn,
    upsertCommentFn: async () => ({ commentId: 1 }),
    notifyFn: () => Promise.resolve(),
  });

  assert.equal(reconcileCalls.length, 1);
  assert.equal(
    reconcileCalls[0].fullScope,
    true,
    'runEpicDeliverFinalize must forward fullScope to reconcileBaselinesFn',
  );
  assert.equal(reconcileCalls[0].baseRef, 'origin/main');
  assert.equal(reconcileCalls[0].headRef, 'epic/2173');
});

test('epic-deliver-finalize.js no longer imports regenerateMainFromTree', () => {
  // Story #2204 / AC: grep the source to confirm the legacy entry point is
  // gone. The unified service is the only refresh funnel.
  const src = readFileSync(
    path.join(REPO_ROOT, '.agents', 'scripts', 'epic-deliver-finalize.js'),
    'utf8',
  );
  assert.ok(
    !/regenerateMainFromTree/.test(src),
    'epic-deliver-finalize.js must not reference regenerateMainFromTree (Epic #2173, Story #2204)',
  );
  assert.ok(
    /refresh-service\.js/.test(src),
    'epic-deliver-finalize.js must import refreshBaseline from lib/baselines/refresh-service.js',
  );
});
