import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildModelAttributionPayload,
  deriveFamily,
  emitModelAttribution,
  MODEL_ATTRIBUTION_TYPE,
  parseModelAttributionComment,
  renderModelAttributionBody,
  resolveModelIdentity,
  rollupModelAttribution,
  UNKNOWN_MODEL_ID,
  validateModelAttributionPayload,
} from '../../../.agents/scripts/lib/orchestration/model-attribution.js';
import { structuredCommentMarker } from '../../../.agents/scripts/lib/orchestration/ticketing.js';

function makeProvider(initialComments = [], subTicketsByParent = {}) {
  const comments = [...initialComments];
  let nextId = 1000;
  return {
    comments,
    subTicketsByParent,
    async postComment(ticketId, { type, body }) {
      const id = nextId++;
      comments.push({ id, ticketId, type, body });
      return { commentId: id };
    },
    async getTicketComments(ticketId) {
      return comments.filter((c) => c.ticketId === ticketId);
    },
    async deleteComment(id) {
      const idx = comments.findIndex((c) => c.id === id);
      if (idx >= 0) comments.splice(idx, 1);
    },
    async getSubTickets(parentId) {
      return subTicketsByParent[parentId] ?? [];
    },
  };
}

test('deriveFamily: maps known Anthropic ids to coarse family labels', () => {
  assert.equal(deriveFamily('claude-opus-4-7'), 'Opus');
  assert.equal(deriveFamily('claude-sonnet-4-6'), 'Sonnet');
  assert.equal(deriveFamily('claude-haiku-4-5-20251001'), 'Haiku');
  assert.equal(deriveFamily('some-other-model'), null);
  assert.equal(deriveFamily(null), null);
});

test('resolveModelIdentity: prefers SDK metadata over env over sentinel', () => {
  const got = resolveModelIdentity({
    sdkMetadata: { modelId: 'claude-opus-4-7', responseId: 'r1' },
    env: { CLAUDE_MODEL: 'claude-sonnet-4-6' },
  });
  assert.equal(got.id, 'claude-opus-4-7');
  assert.equal(got.family, 'Opus');
  assert.equal(got.source, 'sdk-metadata');
  assert.deepEqual(got.sdkMetadata, {
    modelId: 'claude-opus-4-7',
    responseId: 'r1',
  });
});

test('resolveModelIdentity: falls back to env when SDK metadata is absent', () => {
  const got = resolveModelIdentity({
    sdkMetadata: null,
    env: { CLAUDE_MODEL: 'claude-sonnet-4-6' },
  });
  assert.equal(got.id, 'claude-sonnet-4-6');
  assert.equal(got.family, 'Sonnet');
  assert.equal(got.source, 'env');
  assert.equal(got.sdkMetadata, undefined);
});

test('resolveModelIdentity: ANTHROPIC_MODEL is consulted when CLAUDE_MODEL is empty', () => {
  const got = resolveModelIdentity({
    env: { CLAUDE_MODEL: '', ANTHROPIC_MODEL: 'claude-haiku-4-5' },
  });
  assert.equal(got.id, 'claude-haiku-4-5');
  assert.equal(got.source, 'env');
});

test('resolveModelIdentity: returns unknown sentinel when no source is available', () => {
  const got = resolveModelIdentity({ env: {} });
  assert.equal(got.id, UNKNOWN_MODEL_ID);
  assert.equal(got.family, null);
  assert.equal(got.source, 'unknown');
});

test('validateModelAttributionPayload: accepts a well-formed payload', () => {
  const payload = buildModelAttributionPayload({
    ticketId: 42,
    identity: resolveModelIdentity({
      sdkMetadata: { modelId: 'claude-opus-4-7' },
    }),
    recordedAt: '2026-05-21T12:00:00.000Z',
  });
  assert.deepEqual(validateModelAttributionPayload(payload), { ok: true });
});

test('validateModelAttributionPayload: rejects malformed payloads with stable messages', () => {
  const bad = validateModelAttributionPayload({
    kind: 'wrong-kind',
    ticketId: 0,
    model: { id: '' },
    source: 'magic',
    recordedAt: 'yesterday',
    sdkMetadata: 'not-an-object',
  });
  assert.equal(bad.ok, false);
  const joined = bad.errors.join(' | ');
  assert.match(joined, /kind must be "model-attribution"/);
  assert.match(joined, /ticketId must be a positive integer/);
  assert.match(joined, /model.id must be a non-empty string/);
  assert.match(joined, /source must be one of/);
  assert.match(joined, /recordedAt must be an ISO-8601 timestamp/);
  assert.match(joined, /sdkMetadata, when present, must be an object/);
});

test('validateModelAttributionPayload: rejects non-object input', () => {
  assert.equal(validateModelAttributionPayload(null).ok, false);
  assert.equal(validateModelAttributionPayload([]).ok, false);
  assert.equal(validateModelAttributionPayload('hi').ok, false);
});

test('renderModelAttributionBody: contains the header and a fenced JSON block', () => {
  const payload = buildModelAttributionPayload({
    ticketId: 7,
    identity: {
      id: 'claude-opus-4-7',
      family: 'Opus',
      source: 'sdk-metadata',
    },
    recordedAt: '2026-05-21T00:00:00.000Z',
  });
  const body = renderModelAttributionBody(payload);
  assert.match(body, /Model attribution: `claude-opus-4-7`/);
  assert.match(body, /\(Opus\)/);
  assert.match(body, /via SDK metadata/);
  assert.match(body, /```json[\s\S]*"kind": "model-attribution"[\s\S]*```/);
});

