/**
 * run-gates-and-refresh-config-forwarding.test.js
 *
 * Story #3973 — regression guard for the `config` plumbing between the
 * locked close pipeline and the pre-merge gate builder.
 *
 * The original bug: `runGatesAndRefresh` forwarded `agentSettings` to
 * `runPreMergeValidation` but NOT the canonical `config`, so the gate
 * builder received `config === undefined` and the typecheck gate ignored
 * `project.commands.typecheck`, silently falling back to the hardcoded
 * `npm run typecheck`. Any consumer with a non-default typecheck command
 * (e.g. a monorepo running `pnpm exec turbo run typecheck`) had every Story
 * close blocked at the typecheck gate.
 *
 * The leaf test in `tests/story-close.test.js` only exercises
 * `buildDefaultGates` in isolation — it would still pass if someone deleted
 * `config: ctx.config` from `runGatesAndRefresh`. This test guards the
 * FORWARDING by driving `runGatesAndRefresh` directly with an injected
 * `runPreMergeValidation` spy and asserting the spy receives the consumer's
 * configured typecheck command. It FAILS if the forwarding line is removed.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { runGatesAndRefresh } from '../../../../.agents/scripts/lib/orchestration/story-close/phases/locked-pipeline.js';

const CONFIGURED_TYPECHECK = 'pnpm exec turbo run typecheck';

/**
 * Build a locked-pipeline `ctx` carrying a `config` whose
 * `project.commands.typecheck` is a non-default command — the exact shape a
 * monorepo consumer declares in `.agentrc.json`.
 */
function makeCtx() {
  return {
    cwd: '/repo',
    worktreePath: '/repo/.worktrees/story-3973',
    epicBranch: 'main',
    storyBranch: 'story-3973',
    config: {
      project: { commands: { typecheck: CONFIGURED_TYPECHECK } },
    },
    storyId: 3973,
    epicId: null,
    noEvidenceFlag: false,
    phaseTimer: { mark: () => {} },
    provider: {},
    bus: { emit: async () => {} },
    progress: () => {},
  };
}

describe('runGatesAndRefresh — config forwarding to pre-merge validation', () => {
  it('forwards ctx.config (carrying project.commands.typecheck) to runPreMergeValidation', async () => {
    // Arrange: a spy standing in for runPreMergeValidation that returns a
    // clean gate outcome so the auto-refresh tail is reached harmlessly.
    const runPreMergeValidationFn = mock.fn(async () => ({ status: 'ok' }));
    const runAutoRefreshSafelyFn = mock.fn(async () => {});
    const ctx = makeCtx();

    // Act: drive the gate phase with the injected validation seam, plus an
    // injected no-op refresh so the test stays pure (no real baseline I/O).
    const result = await runGatesAndRefresh(ctx, {
      runPreMergeValidationFn,
      runAutoRefreshSafelyFn,
    });

    // Assert: the gate phase did not block, and the validation seam received
    // the canonical config with the consumer's configured typecheck command.
    // This is the contract the forwarding line `config: ctx.config` upholds —
    // delete it and `forwarded.config` becomes undefined, failing this test.
    assert.deepEqual(result, { blocked: null });
    assert.equal(runPreMergeValidationFn.mock.callCount(), 1);
    const forwarded = runPreMergeValidationFn.mock.calls[0].arguments[0];
    assert.ok(
      forwarded.config,
      'runPreMergeValidation must receive a config object (forwarding regressed if undefined)',
    );
    assert.equal(
      forwarded.config?.project?.commands?.typecheck,
      CONFIGURED_TYPECHECK,
      'the configured typecheck command must reach the gate builder via config forwarding',
    );
  });

  it('passes the same config through to the bounded baseline auto-refresh tail', async () => {
    // The auto-refresh tail also reads ctx.config; a second spy proves the
    // clean-outcome path threads config all the way through, not just into
    // the gate runner.
    const runPreMergeValidationFn = mock.fn(async () => ({ status: 'ok' }));
    const runAutoRefreshSafelyFn = mock.fn(async () => {});
    const ctx = makeCtx();

    await runGatesAndRefresh(ctx, {
      runPreMergeValidationFn,
      runAutoRefreshSafelyFn,
    });

    // Same object identity as ctx.config — forwarded by reference into the
    // gate runner, never reconstructed or dropped.
    const forwardedToGates = runPreMergeValidationFn.mock.calls[0].arguments[0];
    assert.strictEqual(forwardedToGates.config, ctx.config);

    // And the refresh tail receives the same canonical config.
    assert.equal(runAutoRefreshSafelyFn.mock.callCount(), 1);
    const forwardedToRefresh =
      runAutoRefreshSafelyFn.mock.calls[0].arguments[0];
    assert.strictEqual(forwardedToRefresh.config, ctx.config);
  });
});
