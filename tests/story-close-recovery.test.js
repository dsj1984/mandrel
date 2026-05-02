import assert from 'node:assert';
import path from 'node:path';
import { test } from 'node:test';

import {
  computeRecoveryMode,
  detectPriorPhase,
  dispatchRecovery,
  RECOVERY_ACTIONS,
  RECOVERY_STATES,
} from '../.agents/scripts/lib/orchestration/story-close-recovery.js';

function makeGit({
  mainStatus = '',
  wtStatusByPath = {},
  lsRemote = '',
  ancestorExit = 1,
  // ALREADY_MERGED detection: tests can override per-(ancestor, descendant)
  // pair to disambiguate `local story → remote epic` vs `remote story →
  // remote epic`. Falls back to the global `ancestorExit` when no pair match.
  ancestorExitByPair = null,
  // showRef: tests opt in by setting `localStoryExists: true` (or by passing
  // a custom `showRefByRef` map). Default `false` keeps legacy behavior.
  localStoryExists = false,
  showRefByRef = null,
} = {}) {
  return {
    status(cwd) {
      if (cwd === '/repo') return { status: 0, stdout: mainStatus };
      return { status: 0, stdout: wtStatusByPath[cwd] ?? '' };
    },
    lsRemote(_cwd, _ref) {
      return { status: 0, stdout: lsRemote };
    },
    isAncestor(_cwd, ancestor, descendant) {
      if (ancestorExitByPair) {
        const key = `${ancestor}→${descendant}`;
        if (key in ancestorExitByPair) {
          return { status: ancestorExitByPair[key] };
        }
      }
      return { status: ancestorExit };
    },
    showRef(_cwd, ref) {
      if (showRefByRef && ref in showRefByRef) {
        return { status: showRefByRef[ref] };
      }
      // Default: only `refs/heads/story-<id>` is "present" when
      // localStoryExists is true.
      if (/^refs\/heads\/story-\d+$/.test(ref) && localStoryExists) {
        return { status: 0 };
      }
      return { status: 1 };
    },
  };
}

function makeFs(existingPaths = []) {
  return { existsSync: (p) => existingPaths.includes(p) };
}

const CWD = '/repo';

