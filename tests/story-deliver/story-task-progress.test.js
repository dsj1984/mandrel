import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import {
  applyTransition,
  hydrateFromComment,
  isCommitReachableFromHead,
  readCache,
  runStoryTaskProgress,
  writeCache,
} from '../../.agents/scripts/story-task-progress.js';

function makeProvider(initialComments = []) {
  const comments = [...initialComments];
  const updates = [];
  const tickets = {};
  let nextId = 100;
  return {
    comments,
    updates,
    tickets,
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
    async getTicket(ticketId) {
      return tickets[ticketId] ?? { id: ticketId, labels: [] };
    },
    async updateTicket(ticketId, mutations) {
      updates.push({ ticketId, mutations });
      const t = tickets[ticketId] ?? { id: ticketId, labels: [] };
      if (mutations.labels) {
        const rm = new Set(mutations.labels.remove ?? []);
        const next = (t.labels ?? []).filter((l) => !rm.has(l));
        for (const add of mutations.labels.add ?? []) {
          if (!next.includes(add)) next.push(add);
        }
        t.labels = next;
      }
      if (mutations.state !== undefined) t.state = mutations.state;
      tickets[ticketId] = t;
    },
    // The cascade-on-done block in `transitionTicketState` calls
    // `getSubTickets` to walk up to parents. Returning empty here keeps the
    // tests focused on the close-this-task path (cascade is opt-out via
    // `cascade: false` for the per-Task close anyway, but the legacy tests
    // call with state=done and the default cascade behavior — so we still
    // need a stub that doesn't throw).
    async getSubTickets() {
      return [];
    },
    async getTicketDependencies() {
      return { blocks: [], blockedBy: [] };
    },
  };
}

function makeTmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-git-'));
  const real = fs.realpathSync.native(dir);
  const run = (...args) => {
    const r = spawnSync('git', args, {
      cwd: real,
      encoding: 'utf8',
      shell: false,
    });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    }
    return r.stdout.trim();
  };
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(real, 'a.txt'), 'a\n');
  run('add', 'a.txt');
  run('commit', '-q', '-m', 'first');
  const sha = run('rev-parse', 'HEAD');
  return { dir: real, sha, run };
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

test('isCommitReachableFromHead: true for HEAD sha, false for unknown sha', () => {
  const repo = makeTmpGitRepo();
  assert.equal(isCommitReachableFromHead(repo.dir, repo.sha), true);
  // 40 zero hex digits — never an existing commit.
  assert.equal(
    isCommitReachableFromHead(repo.dir, '0'.repeat(40)),
    false,
    'unknown sha must not be reachable',
  );
  assert.equal(
    isCommitReachableFromHead(repo.dir, ''),
    false,
    'empty sha must not be reachable',
  );
});

test('runStoryTaskProgress: state=executing flips the Task ticket to agent::executing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-task-progress-'));
  const cachePath = path.join(dir, 'story-32-progress.json');
  writeCache(cachePath, {
    storyId: 32,
    branch: 'story-32',
    tasks: [{ id: 321, title: 't', state: 'pending' }],
  });
  const provider = makeProvider([]);
  provider.tickets[321] = { id: 321, labels: ['agent::ready'], state: 'open' };

  const result = await runStoryTaskProgress({
    storyId: 32,
    taskId: 321,
    state: 'executing',
    provider,
    cachePath,
  });
  assert.equal(result.taskState, 'executing');
  const startCall = provider.updates.find(
    (u) =>
      u.ticketId === 321 &&
      u.mutations.labels?.add?.includes('agent::executing'),
  );
  assert.ok(startCall, 'expected updateTicket call starting Task #321');
  assert.equal(startCall.mutations.state, 'open');
  assert.ok(provider.tickets[321].labels.includes('agent::executing'));
});

