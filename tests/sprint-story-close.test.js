import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildDefaultGates,
  DEFAULT_GATES,
  resolveTypecheckCommand,
  runCloseValidation as runCloseValidationOnly,
} from '../.agents/scripts/lib/close-validation.js';
import {
  buildResumeMergeCommitMsg,
  describeResumePushFailure,
  drainPendingCleanupAfterClose,
  getCloseDrainStatus,
  reconcileCleanupState,
  renderPhaseTimingsCommentBody,
} from '../.agents/scripts/story-close.js';

const SCRIPT_PATH = path.resolve('.agents/scripts/story-close.js');

test('buildResumeMergeCommitMsg lower-cases the first letter and tags resolves', () => {
  assert.strictEqual(
    buildResumeMergeCommitMsg(
      'Story 13 — Address top-priority CRAP hotspots',
      792,
    ),
    'feat: story 13 — Address top-priority CRAP hotspots (resolves #792)',
  );
});

test('buildResumeMergeCommitMsg handles already-lowercase titles', () => {
  assert.strictEqual(
    buildResumeMergeCommitMsg('cleanup tickets', 1),
    'feat: cleanup tickets (resolves #1)',
  );
});

test('describeResumePushFailure returns null when push is ok', () => {
  assert.strictEqual(
    describeResumePushFailure({ ok: true, attempts: 1, result: {} }),
    null,
  );
});

test('describeResumePushFailure: retry-exhausted attaches attempts count', () => {
  const out = describeResumePushFailure({
    ok: false,
    reason: 'retry-exhausted',
    attempts: 3,
    result: { stderr: 'remote rejected' },
  });
  assert.match(out, /retries exhausted after 3 attempt\(s\)/);
  assert.match(out, /remote rejected/);
});

test('describeResumePushFailure: other reasons surface raw reason and detail', () => {
  const out = describeResumePushFailure({
    ok: false,
    reason: 'rebase-conflict',
    attempts: 1,
    result: { stdout: 'conflict in foo.js' },
  });
  assert.match(out, /Push failed \(rebase-conflict\)/);
  assert.match(out, /conflict in foo\.js/);
});

test('describeResumePushFailure: missing detail falls back to "unknown"', () => {
  const out = describeResumePushFailure({
    ok: false,
    reason: 'mystery',
    attempts: 1,
    result: {},
  });
  assert.match(out, /unknown/);
});

test('sprint-story-close script', async (t) => {
  await t.test('fails without --story argument', () => {
    const result = spawnSync('node', [SCRIPT_PATH]);
    assert.strictEqual(result.status, 1);
    assert.match(
      result.stderr.toString() + result.stdout.toString(),
      /Usage: node story-close\.js --story <STORY_ID>/,
    );
  });
});

