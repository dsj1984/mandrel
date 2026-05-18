// tests/scripts/lifecycle-emit.test.js
/**
 * Unit tests for the generic argv-driven emit helper
 * `.agents/scripts/lifecycle-emit.js` (Story #2425 / Task #2434 /
 * Epic #2307).
 *
 * The helper replaces the three single-purpose shim scripts the
 * `/epic-deliver` workflow previously invoked at Phase 6, 7.5, and 8.
 * These tests pin three behaviours:
 *
 *   1. Happy path — `--epic <id> --event epic.close.end` emits
 *      `epic.close.end` with `{ epicId: <id> }` and exits 0.
 *   2. Unknown event — `--event no-such-event` exits non-zero with a
 *      message citing the missing schema file.
 *   3. Required-field omission — emitting an event without a required
 *      payload field propagates the bus's schema-validation error.
 *
 * AC #3 in Task #2434 also requires that `--pr-number 123` flows into
 * the payload as a `prNumber` key. The bus's real schemas don't allow
 * the field, so the test injects a stub bus to assert the argv → payload
 * mapping directly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus } from '../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  buildPayload,
  parseArgv,
  runLifecycleEmit,
} from '../../.agents/scripts/lifecycle-emit.js';

describe('runLifecycleEmit (lifecycle-emit thin helper)', () => {
  it('happy path — emits epic.close.end with the assembled payload', async () => {
    const bus = new Bus();
    const emits = [];
    bus.on('epic.close.end', async (ctx) =>
      emits.push({ event: ctx.event, payload: ctx.payload }),
    );

    const out = await runLifecycleEmit({
      event: 'epic.close.end',
      payload: { epicId: 9999 },
      bus,
    });

    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.close.end');
    assert.deepEqual(emits[0].payload, { epicId: 9999 });
    assert.equal(out.event, 'epic.close.end');
    assert.equal(typeof out.seqId, 'number');
  });

  it('rejects with a clear error when the event schema does not exist', async () => {
    await assert.rejects(
      () => runLifecycleEmit({ event: 'no-such-event', payload: {} }),
      /unknown event "no-such-event".*no schema/,
    );
  });

  it('propagates the bus schema-validation error when a required field is missing', async () => {
    // `epic.close.end` requires `epicId`; emitting with no payload
    // must surface the bus's BUS_SCHEMA_VALIDATION error.
    await assert.rejects(
      () => runLifecycleEmit({ event: 'epic.close.end', payload: {} }),
      (err) => {
        assert.match(err.message, /schema validation failed/i);
        assert.equal(err.code, 'BUS_SCHEMA_VALIDATION');
        return true;
      },
    );
  });

  it('rejects when --event is omitted', async () => {
    await assert.rejects(
      () => runLifecycleEmit({ payload: {} }),
      /--event is required/,
    );
  });
});

describe('parseArgv (argv → flag map)', () => {
  it('maps flat argv flags to a value map', () => {
    const parsed = parseArgv([
      '--epic',
      '2307',
      '--event',
      'epic.automerge.start',
      '--pr-number',
      '123',
    ]);
    assert.deepEqual(parsed, {
      epic: '2307',
      event: 'epic.automerge.start',
      'pr-number': '123',
    });
  });

  it('throws when a flag has no value', () => {
    assert.throws(() => parseArgv(['--epic']), /--epic requires a value/);
  });

  it('throws when two flags appear back-to-back without a value', () => {
    assert.throws(
      () => parseArgv(['--epic', '--event', 'epic.close.end']),
      /--epic requires a value/,
    );
  });
});

describe('buildPayload (kebab → camelCase, --epic → epicId)', () => {
  it('maps --epic to epicId (integer-coerced) and drops the event flag', () => {
    const payload = buildPayload({ event: 'epic.close.end', epic: '2307' });
    assert.deepEqual(payload, { epicId: 2307 });
  });

  it('maps --pr-number 123 to a prNumber payload field (AC #3)', () => {
    const payload = buildPayload({
      event: 'epic.automerge.start',
      epic: '2307',
      'pr-number': '123',
    });
    assert.equal(payload.prNumber, 123);
    assert.equal(payload.epicId, 2307);
  });

  it('forwards non-integer values as strings (e.g. --pr-url)', () => {
    const payload = buildPayload({
      event: 'epic.automerge.start',
      'pr-url': 'https://github.com/dsj1984/mandrel/pull/123',
    });
    assert.equal(payload.prUrl, 'https://github.com/dsj1984/mandrel/pull/123');
  });

  it('rejects a non-positive --epic value', () => {
    assert.throws(
      () => buildPayload({ event: 'epic.close.end', epic: '0' }),
      /--epic must be a positive integer/,
    );
  });
});
