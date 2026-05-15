/**
 * Sibling test for progress-reporter/transport.js — exercises the
 * webhook emit surface directly so the boundary's failure-swallow
 * contract is locked in independently of the parent module's
 * ProgressReporter scaffolding.
 *
 * The "retry path" covered here is the boundary contract: when the
 * caller-supplied `notify` adapter throws (mid-retry exhaustion, network
 * blip, schema drift), the emit helper MUST swallow the failure, log via
 * the caller-supplied logger, and return `null` so the runner keeps
 * moving. The downstream gh-exec retry loop is exercised elsewhere; this
 * module's contract is "swallow what `notify` re-throws". Story #1847.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EPIC_PROGRESS_EVENT,
  emitEpicBlocked,
  emitEpicComplete,
  emitEpicProgress,
  emitEpicStarted,
  emitEpicUnblocked,
} from '../../../.agents/scripts/lib/orchestration/epic-runner/progress-reporter/transport.js';

function recordingNotify(behavior = 'ok') {
  const calls = [];
  const notify = async (epicId, payload, options) => {
    calls.push({ epicId, payload, options });
    if (behavior === 'throw-once' && calls.length === 1) {
      throw new Error('mock notify failure');
    }
    if (behavior === 'throw-always') {
      throw new Error('mock notify hard failure');
    }
  };
  return { notify, calls };
}

function recordingLogger() {
  const warnings = [];
  return {
    logger: { warn: (msg) => warnings.push(msg) },
    warnings,
  };
}

describe('progress-reporter/transport', () => {
  describe('emitEpicProgress', () => {
    it('dispatches the curated epic-progress payload with skipComment=true', async () => {
      const { notify, calls } = recordingNotify();
      const result = await emitEpicProgress({
        notify,
        epicId: 42,
        done: 3,
        total: 10,
        currentWave: 1,
        totalWaves: 4,
        phase: 'implementing',
        openBlockers: [],
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].epicId, 42);
      assert.equal(calls[0].payload.event, EPIC_PROGRESS_EVENT);
      assert.equal(calls[0].payload.severity, 'medium');
      assert.equal(calls[0].options.skipComment, true);
      assert.equal(result.payload.pct, 30);
      assert.equal(result.payload.done, 3);
    });

    it('elevates severity to high when openBlockers is non-empty', async () => {
      const { notify, calls } = recordingNotify();
      await emitEpicProgress({
        notify,
        epicId: 42,
        done: 0,
        total: 1,
        currentWave: 1,
        totalWaves: 1,
        openBlockers: [{ reason: 'review pending', storyId: 100 }],
      });
      assert.equal(calls[0].payload.severity, 'high');
    });

    it('swallows notify failures (deterministic mocked adapter) and warns', async () => {
      const { notify, calls } = recordingNotify('throw-always');
      const { logger, warnings } = recordingLogger();
      const result = await emitEpicProgress({
        notify,
        epicId: 42,
        done: 1,
        total: 2,
        currentWave: 1,
        totalWaves: 2,
        logger,
      });
      assert.equal(result, null);
      assert.equal(calls.length, 1);
      assert.ok(warnings.some((w) => w.includes('notify dispatch failed')));
    });

    it('returns null without invoking notify when epicId is invalid', async () => {
      const { notify, calls } = recordingNotify();
      const result = await emitEpicProgress({
        notify,
        epicId: 'not-a-number',
        done: 0,
        total: 1,
        currentWave: 1,
        totalWaves: 1,
      });
      assert.equal(result, null);
      assert.equal(calls.length, 0);
    });

    it('returns null when notify is not a function', async () => {
      const result = await emitEpicProgress({
        notify: null,
        epicId: 42,
        done: 0,
        total: 1,
        currentWave: 1,
        totalWaves: 1,
      });
      assert.equal(result, null);
    });
  });

  describe('emitEpicStarted', () => {
    it('fires an epic-started event with skipComment=true', async () => {
      const { notify, calls } = recordingNotify();
      await emitEpicStarted({
        notify,
        epicId: 7,
        totalWaves: 3,
        totalStories: 9,
        title: 'Test Epic',
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].payload.event, 'epic-started');
      assert.equal(calls[0].options.skipComment, true);
      assert.match(calls[0].payload.message, /Test Epic/);
    });

    it('swallows notify failures', async () => {
      const { notify } = recordingNotify('throw-always');
      const { logger, warnings } = recordingLogger();
      const result = await emitEpicStarted({
        notify,
        epicId: 7,
        totalWaves: 1,
        totalStories: 1,
        logger,
      });
      assert.equal(result, null);
      assert.ok(warnings.some((w) => w.includes('notify dispatch failed')));
    });
  });

  describe('emitEpicBlocked', () => {
    it('fires an epic-blocked event with high severity', async () => {
      const { notify, calls } = recordingNotify();
      await emitEpicBlocked({
        notify,
        epicId: 11,
        reason: 'merge conflict',
        storyId: 200,
      });
      assert.equal(calls[0].payload.event, 'epic-blocked');
      assert.equal(calls[0].payload.severity, 'high');
      assert.match(calls[0].payload.message, /merge conflict/);
    });

    it('swallows notify failures', async () => {
      const { notify } = recordingNotify('throw-always');
      const { logger, warnings } = recordingLogger();
      const result = await emitEpicBlocked({
        notify,
        epicId: 11,
        reason: 'x',
        logger,
      });
      assert.equal(result, null);
      assert.ok(warnings.some((w) => w.includes('notify dispatch failed')));
    });
  });

  describe('emitEpicUnblocked', () => {
    it('fires an epic-unblocked event with the resolved reason', async () => {
      const { notify, calls } = recordingNotify();
      await emitEpicUnblocked({
        notify,
        epicId: 11,
        resolvedBlocker: { reason: 'rebased on main' },
      });
      assert.equal(calls[0].payload.event, 'epic-unblocked');
      assert.match(calls[0].payload.message, /rebased on main/);
    });
  });

  describe('emitEpicComplete', () => {
    it('fires an epic-complete event with the PR URL in payload', async () => {
      const { notify, calls } = recordingNotify();
      await emitEpicComplete({
        notify,
        epicId: 99,
        totalStories: 5,
        totalWaves: 2,
        prUrl: 'https://example.test/pr/1',
      });
      assert.equal(calls[0].payload.event, 'epic-complete');
      assert.equal(calls[0].payload.prUrl, 'https://example.test/pr/1');
    });

    it('swallows notify failures and still returns null', async () => {
      const { notify } = recordingNotify('throw-always');
      const { logger, warnings } = recordingLogger();
      const result = await emitEpicComplete({
        notify,
        epicId: 99,
        totalStories: 1,
        totalWaves: 1,
        prUrl: null,
        logger,
      });
      assert.equal(result, null);
      assert.ok(warnings.some((w) => w.includes('notify dispatch failed')));
    });
  });
});
