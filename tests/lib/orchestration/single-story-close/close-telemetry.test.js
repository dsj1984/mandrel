/**
 * Story #5435 — per-Story close telemetry: one `retry` signal per non-landed
 * close (with its cause), code-review halts and overrides attributed to the
 * review provider that raised the critical findings, the host-reported
 * worker token total, and the `telemetry` summary close's result carries.
 *
 * Every write goes to an absolute per-test tempRoot and is read back through
 * the same reader the roll-up uses (`forEachLine(null, sid, …)`), so a record
 * written where nothing looks — or dropped as schema-invalid — fails here.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { parseWorkerTokens } from '../../../../.agents/scripts/lib/cli-args.js';
import {
  buildCloseTelemetry,
  emitCloseRetrySignal,
  emitCloseTerminalSignals,
  emitReviewBlockedFriction,
  gatherRunTelemetry,
} from '../../../../.agents/scripts/lib/observability/close-telemetry.js';
import {
  emitRuntimeFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../../.agents/scripts/lib/observability/runtime-friction.js';
import { validateSignal } from '../../../../.agents/scripts/lib/observability/signal-validator.js';
import {
  appendSignal,
  forEachLine,
} from '../../../../.agents/scripts/lib/observability/signals-writer.js';
import { runCodeReview } from '../../../../.agents/scripts/lib/orchestration/code-review.js';
import { createChainProvider } from '../../../../.agents/scripts/lib/orchestration/review-providers/review-provider-factory.js';
import { handleOverriddenReviewBlock } from '../../../../.agents/scripts/lib/orchestration/single-story-close/phases/review-override.js';
import { runSingleStoryClose } from '../../../../.agents/scripts/lib/orchestration/single-story-close/runner.js';
import { makeTempDir } from '../../../../.agents/scripts/lib/test-temp.js';

let tempRoot;
let config;

beforeEach(async () => {
  tempRoot = await makeTempDir('close-telemetry-');
  config = { project: { paths: { tempRoot } } };
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function readStorySignals(storyId) {
  const rows = [];
  await forEachLine(null, storyId, (parsed) => rows.push(parsed), config);
  return rows;
}

function retryRows(rows) {
  return rows.filter((r) => r.kind === 'retry');
}

function envelope(overrides) {
  return {
    kind: 'story-deliver-terminal',
    storyId: 7101,
    phase: 'done',
    nextCommand: null,
    elapsedSeconds: 1,
    ...overrides,
  };
}

/** A provider whose every mutation is a recorded no-op. */
function inertProvider() {
  return {
    getTicket: async (id) => ({ id, labels: [], title: 't', body: '' }),
    getTicketComments: async () => [],
    postComment: async () => ({ commentId: 1 }),
    updateComment: async () => ({}),
    deleteComment: async () => {},
    updateTicket: async () => ({}),
  };
}

describe('AC-1: one retry signal per non-landed close, with its cause', () => {
  const cases = [
    [
      'blocked · checks-failed',
      {
        status: 'blocked',
        blocked: { blockClass: 'checks-failed', reason: 'r' },
      },
      'ci-red',
    ],
    [
      'blocked · checks-pending-timeout',
      {
        status: 'blocked',
        blocked: { blockClass: 'checks-pending-timeout', reason: 'r' },
      },
      'merge-wait',
    ],
    [
      'blocked · api-race-other',
      {
        status: 'blocked',
        blocked: { blockClass: 'api-race-other', reason: 'r' },
      },
      'other',
    ],
    [
      'failed · code-review',
      { status: 'failed', phase: 'code-review', failure: { reason: 'r' } },
      'review-block',
    ],
    [
      'failed · close-validation',
      { status: 'failed', phase: 'close-validation', failure: { reason: 'r' } },
      'gate-failed',
    ],
    [
      'failed · push',
      { status: 'failed', phase: 'push', failure: { reason: 'r' } },
      'other',
    ],
  ];

  for (const [label, overrides, cause] of cases) {
    it(`${label} → exactly one retry record, cause ${cause}`, async () => {
      const appended = await emitCloseRetrySignal({
        envelope: envelope(overrides),
        config,
      });
      assert.equal(appended, true);
      const retries = retryRows(await readStorySignals(7101));
      assert.equal(retries.length, 1);
      assert.equal(retries[0].details.cause, cause);
      assert.equal(retries[0].storyId, 7101);
      assert.equal(validateSignal(retries[0]).valid, true);
    });
  }

  for (const status of ['landed', 'pending']) {
    it(`a ${status} close appends no retry record`, async () => {
      const appended = await emitCloseRetrySignal({
        envelope: envelope({ status }),
        config,
      });
      assert.equal(appended, false);
      assert.equal(retryRows(await readStorySignals(7101)).length, 0);
    });
  }
});