test('detectPriorPhase', async (t) => {
  await t.test('returns fresh when no signals match', () => {
    const result = detectPriorPhase({
      cwd: CWD,
      storyId: 100,
      git: makeGit(),
      fs: makeFs([]),
    });
    assert.strictEqual(result.phase, RECOVERY_STATES.FRESH);
  });

  await t.test('returns partial-merge when UU markers present', () => {
    const result = detectPriorPhase({
      cwd: CWD,
      storyId: 100,
      git: makeGit({ mainStatus: 'UU some/file.js\n M other.js\n' }),
      fs: makeFs([]),
    });
    assert.strictEqual(result.phase, RECOVERY_STATES.PARTIAL_MERGE);
    assert.strictEqual(result.detail.checkout, CWD);
  });

  await t.test(
    'returns uncommitted-worktree when worktree exists and dirty',
    () => {
      const wtPath = path.join(CWD, '.worktrees', 'story-100');
      const result = detectPriorPhase({
        cwd: CWD,
        storyId: 100,
        git: makeGit({
          wtStatusByPath: { [wtPath]: ' M src/index.js\n' },
        }),
        fs: makeFs([wtPath]),
      });
      assert.strictEqual(result.phase, RECOVERY_STATES.UNCOMMITTED_WORKTREE);
      assert.strictEqual(result.detail.worktreePath, wtPath);
    },
  );

  await t.test('skips uncommitted-worktree when worktree is clean', () => {
    const wtPath = path.join(CWD, '.worktrees', 'story-100');
    const result = detectPriorPhase({
      cwd: CWD,
      storyId: 100,
      git: makeGit({ wtStatusByPath: { [wtPath]: '' } }),
      fs: makeFs([wtPath]),
    });
    assert.strictEqual(result.phase, RECOVERY_STATES.FRESH);
  });

  await t.test(
    'returns pushed-unmerged when remote story branch exists and not merged',
    () => {
      const result = detectPriorPhase({
        cwd: CWD,
        storyId: 100,
        epicId: 42,
        git: makeGit({
          lsRemote: 'abc123\trefs/heads/story-100\n',
          ancestorExit: 1, // not an ancestor → not yet merged
        }),
        fs: makeFs([]),
      });
      assert.strictEqual(result.phase, RECOVERY_STATES.PUSHED_UNMERGED);
      assert.match(result.detail.remoteRef, /story-100/);
    },
  );

  await t.test(
    'returns already-merged when remote branch is reachable from origin/epic/<id>',
    () => {
      const result = detectPriorPhase({
        cwd: CWD,
        storyId: 100,
        epicId: 42,
        git: makeGit({
          lsRemote: 'abc123\trefs/heads/story-100\n',
          ancestorExit: 0, // remote story → remote epic ancestor
        }),
        fs: makeFs([]),
      });
      assert.strictEqual(result.phase, RECOVERY_STATES.ALREADY_MERGED);
      assert.strictEqual(result.detail.remoteStoryRef, 'origin/story-100');
    },
  );

  await t.test(
    'returns already-merged when local story branch exists and is reachable from origin/epic/<id>',
    () => {
      // Typical Windows partial-reap recovery: remote story branch was deleted
      // by the prior close push, but the local branch ref survived because
      // the worktree reap stalled before `git branch -D` ran. The local
      // branch's HEAD is still an ancestor of `origin/epic/<id>`.
      const result = detectPriorPhase({
        cwd: CWD,
        storyId: 100,
        epicId: 42,
        git: makeGit({
          lsRemote: '', // remote story branch already deleted
          localStoryExists: true,
          ancestorExitByPair: {
            'story-100→origin/epic/42': 0,
          },
        }),
        fs: makeFs([]),
      });
      assert.strictEqual(result.phase, RECOVERY_STATES.ALREADY_MERGED);
      assert.strictEqual(result.detail.localStoryRef, 'story-100');
      assert.strictEqual(result.detail.remoteEpicRef, 'origin/epic/42');
    },
  );

  await t.test(
    'returns fresh when neither local nor remote branch is merged',
    () => {
      const result = detectPriorPhase({
        cwd: CWD,
        storyId: 100,
        epicId: 42,
        git: makeGit({
          lsRemote: '',
          localStoryExists: false,
        }),
        fs: makeFs([]),
      });
      assert.strictEqual(result.phase, RECOVERY_STATES.FRESH);
    },
  );

  await t.test('partial-merge takes priority over dirty worktree', () => {
    const wtPath = path.join(CWD, '.worktrees', 'story-100');
    const result = detectPriorPhase({
      cwd: CWD,
      storyId: 100,
      git: makeGit({
        mainStatus: 'UU conflict.js\n',
        wtStatusByPath: { [wtPath]: ' M dirty.js\n' },
      }),
      fs: makeFs([wtPath]),
    });
    assert.strictEqual(result.phase, RECOVERY_STATES.PARTIAL_MERGE);
  });

  await t.test(
    'dirty worktree takes priority over pushed-unmerged remote',
    () => {
      const wtPath = path.join(CWD, '.worktrees', 'story-100');
      const result = detectPriorPhase({
        cwd: CWD,
        storyId: 100,
        epicId: 42,
        git: makeGit({
          wtStatusByPath: { [wtPath]: ' M dirty.js\n' },
          lsRemote: 'abc123\trefs/heads/story-100\n',
          ancestorExit: 1,
        }),
        fs: makeFs([wtPath]),
      });
      assert.strictEqual(result.phase, RECOVERY_STATES.UNCOMMITTED_WORKTREE);
    },
  );

  await t.test('throws without required cwd/storyId', () => {
    assert.throws(() => detectPriorPhase({ storyId: 1 }), /cwd is required/);
    assert.throws(() => detectPriorPhase({ cwd: '/x' }), /storyId is required/);
  });

  await t.test('honors custom worktreeRoot', () => {
    const wtPath = path.join(CWD, 'custom-wt', 'story-100');
    const result = detectPriorPhase({
      cwd: CWD,
      storyId: 100,
      worktreeRoot: 'custom-wt',
      git: makeGit({ wtStatusByPath: { [wtPath]: ' M f.js\n' } }),
      fs: makeFs([wtPath]),
    });
    assert.strictEqual(result.phase, RECOVERY_STATES.UNCOMMITTED_WORKTREE);
  });
});