test('runCloseValidation', async (t) => {
  await t.test(
    'DEFAULT_GATES covers typecheck, lint, test, biome format, maintainability, and crap',
    () => {
      const names = DEFAULT_GATES.map((g) => g.name);
      assert.ok(names.includes('typecheck'));
      assert.ok(names.includes('lint'));
      assert.ok(names.includes('test'));
      assert.ok(names.some((n) => n.includes('biome format')));
      assert.ok(names.some((n) => n.includes('maintainability')));
      assert.ok(names.some((n) => n.includes('crap')));
    },
  );

  await t.test(
    'DEFAULT_GATES runs typecheck first so it fast-fails before lint/test',
    () => {
      assert.equal(DEFAULT_GATES[0].name, 'typecheck');
      const names = DEFAULT_GATES.map((g) => g.name);
      const tcIdx = names.indexOf('typecheck');
      const lintIdx = names.indexOf('lint');
      const testIdx = names.indexOf('test');
      assert.ok(
        tcIdx < lintIdx && tcIdx < testIdx,
        'typecheck must run before lint and test',
      );
    },
  );

  await t.test(
    'typecheck gate falls back to `npm run typecheck` when settings is unset',
    () => {
      const gate = DEFAULT_GATES.find((g) => g.name === 'typecheck');
      assert.equal(gate.cmd, 'npm');
      assert.deepStrictEqual(gate.args, ['run', 'typecheck']);
      assert.match(gate.hint, /TypeScript regression/);
    },
  );

  await t.test(
    'typecheck gate honours agentSettings.commands.typecheck when configured',
    () => {
      const gates = buildDefaultGates({
        settings: { commands: { typecheck: 'pnpm exec turbo run typecheck' } },
      });
      const gate = gates.find((g) => g.name === 'typecheck');
      assert.equal(gate.cmd, 'pnpm');
      assert.deepStrictEqual(gate.args, ['exec', 'turbo', 'run', 'typecheck']);
    },
  );

  await t.test('resolveTypecheckCommand resolution rules', () => {
    assert.equal(resolveTypecheckCommand(undefined), 'npm run typecheck');
    assert.equal(resolveTypecheckCommand({}), 'npm run typecheck');
    assert.equal(
      resolveTypecheckCommand({ commands: { typecheck: null } }),
      'npm run typecheck',
    );
    assert.equal(
      resolveTypecheckCommand({ commands: { typecheck: '   ' } }),
      'npm run typecheck',
    );
    assert.equal(
      resolveTypecheckCommand({ commands: { typecheck: 'tsc --noEmit' } }),
      'tsc --noEmit',
    );
  });

  await t.test(
    'a failing typecheck halts runCloseValidation and surfaces the hint',
    () => {
      const gates = buildDefaultGates();
      const tcArgs = gates[0].args;
      const tcCmd = gates[0].cmd;
      const calls = [];
      const runner = (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === tcCmd && args.join(' ') === tcArgs.join(' ')) {
          return { status: 2 };
        }
        return { status: 0 };
      };
      const logs = [];
      const result = runCloseValidationOnly({
        cwd: '.',
        gates,
        runner,
        log: (m) => logs.push(m),
      });
      assert.equal(result.ok, false);
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].gate.name, 'typecheck');
      assert.equal(calls.length, 1, 'should halt before running lint/test');
      assert.ok(logs.some((m) => /TypeScript regression/.test(m)));
    },
  );

  await t.test('biome format gate surfaces the --write hint', () => {
    const gate = DEFAULT_GATES.find((g) => g.name.includes('biome format'));
    assert.match(gate.hint, /biome format --write/);
  });

  await t.test('maintainability gate surfaces the update-baseline hint', () => {
    const gate = DEFAULT_GATES.find((g) => g.name.includes('maintainability'));
    assert.match(gate.hint, /maintainability:update/);
    assert.match(gate.hint, /commit/i);
  });

  await t.test(
    'crap gate runs check-crap.js after maintainability and surfaces the refresh hint',
    () => {
      const names = DEFAULT_GATES.map((g) => g.name);
      const miIdx = names.findIndex((n) => n.includes('maintainability'));
      const crapIdx = names.findIndex((n) => n.includes('crap'));
      assert.ok(crapIdx > miIdx, 'crap gate must run AFTER maintainability');
      const gate = DEFAULT_GATES[crapIdx];
      assert.deepStrictEqual(gate.args, ['.agents/scripts/check-crap.js']);
      assert.match(gate.hint, /crap:update/);
      assert.match(gate.hint, /baseline-refresh:/);
    },
  );

  await t.test('returns ok when every gate exits 0', () => {
    const calls = [];
    const runner = (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0 };
    };
    const gates = [
      { name: 'a', cmd: 'a', args: [] },
      { name: 'b', cmd: 'b', args: [] },
    ];
    const result = runCloseValidationOnly({ cwd: '.', gates, runner });
    assert.deepEqual(result, { ok: true, failed: [], skipped: [] });
    assert.equal(calls.length, 2);
  });

  await t.test(
    'renderPhaseTimingsCommentBody emits a fenced JSON payload',
    () => {
      const body = renderPhaseTimingsCommentBody({
        storyId: 566,
        totalMs: 45_000,
        phases: [
          { name: 'worktree-create', elapsedMs: 100 },
          { name: 'implement', elapsedMs: 40_000 },
          { name: 'lint', elapsedMs: 200 },
        ],
      });
      assert.match(body, /### Phase timings — story #566/);
      const jsonMatch = body.match(/```json\n([\s\S]*?)\n```/);
      assert.ok(jsonMatch, 'body must contain a fenced json block');
      const payload = JSON.parse(jsonMatch[1]);
      assert.equal(payload.kind, 'phase-timings');
      assert.equal(payload.storyId, 566);
      assert.equal(payload.totalMs, 45_000);
      assert.equal(payload.phases.length, 3);
      assert.equal(payload.phases[0].name, 'worktree-create');
    },
  );

  await t.test('stops and reports on first non-zero gate', () => {
    const runner = (cmd) => ({ status: cmd === 'a' ? 0 : 3 });
    const gates = [
      { name: 'a', cmd: 'a', args: [] },
      { name: 'b', cmd: 'b', args: [], hint: 'fix it' },
      { name: 'c', cmd: 'c', args: [] },
    ];
    const logs = [];
    const result = runCloseValidationOnly({
      cwd: '.',
      gates,
      runner,
      log: (m) => logs.push(m),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].gate.name, 'b');
    assert.equal(result.failed[0].status, 3);
    assert.ok(logs.some((m) => m.includes('hint: fix it')));
  });
});