describe('AC-2: review halts and overrides name the contributing provider', () => {
  it('the chain attributes critical findings to the entry that raised them', async () => {
    const entry = (name, findings) => ({
      name,
      gate: () => true,
      provider: { runReview: async () => findings },
    });
    const chain = createChainProvider({
      inline: [
        entry('native', [{ severity: 'high', title: 'h', body: 'b' }]),
        entry('code-review', [
          { severity: 'critical', title: 'c1', body: 'b' },
          { severity: 'critical', title: 'c2', body: 'b' },
        ]),
        entry('security-review', [
          { severity: 'critical', title: 's1', body: 'b' },
        ]),
      ],
      prompts: [],
    });

    const result = await runCodeReview({
      ticketId: 7102,
      baseRef: 'origin/main',
      headRef: 'story-7102',
      commentTargetId: 99,
      changedFiles: ['a.js'],
      provider: inertProvider(),
      reviewProvider: chain,
      resolveConfigFn: () => ({}),
      upsertCommentFn: async () => ({ commentId: 1 }),
      renderFindingsFn: () => 'report',
    });

    assert.equal(result.halted, true);
    assert.deepEqual(result.criticalByProvider, {
      'code-review': 2,
      'security-review': 1,
    });
  });

  it('a non-chain provider owns every critical finding', async () => {
    const result = await runCodeReview({
      ticketId: 7102,
      baseRef: 'origin/main',
      headRef: 'story-7102',
      changedFiles: ['a.js'],
      provider: inertProvider(),
      reviewProvider: {
        runReview: async () => [
          { severity: 'critical', title: 'c', body: 'b' },
        ],
      },
      resolveConfigFn: () => ({}),
      upsertCommentFn: async () => ({ commentId: 1 }),
      renderFindingsFn: () => 'report',
    });
    assert.deepEqual(Object.values(result.criticalByProvider), [1]);
  });

  it('a critical halt emits review-blocked friction naming each provider and count', async () => {
    await emitReviewBlockedFriction({
      storyId: 7103,
      prNumber: 1,
      criticalCount: 3,
      criticalByProvider: { 'code-review': 2, native: 1 },
      config,
    });
    const rows = (await readStorySignals(7103)).filter(
      (r) => r.category === RUNTIME_FRICTION_CATEGORIES.REVIEW_BLOCKED,
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].details.criticalByProvider, {
      'code-review': 2,
      native: 1,
    });
    assert.equal(rows[0].details.criticalCount, 3);
  });

  it('an override carries the same per-provider attribution', async () => {
    await handleOverriddenReviewBlock({
      provider: inertProvider(),
      storyId: 7104,
      prUrl: 'https://github.com/o/r/pull/2',
      prNumber: null,
      criticalCount: 2,
      criticalByProvider: { 'code-review': 2 },
      reason: 'the finding misreads the guard clause',
      config,
    });
    const rows = (await readStorySignals(7104)).filter(
      (r) => r.category === RUNTIME_FRICTION_CATEGORIES.REVIEW_BLOCK_OVERRIDDEN,
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].details.criticalByProvider, { 'code-review': 2 });
  });
});

describe('AC-3: --worker-tokens is best-effort', () => {
  it('accepts a non-negative integer', () => {
    assert.deepEqual(parseWorkerTokens('184233'), {
      tokens: 184233,
      warning: null,
    });
    assert.deepEqual(parseWorkerTokens(0), { tokens: 0, warning: null });
  });

  for (const junk of [undefined, null, '12.5', 'abc', '-3', true, '12k']) {
    it(`records null with a warning for ${JSON.stringify(junk)}`, () => {
      const { tokens, warning } = parseWorkerTokens(junk);
      assert.equal(tokens, null);
      assert.match(warning, /--worker-tokens/);
    });
  }
});

