import assert from 'node:assert/strict';
import test from 'node:test';

import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import {
  renderFrictionBody,
  runWavePrepare,
} from '../../.agents/scripts/wave-prepare.js';

/**
 * Spy/Stub provider mirroring the surface used by the real GitHubProvider —
 * just enough for `findStructuredComment` (via `getTicketComments`) and
 * `postStructuredComment` (via `postComment`).
 */
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

test('renderFrictionBody — surfaces reason and detail', () => {
  const body = renderFrictionBody({
    epicId: 901,
    wave: 2,
    reason: 'no-stories-for-wave',
    detail: 'manifest empty',
  });
  assert.match(body, /wave-prepare friction/);
  assert.match(body, /Epic #901/);
  assert.match(body, /wave 2/);
  assert.match(body, /no-stories-for-wave/);
  assert.match(body, /manifest empty/);
});

test('runWavePrepare — happy path returns plan filtered by wave', async () => {
  const epicId = 901;
  const provider = makeProvider([
    makeManifestComment(epicId, {
      stories: [
        { storyId: 911, title: 'A', wave: 1 },
        { storyId: 912, title: 'B', wave: 2 },
        { storyId: 913, title: 'C', wave: 2, modelTier: 'high' },
        { storyId: 914, title: 'D', wave: 3 },
      ],
    }),
  ]);

  const out = await runWavePrepare({
    epicId,
    wave: 2,
    injectedProvider: provider,
    injectedConcurrencyCap: 4,
    injectedWorktreeResolver: (id) => `.worktrees/story-${id}`,
  });

  assert.equal(out.epicId, epicId);
  assert.equal(out.wave, 2);
  assert.equal(out.concurrencyCap, 4);
  assert.equal(out.plan.length, 2);
  // Order preserved from manifest.
  assert.deepEqual(out.plan[0], {
    storyId: 912,
    title: 'B',
    modelTier: 'low',
    worktree: '.worktrees/story-912',
  });
  assert.deepEqual(out.plan[1], {
    storyId: 913,
    title: 'C',
    modelTier: 'high',
    worktree: '.worktrees/story-913',
  });
  // No friction comment posted on the happy path.
  assert.equal(provider.posted.length, 0);
});

test('runWavePrepare — missing manifest posts friction + throws WAVE_PREPARE_FRICTION', async () => {
  const provider = makeProvider();
  await assert.rejects(
    () =>
      runWavePrepare({
        epicId: 902,
        wave: 1,
        injectedProvider: provider,
        injectedConcurrencyCap: 2,
      }),
    (err) => {
      assert.equal(err.code, 'WAVE_PREPARE_FRICTION');
      assert.equal(err.reason, 'missing-manifest');
      return true;
    },
  );
  // A friction comment was posted on the Epic.
  assert.equal(provider.posted.length, 1);
  assert.equal(provider.posted[0].type, 'friction');
  assert.match(provider.posted[0].body, /missing-manifest/);
});

test('runWavePrepare — no stories matching wave posts friction', async () => {
  const epicId = 903;
  const provider = makeProvider([
    makeManifestComment(epicId, {
      stories: [
        { storyId: 921, title: 'A', wave: 1 },
        { storyId: 922, title: 'B', wave: 1 },
      ],
    }),
  ]);

  await assert.rejects(
    () =>
      runWavePrepare({
        epicId,
        wave: 5,
        injectedProvider: provider,
        injectedConcurrencyCap: 2,
      }),
    (err) => {
      assert.equal(err.code, 'WAVE_PREPARE_FRICTION');
      assert.equal(err.reason, 'no-stories-for-wave');
      return true;
    },
  );
  assert.equal(provider.posted.length, 1);
  assert.match(provider.posted[0].body, /no-stories-for-wave/);
});

test('runWavePrepare — malformed manifest payload posts friction', async () => {
  const epicId = 904;
  const marker = structuredCommentMarker('dispatch-manifest');
  // Body has the marker but no JSON fence — `parseFencedJsonComment` returns
  // `null`, which the runner classifies as `malformed-manifest`.
  const malformed = {
    id: 1,
    ticketId: epicId,
    type: 'comment',
    body: `${marker}\n\n_no fenced json here_`,
  };
  const provider = makeProvider([malformed]);

  await assert.rejects(
    () =>
      runWavePrepare({
        epicId,
        wave: 0,
        injectedProvider: provider,
        injectedConcurrencyCap: 1,
      }),
    (err) => {
      assert.equal(err.code, 'WAVE_PREPARE_FRICTION');
      assert.equal(err.reason, 'malformed-manifest');
      return true;
    },
  );
});

test('runWavePrepare — rejects non-positive epicId / negative wave', async () => {
  const provider = makeProvider();
  await assert.rejects(
    () =>
      runWavePrepare({
        epicId: 0,
        wave: 1,
        injectedProvider: provider,
        injectedConcurrencyCap: 1,
      }),
    /must be a positive integer/,
  );
  await assert.rejects(
    () =>
      runWavePrepare({
        epicId: 1,
        wave: -1,
        injectedProvider: provider,
        injectedConcurrencyCap: 1,
      }),
    /must be a non-negative integer/,
  );
});
