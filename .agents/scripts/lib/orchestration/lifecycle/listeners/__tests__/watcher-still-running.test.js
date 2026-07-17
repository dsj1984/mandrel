// .agents/scripts/lib/orchestration/lifecycle/listeners/__tests__/watcher-still-running.test.js
/**
 * Story #4358 — slow-vs-failed watch semantics.
 *
 * Pins the load-bearing distinction the unified CI-watch mechanism must
 * hold, at both layers:
 *
 *   - The shared `watchPrToTerminal` primitive (watcher.js):
 *       - a genuinely red check short-circuits with `stillRunning:false`
 *         and consumes NO resume budget (`resumesApplied:0`);
 *       - a still-pending-at-cap check re-arms up to `maxResumes` times,
 *         then returns `stillRunning:true` with the leftover pending
 *         promoted to the `'still-running'` sentinel (NEVER `'timed_out'`);
 *       - a green check exits `terminal:true, green:true`.
 *   - The `pr-watch-with-update.js` CLI (`runPrWatch`):
 *       - green → exit 0;
 *       - red → exit 1 immediately + a digest is written for the epic;
 *       - still-running → exit 2 (the reserved `STILL_RUNNING_EXIT_CODE`),
 *         never 1.
 *   - Config wiring: `resolveWatchKnobs` reads `delivery.ci.watch.*`
 *     (pollIntervalMs / maxPolls / maxResumes) with CLI-flag override.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyFailure,
  resolveWatchKnobs,
  runPrWatch,
  STILL_RUNNING_EXIT_CODE,
  WATCH_DEFAULTS,
} from '../../../../../pr-watch-with-update.js';
import {
  hasFailingCheck,
  promotePendingToStillRunning,
  watchPrToTerminal,
} from '../watcher.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function collectPrint() {
  const lines = [];
  return { print: (line) => lines.push(line), lines };
}

const pendingProbe = {
  status: 8,
  stdout: JSON.stringify([{ name: 'test', state: '', bucket: 'pending' }]),
  stderr: '',
};

const redProbe = {
  status: 0,
  stdout: JSON.stringify([
    { name: 'lint', state: 'SUCCESS', bucket: 'pass' },
    { name: 'test', state: 'FAILURE', bucket: 'fail' },
  ]),
  stderr: '',
};

const greenProbe = {
  status: 0,
  stdout: JSON.stringify([{ name: 'test', state: 'SUCCESS', bucket: 'pass' }]),
  stderr: '',
};

const cleanView = () => ({
  status: 0,
  stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }),
  stderr: '',
});

describe('pure helpers — hasFailingCheck / promotePendingToStillRunning', () => {
  it('hasFailingCheck ignores pending, flags a red check', () => {
    assert.equal(hasFailingCheck({ a: 'pending', b: 'success' }), false);
    assert.equal(hasFailingCheck({ a: 'pending', b: 'failure' }), true);
    assert.equal(hasFailingCheck({ a: 'timed_out' }), true);
    assert.equal(hasFailingCheck({ a: 'success', b: 'skipped' }), false);
  });

  it('promotePendingToStillRunning only touches pending entries', () => {
    assert.deepEqual(
      promotePendingToStillRunning({ a: 'pending', b: 'success' }),
      { a: 'still-running', b: 'success' },
    );
  });

  it('classifyFailure steers the operator to a coarse bucket', () => {
    assert.equal(classifyFailure('lint'), 'lint');
    assert.equal(classifyFailure('baselines'), 'baseline');
    assert.equal(classifyFailure('Validate and Test'), 'test');
    assert.equal(classifyFailure('typecheck'), 'build');
    assert.equal(classifyFailure('mystery-gate'), 'unknown');
  });
});

describe('watchPrToTerminal — slow-vs-failed (Story #4358)', () => {
  it('a red check short-circuits with stillRunning:false and no resume budget spent', async () => {
    const result = await watchPrToTerminal({
      prUrl: '7',
      cwd: process.cwd(),
      maxPolls: 5,
      maxUpdates: 0,
      maxResumes: 3,
      pollIntervalMs: 0,
      ghPrChecksFn: () => redProbe,
      ghPrViewFn: cleanView,
      sleepFn: async () => {},
      logger: quietLogger(),
    });
    assert.equal(result.terminal, true);
    assert.equal(result.green, false);
    assert.equal(result.stillRunning, false);
    assert.equal(
      result.resumesApplied,
      0,
      'red check consumes no resume budget',
    );
    assert.equal(result.outcomes.test, 'failure');
  });

  it('a still-pending check re-arms up to maxResumes then returns still-running (never timed_out)', async () => {
    const result = await watchPrToTerminal({
      prUrl: '8',
      cwd: process.cwd(),
      maxPolls: 2,
      maxUpdates: 0,
      maxResumes: 3,
      pollIntervalMs: 0,
      ghPrChecksFn: () => pendingProbe,
      ghPrViewFn: cleanView,
      sleepFn: async () => {},
      logger: quietLogger(),
    });
    assert.equal(result.terminal, false);
    assert.equal(result.green, false);
    assert.equal(result.stillRunning, true);
    assert.equal(result.resumesApplied, 3, 'full resume budget spent');
    assert.equal(result.outcomes.test, 'still-running');
    assert.notEqual(result.outcomes.test, 'timed_out');
  });

  it('a green check exits terminal + green', async () => {
    const result = await watchPrToTerminal({
      prUrl: '9',
      cwd: process.cwd(),
      maxPolls: 5,
      maxUpdates: 0,
      maxResumes: 3,
      pollIntervalMs: 0,
      ghPrChecksFn: () => greenProbe,
      ghPrViewFn: cleanView,
      sleepFn: async () => {},
      logger: quietLogger(),
    });
    assert.equal(result.green, true);
    assert.equal(result.stillRunning, false);
  });
});

describe('runPrWatch — three-way exit codes (Story #4358)', () => {
  it('green → exit 0', async () => {
    const { print } = collectPrint();
    const code = await runPrWatch({
      prNumber: 1,
      config: null,
      pollIntervalMs: 0,
      maxResumes: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => greenProbe,
      ghPrViewFn: cleanView,
      logger: quietLogger(),
      print,
    });
    assert.equal(code, 0);
  });

  it('red → exit 1 immediately and writes the story-scoped digest', async () => {
    const { print, lines } = collectPrint();
    let digestArgs = null;
    const code = await runPrWatch({
      prNumber: 2,
      storyId: 4355,
      config: null,
      pollIntervalMs: 0,
      maxResumes: 3,
      sleepFn: async () => {},
      ghPrChecksFn: () => redProbe,
      ghPrViewFn: cleanView,
      writeDigestFn: (args) => {
        digestArgs = args;
        return { jsonPath: '/tmp/story-4355-ci-digest.json', mdPath: '/x.md' };
      },
      logger: quietLogger(),
      print,
    });
    assert.equal(code, 1);
    assert.ok(digestArgs, 'digest writer invoked on red');
    assert.equal(digestArgs.storyId, 4355);
    assert.deepEqual(digestArgs.failures, [
      { name: 'test', outcome: 'failure' },
    ]);
    const out = JSON.parse(lines[0]);
    assert.equal(out.stillRunning, false);
    assert.equal(out.checkOutcomes.test, 'failure');
  });

  it('still-running → exit 2 (never 1) and skips the digest', async () => {
    const { print, lines } = collectPrint();
    let digestCalled = false;
    const code = await runPrWatch({
      prNumber: 3,
      storyId: 4355,
      config: null,
      pollIntervalMs: 0,
      maxPolls: 2,
      maxResumes: 1,
      sleepFn: async () => {},
      ghPrChecksFn: () => pendingProbe,
      ghPrViewFn: cleanView,
      writeDigestFn: () => {
        digestCalled = true;
        return null;
      },
      logger: quietLogger(),
      print,
    });
    assert.equal(code, STILL_RUNNING_EXIT_CODE);
    assert.notEqual(code, 1);
    assert.equal(digestCalled, false, 'no digest on the slow path');
    const out = JSON.parse(lines[0]);
    assert.equal(out.stillRunning, true);
    assert.equal(out.checkOutcomes.test, 'still-running');
  });
});

describe('resolveWatchKnobs — delivery.ci.watch.* precedence (Story #4356/#4358)', () => {
  it('reads pollIntervalMs / maxPolls / maxResumes from delivery.ci.watch', () => {
    const knobs = resolveWatchKnobs({
      config: {
        delivery: {
          ci: { watch: { pollIntervalMs: 500, maxPolls: 12, maxResumes: 4 } },
        },
      },
    });
    assert.equal(knobs.pollIntervalMs, 500);
    assert.equal(knobs.maxPolls, 12);
    assert.equal(knobs.maxResumes, 4);
  });

  it('a CLI flag overrides config; config overrides the framework default', () => {
    const knobs = resolveWatchKnobs({
      config: { delivery: { ci: { watch: { maxPolls: 12 } } } },
      flags: { maxPolls: 99 },
    });
    assert.equal(knobs.maxPolls, 99, 'flag wins');
    // maxResumes: no flag, no config → framework default.
    assert.equal(knobs.maxResumes, WATCH_DEFAULTS.maxResumes);
  });

  it('falls through to framework defaults when config has no watch block', () => {
    const knobs = resolveWatchKnobs({ config: null });
    assert.equal(knobs.pollIntervalMs, WATCH_DEFAULTS.pollIntervalMs);
    assert.equal(knobs.maxPolls, WATCH_DEFAULTS.maxPolls);
    assert.equal(knobs.maxResumes, WATCH_DEFAULTS.maxResumes);
  });
});
