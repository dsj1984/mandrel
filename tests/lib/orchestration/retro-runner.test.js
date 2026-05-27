/**
 * Unit tests for the in-process `runRetro` module.
 *
 * Story #1155 (Epic #1142, 5.40.0). Drives the runner end-to-end against a
 * fake provider that records:
 *   - Every comment fetch (so the test verifies story-perf-summary +
 *     parked-follow-ons + epic-perf-report were sourced from the graph).
 *   - The final `provider.postComment` payload (so the test verifies the
 *     marker, type, and body shape).
 *
 * Coverage:
 *   - Compact path fires for a clean manifest (zero across all five signals).
 *   - Full path fires when any signal is non-zero (e.g., recut count > 0).
 *   - `runRetro` posts a structured `retro` comment with the
 *     `retro-complete: <ISO>` marker terminating the body.
 *   - `composeRetroBody` is pure and deterministic given a fixed timestamp.
 *   - Required-arg validation (epicId, provider).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeRetroBody,
  gatherRetroSignals,
  runRetro,
} from '../../../.agents/scripts/lib/orchestration/retro-runner.js';

function fencedJson(payload) {
  return `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

function structuredCommentBody(type, jsonPayload) {
  // Mirrors the structuredCommentMarker shape the real codebase uses;
  // findStructuredComment only checks for the marker substring.
  const marker = `<!-- ap:structured-comment type="${type}" -->`;
  return `${marker}\n\n${fencedJson(jsonPayload)}`;
}

/**
 * Build a fake provider with sub-issue topology and per-ticket comments.
 *
 * @param {{
 *   epic: { id: number, title: string },
 *   stories: Array<{ id: number, body?: string, labels?: string[], perfSummary?: object|null }>,
 *   tasks: Array<{ id: number, parentStoryId: number, labels?: string[] }>,
 *   parkedFollowOns?: object|null,
 *   epicPerfReport?: object|null,
 * }} graph
 */
function makeProvider(graph) {
  const subIssuesByParent = new Map();
  subIssuesByParent.set(
    graph.epic.id,
    graph.stories.map((s) => ({
      id: s.id,
      number: s.id,
      body: s.body ?? '',
      labels: s.labels ?? ['type::story'],
    })),
  );
  for (const story of graph.stories) {
    const childTasks = graph.tasks
      .filter((t) => t.parentStoryId === story.id)
      .map((t) => ({
        id: t.id,
        number: t.id,
        labels: t.labels ?? ['type::task'],
      }));
    subIssuesByParent.set(story.id, childTasks);
  }

  const commentsByTicket = new Map();
  // Story → story-perf-summary (when supplied).
  for (const story of graph.stories) {
    const list = [];
    if (story.perfSummary) {
      list.push({
        id: story.id * 1000,
        body: structuredCommentBody('story-perf-summary', story.perfSummary),
      });
    }
    commentsByTicket.set(story.id, list);
  }
  // Epic → parked-follow-ons + epic-perf-report (when supplied).
  const epicComments = [];
  if (graph.parkedFollowOns) {
    epicComments.push({
      id: 1,
      body: structuredCommentBody('parked-follow-ons', graph.parkedFollowOns),
    });
  }
  if (graph.epicPerfReport) {
    epicComments.push({
      id: 2,
      body: structuredCommentBody('epic-perf-report', graph.epicPerfReport),
    });
  }
  commentsByTicket.set(graph.epic.id, epicComments);

  const postedComments = [];
  const deletedCommentIds = [];

  return {
    posted: postedComments,
    deleted: deletedCommentIds,
    async getSubTickets(id) {
      return subIssuesByParent.get(id) ?? [];
    },
    async getTicketComments(id) {
      return commentsByTicket.get(id) ?? [];
    },
    async getTicket(id) {
      if (id === graph.epic.id) return graph.epic;
      return null;
    },
    async postComment(ticketId, payload) {
      const id = postedComments.length + 1;
      postedComments.push({ id, ticketId, ...payload });
      // Mirror real provider semantics: posted comments become visible to
      // subsequent getTicketComments reads on the same ticket.
      const list = commentsByTicket.get(ticketId) ?? [];
      list.push({ id, body: payload.body });
      commentsByTicket.set(ticketId, list);
      return { commentId: id };
    },
    async deleteComment(id) {
      deletedCommentIds.push(id);
    },
  };
}

