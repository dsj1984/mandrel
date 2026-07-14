/**
 * gather-retro-signals.test.js — coverage for gatherRetroSignals /
 * composeRetroBody (Story #4417 substrate), kept after `retro-run.js` was
 * hard-deleted in the v2 ceremony lock-in.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { composeRetroBody } from '../../../.agents/scripts/lib/orchestration/retro/phases/compose-body.js';
import { gatherRetroSignals } from '../../../.agents/scripts/lib/orchestration/retro/phases/gather-signals.js';

// --- helpers ---------------------------------------------------------------

/**
 * Minimal fake ticketing provider: one Epic with the supplied Stories as
 * direct sub-tickets, and empty comment lists (so no story-perf-summary /
 * parked / epic-perf comments are found — friction must then come from the
 * signals scan alone). `epic-run-state` is injected separately in these
 * tests, so `getTicketComments` never needs to serve it.
 */
function makeProvider({ epicId, epicTitle = 'Epic', stories = [] }) {
  const subs = stories.map((s) => ({
    id: s.id,
    number: s.id,
    body: s.body ?? '',
    labels: s.labels ?? ['type::story'],
  }));
  return {
    async getSubTickets(id) {
      return id === epicId ? subs : [];
    },
    async getTicket(id) {
      return id === epicId ? { id: epicId, title: epicTitle, body: '' } : null;
    },
    async getTicketComments() {
      return [];
    },
  };
}

/** Build a `forEachLineFn` stub from a Map<storyId, records[]>. */
function streamFrom(map) {
  return async (_epicId, sid, cb) => {
    const lines = map.get(sid) ?? [];
    for (let i = 0; i < lines.length; i++) await cb(lines[i], i + 1);
    return {
      linesRead: lines.length,
      linesParsed: lines.length,
      missing: false,
    };
  };
}

/** A `forEachLineFn` / `forEachEpicLineFn` that yields nothing. */
const emptyStoryStream = async () => ({
  linesRead: 0,
  linesParsed: 0,
  missing: true,
});
const emptyEpicStream = async () => ({
  linesRead: 0,
  linesParsed: 0,
  missing: true,
});

/** Parse the `<!-- automerge-verdict: {...} -->` trailer out of a body. */
function parseAutomergeVerdict(body) {
  const m = body.match(/<!-- automerge-verdict: (\{.*\}) -->/);
  assert.ok(m, 'expected an automerge-verdict trailer in the retro body');
  return JSON.parse(m[1]);
}
test('gatherRetroSignals: consumer-pane commands target the resolved consumer repo', async () => {
  const provider = makeProvider({ epicId: 100, stories: [{ id: 101 }] });
  const signals = await gatherRetroSignals({
    epicId: 100,
    provider,
    frameworkRepo: 'dsj1984/mandrel',
    consumerRepo: 'acme/widget',
    forEachLineFn: streamFrom(
      new Map([
        [
          101,
          [
            { category: 'flaky-test', source: 'consumer' },
            { category: 'flaky-test', source: 'consumer' },
          ],
        ],
      ]),
    ),
    forEachEpicLineFn: emptyEpicStream,
    epicRunStateReadFn: async () => null,
  });
  assert.equal(signals.routedProposals.consumer.length, 1);
  assert.match(
    signals.routedProposals.consumer[0].command,
    /--repo acme\/widget/,
  );
});

test('gatherRetroSignals: missing consumer repo disables the consumer pane loudly (no dsj1984/mandrel)', async () => {
  const provider = makeProvider({ epicId: 110, stories: [{ id: 111 }] });
  const warns = [];
  const signals = await gatherRetroSignals({
    epicId: 110,
    provider,
    logger: { warn: (m) => warns.push(m) },
    frameworkRepo: '', // resolves to the DEFAULT_FRAMEWORK_REPO constant
    consumerRepo: '', // no resolved consumer repo
    forEachLineFn: streamFrom(
      new Map([
        [
          111,
          [
            { category: 'flaky-test', source: 'consumer' },
            { category: 'flaky-test', source: 'consumer' },
          ],
        ],
      ]),
    ),
    forEachEpicLineFn: emptyEpicStream,
    epicRunStateReadFn: async () => null,
  });
  // Loud: a warn names the disabled consumer pane.
  assert.ok(
    warns.some((m) => /consumer proposal pane is DISABLED/i.test(m)),
    `expected a consumer-pane-disabled warn; got: ${warns.join('\n') || '<none>'}`,
  );
  // No consumer-tagged friction is silently routed at the framework mirror.
  const serialized = JSON.stringify(signals.routedProposals);
  assert.ok(
    !/dsj1984\/mandrel/.test(serialized),
    `no proposal command should target dsj1984/mandrel; got: ${serialized}`,
  );
  assert.equal(signals.routedProposals.consumer.length, 0);
});

// --- 2. counts.friction derives from the signals scan ----------------------

test('gatherRetroSignals: friction derives from the signals scan even with no story-perf-summary comments', async () => {
  const provider = makeProvider({ epicId: 200, stories: [{ id: 201 }] });
  const signals = await gatherRetroSignals({
    epicId: 200,
    provider,
    frameworkRepo: 'dsj1984/mandrel',
    consumerRepo: 'acme/widget',
    // A single categorized signal on disk — no perf-summary comment exists.
    forEachLineFn: streamFrom(
      new Map([[201, [{ category: 'lonely', source: 'consumer' }]]]),
    ),
    forEachEpicLineFn: emptyEpicStream,
    epicRunStateReadFn: async () => null,
  });
  assert.equal(
    signals.counts.friction,
    1,
    'friction must count the categorized signal from the ndjson scan',
  );
  assert.equal(signals.storyPerfSummaries.length, 0);

  // A single-occurrence signal is discarded (not actionable) — the full
  // shape must still fire because friction > 0, and cleanSprint is false.
  const { compact, body } = composeRetroBody({
    epicId: 200,
    counts: signals.counts,
    routedProposals: signals.routedProposals,
    timestamp: '2026-07-10T00:00:00.000Z',
  });
  assert.equal(compact, false, 'friction > 0 must route to the full retro');
  assert.equal(parseAutomergeVerdict(body).cleanSprint, false);
});

