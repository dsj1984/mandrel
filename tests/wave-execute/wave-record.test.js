import assert from 'node:assert/strict';
import test from 'node:test';

import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import {
  aggregateWaveStatus,
  parseResultsArg,
  runWaveRecord,
  validateResults,
  verifyWaveResults,
} from '../../.agents/scripts/wave-record.js';

function makeProvider(initialComments = []) {
  const comments = [...initialComments];
  const posted = [];
  let nextId = 100;
  return {
    comments,
    posted,
    async postComment(ticketId, { type, body }) {
      const id = nextId++;
      const entry = { id, ticketId, type, body };
      comments.push(entry);
      posted.push(entry);
      return { commentId: id };
    },
    async getTicketComments(ticketId) {
      return comments.filter((c) => c.ticketId === ticketId);
    },
    async deleteComment(id) {
      const idx = comments.findIndex((c) => c.id === id);
      if (idx >= 0) comments.splice(idx, 1);
    },
  };
}

function makeManifestComment(epicId, payload) {
  const marker = structuredCommentMarker('dispatch-manifest');
  return {
    id: 1,
    ticketId: epicId,
    type: 'comment',
    body: `${marker}\n\n## Dispatch Manifest\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
  };
}

function extractPayload(body) {
  const match = body.match(/```json\s*\n([\s\S]*?)\n```/);
  return match ? JSON.parse(match[1]) : null;
}

test('validateResults — accepts canonical /story-execute return objects', () => {
  const out = validateResults([
    {
      storyId: 911,
      status: 'done',
      phase: 'done',
      tasksDone: 3,
      tasksTotal: 3,
    },
    {
      storyId: 912,
      status: 'blocked',
      blockerCommentId: 'IC_kabc',
    },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].storyId, 911);
  assert.equal(out[0].status, 'done');
  assert.equal(out[0].tasksDone, 3);
  assert.equal(out[1].blockerCommentId, 'IC_kabc');
});

test('validateResults — rejects non-array, missing id, bad status', () => {
  assert.throws(() => validateResults('nope'), /must be a JSON array/);
  assert.throws(
    () => validateResults([{ status: 'done' }]),
    /storyId must be a positive integer/,
  );
  assert.throws(
    () => validateResults([{ storyId: 1, status: 'wat' }]),
    /must be one of: done, blocked, failed/,
  );
});

test('parseResultsArg — accepts inline JSON', () => {
  const value = JSON.stringify([{ storyId: 1, status: 'done' }]);
  const out = parseResultsArg(value);
  assert.deepEqual(out, [{ storyId: 1, status: 'done' }]);
});

test('parseResultsArg — accepts @<file> with injected reader', () => {
  const out = parseResultsArg('@/fake/path.json', {
    readFile: (p) => {
      assert.equal(p, '/fake/path.json');
      return JSON.stringify([{ storyId: 7, status: 'failed' }]);
    },
  });
  assert.deepEqual(out, [{ storyId: 7, status: 'failed' }]);
});

test('parseResultsArg — malformed JSON throws SyntaxError', () => {
  assert.throws(() => parseResultsArg('{not-json'), /not valid JSON/);
});

test('aggregateWaveStatus — outcome rules', () => {
  assert.equal(
    aggregateWaveStatus([
      { storyId: 1, status: 'done' },
      { storyId: 2, status: 'done' },
    ]).status,
    'complete',
  );
  assert.equal(
    aggregateWaveStatus([
      { storyId: 1, status: 'done' },
      { storyId: 2, status: 'blocked' },
    ]).status,
    'blocked',
  );
  assert.equal(
    aggregateWaveStatus([
      { storyId: 1, status: 'blocked' },
      { storyId: 2, status: 'failed' },
    ]).status,
    'failed',
  );
  assert.deepEqual(
    aggregateWaveStatus([
      { storyId: 11, status: 'blocked' },
      { storyId: 12, status: 'done' },
      { storyId: 13, status: 'blocked' },
    ]).blockedStoryIds,
    [11, 13],
  );
  // Empty array collapses to `complete` — the no-op fan-out case.
  assert.equal(aggregateWaveStatus([]).status, 'complete');
});

test('runWaveRecord — happy path upserts wave-run-progress + returns complete', async () => {
  const epicId = 946;
  const provider = makeProvider([
    makeManifestComment(epicId, {
      stories: [
        { storyId: 911, title: 'Alpha', wave: 1 },
        { storyId: 912, title: 'Beta', wave: 1 },
      ],
    }),
  ]);

  const out = await runWaveRecord({
    epicId,
    wave: 1,
    concurrencyCap: 2,
    injectedProvider: provider,
    results: [
      { storyId: 911, status: 'done', tasksDone: 2, tasksTotal: 2 },
      { storyId: 912, status: 'done', tasksDone: 1, tasksTotal: 1 },
    ],
  });

  assert.equal(out.status, 'complete');
  assert.deepEqual(out.blockedStoryIds, []);
  assert.deepEqual(out.stories, [
    { id: 911, status: 'done' },
    { id: 912, status: 'done' },
  ]);
  // renderedBody is the markdown body upserted onto the Epic — `/wave-execute`
  // relays it to chat as the Wave-level rollup table after fan-out.
  assert.ok(out.renderedBody.startsWith('### 🌊 Wave 1'));
  assert.match(out.renderedBody, /\| #911 \|/);
  assert.match(out.renderedBody, /\| #912 \|/);

  // The wave-run-progress comment was posted on the Epic.
  const waveComment = provider.posted.find(
    (c) => c.type === 'wave-run-progress',
  );
  assert.ok(waveComment, 'wave-run-progress comment was posted');
  const payload = extractPayload(waveComment.body);
  assert.equal(payload.kind, 'wave-run-progress');
  assert.equal(payload.epicId, epicId);
  assert.equal(payload.wave, 1);
  assert.equal(payload.concurrencyCap, 2);
  // Title was cross-looked from the manifest.
  assert.equal(payload.stories[0].title, 'Alpha');
  assert.equal(payload.stories[1].title, 'Beta');
});

test('runWaveRecord — blocked + failed surfaces both blockedStoryIds and failed status', async () => {
  const epicId = 947;
  const provider = makeProvider();

  const out = await runWaveRecord({
    epicId,
    wave: 0,
    concurrencyCap: 3,
    injectedProvider: provider,
    results: [
      { storyId: 1, status: 'done' },
      {
        storyId: 2,
        status: 'blocked',
        blockerCommentId: 'IC_x',
      },
      { storyId: 3, status: 'failed' },
    ],
  });

  assert.equal(out.status, 'failed');
  assert.deepEqual(out.blockedStoryIds, [2]);

  const waveComment = provider.posted.find(
    (c) => c.type === 'wave-run-progress',
  );
  const payload = extractPayload(waveComment.body);
  // Failed rows make it into the wave-run-progress comment.
  const failedRow = payload.stories.find((s) => s.id === 3);
  assert.equal(failedRow.state, 'failed');
  // Blocked rows carry blockerCommentId.
  const blockedRow = payload.stories.find((s) => s.id === 2);
  assert.equal(blockedRow.state, 'blocked');
  assert.equal(blockedRow.blockerCommentId, 'IC_x');
});

test('verifyWaveResults — downgrades done claims that did not actually close', async () => {
  const provider = {
    async getTicket(id) {
      if (id === 911) {
        return { id: 911, labels: ['agent::done'], state: 'closed' };
      }
      // Story #912 claimed done but the live label is still executing —
      // the rec #5 regression scenario.
      return { id: 912, labels: ['agent::executing'], state: 'open' };
    },
  };
  const { verified, discrepancies } = await verifyWaveResults({
    provider,
    results: [
      { storyId: 911, status: 'done' },
      { storyId: 912, status: 'done' },
    ],
  });
  assert.equal(verified[0].status, 'done');
  assert.equal(verified[1].status, 'failed');
  assert.equal(discrepancies.length, 1);
  assert.equal(discrepancies[0].storyId, 912);
  assert.equal(discrepancies[0].claimed, 'done');
  assert.equal(discrepancies[0].actual, 'agent::executing');
});

test('verifyWaveResults — preserves blocked / failed claims without re-fetching', async () => {
  let getTicketCalls = 0;
  const provider = {
    async getTicket(id) {
      getTicketCalls++;
      return { id, labels: ['agent::done'], state: 'closed' };
    },
  };
  const { verified, discrepancies } = await verifyWaveResults({
    provider,
    results: [
      { storyId: 1, status: 'blocked', blockerCommentId: 'IC' },
      { storyId: 2, status: 'failed' },
    ],
  });
  assert.equal(getTicketCalls, 0);
  assert.equal(discrepancies.length, 0);
  assert.equal(verified[0].status, 'blocked');
  assert.equal(verified[1].status, 'failed');
});

test('verifyWaveResults — verification read failures preserve the claim', async () => {
  const provider = {
    async getTicket() {
      throw new Error('GraphQL 502');
    },
  };
  const { verified, discrepancies } = await verifyWaveResults({
    provider,
    results: [{ storyId: 1, status: 'done' }],
  });
  assert.equal(discrepancies.length, 0);
  assert.equal(verified[0].status, 'done');
  assert.match(verified[0].verifyError, /GraphQL 502/);
});

test('runWaveRecord — verification downgrades a done claim and surfaces discrepancies', async () => {
  const epicId = 950;
  const provider = makeProvider();
  // Inject getTicket via the same provider object to drive verification.
  provider.getTicket = async (id) => {
    if (id === 911) return { id, labels: ['agent::done'], state: 'closed' };
    return { id, labels: ['agent::executing'], state: 'open' };
  };

  const out = await runWaveRecord({
    epicId,
    wave: 0,
    concurrencyCap: 2,
    injectedProvider: provider,
    results: [
      { storyId: 911, status: 'done' },
      { storyId: 912, status: 'done' },
    ],
  });

  // Wave 5 scenario: sub-agent claimed done but ticket is still executing —
  // the wave must NOT classify as complete.
  assert.equal(out.status, 'failed');
  assert.deepEqual(
    out.stories.find((s) => s.id === 912),
    { id: 912, status: 'failed' },
  );
  assert.ok(Array.isArray(out.discrepancies));
  assert.equal(out.discrepancies.length, 1);
  assert.equal(out.discrepancies[0].storyId, 912);
});

test('runWaveRecord — malformed results array rejected before any comment write', async () => {
  const provider = makeProvider();
  await assert.rejects(
    () =>
      runWaveRecord({
        epicId: 948,
        wave: 0,
        concurrencyCap: 1,
        injectedProvider: provider,
        results: [{ storyId: 1 }], // missing status
      }),
    /must be one of: done, blocked, failed/,
  );
  // No comment was posted — validation runs before the writer.
  assert.equal(provider.posted.length, 0);
});