test('emitModelAttribution: writes one comment, validates payload, and is idempotent on resume', async () => {
  const provider = makeProvider();
  const first = await emitModelAttribution({
    provider,
    ticketId: 555,
    sdkMetadata: { modelId: 'claude-opus-4-7' },
  });
  assert.equal(first.payload.kind, MODEL_ATTRIBUTION_TYPE);
  assert.equal(first.payload.model.id, 'claude-opus-4-7');
  assert.equal(provider.comments.length, 1);

  // Resume: second emit replaces the first (upsert), not duplicates it.
  await emitModelAttribution({
    provider,
    ticketId: 555,
    sdkMetadata: { modelId: 'claude-sonnet-4-6' },
  });
  const attributions = provider.comments.filter(
    (c) => c.ticketId === 555 && c.type === MODEL_ATTRIBUTION_TYPE,
  );
  assert.equal(attributions.length, 1, 'upsert must collapse to one comment');
  assert.match(attributions[0].body, /claude-sonnet-4-6/);
});

test('emitModelAttribution: rejects bad inputs without writing', async () => {
  const provider = makeProvider();
  await assert.rejects(
    emitModelAttribution({ provider, ticketId: 0 }),
    /positive integer ticketId/,
  );
  await assert.rejects(
    emitModelAttribution({ provider: {}, ticketId: 1 }),
    /provider with postComment/,
  );
  assert.equal(provider.comments.length, 0);
});

test('parseModelAttributionComment: returns null when no comment is present', async () => {
  const provider = makeProvider();
  const got = await parseModelAttributionComment({ provider, ticketId: 9 });
  assert.equal(got, null);
});

test('parseModelAttributionComment: returns null for a malformed payload (does not poison rollup)', async () => {
  const marker = structuredCommentMarker(MODEL_ATTRIBUTION_TYPE);
  const provider = makeProvider([
    {
      id: 1,
      ticketId: 9,
      type: 'comment',
      body: `${marker}\n\n\`\`\`json\n${JSON.stringify({ kind: 'wrong' })}\n\`\`\``,
    },
  ]);
  const got = await parseModelAttributionComment({ provider, ticketId: 9 });
  assert.equal(got, null);
});

test('rollupModelAttribution: aggregates per-family counts and surfaces missing attributions', async () => {
  const marker = structuredCommentMarker(MODEL_ATTRIBUTION_TYPE);
  const makeBody = (ticketId, id, family) =>
    `${marker}\n\n\`\`\`json\n${JSON.stringify({
      kind: MODEL_ATTRIBUTION_TYPE,
      ticketId,
      model: { id, family },
      source: 'env',
      recordedAt: '2026-05-21T00:00:00.000Z',
    })}\n\`\`\``;
  const provider = makeProvider(
    [
      {
        id: 1,
        ticketId: 11,
        type: 'c',
        body: makeBody(11, 'claude-opus-4-7', 'Opus'),
      },
      {
        id: 2,
        ticketId: 12,
        type: 'c',
        body: makeBody(12, 'claude-opus-4-7', 'Opus'),
      },
      {
        id: 3,
        ticketId: 13,
        type: 'c',
        body: makeBody(13, 'claude-sonnet-4-6', 'Sonnet'),
      },
      // Task #14 deliberately has no attribution comment — counts under `missing`.
    ],
    {
      999: [
        { id: 11, title: 't1' },
        { id: 12, title: 't2' },
        { id: 13, title: 't3' },
        { id: 14, title: 't4' },
      ],
    },
  );

  const got = await rollupModelAttribution({ provider, parentId: 999 });
  assert.equal(got.parentId, 999);
  assert.equal(got.totalTasks, 4);
  assert.equal(got.missing, 1);
  assert.deepEqual(got.byModel, { Opus: 2, Sonnet: 1 });
  assert.deepEqual(got.byId, {
    'claude-opus-4-7': 2,
    'claude-sonnet-4-6': 1,
  });
});

test('rollupModelAttribution: returns zeroed envelope for a parent with no children', async () => {
  const provider = makeProvider([], { 42: [] });
  const got = await rollupModelAttribution({ provider, parentId: 42 });
  assert.deepEqual(got, {
    parentId: 42,
    totalTasks: 0,
    missing: 0,
    byModel: {},
    byId: {},
  });
});

test('rollupModelAttribution: rejects bad inputs', async () => {
  await assert.rejects(
    rollupModelAttribution({ provider: {}, parentId: 1 }),
    /provider with getSubTickets/,
  );
  await assert.rejects(
    rollupModelAttribution({ provider: makeProvider(), parentId: 0 }),
    /positive integer parentId/,
  );
});

test('rollupModelAttribution: end-to-end emit → readback → rollup against the same provider', async () => {
  const provider = makeProvider([], {
    700: [
      { id: 701, title: 'a' },
      { id: 702, title: 'b' },
    ],
  });
  await emitModelAttribution({
    provider,
    ticketId: 701,
    sdkMetadata: { modelId: 'claude-opus-4-7' },
  });
  await emitModelAttribution({
    provider,
    ticketId: 702,
    env: { CLAUDE_MODEL: 'claude-sonnet-4-6' },
  });
  const rollup = await rollupModelAttribution({ provider, parentId: 700 });
  assert.equal(rollup.totalTasks, 2);
  assert.equal(rollup.missing, 0);
  assert.deepEqual(rollup.byModel, { Opus: 1, Sonnet: 1 });
});
