// tests/lib/orchestration/lifecycle/listener-progress.test.js
/**
 * Unit test for the lifecycle ProgressReporter listener
 * (Story #2239 Task #2244). Verifies:
 *
 *   - story.dispatch.end increments the per-outcome counter
 *   - wave.end advances currentWave and records the wave history
 *   - duplicate (event, seqId) replays are a no-op
 *   - snapshot() returns a defensive copy
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { ProgressReporter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/progress-reporter.js';

describe('lifecycle ProgressReporter listener', () => {
  it('accumulates outcomes across story.dispatch.end events', async () => {
    const bus = new Bus();
    const reporter = new ProgressReporter({
      logger: { debug() {} },
    });
    reporter.register(bus);

    await bus.emit('story.dispatch.end', {
      storyId: 1,
      outcome: 'done',
      durationMs: 1000,
    });
    await bus.emit('story.dispatch.end', {
      storyId: 2,
      outcome: 'done',
      durationMs: 1500,
    });
    await bus.emit('story.dispatch.end', {
      storyId: 3,
      outcome: 'failed',
      durationMs: 200,
    });
    await bus.emit('story.dispatch.end', {
      storyId: 4,
      outcome: 'blocked',
      durationMs: 50,
    });
    await bus.emit('story.dispatch.end', {
      storyId: 5,
      outcome: 'skipped',
      durationMs: 0,
    });

    const snap = reporter.snapshot();
    assert.deepEqual(snap.outcomes, {
      done: 2,
      blocked: 1,
      failed: 1,
      skipped: 1,
    });
  });

  it('tracks currentWave + wave history off wave.end events', async () => {
    const bus = new Bus();
    const reporter = new ProgressReporter({ logger: { debug() {} } });
    reporter.register(bus);

    await bus.emit('wave.end', {
      waveIndex: 0,
      outcomes: { 1: 'done', 2: 'done' },
    });
    await bus.emit('wave.end', {
      waveIndex: 1,
      outcomes: { 3: 'done', 4: 'failed' },
    });

    const snap = reporter.snapshot();
    assert.equal(snap.currentWave, 2);
    assert.equal(snap.waves.length, 2);
    assert.deepEqual(snap.waves[0], {
      waveIndex: 0,
      outcomes: { 1: 'done', 2: 'done' },
    });
  });

  it('is idempotent on duplicate (event, seqId)', async () => {
    const bus = new Bus();
    const reporter = new ProgressReporter({ logger: { debug() {} } });
    reporter.register(bus);

    await bus.emit('story.dispatch.end', {
      storyId: 1,
      outcome: 'done',
      durationMs: 1,
    });
    // Replay manually with the same seqId.
    await reporter.handle({
      event: 'story.dispatch.end',
      seqId: 1,
      payload: { storyId: 1, outcome: 'done', durationMs: 1 },
    });
    assert.equal(
      reporter.snapshot().outcomes.done,
      1,
      'duplicate seqId must not double-count',
    );
  });

  it('snapshot() returns a defensive copy', async () => {
    const reporter = new ProgressReporter({ logger: { debug() {} } });
    await reporter.handle({
      event: 'story.dispatch.end',
      seqId: 1,
      payload: { storyId: 1, outcome: 'done', durationMs: 1 },
    });
    const s1 = reporter.snapshot();
    s1.outcomes.done = 999;
    const s2 = reporter.snapshot();
    assert.equal(s2.outcomes.done, 1, 'snapshot mutation must not bleed back');
  });
});
