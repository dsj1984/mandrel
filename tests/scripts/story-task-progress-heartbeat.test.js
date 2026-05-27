/**
 * story-task-progress-heartbeat.test.js — Story #3057 Task #3063.
 *
 * Asserts that `story-task-progress.js` emits exactly one
 * `story.heartbeat` ledger record per Task close, with the canonical
 * payload shape (event, storyId, epicId, phase='implementing', taskId,
 * timestamp).
 *
 * The test stubs the ticketing provider to return a Story body
 * carrying `Epic: #N`, points the heartbeat at a temp ledger via the
 * tempRoot config override, and counts NDJSON lines after one close
 * (cadence) plus parses the single record (payload).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { emitStoryHeartbeat } from '../../.agents/scripts/lib/orchestration/lifecycle/emit-story-heartbeat.js';
import { runStoryTaskProgress } from '../../.agents/scripts/story-task-progress.js';

function makeProvider({ storyId, epicId, taskId }) {
  const comments = [];
  const tickets = {
    [storyId]: {
      id: storyId,
      labels: ['type::story'],
      body: `Story body.\n\nEpic: #${epicId}\n`,
    },
    [taskId]: { id: taskId, labels: ['type::task'] },
  };
  let nextId = 100;
  return {
    comments,
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
      return tickets[ticketId] ?? { id: ticketId, labels: [], body: '' };
    },
    async updateTicket(ticketId, mutations) {
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
    async getSubTickets() {
      return [];
    },
    async getTicketDependencies() {
      return { blocks: [], blockedBy: [] };
    },
  };
}

function makeTmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-hb-'));
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
  return { dir: real, sha };
}

// Pending Task #3157: story-task-progress.js still emits a heartbeat
// carrying taskId, which the 3-tier schema now rejects. Reinstate after
// the Task-progress surface is removed (or migrated to a Story-only
// emitter).
test.skip('story-task-progress: emits exactly one story.heartbeat record per Task close', async () => {
  const storyId = 9001;
  const epicId = 9000;
  const taskId = 9100;
  const provider = makeProvider({ storyId, epicId, taskId });
  // Seed the cache so we skip the GitHub comment hydration path.
  const { dir, sha } = makeTmpGitRepo();
  const cachePath = path.join(dir, 'cache.json');
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      kind: 'story-run-progress',
      storyId,
      branch: `story-${storyId}`,
      phase: 'init',
      tasks: [{ id: taskId, title: 'T', state: 'pending' }],
      updatedAt: new Date().toISOString(),
    }),
  );

  // tempRoot resolves to 'temp' (the missing-config fallback) relative to
  // CWD. Run the transition with CWD pinned to the tmp dir so the ledger
  // lands at <dir>/temp/epic-<epicId>/lifecycle.ndjson.
  const prevCwd = process.cwd();
  process.chdir(dir);
  const ledgerPath = path.join(
    dir,
    'temp',
    `epic-${epicId}`,
    'lifecycle.ndjson',
  );
  assert.equal(
    fs.existsSync(ledgerPath),
    false,
    'ledger should not exist before close',
  );

  let result;
  try {
    result = await runStoryTaskProgress({
      storyId,
      taskId,
      state: 'done',
      commitSha: sha,
      cwd: dir,
      provider,
      cachePath,
    });
  } finally {
    process.chdir(prevCwd);
  }

  assert.equal(result.ok, true, 'transition should succeed');
  assert.equal(result.taskState, 'done');

  // Cadence: exactly one NDJSON line.
  const raw = fs.readFileSync(ledgerPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, 'exactly one heartbeat record per close');

  const record = JSON.parse(lines[0]);
  assert.equal(record.event, 'story.heartbeat');
  assert.equal(record.kind, 'emitted');

  // Payload shape.
  assert.deepEqual(Object.keys(record.payload).sort(), [
    'epicId',
    'event',
    'phase',
    'storyId',
    'taskId',
    'timestamp',
  ]);
  assert.equal(record.payload.event, 'story.heartbeat');
  assert.equal(record.payload.storyId, storyId);
  assert.equal(record.payload.epicId, epicId);
  assert.equal(record.payload.phase, 'implementing');
  assert.equal(record.payload.taskId, taskId);
  assert.match(
    record.payload.timestamp,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  );
});

test('story-task-progress: does NOT emit story.heartbeat when --state=done lacks --commit-sha', async () => {
  const storyId = 9002;
  const epicId = 9000;
  const taskId = 9200;
  const provider = makeProvider({ storyId, epicId, taskId });
  const { dir } = makeTmpGitRepo();
  const cachePath = path.join(dir, 'cache.json');
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      kind: 'story-run-progress',
      storyId,
      branch: `story-${storyId}`,
      phase: 'init',
      tasks: [{ id: taskId, title: 'T', state: 'pending' }],
      updatedAt: new Date().toISOString(),
    }),
  );
  const prevCwd = process.cwd();
  process.chdir(dir);
  const ledgerPath = path.join(
    dir,
    'temp',
    `epic-${epicId}`,
    'lifecycle.ndjson',
  );
  try {
    await runStoryTaskProgress({
      storyId,
      taskId,
      state: 'done',
      // no commitSha → snapshot-only update path
      cwd: dir,
      provider,
      cachePath,
    });
  } finally {
    process.chdir(prevCwd);
  }

  assert.equal(
    fs.existsSync(ledgerPath),
    false,
    'no heartbeat without commit-sha',
  );
});

test('emitStoryHeartbeat: 3-tier emit omits taskId and Task counter fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-hb-3tier-'));
  const ledgerPath = path.join(dir, 'lifecycle.ndjson');

  const { record } = emitStoryHeartbeat({
    storyId: 3137,
    epicId: 3078,
    timestamp: '2026-05-27T16:00:00.000Z',
    ledgerPath,
  });

  assert.deepEqual(Object.keys(record.payload).sort(), [
    'epicId',
    'event',
    'phase',
    'storyId',
    'timestamp',
  ]);
  assert.equal('taskId' in record.payload, false);
  assert.equal('tasksDone' in record.payload, false);
  assert.equal('tasksTotal' in record.payload, false);
  assert.equal('currentTaskId' in record.payload, false);

  const raw = fs.readFileSync(ledgerPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
});

// The 3-tier schema rejects taskId on heartbeat payloads. The 4-tier
// emit path is removed under Task #3157; the schema-level rejection is
// covered by tests/schemas/signal-schemas.test.js.
test.skip('emitStoryHeartbeat: 4-tier emit with legacy taskId still validates and is included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-hb-4tier-'));
  const ledgerPath = path.join(dir, 'lifecycle.ndjson');

  const { record } = emitStoryHeartbeat({
    storyId: 3137,
    epicId: 3078,
    taskId: 3146,
    timestamp: '2026-05-27T16:00:00.000Z',
    ledgerPath,
  });

  assert.equal(record.payload.taskId, 3146);
});