test('computeRecoveryMode dispatch table', async (t) => {
  await t.test('fresh state proceeds regardless of flags', () => {
    for (const flags of [{}, { resume: true }, { restart: true }]) {
      const result = computeRecoveryMode({
        state: RECOVERY_STATES.FRESH,
        ...flags,
      });
      assert.strictEqual(result.action, RECOVERY_ACTIONS.PROCEED);
    }
  });

  await t.test('non-fresh state with no flag returns exit-prior-state', () => {
    const result = computeRecoveryMode({
      state: RECOVERY_STATES.PARTIAL_MERGE,
    });
    assert.strictEqual(result.action, RECOVERY_ACTIONS.EXIT_PRIOR_STATE);
    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.reason, RECOVERY_STATES.PARTIAL_MERGE);
  });

  await t.test('--restart returns RESTART for any non-fresh state', () => {
    for (const state of [
      RECOVERY_STATES.PARTIAL_MERGE,
      RECOVERY_STATES.UNCOMMITTED_WORKTREE,
      RECOVERY_STATES.PUSHED_UNMERGED,
    ]) {
      const result = computeRecoveryMode({ state, restart: true });
      assert.strictEqual(result.action, RECOVERY_ACTIONS.RESTART);
    }
  });

  await t.test('--resume dispatches per state', () => {
    assert.strictEqual(
      computeRecoveryMode({
        state: RECOVERY_STATES.PARTIAL_MERGE,
        resume: true,
      }).action,
      RECOVERY_ACTIONS.RESUME_FROM_CONFLICT,
    );
    assert.strictEqual(
      computeRecoveryMode({
        state: RECOVERY_STATES.UNCOMMITTED_WORKTREE,
        resume: true,
      }).action,
      RECOVERY_ACTIONS.RESUME_FROM_VALIDATE,
    );
    assert.strictEqual(
      computeRecoveryMode({
        state: RECOVERY_STATES.PUSHED_UNMERGED,
        resume: true,
      }).action,
      RECOVERY_ACTIONS.RESUME_FROM_MERGE,
    );
  });

  await t.test(
    'already-merged auto-resumes from post-merge with no flag required',
    () => {
      // The prior close pushed the merge but stalled before ticket
      // transitions / cascade / dashboard regen finished. Re-running close
      // is the canonical recovery path and is safe to perform automatically.
      assert.strictEqual(
        computeRecoveryMode({ state: RECOVERY_STATES.ALREADY_MERGED }).action,
        RECOVERY_ACTIONS.RESUME_FROM_POST_MERGE,
      );
      // --resume is a no-op (the action is the same) — it doesn't error.
      assert.strictEqual(
        computeRecoveryMode({
          state: RECOVERY_STATES.ALREADY_MERGED,
          resume: true,
        }).action,
        RECOVERY_ACTIONS.RESUME_FROM_POST_MERGE,
      );
      // --restart still escapes via the restart path.
      assert.strictEqual(
        computeRecoveryMode({
          state: RECOVERY_STATES.ALREADY_MERGED,
          restart: true,
        }).action,
        RECOVERY_ACTIONS.RESTART,
      );
    },
  );

  await t.test('--resume + --restart together throws', () => {
    assert.throws(
      () =>
        computeRecoveryMode({
          state: RECOVERY_STATES.PARTIAL_MERGE,
          resume: true,
          restart: true,
        }),
      /mutually exclusive/,
    );
  });
});

function makeStubLogger() {
  const errors = [];
  const fatals = [];
  return {
    errors,
    fatals,
    error: (m) => errors.push(m),
    fatal: (m) => {
      fatals.push(m);
      throw new Error(m);
    },
    info: () => {},
    warn: () => {},
  };
}

function captureProgress() {
  const events = [];
  return { events, fn: (phase, msg) => events.push({ phase, msg }) };
}

const DISPATCH_BASE = {
  cwd: '/repo',
  storyId: 100,
  epicId: 9,
  epicBranch: 'epic/9',
  storyBranch: 'story-100',
  orchestration: {},
};

