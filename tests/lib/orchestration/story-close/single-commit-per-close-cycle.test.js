/**
 * single-commit-per-close-cycle.test.js — Story #2205 / Task #2219.
 *
 * Pins AC-9: across a 3-attempt synthetic retry sequence (fail, fail,
 * pass), at most one `chore(baselines): refresh <kind> for story-<id>`
 * commit lands on the Story branch. Subsumes and extends the original
 * #2176 fixture so the single-commit invariant survives the migration
 * to `refreshBaseline()`-routed attribution refreshes.
 *
 * Two scenarios:
 *
 *   1. Pre-merge gates fail on attempts 1 and 2 (each triggering an
 *      attributable baseline-drift refresh), pass on attempt 3 → exactly
 *      ONE baseline-refresh commit lands. The second refresh attempt
 *      MUST short-circuit via the `cycleState.refreshedKinds`
 *      idempotency token; no sibling commit is emitted.
 *
 *   2. No in-scope drift exists (regressions list is empty per attempt)
 *      → the runner short-circuits with `action: 'rethrow'`, the close
 *      surfaces the original failure, and ZERO baseline-refresh commits
 *      were attempted along the way.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  handleBaselineGateFailure,
  runPreMergeGatesWithAttribution,
} from '../../../../.agents/scripts/lib/orchestration/story-close/baseline-attribution-wiring.js';

const STORY_ID = 2205;
const EPIC_BRANCH = 'epic/2173';
const STORY_BRANCH = 'story-2205';
const AGENT_SETTINGS = {
  paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
  quality: {
    baselines: {
      maintainability: { path: 'baselines/maintainability.json' },
      crap: { path: 'baselines/crap.json' },
    },
  },
};

describe('AC-9 single-baseline-refresh-commit-per-close-cycle invariant', () => {
  it('synthetic 3-attempt retry (fail, fail, pass) lands exactly 1 baseline-refresh commit', async () => {
    const start = Date.now();

    // Drive runPreMergeGates: throw a baseline-gate failure twice, then
    // succeed on attempt 3.
    let preMergeAttempts = 0;
    const runPreMergeGates = () => {
      preMergeAttempts += 1;
      if (preMergeAttempts < 3) {
        const err = new Error(
          'Pre-merge validation failed at "check-maintainability" (exit 1).',
        );
        err.gateName = 'check-maintainability';
        err.exitCode = 1;
        throw err;
      }
      // Attempt 3 → success
    };

    // Record every git call across the whole retry sequence so we can
    // count commits at the end.
    const allGitCalls = [];
    const gitSpawn = (cwd, ...args) => {
      allGitCalls.push({ cwd, args });
      const key = args.join(' ');
      // Story-diff (attribution classifier) — touched-file present so the
      // regression is treated as attributable.
      if (key === `diff --name-only origin/${EPIC_BRANCH}...${STORY_BRANCH}`) {
        return { status: 0, stdout: 'lib/touched.js\n' };
      }
      // Post-refresh staging
      if (key === 'add baselines/maintainability.json') return { status: 0 };
      // diff --cached --exit-code → drift on the first refresh attempt.
      if (
        key ===
        'diff --cached --exit-code -- baselines/maintainability.json'
      ) {
        return { status: 1, stdout: 'drift\n' };
      }
      // Commit
      if (
        key ===
        `commit -m chore(baselines): refresh maintainability for story-${STORY_ID}`
      ) {
        return { status: 0 };
      }
      if (key === 'rev-parse --short HEAD') {
        return { status: 0, stdout: `sha-${preMergeAttempts}` };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    // Stub the refresh-service so it always "wrote" the baseline.
    const refreshBaseline = async (opts) => ({
      kind: opts.kind,
      writePath: opts.writePath,
      wrote: true,
    });

    // Bridge handleBaselineGateFailure to the runner's defaults but
    // inject our git + service stubs (deps wins over real surfaces).
    const handleBaselineGateFailureFn = async (input) =>
      handleBaselineGateFailure({
        ...input,
        deps: {
          gitRunner: { gitSpawn },
          refreshBaseline,
          scorerBuilder: () => () => async () => [],
        },
      });

    const result = await runPreMergeGatesWithAttribution({
      cwd: '/repo',
      worktreePath: '/repo',
      epicBranch: EPIC_BRANCH,
      storyBranch: STORY_BRANCH,
      agentSettings: AGENT_SETTINGS,
      storyId: STORY_ID,
      epicId: 2173,
      useEvidence: false,
      provider: {},
      runPreMergeGates,
      handleBaselineGateFailureFn,
      projectRegressionsFn: ({ gateName }) =>
        gateName === 'check-maintainability'
          ? [{ path: 'lib/touched.js' }]
          : [],
      maxAttempts: 3,
    });

    assert.equal(result.status, 'ok');
    assert.equal(preMergeAttempts, 3);

    // AC: exactly one `chore(baselines): refresh ...` commit across the
    // entire retry sequence. The second refresh attempt must have
    // short-circuited via the cycleState idempotency token.
    const refreshCommits = allGitCalls.filter(
      (c) =>
        c.args[0] === 'commit' &&
        c.args[1] === '-m' &&
        typeof c.args[2] === 'string' &&
        c.args[2].startsWith('chore(baselines): refresh '),
    );
    assert.equal(
      refreshCommits.length,
      1,
      `expected exactly 1 refresh commit, saw ${refreshCommits.length}`,
    );

    // No `--amend` / `--allow-empty` was ever issued.
    for (const call of allGitCalls) {
      assert.equal(
        call.args.includes('--amend'),
        false,
        `git received --amend: ${JSON.stringify(call.args)}`,
      );
      assert.equal(
        call.args.includes('--allow-empty'),
        false,
        `git received --allow-empty: ${JSON.stringify(call.args)}`,
      );
    }

    // Test performance budget — must run under 15s on local hardware.
    const elapsedMs = Date.now() - start;
    assert.ok(
      elapsedMs < 15_000,
      `single-commit fixture must complete < 15s; ran ${elapsedMs}ms`,
    );
  });

  it('no in-scope drift (empty regressions) → 0 baseline-refresh commits, original failure rethrown', async () => {
    let preMergeAttempts = 0;
    const runPreMergeGates = () => {
      preMergeAttempts += 1;
      const err = new Error(
        'Pre-merge validation failed at "check-maintainability" (exit 1).',
      );
      err.gateName = 'check-maintainability';
      err.exitCode = 1;
      throw err;
    };

    const allGitCalls = [];
    const gitSpawn = (cwd, ...args) => {
      allGitCalls.push({ cwd, args });
      return { status: 0, stdout: '' };
    };

    const refreshBaseline = async () => {
      throw new Error('refreshBaseline must not fire on the empty-drift path');
    };

    const handleBaselineGateFailureFn = async (input) =>
      handleBaselineGateFailure({
        ...input,
        deps: {
          gitRunner: { gitSpawn },
          refreshBaseline,
          scorerBuilder: () => () => async () => [],
        },
      });

    await assert.rejects(
      runPreMergeGatesWithAttribution({
        cwd: '/repo',
        worktreePath: '/repo',
        epicBranch: EPIC_BRANCH,
        storyBranch: STORY_BRANCH,
        agentSettings: AGENT_SETTINGS,
        storyId: STORY_ID,
        epicId: 2173,
        useEvidence: false,
        provider: {},
        runPreMergeGates,
        handleBaselineGateFailureFn,
        // No regressions → handleBaselineGateFailure returns
        // `{ action: 'rethrow' }` and the original gate error surfaces.
        projectRegressionsFn: () => [],
        maxAttempts: 3,
      }),
      /failed at "check-maintainability"/,
    );

    // First attempt fails, classifier sees empty regressions, throws
    // rethrow → no retry, no refresh.
    assert.equal(preMergeAttempts, 1);

    const refreshCommits = allGitCalls.filter(
      (c) =>
        c.args[0] === 'commit' &&
        c.args[1] === '-m' &&
        typeof c.args[2] === 'string' &&
        c.args[2].startsWith('chore(baselines): refresh '),
    );
    assert.equal(
      refreshCommits.length,
      0,
      'no baseline-refresh commits when no in-scope drift exists',
    );
  });
});
