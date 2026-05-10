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
    async getSubIssues(id) {
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