// --- 3. compact suppressed by actionable proposals -------------------------

test('composeRetroBody: never compact when an actionable bucket is non-empty (clean counts, no forceFull)', () => {
  const routedProposals = {
    framework: [{ category: 'lint-loop', title: 'x', command: 'gh ...' }],
    consumer: [],
    discarded: [],
  };
  const { compact, body } = composeRetroBody({
    epicId: 300,
    counts: { friction: 0, parked: 0, recuts: 0, hitl: 0, interventions: 0 },
    routedProposals,
    forceFull: false,
    timestamp: '2026-07-10T00:00:00.000Z',
  });
  assert.equal(compact, false);
  assert.equal(parseAutomergeVerdict(body).cleanSprint, false);
});

test('composeRetroBody: a consumer actionable item also suppresses the compact shape', () => {
  const routedProposals = {
    framework: [],
    consumer: [{ category: 'flaky-test', title: 'x', command: 'gh ...' }],
    discarded: [],
  };
  const { compact } = composeRetroBody({
    epicId: 301,
    counts: { friction: 0, parked: 0, recuts: 0, hitl: 0, interventions: 0 },
    routedProposals,
    timestamp: '2026-07-10T00:00:00.000Z',
  });
  assert.equal(compact, false);
});

test('composeRetroBody: a purely discarded bucket does NOT suppress the compact shape', () => {
  const routedProposals = {
    framework: [],
    consumer: [],
    discarded: [{ category: 'one-off', occurrences: 1, source: 'consumer' }],
  };
  const { compact } = composeRetroBody({
    epicId: 302,
    counts: { friction: 0, parked: 0, recuts: 0, hitl: 0, interventions: 0 },
    routedProposals,
    timestamp: '2026-07-10T00:00:00.000Z',
  });
  assert.equal(compact, true, 'discarded-only proposals leave a clean sprint');
});

// --- 4. blocked events from the epic-run-state snapshot --------------------

test('gatherRetroSignals: category-less blocked snapshot record forces an actionable proposal (fallback category)', async () => {
  const provider = makeProvider({ epicId: 400, stories: [{ id: 401 }] });
  const signals = await gatherRetroSignals({
    epicId: 400,
    provider,
    frameworkRepo: 'dsj1984/mandrel',
    consumerRepo: 'acme/widget',
    forEachLineFn: emptyStoryStream, // no friction signals at all
    forEachEpicLineFn: emptyEpicStream,
    // A blocked Story with NO category on its snapshot record.
    epicRunStateReadFn: async () => ({
      stories: { 401: { status: 'blocked', title: 'Stuck' } },
    }),
  });
  const consumer = signals.routedProposals.consumer;
  assert.equal(
    consumer.length,
    1,
    'blocked event must force one actionable proposal',
  );
  assert.equal(consumer[0].category, 'agent-blocked');

  // ...and it suppresses the compact shape (auto-merge input).
  const { compact } = composeRetroBody({
    epicId: 400,
    counts: signals.counts,
    routedProposals: signals.routedProposals,
    timestamp: '2026-07-10T00:00:00.000Z',
  });
  assert.equal(compact, false);
});

test('gatherRetroSignals: a categorized blocked snapshot record keeps its own category', async () => {
  const provider = makeProvider({ epicId: 410, stories: [{ id: 411 }] });
  const signals = await gatherRetroSignals({
    epicId: 410,
    provider,
    frameworkRepo: 'dsj1984/mandrel',
    consumerRepo: 'acme/widget',
    forEachLineFn: emptyStoryStream,
    forEachEpicLineFn: emptyEpicStream,
    epicRunStateReadFn: async () => ({
      stories: {
        411: {
          status: 'blocked',
          category: 'schema-migration',
          source: 'framework',
        },
      },
    }),
  });
  assert.equal(signals.routedProposals.framework.length, 1);
  assert.equal(
    signals.routedProposals.framework[0].category,
    'schema-migration',
  );
});

// --- 5. per-Epic stream folded into the unified scan -----------------------

test('gatherRetroSignals: unified scan includes the per-Epic signals.ndjson stream', async () => {
  const provider = makeProvider({ epicId: 500, stories: [{ id: 501 }] });
  const signals = await gatherRetroSignals({
    epicId: 500,
    provider,
    frameworkRepo: 'dsj1984/mandrel',
    consumerRepo: 'acme/widget',
    forEachLineFn: emptyStoryStream, // Story streams empty
    // Per-Epic stream carries two same-category framework signals →
    // actionable. This mirrors an appendEpicSignal writer (lifecycle-emit).
    forEachEpicLineFn: async (_epicId, cb) => {
      const lines = [
        { category: 'wave-stall', source: 'framework' },
        { category: 'wave-stall', source: 'framework' },
      ];
      for (let i = 0; i < lines.length; i++) await cb(lines[i], i + 1);
      return { linesRead: 2, linesParsed: 2, missing: false };
    },
    epicRunStateReadFn: async () => null,
  });
  assert.equal(
    signals.counts.friction,
    2,
    'the per-Epic stream signals must count toward friction',
  );
  assert.equal(signals.routedProposals.framework.length, 1);
  assert.equal(signals.routedProposals.framework[0].category, 'wave-stall');
});
