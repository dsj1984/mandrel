import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyPollResult,
  classifyPrWatchInvocation,
  normalizeCheckResult,
  parsePrWatchArgs,
  runPrWatchWithUpdate,
} from '../../.agents/scripts/pr-watch-with-update.js';

const silentLogger = { info: () => {}, error: () => {}, warn: () => {} };

describe('parsePrWatchArgs', () => {
  it('parses --pr / --repo / --max-updates / --poll-interval-ms / --dry-run', () => {
    const out = parsePrWatchArgs([
      '--pr',
      '42',
      '--repo',
      'owner/repo',
      '--max-updates',
      '5',
      '--poll-interval-ms',
      '500',
      '--dry-run',
    ]);
    assert.deepEqual(out, {
      prNumber: 42,
      repo: 'owner/repo',
      maxUpdates: 5,
      pollIntervalMs: 500,
      dryRun: true,
      help: false,
    });
  });

  it('defaults maxUpdates to 3 and pollIntervalMs to 10000 when omitted', () => {
    const out = parsePrWatchArgs(['--pr', '7']);
    assert.equal(out.maxUpdates, 3);
    assert.equal(out.pollIntervalMs, 10000);
    assert.equal(out.repo, null);
    assert.equal(out.dryRun, false);
  });

  it('returns prNumber=null when --pr is missing or invalid', () => {
    assert.equal(parsePrWatchArgs([]).prNumber, null);
    assert.equal(parsePrWatchArgs(['--pr', 'abc']).prNumber, null);
    assert.equal(parsePrWatchArgs(['--pr', '0']).prNumber, null);
  });
});

describe('classifyPrWatchInvocation', () => {
  it('returns help when --help is set', () => {
    assert.deepEqual(classifyPrWatchInvocation({ help: true }), {
      kind: 'help',
    });
  });

  it('returns usage-error when --pr is missing', () => {
    const r = classifyPrWatchInvocation({
      help: false,
      prNumber: null,
      repo: null,
      maxUpdates: 3,
      pollIntervalMs: 10000,
      dryRun: false,
    });
    assert.equal(r.kind, 'usage-error');
    assert.ok(r.messages.some((m) => /required/.test(m)));
  });

  it('returns run intent when all required args present', () => {
    const r = classifyPrWatchInvocation({
      help: false,
      prNumber: 12,
      repo: 'o/r',
      maxUpdates: 3,
      pollIntervalMs: 10000,
      dryRun: false,
    });
    assert.deepEqual(r, {
      kind: 'run',
      prNumber: 12,
      repo: 'o/r',
      maxUpdates: 3,
      pollIntervalMs: 10000,
      dryRun: false,
    });
  });
});

describe('normalizeCheckResult', () => {
  it('returns conclusion when a check-run is COMPLETED', () => {
    assert.equal(
      normalizeCheckResult({ status: 'COMPLETED', conclusion: 'SUCCESS' }),
      'SUCCESS',
    );
    assert.equal(
      normalizeCheckResult({ status: 'COMPLETED', conclusion: 'FAILURE' }),
      'FAILURE',
    );
  });

  it('returns status when a check-run is still in-flight', () => {
    assert.equal(
      normalizeCheckResult({ status: 'IN_PROGRESS', conclusion: null }),
      'IN_PROGRESS',
    );
    assert.equal(
      normalizeCheckResult({ status: 'QUEUED', conclusion: null }),
      'QUEUED',
    );
  });

  it('returns state for status-check entries', () => {
    assert.equal(normalizeCheckResult({ state: 'SUCCESS' }), 'SUCCESS');
    assert.equal(normalizeCheckResult({ state: 'PENDING' }), 'PENDING');
  });

  it('returns PENDING for unknown / empty shapes', () => {
    assert.equal(normalizeCheckResult(null), 'PENDING');
    assert.equal(normalizeCheckResult({}), 'PENDING');
  });
});