test('runStoryTaskProgress: state=done with commitSha closes the Task ticket (cascade suppressed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-task-progress-'));
  const cachePath = path.join(dir, 'story-30-progress.json');
  writeCache(cachePath, {
    storyId: 30,
    branch: 'story-30',
    tasks: [{ id: 301, title: 't', state: 'executing' }],
  });
  const provider = makeProvider([]);
  // Pre-seed the Task ticket so the mock has a starting label set.
  provider.tickets[301] = { id: 301, labels: ['agent::executing'] };

  const result = await runStoryTaskProgress({
    storyId: 30,
    taskId: 301,
    state: 'done',
    commitSha: 'cafebabe',
    provider,
    cachePath,
  });
  assert.equal(result.taskState, 'done');
  // The per-Task close MUST have hit updateTicket with agent::done +
  // state:'closed' as a single mutation.
  const closeCall = provider.updates.find(
    (u) =>
      u.ticketId === 301 && u.mutations.labels?.add?.includes('agent::done'),
  );
  assert.ok(closeCall, 'expected updateTicket call closing Task #301');
  assert.equal(closeCall.mutations.state, 'closed');
  assert.equal(closeCall.mutations.state_reason, 'completed');
  // Ticket label set reflects the close.
  assert.ok(provider.tickets[301].labels.includes('agent::done'));
});

test('runStoryTaskProgress: state=done WITHOUT commitSha skips the per-Task close (resume guard needs the sha)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-task-progress-'));
  const cachePath = path.join(dir, 'story-31-progress.json');
  writeCache(cachePath, {
    storyId: 31,
    branch: 'story-31',
    tasks: [{ id: 311, title: 't', state: 'executing' }],
  });
  const provider = makeProvider([]);
  await runStoryTaskProgress({
    storyId: 31,
    taskId: 311,
    state: 'done',
    provider,
    cachePath,
  });
  // No updateTicket call — the close path is gated on having a commit SHA
  // because the resume guard reads it back. A done-without-sha is treated
  // as a snapshot-only update (preserves prior behavior for any caller
  // that wants to mark progress without recording a commit).
  assert.equal(
    provider.updates.length,
    0,
    'expected no updateTicket calls when commitSha is absent',
  );
});

test('runStoryTaskProgress: state=executing returns skip:true when prior run closed this Task and commit is on HEAD', async () => {
  const repo = makeTmpGitRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-task-progress-'));
  const cachePath = path.join(dir, 'story-40-progress.json');
  // Prior run left Task #401 done with the repo HEAD sha — i.e. its commit
  // really is on the branch. Resume should skip.
  writeCache(cachePath, {
    storyId: 40,
    branch: 'story-40',
    tasks: [
      { id: 401, title: 'first', state: 'done', commitSha: repo.sha },
      { id: 402, title: 'second', state: 'pending' },
    ],
  });
  const provider = makeProvider([]);

  const result = await runStoryTaskProgress({
    storyId: 40,
    taskId: 401,
    state: 'executing',
    provider,
    cachePath,
    cwd: repo.dir,
  });

  assert.equal(result.ok, true);
  assert.equal(result.skip, true);
  assert.equal(result.reason, 'task-already-complete-and-reachable');
  assert.equal(result.taskState, 'done');
  // Cache + comment surfaces must be untouched.
  const cached = readCache(cachePath);
  assert.equal(cached.tasks.find((t) => t.id === 401).state, 'done');
  assert.equal(provider.comments.length, 0);
  assert.equal(provider.updates.length, 0);
});

test('runStoryTaskProgress: state=executing does NOT skip when prior commit is missing from HEAD (resume after branch loss)', async () => {
  const repo = makeTmpGitRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-task-progress-'));
  const cachePath = path.join(dir, 'story-41-progress.json');
  // Snapshot says done at a sha that doesn't exist in the repo — e.g.
  // branch was reset / clobbered. The Task must re-run, not be skipped.
  writeCache(cachePath, {
    storyId: 41,
    branch: 'story-41',
    tasks: [
      { id: 411, title: 'first', state: 'done', commitSha: '0'.repeat(40) },
    ],
  });
  const provider = makeProvider([]);

  const result = await runStoryTaskProgress({
    storyId: 41,
    taskId: 411,
    state: 'executing',
    provider,
    cachePath,
    cwd: repo.dir,
  });
  assert.notEqual(result.skip, true);
  assert.equal(result.taskState, 'executing');
});
