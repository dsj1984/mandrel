import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import {
  applyTransition,
  hydrateFromComment,
  readCache,
  runStoryTaskProgress,
  writeCache,
} from '../../.agents/scripts/story-task-progress.js';

function makeProvider(initialComments = []) {
  const comments = [...initialComments];
  let nextId = 100;
  return {
    comments,
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
  };
}

test('applyTransition: marks the matching task as executing', () => {
  const next = applyTransition(
    {
      tasks: [
        { id: 1, title: 'a', state: 'pending' },
        { id: 2, title: 'b', state: 'pending' },
      ],
    },
    { taskId: 2, state: 'executing' },
  );
  assert.equal(next.tasks[0].state, 'pending');
  assert.equal(next.tasks[1].state, 'executing');
});

test('applyTransition: carries commitSha on done, drops it on later transitions', () => {
  const a = applyTransition(
    { tasks: [{ id: 1, title: 'x', state: 'executing' }] },
    { taskId: 1, state: 'done', commitSha: 'abc1234' },
  );
  assert.equal(a.tasks[0].state, 'done');
  assert.equal(a.tasks[0].commitSha, 'abc1234');

  const b = applyTransition(a, { taskId: 1, state: 'blocked' });
  assert.equal(b.tasks[0].state, 'blocked');
  assert.equal(b.tasks[0].commitSha, undefined);
});

test('applyTransition: throws when task id is unknown', () => {
  assert.throws(
    () =>
      applyTransition(
        { tasks: [{ id: 1, title: 'a', state: 'pending' }] },
        { taskId: 99, state: 'done' },
      ),
    /not found/,
  );
});

test('applyTransition: rejects invalid state', () => {
  assert.throws(
    () =>
      applyTransition(
        { tasks: [{ id: 1, title: 'a', state: 'pending' }] },
        { taskId: 1, state: 'wibble' },
      ),
    /must be one of/,
  );
});

test('readCache + writeCache: round-trips JSON and returns null on missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-task-progress-'));
  const cachePath = path.join(dir, 'story-7-progress.json');
  assert.equal(readCache(cachePath), null);
  writeCache(cachePath, { storyId: 7, tasks: [{ id: 1, state: 'pending' }] });
  const got = readCache(cachePath);
  assert.equal(got.storyId, 7);
  assert.equal(got.tasks[0].state, 'pending');
});

test('hydrateFromComment: parses the fenced JSON payload off the marker comment', async () => {
  const marker = structuredCommentMarker('story-run-progress');
  const payload = {
    kind: 'story-run-progress',
    storyId: 5,
    branch: 'story-5',
    phase: 'init',
    tasks: [{ id: 11, title: 't1', state: 'pending' }],
  };
  const provider = makeProvider([
    {
      id: 1,
      ticketId: 5,
      type: 'comment',
      body: `${marker}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    },
  ]);
  const got = await hydrateFromComment({ provider, storyId: 5 });
  assert.equal(got.storyId, 5);
  assert.equal(got.branch, 'story-5');
  assert.deepEqual(got.tasks, payload.tasks);
});

test('hydrateFromComment: returns null when no marker comment exists', async () => {
  const provider = makeProvider([]);
  assert.equal(await hydrateFromComment({ provider, storyId: 5 }), null);
});

test('runStoryTaskProgress: cache-miss → hydrates from comment → writes cache + upserts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-task-progress-'));
  const cachePath = path.join(dir, 'story-12-progress.json');
  const marker = structuredCommentMarker('story-run-progress');
  const initialPayload = {
    kind: 'story-run-progress',
    storyId: 12,
    branch: 'story-12',
    phase: 'init',
    tasks: [
      { id: 100, title: 'first', state: 'pending' },
      { id: 200, title: 'second', state: 'pending' },
    ],
  };
  const provider = makeProvider([
    {
      id: 1,
      ticketId: 12,
      type: 'comment',
      body: `${marker}\n\n\`\`\`json\n${JSON.stringify(initialPayload)}\n\`\`\``,
    },
  ]);

  const result = await runStoryTaskProgress({
    storyId: 12,
    taskId: 100,
    state: 'executing',
    provider,
    cachePath,
  });
  assert.equal(result.ok, true);
  assert.equal(result.taskState, 'executing');
  assert.equal(result.phase, 'implementing');
  // renderedBody is the markdown body upserted onto the Story ticket — the
  // skill relays it to chat after each transition. Must contain the
  // story-progress header and the executing row.
  assert.ok(result.renderedBody.startsWith('### 📖 Story #12'));
  assert.match(result.renderedBody, /\| #100 \| .*executing/);
  // Cache exists with the new state.
  const cached = readCache(cachePath);
  const t100 = cached.tasks.find((t) => t.id === 100);
  assert.equal(t100.state, 'executing');
  // Upserted comment payload reflects new state.
  const latest = provider.comments.at(-1);
  assert.match(latest.body, /"state": "executing"/);
});

test('runStoryTaskProgress: cache-hit avoids hydrating from the comment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-task-progress-'));
  const cachePath = path.join(dir, 'story-13-progress.json');
  writeCache(cachePath, {
    storyId: 13,
    branch: 'story-13',
    tasks: [
      { id: 1, title: 'a', state: 'executing' },
      { id: 2, title: 'b', state: 'pending' },
    ],
  });
  let getCommentsCalls = 0;
  const provider = makeProvider([]);
  const wrapped = {
    ...provider,
    async getTicketComments(ticketId) {
      getCommentsCalls++;
      return provider.getTicketComments(ticketId);
    },
  };

  const result = await runStoryTaskProgress({
    storyId: 13,
    taskId: 1,
    state: 'done',
    commitSha: 'feedfac',
    provider: wrapped,
    cachePath,
  });
  assert.equal(result.taskState, 'done');
  // upsertStructuredComment calls getTicketComments once to find the existing
  // comment — but hydrateFromComment must not have run a second time.
  // (Cache hit means hydrate is skipped entirely.) We expect exactly 1 call.
  assert.equal(getCommentsCalls, 1);
});

test('runStoryTaskProgress: throws when no cache and no comment exist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-task-progress-'));
  const cachePath = path.join(dir, 'story-14-progress.json');
  const provider = makeProvider([]);

  await assert.rejects(
    runStoryTaskProgress({
      storyId: 14,
      taskId: 1,
      state: 'executing',
      provider,
      cachePath,
    }),
    /no story-run-progress snapshot/,
  );
});

test('runStoryTaskProgress: rejects unknown CLI states', async () => {
  await assert.rejects(
    runStoryTaskProgress({
      storyId: 1,
      taskId: 1,
      state: 'wibble',
      provider: makeProvider([]),
      cachePath: '/tmp/ignored.json',
    }),
    /must be one of/,
  );
});