describe('classifyPollResult', () => {
  it('returns merged when state === MERGED', () => {
    assert.deepEqual(classifyPollResult({ state: 'MERGED' }), {
      kind: 'merged',
    });
  });

  it('returns closed when state === CLOSED', () => {
    assert.deepEqual(classifyPollResult({ state: 'CLOSED' }), {
      kind: 'closed',
    });
  });

  it('returns check-failure when any check has a failure result', () => {
    const r = classifyPollResult({
      state: 'OPEN',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [
        { name: 'lint', state: 'SUCCESS' },
        { name: 'test', state: 'FAILURE' },
      ],
    });
    assert.equal(r.kind, 'check-failure');
    assert.deepEqual(r.failed, ['test: FAILURE']);
  });

  it('returns wait when checks are still pending', () => {
    assert.deepEqual(
      classifyPollResult({
        state: 'OPEN',
        mergeStateStatus: 'BEHIND',
        statusCheckRollup: [
          { name: 'lint', state: 'SUCCESS' },
          { name: 'test', state: 'PENDING' },
        ],
      }),
      { kind: 'wait' },
    );
  });

  it('returns green-behind when all checks green AND mergeStateStatus BEHIND', () => {
    assert.deepEqual(
      classifyPollResult({
        state: 'OPEN',
        mergeStateStatus: 'BEHIND',
        statusCheckRollup: [
          { name: 'lint', state: 'SUCCESS' },
          { name: 'test', state: 'SUCCESS' },
        ],
      }),
      { kind: 'green-behind' },
    );
  });

  it('returns green-clean when all checks green AND mergeStateStatus CLEAN', () => {
    assert.deepEqual(
      classifyPollResult({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ name: 'lint', state: 'SUCCESS' }],
      }),
      { kind: 'green-clean' },
    );
  });

  it('returns wait when checks green but mergeStateStatus is BLOCKED / UNKNOWN', () => {
    assert.deepEqual(
      classifyPollResult({
        state: 'OPEN',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [{ name: 'lint', state: 'SUCCESS' }],
      }),
      { kind: 'wait' },
    );
  });

  it('returns wait when rollup is empty (no checks reported yet)', () => {
    assert.deepEqual(
      classifyPollResult({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [],
      }),
      { kind: 'wait' },
    );
  });
});

/** Helper: build a sequential ghViewFn from a list of canned poll outcomes. */
function scriptedGhView(states) {
  let i = 0;
  return () => {
    const next = states[Math.min(i, states.length - 1)];
    i += 1;
    if (next.error) return { ok: false, error: next.error };
    return { ok: true, value: next };
  };
}

