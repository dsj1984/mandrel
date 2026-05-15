/**
 * detectorsPhase — verifies that the post-merge detector phase resolves
 * thresholds via `getSignals(config)`, persists each emission via the
 * injected `appendSignal` writer, and isolates failures (a thrown
 * detector or appendSignal MUST NOT block the rest of the close).
 *
 * Lives in its own file (alongside the implementation at
 * `lib/orchestration/detectors-phase.js`) rather than inline in
 * `post-merge-pipeline.test.js` so the parent sequencer's test surface
 * stays focused on phase orchestration.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectorsPhase } from '../../../.agents/scripts/lib/orchestration/detectors-phase.js';

function makeLogger() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error: (msg) => errors.push(msg),
    warn: (msg) => warnings.push(msg),
    info: () => {},
    debug: () => {},
  };
}

function captureProgress() {
  const events = [];
  const fn = (phase, msg) => events.push({ phase, msg });
  return { events, fn };
}

const REWORK_BASE = {
  ts: 't',
  kind: 'rework',
  source: { tool: 'rework-detector' },
  epicId: 1,
  storyId: 2,
  taskId: 9,
};

const RETRY_BASE = {
  ts: 't',
  kind: 'retry',
  source: { tool: 'retry-detector' },
  epicId: 1,
  storyId: 2,
  taskId: 9,
};

describe('detectorsPhase', () => {
  it('runs both detectors and persists each returned event via appendSignal', async () => {
    const logger = makeLogger();
    const { events: progressEvents, fn: progress } = captureProgress();
    const reworkEvents = [
      {
        ...REWORK_BASE,
        details: { targetHash: 'h1', editCount: 7, threshold: 5 },
      },
      {
        ...REWORK_BASE,
        details: { targetHash: 'h2', editCount: 6, threshold: 5 },
      },
    ];
    const retryEvents = [
      {
        ...RETRY_BASE,
        details: {
          commandHash: 'c1',
          failureCount: 4,
          threshold: 3,
          normalizationRules: [],
        },
      },
    ];
    const reworkCalls = [];
    const retryCalls = [];
    const appendCalls = [];
    const result = await detectorsPhase({
      epicId: 1,
      storyId: 2,
      tasks: [{ id: 7 }, { id: 9 }],
      config: {
        delivery: {
          signals: { rework: { editsPerFile: 5 }, retry: { repeatCount: 3 } },
        },
      },
      progress,
      logger,
      detectorsImpl: {
        detectRework: async (args) => {
          reworkCalls.push(args);
          return reworkEvents;
        },
        detectRetry: async (args) => {
          retryCalls.push(args);
          return retryEvents;
        },
      },
      appendSignalFn: async (args) => {
        appendCalls.push(args);
        return true;
      },
    });
    assert.deepEqual(result, { rework: 2, retry: 1 });
    assert.equal(reworkCalls.length, 1);
    assert.equal(reworkCalls[0].threshold, 5);
    assert.equal(reworkCalls[0].epicId, 1);
    assert.equal(reworkCalls[0].storyId, 2);
    assert.equal(
      reworkCalls[0].taskId,
      9,
      'tags signals with the last Task ID',
    );
    assert.match(reworkCalls[0].tracesPath, /traces\.ndjson$/);
    assert.equal(retryCalls.length, 1);
    assert.equal(retryCalls[0].threshold, 3);
    assert.equal(appendCalls.length, 3);
    assert.ok(
      progressEvents.some(
        (e) => e.phase === 'DETECTORS' && /rework=2 retry=1/.test(e.msg),
      ),
      `expected DETECTORS summary line, got: ${JSON.stringify(progressEvents)}`,
    );
  });

  it('failure-isolated: rework detector throwing does not block retry, returns zero rework count', async () => {
    const logger = makeLogger();
    const result = await detectorsPhase({
      epicId: 1,
      storyId: 2,
      tasks: [{ id: 9 }],
      config: {},
      progress: () => {},
      logger,
      detectorsImpl: {
        detectRework: async () => {
          throw new Error('rework boom');
        },
        detectRetry: async () => [
          {
            ...RETRY_BASE,
            details: {
              commandHash: 'c',
              failureCount: 5,
              threshold: 3,
              normalizationRules: [],
            },
          },
        ],
      },
      appendSignalFn: async () => true,
    });
    assert.deepEqual(result, { rework: 0, retry: 1 });
    assert.ok(
      logger.warnings.some((m) => /rework detector threw/.test(m)),
      `expected rework-threw warn, got: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('failure-isolated: appendSignal throwing on one event does not block subsequent events or detectors', async () => {
    const logger = makeLogger();
    let calls = 0;
    const result = await detectorsPhase({
      epicId: 1,
      storyId: 2,
      tasks: [{ id: 9 }],
      config: {},
      progress: () => {},
      logger,
      detectorsImpl: {
        detectRework: async () => [
          {
            ...REWORK_BASE,
            details: { targetHash: 'a', editCount: 9, threshold: 5 },
          },
          {
            ...REWORK_BASE,
            details: { targetHash: 'b', editCount: 9, threshold: 5 },
          },
        ],
        detectRetry: async () => [],
      },
      appendSignalFn: async () => {
        calls += 1;
        if (calls === 1) throw new Error('disk boom');
        return true;
      },
    });
    assert.deepEqual(result, { rework: 1, retry: 0 });
    assert.ok(
      logger.warnings.some((m) => /rework appendSignal failed/.test(m)),
    );
  });

  it('skips with zero counts when epicId/storyId are invalid', async () => {
    const logger = makeLogger();
    const result = await detectorsPhase({
      epicId: 0,
      storyId: -1,
      config: {},
      progress: () => {},
      logger,
      detectorsImpl: {
        detectRework: async () => {
          throw new Error('should not be called');
        },
        detectRetry: async () => {
          throw new Error('should not be called');
        },
      },
      appendSignalFn: async () => true,
    });
    assert.deepEqual(result, { rework: 0, retry: 0 });
  });
});
