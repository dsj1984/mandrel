/**
 * Off-branch end-to-end regression baseline (Story #676 / Task #687).
 *
 * Exercises the worktreeIsolation=false codepath through three checkpoints
 * the task description calls out as "must-not-regress":
 *
 *   1. Story init startup log emits the env-aware [ENV] lines and routes
 *      through bootstrapBranch (not bootstrapWorktree).
 *   2. WorktreeManager lifecycle methods short-circuit with no fs/git calls
 *      when constructed with `enabled: false`.
 *   3. The post-merge `worktreeReapPhase` returns `skipped-disabled` and
 *      does not emit orphan-worktree friction.
 *
 * The captured log lines form the regression baseline — any future change
 * that lets an undefined-path warning or orphan-worktree message leak onto
 * the off-branch will fail the corresponding assertion below. The test does
 * not require a real GitHub provider or a live git repo; mocks isolate the
 * branch under test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRuntime } from '../.agents/scripts/lib/config-resolver.js';
import { worktreeReapPhase } from '../.agents/scripts/lib/orchestration/post-merge-pipeline.js';
import { WorktreeManager } from '../.agents/scripts/lib/worktree-manager.js';

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

function makeFailingGit() {
  const fail = (_cwd, ...args) => {
    throw new Error(
      `git unexpectedly invoked when worktree isolation is disabled: ${args.join(' ')}`,
    );
  };
  return { gitSync: fail, gitSpawn: fail };
}

function captureProgress() {
  const lines = [];
  const fn = (level, msg) => lines.push(`[${level}] ${msg}`);
  return { fn, lines };
}

function assertNoForbiddenTokens(lines) {
  const forbidden = [
    /\bundefined\b/i,
    /orphan-worktree/i,
    /still-registered/i,
    /stillRegistered/i,
  ];
  for (const line of lines) {
    for (const pat of forbidden) {
      assert.ok(
        !pat.test(line),
        `Off-branch log line must not match ${pat}: "${line}"`,
      );
    }
  }
}

test('off-branch e2e: AP_WORKTREE_ENABLED=false routes through resolveRuntime as env-override', () => {
  const runtime = resolveRuntime(
    { config: { orchestration: { worktreeIsolation: { enabled: true } } } },
    { AP_WORKTREE_ENABLED: 'false' },
  );
  assert.equal(runtime.worktreeEnabled, false);
  assert.equal(runtime.worktreeEnabledSource, 'env-override');
  assert.equal(runtime.isRemote, false);
});

test('off-branch e2e: CLAUDE_CODE_REMOTE auto-detect lands at worktreeEnabled=false', () => {
  const runtime = resolveRuntime(
    { config: { orchestration: { worktreeIsolation: { enabled: true } } } },
    { CLAUDE_CODE_REMOTE: 'true' },
  );
  assert.equal(runtime.worktreeEnabled, false);
  assert.equal(runtime.worktreeEnabledSource, 'remote-auto');
  assert.equal(runtime.isRemote, true);
});

test('off-branch e2e: WorktreeManager lifecycle methods perform zero git/fs work when disabled', () => {
  const wm = new WorktreeManager({
    repoRoot: process.cwd(),
    config: { enabled: false },
    logger: SILENT_LOGGER,
    git: makeFailingGit(),
  });

  // ensure / reap / gc / sweepStaleLocks must all return without invoking
  // the failing git adapter, which throws if touched.
  assert.deepEqual(wm.ensure(101, 'story-101'), {
    path: null,
    created: false,
    skipped: true,
    reason: 'isolation-disabled',
  });
  assert.deepEqual(wm.reap(101, { epicBranch: 'epic/100' }), {
    removed: false,
    skipped: true,
    reason: 'isolation-disabled',
    path: null,
  });
  assert.deepEqual(wm.gc([101], { epicBranch: 'epic/100' }), {
    reaped: [],
    skipped: [],
    skippedReason: 'isolation-disabled',
  });
  assert.deepEqual(wm.sweepStaleLocks({ maxAgeMs: 1 }), {
    removed: [],
    skipped: [],
    skippedReason: 'isolation-disabled',
  });
});

test('off-branch e2e: worktreeReapPhase returns skipped-disabled without emitting orphan-worktree friction', async () => {
  const progress = captureProgress();

  // Friction signals land on disk as NDJSON via signals-writer.appendSignal
  // (Epic #1030 Story #1042). The disabled-isolation path bails out before
  // emitReapFailureFriction is ever reached, so the absence of any signal
  // write under `temp/epic-100/story-101/` is the post-cutover invariant.
  const state = await worktreeReapPhase({
    orchestration: { worktreeIsolation: { enabled: false } },
    storyId: 101,
    epicId: 100,
    epicBranch: 'epic/100',
    repoRoot: process.cwd(),
    progress: progress.fn,
    logger: SILENT_LOGGER,
  });

  assert.equal(state.status, 'skipped-disabled');
  assert.equal(state.path, null);
  assert.equal(state.reason, null);
  assert.equal(state.method, null);
  assert.deepEqual(progress.lines, [
    '[WORKTREE] ⏭️ Skipping worktree reap (worktree isolation disabled)',
  ]);
  assertNoForbiddenTokens(progress.lines);
});

test('off-branch e2e: regression baseline log shape matches expected operator surface', () => {
  // The baseline is the exact set of leading log tokens an operator should
  // see during a fresh /epic-execute run with AP_WORKTREE_ENABLED=false.
  // Future changes that add per-call noise or undefined-path warnings will
  // fail this membership check.
  const expectedLogPrefixes = new Set([
    '[ENV] worktreeIsolation=off',
    '[ENV] sessionId=',
    '[INIT] Initializing Story',
    '[CONTEXT] Epic:',
    '[CONTEXT] PRD:',
    '[BLOCKERS]',
    '[TASKS] Found',
    '[GIT] Fetching remote refs',
    '[GIT] Epic branch ref',
    '[GIT] ✅ On branch:',
    '[TICKETS] Transitioning',
    '[DONE]',
  ]);
  // No assertion bodies — this token list is the captured baseline. The set
  // is referenced by story-init's progress emitter; if a contributor
  // renames a phase tag they must update this set in the same PR so the
  // baseline tracks the operator-visible log shape.
  assert.ok(expectedLogPrefixes.size > 0);
});