describe('runPrWatchWithUpdate', () => {
  it('returns merged when the PR reaches MERGED state', async () => {
    const out = await runPrWatchWithUpdate({
      prNumber: 1,
      pollIntervalMs: 1,
      maxPolls: 5,
      ghViewFn: scriptedGhView([{ state: 'MERGED' }]),
      ghUpdateBranchFn: () => assert.fail('should not call update-branch'),
      sleepFn: () => Promise.resolve(),
      logger: silentLogger,
    });
    assert.deepEqual(out, { kind: 'merged', prNumber: 1, updatesApplied: 0 });
  });

  it('returns green-clean when checks pass and PR is mergeable', async () => {
    const out = await runPrWatchWithUpdate({
      prNumber: 2,
      pollIntervalMs: 1,
      maxPolls: 5,
      ghViewFn: scriptedGhView([
        {
          state: 'OPEN',
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [{ name: 'lint', state: 'SUCCESS' }],
        },
      ]),
      ghUpdateBranchFn: () => assert.fail('should not call update-branch'),
      sleepFn: () => Promise.resolve(),
      logger: silentLogger,
    });
    assert.equal(out.kind, 'green-clean');
    assert.equal(out.updatesApplied, 0);
  });

  it('calls update-branch when BEHIND + green, then continues polling', async () => {
    let updateCalls = 0;
    const out = await runPrWatchWithUpdate({
      prNumber: 3,
      pollIntervalMs: 1,
      maxPolls: 10,
      ghViewFn: scriptedGhView([
        {
          state: 'OPEN',
          mergeStateStatus: 'BEHIND',
          statusCheckRollup: [{ name: 'lint', state: 'SUCCESS' }],
        },
        { state: 'MERGED' },
      ]),
      ghUpdateBranchFn: () => {
        updateCalls += 1;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
      sleepFn: () => Promise.resolve(),
      logger: silentLogger,
    });
    assert.equal(updateCalls, 1);
    assert.equal(out.kind, 'merged');
    assert.equal(out.updatesApplied, 1);
  });

  it('does NOT call update-branch when checks are still pending', async () => {
    let updateCalls = 0;
    const out = await runPrWatchWithUpdate({
      prNumber: 4,
      pollIntervalMs: 1,
      maxPolls: 3,
      ghViewFn: scriptedGhView([
        {
          state: 'OPEN',
          mergeStateStatus: 'BEHIND',
          statusCheckRollup: [
            { name: 'lint', state: 'SUCCESS' },
            { name: 'test', state: 'PENDING' },
          ],
        },
        {
          state: 'OPEN',
          mergeStateStatus: 'BEHIND',
          statusCheckRollup: [
            { name: 'lint', state: 'SUCCESS' },
            { name: 'test', state: 'SUCCESS' },
          ],
        },
        { state: 'MERGED' },
      ]),
      ghUpdateBranchFn: () => {
        updateCalls += 1;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
      sleepFn: () => Promise.resolve(),
      logger: silentLogger,
    });
    assert.equal(
      updateCalls,
      1,
      'update-branch should fire exactly once — only after checks went green',
    );
    assert.equal(out.kind, 'merged');
  });

  it('throws when the update-branch cap is exhausted', async () => {
    const behindGreen = {
      state: 'OPEN',
      mergeStateStatus: 'BEHIND',
      statusCheckRollup: [{ name: 'lint', state: 'SUCCESS' }],
    };
    await assert.rejects(
      () =>
        runPrWatchWithUpdate({
          prNumber: 5,
          pollIntervalMs: 1,
          maxPolls: 20,
          maxUpdates: 2,
          ghViewFn: scriptedGhView([behindGreen]),
          ghUpdateBranchFn: () => ({
            ok: true,
            status: 0,
            stdout: '',
            stderr: '',
          }),
          sleepFn: () => Promise.resolve(),
          logger: silentLogger,
        }),
      /still BEHIND after 2 update-branch call/,
    );
  });

  it('throws when a required check transitions to FAILURE', async () => {
    await assert.rejects(
      () =>
        runPrWatchWithUpdate({
          prNumber: 6,
          pollIntervalMs: 1,
          maxPolls: 5,
          ghViewFn: scriptedGhView([
            {
              state: 'OPEN',
              mergeStateStatus: 'CLEAN',
              statusCheckRollup: [
                { name: 'lint', state: 'SUCCESS' },
                { name: 'test', state: 'FAILURE' },
              ],
            },
          ]),
          ghUpdateBranchFn: () => assert.fail('should not call update-branch'),
          sleepFn: () => Promise.resolve(),
          logger: silentLogger,
        }),
      /failed required check/,
    );
  });

  it('throws when the PR is closed without merging', async () => {
    await assert.rejects(
      () =>
        runPrWatchWithUpdate({
          prNumber: 7,
          pollIntervalMs: 1,
          maxPolls: 5,
          ghViewFn: scriptedGhView([{ state: 'CLOSED' }]),
          ghUpdateBranchFn: () => assert.fail('should not call update-branch'),
          sleepFn: () => Promise.resolve(),
          logger: silentLogger,
        }),
      /closed without merging/,
    );
  });

  it('honors --dry-run by not calling update-branch when BEHIND + green', async () => {
    let updateCalls = 0;
    const out = await runPrWatchWithUpdate({
      prNumber: 8,
      pollIntervalMs: 1,
      maxPolls: 5,
      dryRun: true,
      ghViewFn: scriptedGhView([
        {
          state: 'OPEN',
          mergeStateStatus: 'BEHIND',
          statusCheckRollup: [{ name: 'lint', state: 'SUCCESS' }],
        },
      ]),
      ghUpdateBranchFn: () => {
        updateCalls += 1;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
      sleepFn: () => Promise.resolve(),
      logger: silentLogger,
    });
    assert.equal(updateCalls, 0);
    assert.equal(out.kind, 'green-clean');
  });

  it('throws when ghViewFn signals an error', async () => {
    await assert.rejects(
      () =>
        runPrWatchWithUpdate({
          prNumber: 9,
          pollIntervalMs: 1,
          maxPolls: 5,
          ghViewFn: () => ({ ok: false, error: 'gh pr view exit 1: boom' }),
          ghUpdateBranchFn: () => assert.fail('should not call update-branch'),
          sleepFn: () => Promise.resolve(),
          logger: silentLogger,
        }),
      /boom/,
    );
  });

  it('throws when gh pr update-branch fails', async () => {
    await assert.rejects(
      () =>
        runPrWatchWithUpdate({
          prNumber: 10,
          pollIntervalMs: 1,
          maxPolls: 5,
          ghViewFn: scriptedGhView([
            {
              state: 'OPEN',
              mergeStateStatus: 'BEHIND',
              statusCheckRollup: [{ name: 'lint', state: 'SUCCESS' }],
            },
          ]),
          ghUpdateBranchFn: () => ({
            ok: false,
            status: 1,
            stdout: '',
            stderr: 'forbidden',
          }),
          sleepFn: () => Promise.resolve(),
          logger: silentLogger,
        }),
      /update-branch exit 1: forbidden/,
    );
  });
});