test('reconcileCleanupState marks deferred worktree cleanup as removed-after-drain and updates branch deletion flags', () => {
  const result = reconcileCleanupState({
    storyId: 795,
    worktreeReap: {
      status: 'deferred-to-sweep',
      path: '/repo/.worktrees/story-795',
      pendingCleanup: { storyId: 795, branch: 'story-795' },
    },
    branchCleanup: {
      localDeleted: false,
      remoteDeleted: true,
      localReason: 'error',
      remoteReason: 'deleted',
    },
    pendingCleanupDrain: {
      drained: [795],
      drainedDetails: [
        {
          storyId: 795,
          path: '/repo/.worktrees/story-795',
          branch: 'story-795',
          localBranchDeleted: true,
          remoteBranchDeleted: true,
        },
      ],
      persistent: [],
      persistentDetails: [],
      stillPending: [],
      stillPendingDetails: [],
    },
  });
  assert.equal(result.worktreeReap.status, 'removed-after-drain');
  assert.equal(result.worktreeReap.closeDrainStatus, 'drained');
  assert.equal(result.worktreeReap.pendingCleanup, null);
  assert.equal(result.branchCleanup.localDeleted, true);
  assert.equal(result.branchCleanup.remoteDeleted, true);
});

test('getCloseDrainStatus covers the persistent / still-pending / not-found truth table', () => {
  // persistent wins over still-pending — operator action is the authoritative outcome
  assert.equal(
    getCloseDrainStatus({ isPersistent: true, isStillPending: true }),
    'persistent',
  );
  assert.equal(
    getCloseDrainStatus({ isPersistent: true, isStillPending: false }),
    'persistent',
  );
  assert.equal(
    getCloseDrainStatus({ isPersistent: false, isStillPending: true }),
    'still-pending',
  );
  assert.equal(
    getCloseDrainStatus({ isPersistent: false, isStillPending: false }),
    'not-found',
  );
});

test('reconcileCleanupState marks the deferred worktree as persistent when the drain hit the persistent-lock threshold', () => {
  const result = reconcileCleanupState({
    storyId: 808,
    worktreeReap: {
      status: 'deferred-to-sweep',
      path: '/repo/.worktrees/story-808',
      pendingCleanup: { storyId: 808, branch: 'story-808' },
    },
    branchCleanup: {
      localDeleted: false,
      remoteDeleted: true,
      localReason: 'error',
      remoteReason: 'deleted',
    },
    pendingCleanupDrain: {
      drained: [],
      drainedDetails: [],
      persistent: [808],
      persistentDetails: [{ storyId: 808 }],
      stillPending: [],
      stillPendingDetails: [],
    },
  });
  assert.equal(result.worktreeReap.status, 'deferred-to-sweep');
  assert.equal(result.worktreeReap.closeDrainStatus, 'persistent');
});

test('reconcileCleanupState preserves deferred state when the close-time drain still cannot clear the lock', () => {
  const result = reconcileCleanupState({
    storyId: 795,
    worktreeReap: {
      status: 'deferred-to-sweep',
      path: '/repo/.worktrees/story-795',
      pendingCleanup: { storyId: 795, branch: 'story-795' },
    },
    branchCleanup: {
      localDeleted: false,
      remoteDeleted: true,
      localReason: 'error',
      remoteReason: 'deleted',
    },
    pendingCleanupDrain: {
      drained: [],
      drainedDetails: [],
      persistent: [],
      persistentDetails: [],
      stillPending: [795],
      stillPendingDetails: [{ storyId: 795 }],
    },
  });
  assert.equal(result.worktreeReap.status, 'deferred-to-sweep');
  assert.equal(result.worktreeReap.closeDrainStatus, 'still-pending');
  assert.equal(result.branchCleanup.localDeleted, false);
  assert.equal(result.branchCleanup.remoteDeleted, true);
});

test('drainPendingCleanupAfterClose returns null when worktree isolation is disabled', async () => {
  const res = await drainPendingCleanupAfterClose({
    repoRoot: '.',
    orchestration: { worktreeIsolation: { enabled: false } },
  });
  assert.equal(res, null);
});

test('drainPendingCleanupAfterClose reports the worktree root and drain summary', async () => {
  const events = [];
  const res = await drainPendingCleanupAfterClose({
    repoRoot: '/repo',
    orchestration: { worktreeIsolation: { enabled: true, root: '.worktrees' } },
    progress: (phase, msg) => events.push({ phase, msg }),
    drainFn: async () => ({
      drained: [795],
      drainedDetails: [{ storyId: 795, localBranchDeleted: true }],
      persistent: [],
      persistentDetails: [],
      stillPending: [],
      stillPendingDetails: [],
    }),
  });
  assert.equal(res.worktreeRoot, path.join('/repo', '.worktrees'));
  assert.deepEqual(res.drained, [795]);
  assert.ok(
    events.some(
      (e) =>
        e.phase === 'WORKTREE' &&
        e.msg.includes('Pending cleanup drain: drained=1'),
    ),
  );
});