describe('AC-4: the telemetry summary', () => {
  async function seedStory(storyId) {
    for (const round of [1, 2]) {
      await appendSignal({
        epicId: null,
        storyId,
        config,
        signal: {
          kind: 'acceptance-eval',
          ts: new Date().toISOString(),
          epicId: null,
          storyId,
          phase: 'implement',
          emitter: { tool: 'acceptance-eval.js' },
          details: { decision: round === 1 ? 'redraft' : 'proceed', round },
        },
      });
    }
    await emitCloseRetrySignal({
      envelope: envelope({
        storyId,
        status: 'failed',
        phase: 'code-review',
        failure: { reason: 'r' },
      }),
      config,
    });
    await emitRuntimeFriction({
      storyId,
      category: RUNTIME_FRICTION_CATEGORIES.REVIEW_BLOCKED,
      tool: 'single-story-close',
      details: { criticalByProvider: { 'code-review': 2, native: 1 } },
      config,
    });
    await emitRuntimeFriction({
      storyId,
      category: RUNTIME_FRICTION_CATEGORIES.REVIEW_BLOCK_OVERRIDDEN,
      tool: 'single-story-close',
      details: { criticalByProvider: { 'code-review': 2 } },
      config,
    });
  }

  it('reports acceptance rounds, retries by cause, halts/overrides by provider and worker tokens', async () => {
    await seedStory(7105);
    const telemetry = await buildCloseTelemetry({
      storyId: 7105,
      config,
      workerTokens: 5000,
      landed: true,
    });
    assert.deepEqual(telemetry, {
      acceptanceRounds: 2,
      retries: { total: 1, byCause: { 'review-block': 1 } },
      review: {
        haltsByProvider: { 'code-review': 1, native: 1 },
        overridesByProvider: { 'code-review': 1 },
        // native's halt was never overridden and the Story landed.
        confirmedHaltsByProvider: { native: 1 },
      },
      workerTokens: 5000,
    });
  });

  it('an unlanded Story confirms no halt; invalid tokens record null', async () => {
    await seedStory(7106);
    const telemetry = await buildCloseTelemetry({
      storyId: 7106,
      config,
      workerTokens: null,
    });
    assert.deepEqual(telemetry.review.confirmedHaltsByProvider, {});
    assert.equal(telemetry.workerTokens, null);
  });

  it('run-level tallies sum per-Story ones', async () => {
    await seedStory(7107);
    await seedStory(7108);
    const run = await gatherRunTelemetry([7107, '7108', 'junk'], config);
    assert.equal(run.storyCount, 2);
    assert.equal(run.acceptanceRounds, 4);
    assert.deepEqual(run.retries, { total: 2, byCause: { 'review-block': 2 } });
    assert.deepEqual(run.review.haltsByProvider, {
      'code-review': 2,
      native: 2,
    });
    assert.deepEqual(run.review.overridesByProvider, { 'code-review': 2 });
  });
});

describe('AC-3/AC-4/AC-6: through the close runner', () => {
  function closedStoryProvider(stateReason) {
    return {
      ...inertProvider(),
      getTicket: async (id) => ({
        id,
        state: 'closed',
        stateReason,
        labels: [],
        title: 't',
        body: '',
      }),
    };
  }

  it('a not-planned (failed) close appends one retry and reports it with the worker tokens', async () => {
    const outcome = await runSingleStoryClose({
      storyId: 7109,
      cwd: tempRoot,
      workerTokens: '4242',
      injectedConfig: config,
      injectedProvider: closedStoryProvider('not_planned'),
    });
    assert.equal(outcome.terminal.status, 'failed');
    assert.equal(retryRows(await readStorySignals(7109)).length, 1);
    assert.equal(outcome.result.telemetry.workerTokens, 4242);
    assert.deepEqual(outcome.result.telemetry.retries, {
      total: 1,
      byCause: { other: 1 },
    });
  });

  it('a landed close appends no retry; an invalid token value leaves the status unchanged', async () => {
    const outcome = await runSingleStoryClose({
      storyId: 7110,
      cwd: tempRoot,
      workerTokens: 'not-a-number',
      injectedConfig: config,
      injectedProvider: closedStoryProvider('completed'),
    });
    assert.equal(outcome.terminal.status, 'landed');
    assert.equal(outcome.success, true);
    assert.equal(outcome.result.telemetry.workerTokens, null);
    assert.equal(retryRows(await readStorySignals(7110)).length, 0);
  });
});

describe('AC-6: a telemetry write failure never changes the close', () => {
  it('a throwing retry append resolves false', async () => {
    const appended = await emitCloseRetrySignal({
      envelope: envelope({ status: 'failed', phase: 'push' }),
      config,
      appendFn: async () => {
        throw new Error('disk full');
      },
    });
    assert.equal(appended, false);
  });

  it('a throwing signal read yields an empty summary, not a throw', async () => {
    const telemetry = await buildCloseTelemetry({
      storyId: 7111,
      config,
      workerTokens: 1,
      readFn: async () => {
        throw new Error('EIO');
      },
    });
    assert.equal(telemetry.acceptanceRounds, 0);
    assert.equal(telemetry.retries.total, 0);
    assert.equal(telemetry.workerTokens, 1);
  });

  it('an unwritable signal stream never throws out of any telemetry write', async () => {
    // A FILE where the temp directory should be: every append fails.
    const blocker = `${tempRoot}/not-a-dir`;
    await fs.writeFile(blocker, 'x');
    const broken = { project: { paths: { tempRoot: blocker } } };
    const failed = envelope({ status: 'failed', phase: 'push' });

    assert.equal(
      await emitCloseRetrySignal({ envelope: failed, config: broken }),
      false,
    );
    assert.equal(
      await emitReviewBlockedFriction({
        storyId: 7112,
        prNumber: 3,
        criticalCount: 1,
        criticalByProvider: { native: 1 },
        config: broken,
      }),
      false,
    );
    await assert.doesNotReject(
      emitCloseTerminalSignals({ envelope: failed, config: broken }),
    );
  });
});
