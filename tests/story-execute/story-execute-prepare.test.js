import assert from 'node:assert/strict';
import test from 'node:test';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import {
  deriveInstallAction,
  resolveInstallCommand,
  runStoryExecutePrepare,
} from '../../.agents/scripts/story-execute-prepare.js';

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

function makeStoryInitComment({
  storyId,
  workCwd,
  dependenciesInstalled,
  tasks,
  storyBranch,
}) {
  const marker = structuredCommentMarker('story-init');
  const payload = {
    storyId,
    storyBranch: storyBranch ?? `story-${storyId}`,
    workCwd,
    dependenciesInstalled,
    tasks: tasks ?? [],
  };
  return {
    id: 1,
    ticketId: storyId,
    type: 'comment',
    body: `${marker}\n\n## Story init\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
  };
}

test('deriveInstallAction: tri-state truth table', () => {
  assert.equal(deriveInstallAction('true'), 'skip');
  assert.equal(deriveInstallAction('skipped'), 'skip');
  assert.equal(deriveInstallAction('false'), 'install');
});

test('deriveInstallAction: --skip-install always wins', () => {
  assert.equal(deriveInstallAction('false', { skipInstall: true }), 'skip');
});

test('deriveInstallAction: rejects unknown tri-state values', () => {
  assert.throws(() => deriveInstallAction('maybe'), /must be one of/);
});

test('resolveInstallCommand: defaults to npm ci', () => {
  assert.equal(resolveInstallCommand(), 'npm ci');
});

test('resolveInstallCommand: honors override when non-blank', () => {
  assert.equal(
    resolveInstallCommand({ override: 'pnpm install --frozen-lockfile' }),
    'pnpm install --frozen-lockfile',
  );
  assert.equal(resolveInstallCommand({ override: '   ' }), 'npm ci');
});

test('runStoryExecutePrepare: dependenciesInstalled=true skips install + upserts init snapshot', async () => {
  const provider = makeProvider([
    makeStoryInitComment({
      storyId: 42,
      workCwd: '/tmp/.worktrees/story-42',
      dependenciesInstalled: 'true',
      tasks: [
        { id: 100, title: 'first', state: 'pending' },
        { id: 200, title: 'second', state: 'pending' },
      ],
    }),
  ]);
  let runInstallCalls = 0;

  const result = await runStoryExecutePrepare({
    storyId: 42,
    provider,
    runInstall: () => {
      runInstallCalls++;
      return { status: 0 };
    },
  });
  assert.equal(result.installAction, 'skip');
  assert.equal(result.installCmd, null);
  assert.equal(runInstallCalls, 0);
  assert.equal(result.workCwd, '/tmp/.worktrees/story-42');
  assert.equal(result.snapshot.phase, 'init');
  assert.equal(result.snapshot.tasks.length, 2);
  assert.ok(result.snapshot.tasks.every((t) => t.state === 'pending'));

  // The story-run-progress comment was upserted on the same ticket.
  const progressMarker = structuredCommentMarker('story-run-progress');
  const upserted = provider.comments.find(
    (c) => typeof c.body === 'string' && c.body.includes(progressMarker),
  );
  assert.ok(upserted, 'expected a story-run-progress comment to be upserted');
  // renderedBody is the same markdown body, surfaced for chat relay by
  // `/story-execute` so operators see the initial task table before the
  // first commit lands.
  assert.ok(result.renderedBody.startsWith('### 📖 Story #42'));
  assert.match(result.renderedBody, /0\/2 tasks done/);
});

test('runStoryExecutePrepare: dependenciesInstalled=false runs install before upserting', async () => {
  const provider = makeProvider([
    makeStoryInitComment({
      storyId: 50,
      workCwd: '/tmp/.worktrees/story-50',
      dependenciesInstalled: 'false',
      tasks: [{ id: 1, title: 't', state: 'pending' }],
    }),
  ]);
  const installs = [];
  const result = await runStoryExecutePrepare({
    storyId: 50,
    provider,
    runInstall: (cmd, dir) => {
      installs.push({ cmd, dir });
      return { status: 0 };
    },
  });
  assert.equal(result.installAction, 'install');
  assert.equal(result.installCmd, 'npm ci');
  assert.deepEqual(installs, [
    { cmd: 'npm ci', dir: '/tmp/.worktrees/story-50' },
  ]);
});

test('runStoryExecutePrepare: failed install bubbles up as an Error', async () => {
  const provider = makeProvider([
    makeStoryInitComment({
      storyId: 51,
      workCwd: '/tmp/.worktrees/story-51',
      dependenciesInstalled: 'false',
      tasks: [{ id: 1, title: 't', state: 'pending' }],
    }),
  ]);
  await assert.rejects(
    runStoryExecutePrepare({
      storyId: 51,
      provider,
      runInstall: () => ({ status: 7, stderr: 'npm exited 7' }),
    }),
    /install command `npm ci` failed/,
  );
});

test('runStoryExecutePrepare: throws if no story-init comment is found', async () => {
  const provider = makeProvider([]);
  await assert.rejects(
    runStoryExecutePrepare({ storyId: 999, provider }),
    /no story-init comment found/,
  );
});
