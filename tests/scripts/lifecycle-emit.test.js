// tests/scripts/lifecycle-emit.test.js
/**
 * Unit tests for the generic argv-driven emit helper
 * `.agents/scripts/lifecycle-emit.js` (Story #2425 / Task #2434 /
 * Epic #2307).
 *
 * The helper replaces the three single-purpose shim scripts the
 * `/deliver` workflow previously invoked at Phase 6, 7.5, and 8.
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
  collectOutcomes,
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

// Story #2681 — the three `epic.merge.*` schemas previously declared
// `additionalProperties: false` with no `epicId` property, so
// `lifecycle-emit --epic <id> --event epic.merge.armed --pr-url <url>`
// failed schema validation despite the CLI's documented auto-inject of
// `epicId`. The schemas now accept `epicId` as an optional integer.
// These tests pin the relaxation so a future schema edit can't silently
// re-tighten and re-break the documented CLI surface.
describe('lifecycle-emit ↔ epic.merge.* schemas (Story #2681)', () => {
  // Inject a bus so the helper does NOT wire the default listener chain.
  // Without this, MergeWatcher would subscribe to `epic.merge.armed`,
  // shell out to real `gh pr view` against the fake pull URL, and sleep
  // 30s up to a 1-hour budget on every emit. We are pinning schema
  // validation here, not exercising the listener roster, so the bus
  // should stay listener-free.
  it('epic.merge.armed accepts the injected epicId alongside prUrl', async () => {
    const out = await runLifecycleEmit({
      event: 'epic.merge.armed',
      payload: {
        epicId: 90042,
        prUrl: 'https://github.com/dsj1984/mandrel/pull/90042',
      },
      bus: new Bus(),
    });
    assert.equal(out.event, 'epic.merge.armed');
    assert.equal(typeof out.seqId, 'number');
  });

  it('epic.merge.blocked accepts the injected epicId alongside prUrl + reason', async () => {
    const out = await runLifecycleEmit({
      event: 'epic.merge.blocked',
      payload: {
        epicId: 90043,
        prUrl: 'https://github.com/dsj1984/mandrel/pull/90043',
        reason: 'manualInterventions > 0',
      },
      bus: new Bus(),
    });
    assert.equal(out.event, 'epic.merge.blocked');
  });

  it('epic.merge.ready accepts the injected epicId alongside prUrl', async () => {
    const out = await runLifecycleEmit({
      event: 'epic.merge.ready',
      payload: {
        epicId: 90044,
        prUrl: 'https://github.com/dsj1984/mandrel/pull/90044',
      },
      bus: new Bus(),
    });
    assert.equal(out.event, 'epic.merge.ready');
  });
});

// Story #2855 — `epic.automerge.start` had the same shape as the #2681
// schemas (additionalProperties: false, no `epicId` property), so the
// documented `/deliver` Phase 8.5 invocation
// `lifecycle-emit --epic <id> --event epic.automerge.start --pr-url <url>`
// failed schema validation. The schema now accepts `epicId` as an optional
// integer. This test pins the relaxation against future re-tightening.
describe('lifecycle-emit ↔ epic.automerge.start schema (Story #2855)', () => {
  it('epic.automerge.start accepts the injected epicId alongside prUrl', async () => {
    const out = await runLifecycleEmit({
      event: 'epic.automerge.start',
      payload: {
        epicId: 90045,
        prUrl: 'https://github.com/dsj1984/mandrel/pull/90045',
      },
      bus: new Bus(),
    });
    assert.equal(out.event, 'epic.automerge.start');
    assert.equal(typeof out.seqId, 'number');
  });
});

// Story #3904 — `runLifecycleEmit` previously returned `{ event, payload,
// seqId }` and the CLI always exited 0, even when a listener (e.g. the
// Finalizer on a `closePlanningTickets` throw, or the AcceptanceReconciler
// on an unmet AC gap) classified its invocation `failed`. Listeners record
// `failed` into `this.classifications` rather than throwing, so the bus
// emit resolves cleanly and the partial-finalize failure was swallowed at
// the CLI boundary. The fix collects every listener's classifications into
// `outcomes[]`, sets `failed` when any is `failed`, and fires an
// operator-visible blocker signal.
describe('runLifecycleEmit failure propagation (Story #3904)', () => {
  it('returns outcomes[] flattened from the listener chain classifications', () => {
    const chain = {
      acceptanceReconciler: {
        classifications: [{ event: 'epic.close.end', seqId: 1, outcome: 'ok' }],
      },
      finalizer: {
        classifications: [
          {
            event: 'acceptance.reconcile.ok',
            seqId: 2,
            outcome: 'failed',
            reason: 'finalize-threw:boom',
          },
        ],
      },
    };
    const outcomes = collectOutcomes(chain);
    assert.equal(outcomes.length, 2);
    assert.deepEqual(outcomes[0], {
      listener: 'acceptanceReconciler',
      event: 'epic.close.end',
      seqId: 1,
      outcome: 'ok',
    });
    assert.equal(outcomes[1].listener, 'finalizer');
    assert.equal(outcomes[1].outcome, 'failed');
    assert.equal(outcomes[1].reason, 'finalize-threw:boom');
  });

  it('collectOutcomes tolerates a null/undefined chain (injected-bus path)', () => {
    assert.deepEqual(collectOutcomes(null), []);
    assert.deepEqual(collectOutcomes(undefined), []);
    assert.deepEqual(collectOutcomes({}), []);
  });

  it('happy path — no failed classification → failed:false, empty outcomes, signal not fired', async () => {
    let signalFired = false;
    const out = await runLifecycleEmit({
      event: 'epic.close.end',
      payload: { epicId: 9999 },
      bus: new Bus(),
      emitBlockedSignalFn: async () => {
        signalFired = true;
      },
    });
    assert.equal(out.failed, false);
    assert.deepEqual(out.outcomes, []);
    assert.equal(signalFired, false);
  });

  it('failing listener → failed:true, outcomes[] surfaced, blocker signal fired', async () => {
    // Inject a bus (so the helper does not wire the real chain) plus a
    // fake chain whose listener classified `failed` — the canonical
    // partial-finalize shape.
    const bus = new Bus();
    const chain = {
      finalizer: {
        classifications: [
          {
            event: 'acceptance.reconcile.ok',
            seqId: 1,
            outcome: 'failed',
            reason: 'finalize-threw:closePlanningTickets',
          },
        ],
      },
    };
    let signalArgs = null;
    const out = await runLifecycleEmit({
      event: 'epic.close.end',
      payload: { epicId: 4242 },
      bus,
      chain,
      emitBlockedSignalFn: async (args) => {
        signalArgs = args;
      },
    });

    assert.equal(out.failed, true);
    assert.equal(out.outcomes.length, 1);
    assert.equal(out.outcomes[0].listener, 'finalizer');
    assert.equal(out.outcomes[0].outcome, 'failed');

    // Operator-visible signal fired with the Epic id + failed outcomes.
    assert.ok(
      signalArgs,
      'emitBlockedSignalFn should fire on a failed outcome',
    );
    assert.equal(signalArgs.epicId, 4242);
    assert.equal(signalArgs.event, 'epic.close.end');
    assert.equal(signalArgs.failedOutcomes.length, 1);
    assert.equal(
      signalArgs.failedOutcomes[0].reason,
      'finalize-threw:closePlanningTickets',
    );
  });

  it('ignores an injected chain when no bus is supplied (helper owns the chain)', async () => {
    // Without an injected bus the helper builds (or skips) the chain itself,
    // so a caller-supplied `chain` override is intentionally not honoured.
    // With no epicId in the payload the real chain is skipped entirely, so
    // outcomes stay empty and `failed` is false.
    const chain = {
      finalizer: {
        classifications: [{ event: 'x', seqId: 1, outcome: 'failed' }],
      },
    };
    let signalFired = false;
    const out = await runLifecycleEmit({
      // `acceptance.reconcile.ok` requires only `baseRead` (no epicId), so
      // the helper skips the real chain entirely.
      event: 'acceptance.reconcile.ok',
      payload: { baseRead: true },
      chain,
      emitBlockedSignalFn: async () => {
        signalFired = true;
      },
    });
    assert.deepEqual(out.outcomes, []);
    assert.equal(out.failed, false);
    assert.equal(signalFired, false);
  });
});
