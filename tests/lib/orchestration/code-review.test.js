/**
 * Unit tests for the in-process `runCodeReview` wrapper.
 *
 * Story #1155 (Epic #1142) — original wrapper extracted the helper-driven
 * `epic-code-review` invocation into a callable module.
 *
 * Story #2831 (Epic #2815) — refactored to load the review provider
 * through the factory, render the structured comment via
 * `findings-renderer`, and post via `upsertStructuredComment`. These
 * tests now stub the factory + upsert seam (the runner-stub indirection
 * is gone — the adapter is the seam).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runCodeReview } from '../../../.agents/scripts/lib/orchestration/code-review.js';

const stubBus = { emit: async () => {} };

function noopUpsert() {
  return async () => {};
}

function recordingUpsert() {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
  };
  return { fn, calls };
}

function fakeAdapter(findings) {
  const calls = [];
  return {
    calls,
    runReview: async (input) => {
      calls.push(input);
      return findings;
    },
  };
}

function baseResolveConfig() {
  return {
    project: { baseBranch: 'main' },
    delivery: { codeReview: { provider: 'native' } },
  };
}

test('runCodeReview: rejects missing/invalid epicId', async () => {
  await assert.rejects(
    () => runCodeReview({ provider: {}, bus: stubBus }),
    /epicId is required/,
  );
  await assert.rejects(
    () =>
      runCodeReview({
        epicId: 0,
        provider: {},
        bus: stubBus,
      }),
    /epicId is required/,
  );
});

test('runCodeReview: rejects missing bus', async () => {
  await assert.rejects(
    () => runCodeReview({ epicId: 42, provider: {} }),
    /bus is required/,
  );
});

test('runCodeReview: clean run posts the structured comment and reports posted=true', async () => {
  const adapter = fakeAdapter([]);
  const upsert = recordingUpsert();

  const out = await runCodeReview({
    epicId: 42,
    provider: { kind: 'github' },
    bus: stubBus,
    reviewProvider: adapter,
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: upsert.fn,
  });

  assert.equal(out.status, 'ok');
  assert.equal(out.halted, false);
  assert.equal(out.posted, true);
  assert.equal(out.blockerReason, null);
  assert.deepEqual(out.severity, {
    critical: 0,
    high: 0,
    medium: 0,
    suggestion: 0,
  });
  assert.equal(upsert.calls.length, 1);
  const [provider, ticketId, type, body] = upsert.calls[0];
  assert.deepEqual(provider, { kind: 'github' });
  assert.equal(ticketId, 42);
  assert.equal(type, 'code-review');
  assert.match(body, /Code Review — Epic #42/);
});

test('runCodeReview: passes scope/ticketId/baseRef/headRef to the adapter', async () => {
  const adapter = fakeAdapter([]);
  await runCodeReview({
    epicId: 42,
    provider: {},
    bus: stubBus,
    baseBranch: 'develop',
    reviewProvider: adapter,
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: noopUpsert(),
  });
  assert.equal(adapter.calls.length, 1);
  // Story #2871 — ReviewInput now carries an optional `labels` field
  // (defaults to []) so chain-entry gate predicates can read ticket
  // labels at invocation time.
  assert.deepEqual(adapter.calls[0], {
    scope: 'epic',
    ticketId: 42,
    baseRef: 'develop',
    headRef: 'epic/42',
    labels: [],
  });
});

test('runCodeReview: critical findings set halted=true with a reason', async () => {
  const adapter = fakeAdapter([
    {
      severity: 'critical',
      title: 'Low Maintainability',
      body: 'critical body',
    },
    { severity: 'high', title: 'Lint check failed', body: 'high body' },
  ]);
  const out = await runCodeReview({
    epicId: 42,
    provider: {},
    bus: stubBus,
    reviewProvider: adapter,
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: noopUpsert(),
  });
  assert.equal(out.halted, true);
  assert.equal(out.severity.critical, 1);
  assert.equal(out.severity.high, 1);
  assert.match(out.blockerReason, /1 critical/);
});

test('runCodeReview: defaults baseBranch to project.baseBranch when arg is null', async () => {
  const adapter = fakeAdapter([]);
  await runCodeReview({
    epicId: 7,
    provider: {},
    bus: stubBus,
    reviewProvider: adapter,
    resolveConfigFn: () => ({
      project: { baseBranch: 'trunk' },
      delivery: { codeReview: { provider: 'native' } },
    }),
    upsertCommentFn: noopUpsert(),
  });
  assert.equal(adapter.calls[0].baseRef, 'trunk');
});

test('runCodeReview: surfaces upsert failure as posted=false but still returns ok', async () => {
  const adapter = fakeAdapter([]);
  const out = await runCodeReview({
    epicId: 42,
    provider: {},
    bus: stubBus,
    reviewProvider: adapter,
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.posted, false);
});

test('runCodeReview: adapter throw emits code-review.end with status=invalid and rethrows', async () => {
  const events = [];
  const bus = {
    emit: async (ev, payload) => {
      events.push({ ev, payload });
    },
  };
  await assert.rejects(
    () =>
      runCodeReview({
        epicId: 42,
        provider: {},
        bus,
        reviewProvider: {
          runReview: async () => {
            throw new Error('adapter blew up');
          },
        },
        resolveConfigFn: baseResolveConfig,
        upsertCommentFn: noopUpsert(),
      }),
    /adapter blew up/,
  );
  assert.equal(events[0].ev, 'code-review.start');
  const end = events.find((e) => e.ev === 'code-review.end');
  assert.equal(end.payload.status, 'invalid');
});

test('runCodeReview: adapter returning non-array throws TypeError and emits invalid', async () => {
  const events = [];
  const bus = {
    emit: async (ev, payload) => {
      events.push({ ev, payload });
    },
  };
  await assert.rejects(
    () =>
      runCodeReview({
        epicId: 42,
        provider: {},
        bus,
        reviewProvider: { runReview: async () => 'not-an-array' },
        resolveConfigFn: baseResolveConfig,
        upsertCommentFn: noopUpsert(),
      }),
    /expected Finding\[\]/,
  );
  const end = events.find((e) => e.ev === 'code-review.end');
  assert.equal(end.payload.status, 'invalid');
});

test('runCodeReview: emits code-review.start then code-review.end on clean run', async () => {
  const events = [];
  const bus = {
    emit: async (ev, payload) => {
      events.push({ ev, payload });
    },
  };
  const out = await runCodeReview({
    epicId: 42,
    provider: {},
    bus,
    reviewProvider: fakeAdapter([
      { severity: 'medium', title: 'one', body: 'x' },
    ]),
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: noopUpsert(),
  });
  assert.equal(events[0].ev, 'code-review.start');
  assert.equal(events[1].ev, 'code-review.end');
  assert.equal(events[1].payload.epicId, 42);
  assert.equal(events[1].payload.status, 'ok');
  assert.deepEqual(events[1].payload.severity, out.severity);
  assert.equal(events[1].payload.halted, false);
  assert.equal(events[1].payload.posted, true);
});

test('runCodeReview: routes provider name from delivery.codeReview to the factory', async () => {
  const factoryCalls = [];
  const adapter = fakeAdapter([]);
  await runCodeReview({
    epicId: 42,
    provider: {},
    bus: stubBus,
    resolveConfigFn: () => ({
      project: { baseBranch: 'main' },
      delivery: { codeReview: { provider: 'native' } },
    }),
    createReviewProviderFn: (cfg) => {
      factoryCalls.push(cfg);
      return adapter;
    },
    upsertCommentFn: noopUpsert(),
  });
  assert.equal(factoryCalls.length, 1);
  assert.deepEqual(factoryCalls[0], { provider: 'native' });
});
