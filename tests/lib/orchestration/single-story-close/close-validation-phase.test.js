import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runCloseValidationPhase } from '../../../../.agents/scripts/lib/orchestration/single-story-close/phases/close-validation.js';

/**
 * Story #4250 — standalone close-validation phase.
 *
 * Two contracts:
 *   1. The phase passes `standalone: true` (not `epicId: null`) into
 *      `runCloseValidation`, so the storyId-anchored evidence keyspace is
 *      consulted instead of the structurally-disabled Epic-keyed path.
 *   2. The phase runs `runScopedFormatAutofix` (with `baseBranch` as the diff
 *      anchor and the worktree as the commit target) BEFORE the gate chain.
 */

function noopProgress() {}

describe('runCloseValidationPhase — standalone parity (Story #4250)', () => {
  it('passes standalone:true into runCloseValidation (not epicId)', async () => {
    let observed = null;
    await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-4250',
      config: {},
      baseBranch: 'main',
      storyBranch: 'story-4250',
      storyId: 4250,
      progress: noopProgress,
      runCloseValidation: (opts) => {
        observed = opts;
        return { ok: true, failed: [], skipped: [] };
      },
      buildDefaultGates: () => [
        { name: 'lint', cmd: 'npm', args: ['run', 'lint'] },
      ],
      runScopedFormatAutofix: () => ({ ran: false, committed: false }),
    });
    assert.equal(observed.standalone, true);
    assert.equal(observed.storyId, 4250);
    // The phase must NOT thread a positive/zero epicId into the Epic path.
    assert.ok(
      observed.epicId == null,
      'standalone phase must not feed an epicId into runCloseValidation',
    );
  });

  it('runs scoped format-autofix before validation with baseBranch as the diff anchor', async () => {
    const order = [];
    const autofixArgs = [];
    await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-4250',
      config: {},
      baseBranch: 'main',
      storyBranch: 'story-4250',
      storyId: 4250,
      progress: noopProgress,
      runCloseValidation: () => {
        order.push('validate');
        return { ok: true, failed: [], skipped: [] };
      },
      buildDefaultGates: () => [],
      runScopedFormatAutofix: (args) => {
        order.push('autofix');
        autofixArgs.push(args);
        return { ran: true, committed: false };
      },
    });
    assert.deepEqual(
      order,
      ['autofix', 'validate'],
      'format-autofix must run before the gate chain',
    );
    assert.equal(autofixArgs[0].baseBranch, 'main');
    assert.equal(autofixArgs[0].storyBranch, 'story-4250');
    assert.equal(
      autofixArgs[0].worktreePath,
      '/main/repo/.worktrees/story-4250',
      'autofix must target the Story worktree',
    );
  });

  it('skips scoped format-autofix when no storyBranch is supplied', async () => {
    let autofixCalled = false;
    await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: null,
      config: {},
      baseBranch: 'main',
      storyBranch: undefined,
      storyId: 4250,
      progress: noopProgress,
      runCloseValidation: () => ({ ok: true, failed: [], skipped: [] }),
      buildDefaultGates: () => [],
      runScopedFormatAutofix: () => {
        autofixCalled = true;
        return { ran: false, committed: false };
      },
    });
    assert.equal(
      autofixCalled,
      false,
      'autofix must be skipped without a story branch',
    );
  });

  it('swallows a format-autofix throw (best-effort self-heal) and still validates', async () => {
    let validated = false;
    await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-4250',
      config: {},
      baseBranch: 'main',
      storyBranch: 'story-4250',
      storyId: 4250,
      progress: noopProgress,
      runCloseValidation: () => {
        validated = true;
        return { ok: true, failed: [], skipped: [] };
      },
      buildDefaultGates: () => [],
      runScopedFormatAutofix: () => {
        throw new Error('git diff failed: missing ref');
      },
    });
    assert.equal(
      validated,
      true,
      'a format-autofix throw must not abort the close-validation phase',
    );
  });

  it('throws on a failed gate with the gate name and hint', async () => {
    await assert.rejects(
      () =>
        runCloseValidationPhase({
          cwd: '/main/repo',
          worktreePath: '/main/repo/.worktrees/story-4250',
          config: {},
          baseBranch: 'main',
          storyBranch: 'story-4250',
          storyId: 4250,
          progress: noopProgress,
          runCloseValidation: () => ({
            ok: false,
            failed: [
              {
                gate: { name: 'lint', hint: 'fix lint' },
                status: 2,
                cwd: '/main/repo/.worktrees/story-4250',
              },
            ],
            skipped: [],
          }),
          buildDefaultGates: () => [],
          runScopedFormatAutofix: () => ({ ran: false, committed: false }),
        }),
      (err) =>
        err instanceof Error &&
        err.message.includes('lint') &&
        err.message.includes('fix lint'),
    );
  });
});
