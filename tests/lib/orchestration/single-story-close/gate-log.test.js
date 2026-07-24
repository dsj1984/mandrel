/**
 * tests/lib/orchestration/single-story-close/gate-log.test.js — Story #4736.
 *
 * The close path's gate-output sink. The contract under test is the asymmetry
 * that makes the ~2KB success bound safe to adopt:
 *
 *   - a clean run says how much output there was and where it went, and emits
 *     none of it inline;
 *   - a red run puts the evidence back in front of the caller;
 *   - `AGENT_LOG_LEVEL=verbose` restores live streaming;
 *   - an unwritable artifact degrades to streaming rather than dropping the
 *     gate output, because losing the size bound beats losing the reason a
 *     close failed.
 */

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  createGateLogSink,
  REPLAY_TAIL_LINES,
} from '../../../../.agents/scripts/lib/orchestration/single-story-close/gate-log.js';

let tmpDir;
let emitted;
const logger = { info: (m) => emitted.push(m) };

before(() => {
  tmpDir = nodeFs.mkdtempSync(path.join(nodeOs.tmpdir(), 'gate-log-'));
});

after(() => {
  nodeFs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  emitted = [];
});

/** A sink rooted in the per-run temp dir, with the logger captured. */
function sinkAt(name, opts = {}) {
  return createGateLogSink({
    storyId: 4736,
    logDir: path.join(tmpDir, name),
    logger,
    level: 'info',
    ...opts,
  });
}

describe('createGateLogSink — success path (AC-3)', () => {
  it('captures gate output to the artifact and emits nothing inline', () => {
    const sink = sinkAt('quiet');
    for (let i = 0; i < 500; i += 1)
      sink.log(`[test] line ${i} ${'x'.repeat(80)}`);

    assert.deepEqual(emitted, [], 'no gate line may reach the inline sink');
    assert.equal(sink.lineCount, 500);
    const written = nodeFs.readFileSync(sink.logPath, 'utf8');
    assert.ok(
      written.includes('line 499'),
      'the artifact must hold the full output, including the last line',
    );
    assert.equal(written.split('\n').filter(Boolean).length, 500);
  });

  it('digests to a single short line naming the artifact', () => {
    const sink = sinkAt('digest');
    for (let i = 0; i < 5_000; i += 1) sink.log(`gate output line ${i}`);

    const digest = sink.digest();
    assert.ok(digest.includes('5000'), 'the digest reports the line count');
    assert.ok(
      digest.includes(sink.logPath),
      'the digest names the artifact path so the caller can open it on demand',
    );
    assert.ok(
      Buffer.byteLength(digest, 'utf8') < 2048,
      `the digest itself must stay well inside the ~2KB bound (was ${Buffer.byteLength(digest, 'utf8')}B)`,
    );
  });

  it('truncates the artifact per run so a re-run never interleaves two runs', () => {
    const dir = path.join(tmpDir, 'rerun');
    const first = createGateLogSink({
      storyId: 4736,
      logDir: dir,
      logger,
      level: 'info',
    });
    first.log('FIRST RUN');
    const second = createGateLogSink({
      storyId: 4736,
      logDir: dir,
      logger,
      level: 'info',
    });
    second.log('SECOND RUN');

    const written = nodeFs.readFileSync(second.logPath, 'utf8');
    assert.equal(first.logPath, second.logPath, 'both runs key on the storyId');
    assert.ok(written.includes('SECOND RUN'));
    assert.ok(
      !written.includes('FIRST RUN'),
      'the previous run’s output must not survive into this run’s artifact',
    );
  });
});

describe('createGateLogSink — failure path (AC-4)', () => {
  it('replays the captured tail inline so the evidence stays in front of the caller', () => {
    const sink = sinkAt('replay');
    sink.log('assertion failed: expected 1 to equal 2');
    sink.log('  at tests/example.test.js:14');

    const replayed = sink.replay();
    assert.equal(replayed, 2);
    assert.deepEqual(emitted, [
      'assertion failed: expected 1 to equal 2',
      '  at tests/example.test.js:14',
    ]);
  });

  it('bounds the replay to the tail and says how much it omitted', () => {
    const sink = sinkAt('replay-tail');
    const total = REPLAY_TAIL_LINES + 40;
    for (let i = 0; i < total; i += 1) sink.log(`line ${i}`);

    assert.equal(sink.replay(), REPLAY_TAIL_LINES);
    assert.equal(emitted.length, REPLAY_TAIL_LINES + 1, 'tail plus one notice');
    assert.match(emitted[0], /40 earlier line\(s\) omitted/);
    assert.ok(
      emitted[0].includes(sink.logPath),
      'the omission notice must point at the artifact holding the rest',
    );
    assert.equal(emitted.at(-1), `line ${total - 1}`);
    assert.ok(
      nodeFs.readFileSync(sink.logPath, 'utf8').includes('line 0'),
      'the artifact still holds every line, including those not replayed',
    );
  });
});

describe('createGateLogSink — streaming and degradation', () => {
  it('AGENT_LOG_LEVEL=verbose streams inline AND still writes the artifact', () => {
    const sink = sinkAt('verbose', { level: 'verbose' });
    sink.log('gate line');

    assert.deepEqual(emitted, ['gate line']);
    assert.ok(nodeFs.readFileSync(sink.logPath, 'utf8').includes('gate line'));
    assert.equal(
      sink.replay(),
      0,
      'replay must not double-print what streaming already emitted',
    );
  });

  it('degrades to inline streaming when the artifact cannot be opened', () => {
    const sink = createGateLogSink({
      storyId: 4736,
      logDir: path.join(tmpDir, 'unwritable'),
      logger,
      level: 'info',
      fs: {
        mkdirSync() {
          throw new Error('EACCES: permission denied');
        },
      },
    });
    sink.log('gate line that must not be lost');

    assert.equal(sink.logPath, null);
    assert.deepEqual(emitted, ['gate line that must not be lost']);
    assert.match(sink.digest(), /no artifact could be written/);
  });

  it('survives a mid-run write failure without aborting the close', () => {
    let calls = 0;
    const sink = createGateLogSink({
      storyId: 4736,
      logDir: path.join(tmpDir, 'flaky'),
      logger,
      level: 'info',
      fs: {
        mkdirSync() {},
        openSync: () => 7,
        writeSync() {
          calls += 1;
          throw new Error('ENOSPC: no space left on device');
        },
      },
    });

    assert.doesNotThrow(() => sink.log('gate line'));
    assert.equal(calls, 1);
    assert.equal(sink.lineCount, 1, 'the line is still counted and replayable');
  });
});