// Epic #2646 Story C (Task #2700) — runRetro now requires `bus` as a
// hard input; tests pass this minimal stub through every call.
const stubBus = { emit: async () => {} };

test('runRetro: rejects missing epicId / provider', async () => {
  await assert.rejects(() => runRetro({ provider: {} }), /epicId is required/);
  await assert.rejects(() => runRetro({ epicId: 5 }), /provider is required/);
});

test('runRetro: clean manifest fires the compact path and posts retro comment', async () => {
  const provider = makeProvider({
    epic: { id: 100, title: 'Test Epic' },
    stories: [
      {
        id: 200,
        labels: ['type::story'],
        perfSummary: {
          kind: 'story-perf-summary',
          frictionByCategory: {},
        },
      },
    ],
    tasks: [
      { id: 300, parentStoryId: 200, labels: ['type::task'] },
      { id: 301, parentStoryId: 200, labels: ['type::task'] },
    ],
  });

  const out = await runRetro({
    epicId: 100,
    provider,
    bus: stubBus,
    timestamp: '2026-05-10T00:00:00.000Z',
  });

  assert.equal(out.posted, true);
  assert.equal(out.compact, true);
  assert.equal(provider.posted.length, 1);
  const retroComment = provider.posted[0];
  assert.equal(retroComment.ticketId, 100);
  assert.equal(retroComment.type, 'retro');
  assert.match(retroComment.body, /Sprint Retrospective.*Epic #100/);
  assert.match(retroComment.body, /🟢 Clean sprint/);
  assert.match(retroComment.body, /Session Observations/);
  assert.match(
    retroComment.body,
    /<!-- retro-complete: 2026-05-10T00:00:00\.000Z -->/,
  );
  // Compact path omits "What Went Well" / "Architectural Debt" headings.
  assert.equal(retroComment.body.includes('What Went Well'), false);
});

test('runRetro: non-clean signals route to the full six-section path', async () => {
  const provider = makeProvider({
    epic: { id: 101, title: 'Friction Epic' },
    stories: [
      {
        id: 210,
        body: '<!-- recut-of: #999 -->',
        labels: ['type::story'],
        perfSummary: {
          kind: 'story-perf-summary',
          frictionByCategory: { hotspot: 3 },
        },
      },
    ],
    tasks: [
      {
        id: 310,
        parentStoryId: 210,
        labels: ['type::task', 'status::blocked'],
      },
    ],
    epicPerfReport: {
      kind: 'epic-perf-report',
      topHotspots: [{ phase: 'lint', occurrences: 4, avgRatio: 1.7 }],
    },
  });

  const out = await runRetro({
    epicId: 101,
    provider,
    bus: stubBus,
    timestamp: '2026-05-10T01:00:00.000Z',
  });

  assert.equal(out.compact, false);
  const retroComment = provider.posted[0];
  assert.match(retroComment.body, /What Went Well/);
  assert.match(retroComment.body, /What Could Be Improved/);
  assert.match(retroComment.body, /Architectural Debt/);
  assert.match(retroComment.body, /Top hotspots/);
  assert.match(retroComment.body, /`lint`.*occurrence/);
  // Recut count derived from body marker fallback.
  assert.equal(out.scorecard.recuts, 1);
  assert.equal(out.scorecard.hotfixes, 1);
  assert.equal(out.scorecard.friction, 3);
});

test('runRetro: forceFull overrides the clean-manifest heuristic', async () => {
  const provider = makeProvider({
    epic: { id: 102, title: 'Clean But Force-Full' },
    stories: [
      {
        id: 220,
        labels: ['type::story'],
        perfSummary: { kind: 'story-perf-summary', frictionByCategory: {} },
      },
    ],
    tasks: [{ id: 320, parentStoryId: 220, labels: ['type::task'] }],
  });
  const out = await runRetro({
    epicId: 102,
    provider,
    bus: stubBus,
    timestamp: '2026-05-10T02:00:00.000Z',
    forceFull: true,
  });
  assert.equal(out.compact, false);
  assert.match(provider.posted[0].body, /What Went Well/);
});

test('composeRetroBody: deterministic body for a clean manifest', () => {
  const { body, compact, scorecard } = composeRetroBody({
    epicId: 5,
    epicTitle: 'X',
    counts: { friction: 0, parked: 0, recuts: 0, hotfixes: 0, hitl: 0 },
    tasksTotal: 3,
    tasksFirstTry: 3,
    timestamp: '2026-05-10T00:00:00.000Z',
  });
  assert.equal(compact, true);
  assert.equal(scorecard.totalTasks, 3);
  assert.match(body, /Total Tasks {18}\| 3/);
  assert.match(body, /<!-- retro-complete: 2026-05-10T00:00:00\.000Z -->$/);
});

test('gatherRetroSignals: aggregates friction across stories', async () => {
  const provider = makeProvider({
    epic: { id: 110, title: 'Aggregator' },
    stories: [
      {
        id: 230,
        labels: ['type::story'],
        perfSummary: {
          kind: 'story-perf-summary',
          frictionByCategory: { rework: 2, hotspot: 1 },
        },
      },
      {
        id: 231,
        labels: ['type::story'],
        perfSummary: {
          kind: 'story-perf-summary',
          frictionByCategory: { idle: 4 },
        },
      },
    ],
    tasks: [
      { id: 330, parentStoryId: 230, labels: ['type::task'] },
      { id: 331, parentStoryId: 231, labels: ['type::task'] },
    ],
  });
  const signals = await gatherRetroSignals({ epicId: 110, provider });
  assert.equal(signals.counts.friction, 7);
  assert.equal(signals.storyPerfSummaries.length, 2);
});

// --- Story #2289 regression coverage ---

test('runRetro: throws when provider is missing getSubTickets (no silent compact)', async () => {
  // Pre-#2289, retro-runner called `provider.getSubIssues?.()` with an
  // optional-chain — a provider that only implemented `getSubTickets`
  // (per the ITicketingProvider contract) silently produced an empty
  // descendant set. Now the call is unconditional, so the missing method
  // throws and surfaces the contract drift instead of producing a wrong
  // compact retro.
  const provider = {
    async getTicket() {
      return { id: 500, title: 'Epic missing getSubTickets', body: '' };
    },
    async getTicketComments() {
      return [];
    },
  };
  await assert.rejects(() =>
    runRetro({
      epicId: 500,
      provider,
      bus: stubBus,
      timestamp: '2026-05-17T00:00:00.000Z',
    }),
  );
});

test('gatherRetroSignals: warns when descendants empty but Epic body references children', async () => {
  // Defensive guard: if the walker returns zero descendants under an Epic
  // whose body references child issues (`#123` planning refs), emit a
  // warn so the silent failure surfaces. The guard is logger-only — it
  // never throws and never blocks retro composition.
  const provider = {
    async getSubTickets() {
      return [];
    },
    async getTicketComments() {
      return [];
    },
    async getTicket(id) {
      if (id === 600) {
        return {
          id: 600,
          title: 'Populated Epic',
          body: 'Children: #601 #602 #603',
        };
      }
      return null;
    },
  };
  const warns = [];
  const signals = await gatherRetroSignals({
    epicId: 600,
    provider,
    logger: { warn: (msg) => warns.push(msg) },
  });
  assert.equal(signals.tasks.length, 0);
  assert.ok(
    warns.some((line) => /under-report|contract drift|WARNING/i.test(line)),
    `expected a warn line about the empty descendant walk, got: ${warns.join('\n') || '<none>'}`,
  );
});

test('gatherRetroSignals: no warn when descendants empty and Epic body has no child refs', async () => {
  // A truly empty / no-op Epic (body has no `#NNN` refs) should not
  // trigger the guard — otherwise every legitimately-empty Epic would
  // generate noise on every retro.
  const provider = {
    async getSubTickets() {
      return [];
    },
    async getTicketComments() {
      return [];
    },
    async getTicket(id) {
      if (id === 601) {
        return {
          id: 601,
          title: 'Empty Epic',
          body: 'No child references in this body.',
        };
      }
      return null;
    },
  };
  const warns = [];
  await gatherRetroSignals({
    epicId: 601,
    provider,
    logger: { warn: (msg) => warns.push(msg) },
  });
  assert.equal(
    warns.length,
    0,
    `expected no warns for genuinely empty Epic, got: ${warns.join('\n')}`,
  );
});

test('composeRetroBody: interventions > 0 routes to full retro and shows scorecard row', async () => {
  const { body, compact, scorecard } = composeRetroBody({
    epicId: 700,
    epicTitle: 'Intervention Epic',
    counts: {
      friction: 0,
      parked: 0,
      recuts: 0,
      hotfixes: 0,
      hitl: 0,
      interventions: 5,
    },
    tasksTotal: 4,
    tasksFirstTry: 4,
    timestamp: '2026-05-17T01:00:00.000Z',
  });
  assert.equal(compact, false, 'expected full retro when interventions > 0');
  assert.equal(scorecard.interventions, 5);
  assert.match(body, /Manual Interventions {9}\| 5/);
  assert.match(body, /What Went Well/);
});

test('runRetro: surfaces manualInterventions count in scorecard', async () => {
  const provider = makeProvider({
    epic: { id: 800, title: 'Intervention Epic' },
    stories: [
      {
        id: 810,
        labels: ['type::story'],
        perfSummary: {
          kind: 'story-perf-summary',
          frictionByCategory: {},
        },
      },
    ],
    tasks: [{ id: 820, parentStoryId: 810, labels: ['type::task'] }],
  });
  const out = await runRetro({
    epicId: 800,
    provider,
    bus: stubBus,
    manualInterventions: 3,
    timestamp: '2026-05-17T02:00:00.000Z',
  });
  assert.equal(out.scorecard.interventions, 3);
  // Five recorded interventions otherwise clean must still render full.
  assert.equal(out.compact, false);
  assert.match(provider.posted[0].body, /Manual Interventions {9}\| 3/);
});

// --- Story #2558 routedProposals coverage ---

test('gatherRetroSignals: returns routedProposals envelope (empty when no signals)', async () => {
  const provider = makeProvider({
    epic: { id: 950, title: 'No signals Epic' },
    stories: [
      {
        id: 951,
        labels: ['type::story'],
        perfSummary: { kind: 'story-perf-summary', frictionByCategory: {} },
      },
    ],
    tasks: [{ id: 952, parentStoryId: 951, labels: ['type::task'] }],
  });
  // Stub forEachLineFn so the test does not hit disk — emit nothing.
  const signals = await gatherRetroSignals({
    epicId: 950,
    provider,
    forEachLineFn: async () => ({
      linesRead: 0,
      linesParsed: 0,
      missing: true,
    }),
  });
  assert.ok(signals.routedProposals, 'routedProposals key present');
  assert.deepEqual(signals.routedProposals, {
    framework: [],
    consumer: [],
    memory: [],
    discarded: [],
  });
  // Existing behaviour intact.
  assert.equal(signals.storyPerfSummaries.length, 1);
  assert.equal(signals.tasks.length, 1);
});

test('gatherRetroSignals: computes routedProposals from per-Story signals streams', async () => {
  const provider = makeProvider({
    epic: { id: 960, title: 'Signals Epic' },
    stories: [
      {
        id: 961,
        labels: ['type::story'],
        perfSummary: { kind: 'story-perf-summary', frictionByCategory: {} },
      },
      {
        id: 962,
        labels: ['type::story'],
        perfSummary: { kind: 'story-perf-summary', frictionByCategory: {} },
      },
    ],
    tasks: [
      { id: 963, parentStoryId: 961, labels: ['type::task'] },
      { id: 964, parentStoryId: 962, labels: ['type::task'] },
    ],
  });
  // Synthetic signals streams per Story.
  const fakeStreams = new Map([
    [
      961,
      [
        { category: 'lint-loop', source: 'framework' },
        { category: 'lint-loop', source: 'framework' },
        { category: 'one-off', source: 'consumer' },
      ],
    ],
    [
      962,
      [
        { category: 'flaky-test', source: 'consumer' },
        { category: 'flaky-test', source: 'consumer' },
      ],
    ],
  ]);
  const forEachLineFn = async (_epicId, sid, cb) => {
    const lines = fakeStreams.get(sid) ?? [];
    for (let i = 0; i < lines.length; i++) {
      await cb(lines[i], i + 1);
    }
    return {
      linesRead: lines.length,
      linesParsed: lines.length,
      missing: false,
    };
  };
  const out = await gatherRetroSignals({
    epicId: 960,
    provider,
    frameworkRepo: 'dsj1984/mandrel',
    consumerRepo: 'dsj1984/domio',
    forEachLineFn,
  });
  assert.equal(out.routedProposals.framework.length, 1);
  assert.equal(out.routedProposals.framework[0].category, 'lint-loop');
  assert.equal(out.routedProposals.consumer.length, 1);
  assert.equal(out.routedProposals.consumer[0].category, 'flaky-test');
  assert.equal(out.routedProposals.discarded.length, 1);
  assert.equal(out.routedProposals.discarded[0].category, 'one-off');
});

test('gatherRetroSignals: degrades silently on forEachLine error', async () => {
  const provider = makeProvider({
    epic: { id: 970, title: 'Defensive Epic' },
    stories: [
      {
        id: 971,
        labels: ['type::story'],
        perfSummary: { kind: 'story-perf-summary', frictionByCategory: {} },
      },
    ],
    tasks: [{ id: 972, parentStoryId: 971, labels: ['type::task'] }],
  });
  const warns = [];
  const out = await gatherRetroSignals({
    epicId: 970,
    provider,
    logger: { warn: (m) => warns.push(m) },
    forEachLineFn: async () => {
      throw new Error('boom');
    },
  });
  assert.ok(out.routedProposals, 'still returns routedProposals on read error');
  assert.deepEqual(out.routedProposals.framework, []);
  assert.ok(warns.some((w) => /forEachLine failed/.test(w)));
});

// Story #2853 — concurrent fan-out assertions.
//
// `gatherRetroSignals` previously serialized two hot loops:
//   1. per-Story `findStructuredComment` lookups for `story-perf-summary`
//   2. descendant BFS in `collectDescendants`
//
// Both are now parallelized; the assertions below pin that behaviour so a
// future refactor that reintroduces the serial shape fails loudly.

test('gatherRetroSignals: per-Story story-perf-summary lookups fan out concurrently', async () => {
  // Use deferred promises to gate each per-Story `getTicketComments` call.
  // If the loop is serial, only the first deferred will be observed before
  // we resolve them; if it's concurrent, all four are awaited at the same
  // time.
  const deferreds = new Map();
  const observedActive = new Set();
  let maxActive = 0;
  let activeNow = 0;

  const epicComment = {
    id: 1,
    body: `<!-- ap:structured-comment type="epic-perf-report" -->\n\n\`\`\`json\n${JSON.stringify(
      { ok: true },
    )}\n\`\`\``,
  };

  const storyIds = [201, 202, 203, 204];

  const provider = {
    async getSubTickets(id) {
      if (id === 200) {
        return storyIds.map((sid) => ({
          id: sid,
          number: sid,
          labels: ['type::story'],
        }));
      }
      return [];
    },
    async getTicket(id) {
      if (id === 200) return { id: 200, title: 'Concurrent Epic', body: '' };
      return null;
    },
    async getTicketComments(ticketId) {
      if (ticketId === 200) return [epicComment];
      // Story ticket — gate on a per-call deferred.
      activeNow++;
      maxActive = Math.max(maxActive, activeNow);
      observedActive.add(ticketId);
      const result = await new Promise((resolve) => {
        deferreds.set(ticketId, resolve);
      });
      activeNow--;
      return result;
    },
  };

  // Kick off the gather; resolve every per-Story deferred only after all
  // four have been observed in flight.
  const gatherPromise = gatherRetroSignals({ epicId: 200, provider });

  // Spin until every Story is awaiting (or fail the test if it never
  // happens). The retro-runner orchestrates other awaits between
  // descendant collection and the per-Story fan-out, so we may need a
  // few microtasks to reach the fan-out.
  for (let i = 0; i < 100 && observedActive.size < storyIds.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(
    observedActive.size,
    storyIds.length,
    'every Story comment fetch should be in flight before any resolves (serial loop regression)',
  );
  assert.equal(
    maxActive,
    storyIds.length,
    'max in-flight should equal Story count',
  );

  // Resolve all the deferreds with empty comment lists so gather completes.
  for (const sid of storyIds) {
    deferreds.get(sid)([]);
  }
  await gatherPromise;
});

test('collectDescendants: walks each BFS level concurrently', async () => {
  // Provider records the order of getSubTickets calls. A serial walk
  // would interleave parent → child → parent → child …; level-order
  // parallelism fires every parent at the current depth before any
  // child at the next depth.
  const callOrder = [];
  const callStartTimes = new Map();

  const subsByParent = new Map([
    [400, [{ id: 401 }, { id: 402 }, { id: 403 }]],
    [401, [{ id: 411 }, { id: 412 }]],
    [402, [{ id: 421 }]],
    [403, [{ id: 431 }, { id: 432 }]],
    // Leaves return empty.
  ]);

  const provider = {
    async getSubTickets(id) {
      callOrder.push(id);
      callStartTimes.set(id, callOrder.length);
      // Defer the resolution so the test can observe whether siblings
      // start before any of their children fire.
      await new Promise((r) => setImmediate(r));
      const subs = subsByParent.get(id) ?? [];
      return subs.map((s) => ({ ...s, number: s.id, labels: ['type::task'] }));
    },
    async getTicket() {
      return null;
    },
    async getTicketComments() {
      return [];
    },
  };

  const out = await gatherRetroSignals({ epicId: 400, provider });

  // Level 0: epic 400.
  // Level 1: stories 401, 402, 403 (all three must start before any
  // level-2 children).
  // Level 2: 411, 412, 421, 431, 432.
  const idxOf = (id) => callOrder.indexOf(id);
  const lvl1 = [401, 402, 403].map(idxOf);
  const lvl2 = [411, 412, 421, 431, 432].map(idxOf);
  const maxLvl1 = Math.max(...lvl1);
  const minLvl2 = Math.min(...lvl2);
  assert.ok(
    maxLvl1 < minLvl2,
    `all level-1 getSubTickets calls must fire before any level-2 call ` +
      `(serial BFS regression). order=${callOrder.join(',')}`,
  );

  // Sanity: the descendant set is the same as the serial walker would
  // produce.
  const descendantIds = new Set();
  for (const sub of [...out.stories, ...out.tasks]) {
    descendantIds.add(sub.id ?? sub.number);
  }
  for (const id of [401, 402, 403, 411, 412, 421, 431, 432]) {
    assert.ok(descendantIds.has(id), `descendant set missing #${id}`);
  }
});

test('gatherRetroSignals: 3-tier ledger (Stories present, zero Tasks) walks without error', async () => {
  // Story #3151 (Epic #3078) — under the 3-tier hierarchy, the
  // descendant walk surfaces only `type::story` issues; child
  // `type::task` tickets do not exist. `gather-signals.js` must
  // tolerate this shape: produce a non-empty signals report from the
  // Story-level perf summaries and emit zero hotfix/HITL counts
  // without throwing. It must also NOT trigger the
  // "empty-descendant" warn guard, because descendants are not empty
  // (they contain the Stories themselves) — the guard is meant for a
  // genuinely empty walk under a populated Epic.
  const provider = makeProvider({
    epic: { id: 3078, title: '3-tier Epic' },
    stories: [
      {
        id: 3088,
        labels: ['type::story'],
        perfSummary: {
          kind: 'story-perf-summary',
          frictionByCategory: { thrash: 2, drift: 1 },
        },
      },
      {
        id: 3151,
        labels: ['type::story'],
        perfSummary: {
          kind: 'story-perf-summary',
          frictionByCategory: { ambiguity: 4 },
        },
      },
    ],
    tasks: [],
  });
  const warns = [];
  const signals = await gatherRetroSignals({
    epicId: 3078,
    provider,
    logger: { warn: (msg) => warns.push(msg) },
  });
  assert.equal(signals.tasks.length, 0, 'expected zero tasks under 3-tier');
  assert.equal(signals.stories.length, 2, 'expected two child Stories');
  assert.equal(
    signals.counts.hotfixes,
    0,
    'hotfixes is task-derived and must be zero under 3-tier',
  );
  assert.equal(
    signals.counts.hitl,
    0,
    'no HITL labels on these stories, expected zero',
  );
  assert.equal(
    signals.counts.friction,
    7,
    'friction should aggregate across both Story perf summaries (2+1+4)',
  );
  assert.equal(signals.storyPerfSummaries.length, 2);
  assert.equal(
    warns.length,
    0,
    `3-tier walk is not empty, guard must stay silent; got: ${warns.join('\n')}`,
  );
  assert.ok(signals.routedProposals, 'routedProposals envelope present');
});

test('runRetro: ignores non-finite manualInterventions (defensive)', async () => {
  const provider = makeProvider({
    epic: { id: 900, title: 'Defensive Epic' },
    stories: [
      {
        id: 910,
        labels: ['type::story'],
        perfSummary: {
          kind: 'story-perf-summary',
          frictionByCategory: {},
        },
      },
    ],
    tasks: [{ id: 920, parentStoryId: 910, labels: ['type::task'] }],
  });
  const out = await runRetro({
    epicId: 900,
    provider,
    bus: stubBus,
    manualInterventions: Number.NaN,
    timestamp: '2026-05-17T03:00:00.000Z',
  });
  assert.equal(out.scorecard.interventions, 0);
  assert.equal(out.compact, true);
});