test('dispatchRecovery', async (t) => {
  await t.test('returns proceed-shaped result on fresh state', () => {
    const { events, fn } = captureProgress();
    const result = dispatchRecovery({
      ...DISPATCH_BASE,
      detectFn: () => ({ phase: RECOVERY_STATES.FRESH, detail: {} }),
      restartFn: () => {
        throw new Error('should not be called');
      },
      progress: fn,
      logger: makeStubLogger(),
    });
    assert.equal(result.action, RECOVERY_ACTIONS.PROCEED);
    assert.equal(result.resumeFromConflict, false);
    assert.equal(result.resumeFromMerge, false);
    assert.equal(result.resumeFromValidate, false);
    assert.equal(events.length, 0);
  });

  await t.test(
    'throws with exitCode=2 and logs prior-state body when no flag set',
    () => {
      const logger = makeStubLogger();
      const detail = {
        storyId: 100,
        storyBranch: 'story-100',
        checkout: '/repo',
      };
      try {
        dispatchRecovery({
          ...DISPATCH_BASE,
          detectFn: () => ({
            phase: RECOVERY_STATES.PARTIAL_MERGE,
            detail,
          }),
          logger,
        });
        assert.fail('expected throw');
      } catch (err) {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /prior-state:partial-merge/);
      }
      assert.ok(
        logger.errors.some(
          (m) =>
            m.includes('[phase=prior-state]') && m.includes('partial-merge'),
        ),
      );
    },
  );

  await t.test('invokes restartFn when --restart is passed', () => {
    const restartCalls = [];
    const { fn: progress, events } = captureProgress();
    const result = dispatchRecovery({
      ...DISPATCH_BASE,
      restart: true,
      detectFn: () => ({
        phase: RECOVERY_STATES.PARTIAL_MERGE,
        detail: {},
      }),
      restartFn: (opts) => restartCalls.push(opts),
      progress,
      logger: makeStubLogger(),
    });
    assert.equal(result.action, RECOVERY_ACTIONS.RESTART);
    assert.equal(restartCalls.length, 1);
    assert.equal(restartCalls[0].cwd, '/repo');
    assert.equal(restartCalls[0].storyBranch, 'story-100');
    assert.ok(
      events.some(
        (e) => e.msg.includes('--restart') && e.msg.includes('partial-merge'),
      ),
    );
  });

  await t.test('emits the matching resume progress line per state', () => {
    const cases = [
      {
        phase: RECOVERY_STATES.PARTIAL_MERGE,
        flag: 'resumeFromConflict',
        snippet: 'conflict',
        resume: true,
      },
      {
        phase: RECOVERY_STATES.PUSHED_UNMERGED,
        flag: 'resumeFromMerge',
        snippet: 'from merge',
        resume: true,
      },
      {
        phase: RECOVERY_STATES.UNCOMMITTED_WORKTREE,
        flag: 'resumeFromValidate',
        snippet: 'from validate',
        resume: true,
      },
      {
        phase: RECOVERY_STATES.ALREADY_MERGED,
        flag: 'resumeFromPostMerge',
        snippet: 'already landed',
        resume: false, // no flag required — auto-recovery
      },
    ];
    for (const { phase, flag, snippet, resume } of cases) {
      const { fn, events } = captureProgress();
      const result = dispatchRecovery({
        ...DISPATCH_BASE,
        resume,
        detectFn: () => ({ phase, detail: {} }),
        progress: fn,
        logger: makeStubLogger(),
      });
      assert.equal(result[flag], true, `${flag} should be true for ${phase}`);
      assert.ok(
        events.some((e) => e.msg.toLowerCase().includes(snippet)),
        `expected progress containing "${snippet}" for ${phase}, got ${JSON.stringify(events)}`,
      );
    }
  });

  await t.test('--resume + --restart together calls logger.fatal', () => {
    const logger = makeStubLogger();
    assert.throws(
      () =>
        dispatchRecovery({
          ...DISPATCH_BASE,
          resume: true,
          restart: true,
          detectFn: () => ({ phase: RECOVERY_STATES.FRESH, detail: {} }),
          logger,
        }),
      /mutually exclusive/,
    );
  });
});
