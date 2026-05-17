// tests/lib/orchestration/lifecycle/listener-watcher.test.js
/**
 * Unit tests for the lifecycle Watcher listener
 * (Story #2256 / Task #2261).
 *
 * Acceptance contract:
 *   - Subscribes to `pr.created` (and ONLY that event).
 *   - Required-check names come from `gh pr checks --required` at
 *     runtime — NOT from `.agentrc.json.branchProtection.requiredChecks`.
 *   - Emits `epic.watch.start` carrying the resolved required-check
 *     list, then polls until terminal, then emits `epic.watch.end`
 *     with the outcome map.
 *   - Listener is idempotent on repeat `(event, seqId)`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  allTerminal,
  extractPrNumber,
  normalizeCheckState,
  parseGhPrChecks,
  reduceOutcomes,
  Watcher,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/watcher.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function recordingBus() {
  const bus = new Bus();
  const emits = [];
  const record = (event) => async (ctx) => {
    emits.push({ event, seqId: ctx.seqId, payload: ctx.payload });
  };
  bus.on('epic.watch.start', record('epic.watch.start'));
  bus.on('epic.watch.end', record('epic.watch.end'));
  return { bus, emits };
}

describe('normalizeCheckState', () => {
  it('maps SUCCESS / FAILURE / TIMED_OUT / SKIPPED to schema enum', () => {
    assert.equal(normalizeCheckState('SUCCESS'), 'success');
    assert.equal(normalizeCheckState('FAILURE'), 'failure');
    assert.equal(normalizeCheckState('TIMED_OUT'), 'timed_out');
    assert.equal(normalizeCheckState('SKIPPED'), 'skipped');
  });

  it('collapses empty / queued / in-progress to pending; unknown to skipped', () => {
    assert.equal(normalizeCheckState(''), 'pending');
    assert.equal(normalizeCheckState('PENDING'), 'pending');
    assert.equal(normalizeCheckState('QUEUED'), 'pending');
    assert.equal(normalizeCheckState('IN_PROGRESS'), 'pending');
    assert.equal(normalizeCheckState(undefined), 'pending');
    assert.equal(normalizeCheckState('weird'), 'skipped');
  });
});

describe('extractPrNumber', () => {
  it('parses a github.com PR URL', () => {
    assert.equal(
      extractPrNumber('https://github.com/owner/repo/pull/123'),
      123,
    );
  });

  it('returns null for non-PR URLs', () => {
    assert.equal(extractPrNumber('https://example.com'), null);
    assert.equal(extractPrNumber(''), null);
    assert.equal(extractPrNumber(undefined), null);
  });
});

describe('parseGhPrChecks', () => {
  it('parses the JSON array form', () => {
    const out = parseGhPrChecks(
      '[{"name":"lint","state":"SUCCESS","bucket":"pass"}]',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'lint');
  });

  it('returns [] for malformed JSON', () => {
    assert.deepEqual(parseGhPrChecks('not json'), []);
  });

  it('drops entries without a name', () => {
    const out = parseGhPrChecks('[{"state":"SUCCESS"},{"name":"lint"}]');
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'lint');
  });
});

describe('reduceOutcomes', () => {
  it('builds a name → outcome map and prefers state over bucket', () => {
    const out = reduceOutcomes([
      { name: 'lint', state: 'SUCCESS', bucket: 'pass' },
      { name: 'test', state: '', bucket: 'pending' },
    ]);
    assert.deepEqual(out, { lint: 'success', test: 'pending' });
  });

  it('last-write-wins on duplicate names', () => {
    const out = reduceOutcomes([
      { name: 'lint', state: 'FAILURE' },
      { name: 'lint', state: 'SUCCESS' },
    ]);
    assert.deepEqual(out, { lint: 'success' });
  });
});

describe('allTerminal', () => {
  it('true when every outcome is terminal', () => {
    assert.equal(allTerminal({ a: 'success', b: 'failure' }), true);
  });

  it('false when any outcome is pending', () => {
    assert.equal(allTerminal({ a: 'success', b: 'pending' }), false);
  });
});

describe('Watcher (bus integration)', () => {
  it('emits start → end with runtime-resolved required checks', async () => {
    const { bus, emits } = recordingBus();
    let ghCalls = 0;
    const watcher = new Watcher({
      bus,
      cwd: '/tmp',
      pollIntervalMs: 0,
      maxPolls: 5,
      sleepFn: async () => {},
      ghPrChecksFn: () => {
        ghCalls += 1;
        // Both ticks return all-terminal — single iteration.
        return {
          status: 0,
          stdout: JSON.stringify([
            { name: 'Validate and Test', state: 'SUCCESS', bucket: 'pass' },
            { name: 'baselines', state: 'SUCCESS', bucket: 'pass' },
          ]),
          stderr: '',
        };
      },
      logger: quietLogger(),
    });
    watcher.register();

    await bus.emit('pr.created', {
      prUrl: 'https://github.com/owner/repo/pull/9',
      head: 'epic/2172',
      base: 'main',
    });

    const ordered = emits.map((e) => e.event);
    assert.deepEqual(ordered, ['epic.watch.start', 'epic.watch.end']);
    const start = emits.find((e) => e.event === 'epic.watch.start');
    assert.deepEqual(start.payload.requiredChecks, [
      'Validate and Test',
      'baselines',
    ]);
    const end = emits.find((e) => e.event === 'epic.watch.end');
    assert.deepEqual(end.payload.checkOutcomes, {
      'Validate and Test': 'success',
      baselines: 'success',
    });
    // First probe + one terminal iteration (the while-loop exits
    // before a second probe because outcomes are already terminal).
    assert.equal(ghCalls, 1);
  });

  it('required-check names come from gh, NOT .agentrc.json', () => {
    // The Watcher constructor accepts no agentrc/config injection at
    // all — required checks are resolved exclusively from the
    // `ghPrChecksFn` return value. This guards against future drift
    // where someone might plumb config into the listener.
    const watcher = new Watcher({
      bus: new Bus(),
      ghPrChecksFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
      logger: quietLogger(),
    });
    // Verify no config-shaped property leaked onto the instance.
    assert.ok(!('agentrc' in watcher), 'watcher must not carry agentrc');
    assert.ok(
      !('branchProtection' in watcher),
      'watcher must not carry branchProtection config',
    );
    assert.ok(
      !('requiredChecks' in watcher),
      'watcher must not pre-resolve requiredChecks at construct-time',
    );
  });

  it('subscribes ONLY to pr.created', () => {
    const watcher = new Watcher({
      bus: new Bus(),
      ghPrChecksFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
      logger: quietLogger(),
    });
    assert.deepEqual([...watcher.events], ['pr.created']);
  });

  it('listener is idempotent on repeat (event, seqId)', async () => {
    const { emits } = recordingBus();
    const bus = new Bus();
    bus.on('epic.watch.start', async (ctx) =>
      emits.push({ event: 'epic.watch.start', seqId: ctx.seqId }),
    );
    bus.on('epic.watch.end', async (ctx) =>
      emits.push({ event: 'epic.watch.end', seqId: ctx.seqId }),
    );

    let ghCalls = 0;
    const watcher = new Watcher({
      bus,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => {
        ghCalls += 1;
        return {
          status: 0,
          stdout: '[{"name":"lint","state":"SUCCESS"}]',
          stderr: '',
        };
      },
      logger: quietLogger(),
    });
    watcher.register();

    const ctx = {
      event: 'pr.created',
      seqId: 50,
      payload: {
        prUrl: 'https://github.com/o/r/pull/1',
        head: 'epic/2172',
        base: 'main',
      },
    };
    await watcher.handle(ctx);
    await watcher.handle(ctx);

    assert.equal(ghCalls, 1, 'gh pr checks invoked exactly once');
    const dup = watcher.classifications.find(
      (c) => c.outcome === 'skipped' && c.reason === 'duplicate-seqId',
    );
    assert.ok(dup, 'duplicate seqId logged');
  });

  it('handles polling: pending → terminal across multiple iterations', async () => {
    const { bus, emits } = recordingBus();
    const responses = [
      // First probe — name resolution + initial state (pending).
      {
        status: 8,
        stdout: '[{"name":"lint","state":"","bucket":"pending"}]',
        stderr: '',
      },
      // Second tick — still pending.
      {
        status: 8,
        stdout: '[{"name":"lint","state":"","bucket":"pending"}]',
        stderr: '',
      },
      // Third tick — terminal.
      {
        status: 0,
        stdout: '[{"name":"lint","state":"SUCCESS","bucket":"pass"}]',
        stderr: '',
      },
    ];
    let idx = 0;
    const watcher = new Watcher({
      bus,
      pollIntervalMs: 0,
      maxPolls: 5,
      sleepFn: async () => {},
      ghPrChecksFn: () => responses[Math.min(idx++, responses.length - 1)],
      logger: quietLogger(),
    });
    watcher.register();

    await bus.emit('pr.created', {
      prUrl: 'https://github.com/o/r/pull/2',
      head: 'epic/2172',
      base: 'main',
    });
    const end = emits.find((e) => e.event === 'epic.watch.end');
    assert.deepEqual(end.payload.checkOutcomes, { lint: 'success' });
    const cls = watcher.classifications[0];
    assert.equal(cls.outcome, 'watched');
    assert.equal(cls.polls, 2);
  });

  it('hits the iteration cap and classifies as timed-out', async () => {
    const { bus, emits } = recordingBus();
    const watcher = new Watcher({
      bus,
      pollIntervalMs: 0,
      maxPolls: 3,
      sleepFn: async () => {},
      ghPrChecksFn: () => ({
        status: 8,
        stdout: '[{"name":"slow","state":"","bucket":"pending"}]',
        stderr: '',
      }),
      logger: quietLogger(),
    });
    watcher.register();

    await bus.emit('pr.created', {
      prUrl: 'https://github.com/o/r/pull/3',
      head: 'epic/2172',
      base: 'main',
    });
    const end = emits.find((e) => e.event === 'epic.watch.end');
    assert.ok(end, 'watch.end emitted even on timeout');
    assert.equal(end.payload.checkOutcomes.slow, 'timed_out');
    const cls = watcher.classifications[0];
    assert.equal(cls.outcome, 'timed-out');
  });

  it('genuine gh failure (status != 0/8 with empty stdout) classifies failed; no emits', async () => {
    const { bus, emits } = recordingBus();
    const watcher = new Watcher({
      bus,
      pollIntervalMs: 0,
      maxPolls: 1,
      sleepFn: async () => {},
      ghPrChecksFn: () => ({
        status: 4,
        stdout: '',
        stderr: 'gh: not authenticated',
      }),
      logger: quietLogger(),
    });
    watcher.register();

    await bus.emit('pr.created', {
      prUrl: 'https://github.com/o/r/pull/4',
      head: 'epic/2172',
      base: 'main',
    });
    assert.equal(emits.length, 0, 'no emits when gh fails');
    const failed = watcher.classifications.find((c) => c.outcome === 'failed');
    assert.ok(failed);
    assert.match(failed.reason, /gh-checks-failed/);
  });
});
