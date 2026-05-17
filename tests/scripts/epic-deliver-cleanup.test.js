// tests/scripts/epic-deliver-cleanup.test.js
/**
 * Unit tests for the post-Wave-8 thin-emit-shim `epic-deliver-cleanup`
 * CLI (Story #2259 / Task #2265, Epic #2172).
 *
 * Pre-Wave-8 this CLI reaped branches + worktrees directly. After
 * Wave 8 the responsibility belongs to the `Cleaner` lifecycle
 * listener; the CLI is now a telemetry shim that emits
 * `epic.cleanup.start` onto a per-invocation bus and exits.
 *
 * The contract here matches `epic-deliver-automerge.test.js`:
 *   - argv parsing produces a typed `epicId` or `null`;
 *   - classifyCleanupInvocation distinguishes help / usage-error / run;
 *   - runEpicDeliverCleanup emits exactly one `epic.cleanup.start`
 *     event onto the injected bus and returns the seqId.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyCleanupInvocation,
  parseCleanupArgs,
  runEpicDeliverCleanup,
} from '../../.agents/scripts/epic-deliver-cleanup.js';
import { Bus } from '../../.agents/scripts/lib/orchestration/lifecycle/bus.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

describe('parseCleanupArgs', () => {
  it('parses --epic', () => {
    const out = parseCleanupArgs(['--epic', '1178']);
    assert.equal(out.epicId, 1178);
    assert.equal(out.help, false);
  });

  it('returns help=true on --help', () => {
    const out = parseCleanupArgs(['--help']);
    assert.equal(out.help, true);
  });

  it('rejects non-positive epic ids', () => {
    assert.equal(parseCleanupArgs(['--epic', '0']).epicId, null);
    assert.equal(parseCleanupArgs([]).epicId, null);
  });
});

describe('classifyCleanupInvocation', () => {
  it('returns help when --help is set', () => {
    assert.deepEqual(classifyCleanupInvocation({ help: true }), {
      kind: 'help',
    });
  });

  it('returns usage-error when --epic is missing', () => {
    const r = classifyCleanupInvocation({ help: false, epicId: null });
    assert.equal(r.kind, 'usage-error');
    assert.ok(r.messages.some((m) => /required/.test(m)));
  });

  it('returns run intent when --epic is provided', () => {
    const r = classifyCleanupInvocation({ help: false, epicId: 1178 });
    assert.deepEqual(r, { kind: 'run', epicId: 1178 });
  });
});

describe('runEpicDeliverCleanup', () => {
  it('emits exactly one epic.cleanup.start event with epicId payload', async () => {
    const bus = new Bus();
    const emits = [];
    bus.on('epic.cleanup.start', async (ctx) => {
      emits.push({ event: ctx.event, payload: ctx.payload });
    });

    const out = await runEpicDeliverCleanup({
      epicId: 2172,
      bus,
      loggerImpl: quietLogger(),
    });

    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.cleanup.start');
    assert.deepEqual(emits[0].payload, { epicId: 2172 });
    assert.equal(Number.isInteger(out.seqId), true);
    assert.equal(out.epicId, 2172);
  });

  it('rejects bad epicId', async () => {
    await assert.rejects(
      () => runEpicDeliverCleanup({ epicId: 0 }),
      /must be a positive integer/,
    );
    await assert.rejects(
      () => runEpicDeliverCleanup({ epicId: -5 }),
      /must be a positive integer/,
    );
  });
});
