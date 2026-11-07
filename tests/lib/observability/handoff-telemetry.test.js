/**
 * Story #5970 — the story-handoff record: closed cause set, retry vs trace by
 * status, no file path in details, an attempt counter read from the stream,
 * and a best-effort emitter.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  buildHandoffRecord,
  emitHandoffRecord,
  HANDOFF_CAUSES,
  handoffCause,
  isHandoffRecord,
  nextHandoffAttempt,
} from '../../../.agents/scripts/lib/observability/handoff-telemetry.js';
import { validateSignal } from '../../../.agents/scripts/lib/observability/signal-validator.js';
import { appendSignal } from '../../../.agents/scripts/lib/observability/signals-writer.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const STORY = 5970;
let tempRoot;
let config;
beforeEach(() => {
  tempRoot = makeTempDir('handoff-telemetry-');
  config = { project: { paths: { tempRoot } } };
});
afterEach(() => rmSync(tempRoot, { recursive: true, force: true }));

const refused = {
  status: 'fix-required',
  failedStep: 'preflight',
  cause: 'ratchet',
  attempt: 1,
  depositor: 'test',
  headSha: 'a'.repeat(40),
  evidencePath: '/tmp/x/preflight.log',
  steps: [
    { name: 'base-merge', durationMs: 4 },
    {
      name: 'preflight',
      durationMs: 9,
      check: 'dead-exports',
      evidencePath: '/tmp/x/preflight.log',
    },
  ],
};

describe('handoff-telemetry', () => {
  it('normalizes an unknown or missing cause to other', () => {
    assert.equal(handoffCause('push-hook'), 'push-hook');
    assert.equal(handoffCause('host-resources'), 'other');
    assert.equal(handoffCause(undefined), 'other');
    assert.ok(Object.isFrozen(HANDOFF_CAUSES));
  });

  it('builds a schema-valid retry for a refused run, carrying the check and no path', () => {
    const record = buildHandoffRecord({ storyId: STORY, envelope: refused });
    assert.equal(validateSignal(record).valid, true);
    assert.equal(record.kind, 'retry');
    assert.equal(isHandoffRecord(record), true);
    assert.deepEqual(record.details, {
      status: 'fix-required',
      failedStep: 'preflight',
      cause: 'ratchet',
      check: 'dead-exports',
      attempt: 1,
      stepDurationsMs: { 'base-merge': 4, preflight: 9 },
      depositor: 'test',
      headSha: 'a'.repeat(40),
    });
  });

  it('builds a trace for a ready run with only the numeric timing fields', () => {
    const record = buildHandoffRecord({
      storyId: STORY,
      envelope: {
        status: 'ready',
        attempt: 3,
        steps: [],
        suiteTimings: { lockWaitMs: 1, hostWaitMs: null, testRunMs: 5 },
        lockWait: { waitedSeconds: 2, expired: false, holder: { pid: 1 } },
        reviewMs: 40,
      },
    });
    assert.equal(record.kind, 'trace');
    assert.equal(validateSignal(record).valid, true);
    assert.deepEqual(record.details.suiteTimings, {
      lockWaitMs: 1,
      hostWaitMs: null,
      testRunMs: 5,
    });
    assert.deepEqual(record.details.lockWait, {
      waitedSeconds: 2,
      expired: false,
    });
    assert.equal(record.details.reviewMs, 40);
  });

  it('counts only story-handoff records toward the next attempt', async () => {
    assert.equal(await nextHandoffAttempt({ storyId: STORY, config }), 1);
    await emitHandoffRecord({ storyId: STORY, envelope: refused, config });
    await appendSignal({
      epicId: null,
      storyId: STORY,
      config,
      signal: {
        kind: 'retry',
        ts: new Date().toISOString(),
        epicId: null,
        phase: 'close',
        emitter: { tool: 'single-story-close' },
        details: { cause: 'ci-red' },
      },
    });
    assert.equal(await nextHandoffAttempt({ storyId: STORY, config }), 2);
  });

  it('a throwing reader yields a null attempt; a throwing writer returns false', async () => {
    const boom = async () => {
      throw new Error('boom');
    };
    assert.equal(
      await nextHandoffAttempt({ storyId: STORY, config, readFn: boom }),
      null,
    );
    const warnings = [];
    const ok = await emitHandoffRecord({
      storyId: STORY,
      envelope: refused,
      config,
      writeFn: boom,
      warn: (m) => warnings.push(m),
    });
    assert.equal(ok, false);
    assert.match(warnings[0], /boom/);
  });
});
