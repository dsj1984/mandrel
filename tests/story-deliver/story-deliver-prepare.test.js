import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInstallCmd } from '../../.agents/scripts/lib/install-cmd-parser.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import {
  deriveInstallAction,
  resolveInstallCommand,
  runStoryDeliverPrepare,
} from '../../.agents/scripts/story-deliver-prepare.js';

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

test('runStoryDeliverPrepare: dependenciesInstalled=true skips install + upserts init snapshot', async () => {
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

  const result = await runStoryDeliverPrepare({
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
  // `/story-deliver` so operators see the initial task table before the
  // first commit lands.
  assert.ok(result.renderedBody.startsWith('### 📖 Story #42'));
  assert.match(result.renderedBody, /0\/2 tasks done/);
});

test('runStoryDeliverPrepare: dependenciesInstalled=false runs install before upserting', async () => {
  const provider = makeProvider([
    makeStoryInitComment({
      storyId: 50,
      workCwd: '/tmp/.worktrees/story-50',
      dependenciesInstalled: 'false',
      tasks: [{ id: 1, title: 't', state: 'pending' }],
    }),
  ]);
  const installs = [];
  const result = await runStoryDeliverPrepare({
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

test('runStoryDeliverPrepare: failed install bubbles up as an Error', async () => {
  const provider = makeProvider([
    makeStoryInitComment({
      storyId: 51,
      workCwd: '/tmp/.worktrees/story-51',
      dependenciesInstalled: 'false',
      tasks: [{ id: 1, title: 't', state: 'pending' }],
    }),
  ]);
  await assert.rejects(
    runStoryDeliverPrepare({
      storyId: 51,
      provider,
      runInstall: () => ({ status: 7, stderr: 'npm exited 7' }),
    }),
    /install command `npm ci` failed/,
  );
});

test('runStoryDeliverPrepare: falls back to provider.getSubTickets when legacy story-init payload omits tasks', async () => {
  // Pre-5.31.2 story-init comments did not embed `tasks[]`. The prepare CLI
  // must hydrate the task list from the provider so the initial
  // story-run-progress snapshot is non-empty.
  const provider = makeProvider([
    makeStoryInitComment({
      storyId: 60,
      workCwd: '/tmp/.worktrees/story-60',
      dependenciesInstalled: 'true',
      tasks: undefined, // legacy payload — no tasks field
    }),
  ]);
  // Stub getSubTickets — the fallback path uses fetchChildTasks under the hood.
  provider.getSubTickets = async () => [
    { number: 91, title: 'legacy-A', labels: ['type::task'] },
    { number: 92, title: 'legacy-B', labels: ['type::task'] },
    { number: 93, title: 'unrelated', labels: ['type::feature'] },
  ];

  const result = await runStoryDeliverPrepare({
    storyId: 60,
    provider,
    runInstall: () => ({ status: 0 }),
  });
  assert.equal(result.snapshot.tasks.length, 2);
  assert.deepEqual(
    result.snapshot.tasks.map((t) => t.id),
    [91, 92],
  );
  assert.ok(result.snapshot.tasks.every((t) => t.state === 'pending'));
});

test('runStoryDeliverPrepare: prefers payload.tasks when present (no fallback fetch)', async () => {
  const provider = makeProvider([
    makeStoryInitComment({
      storyId: 61,
      workCwd: '/tmp/.worktrees/story-61',
      dependenciesInstalled: 'true',
      tasks: [
        { id: 70, title: 'embedded-A' },
        { id: 71, title: 'embedded-B' },
      ],
    }),
  ]);
  let getSubTicketsCalls = 0;
  provider.getSubTickets = async () => {
    getSubTicketsCalls++;
    return [];
  };
  const result = await runStoryDeliverPrepare({
    storyId: 61,
    provider,
    runInstall: () => ({ status: 0 }),
  });
  assert.equal(result.snapshot.tasks.length, 2);
  assert.equal(getSubTicketsCalls, 0); // no fallback needed
});

test('runStoryDeliverPrepare: throws if no story-init comment is found', async () => {
  const provider = makeProvider([]);
  await assert.rejects(
    runStoryDeliverPrepare({ storyId: 999, provider }),
    /no story-init comment found/,
  );
});

test('parseInstallCmd: tokenizes "npm ci" into bin + args', () => {
  const { bin, args, shell } = parseInstallCmd('npm ci');
  assert.equal(bin, 'npm');
  assert.deepEqual(args, ['ci']);
  // shell:true on Windows is required for .cmd shim spawn under
  // CVE-2024-27980; POSIX hosts get shell:false.
  assert.equal(shell, process.platform === 'win32');
});

test('parseInstallCmd: tokenizes multi-arg pnpm overrides', () => {
  const { bin, args } = parseInstallCmd('pnpm install --frozen-lockfile');
  assert.equal(bin, 'pnpm');
  assert.deepEqual(args, ['install', '--frozen-lockfile']);
});

test('parseInstallCmd: collapses internal whitespace and trims edges', () => {
  const { bin, args } = parseInstallCmd('  npm   install   --silent  ');
  assert.equal(bin, 'npm');
  assert.deepEqual(args, ['install', '--silent']);
});

test('parseInstallCmd: preserves absolute paths to non-shimmed binaries', () => {
  const { bin, args } = parseInstallCmd('/usr/local/bin/custom-installer --ci');
  assert.equal(bin, '/usr/local/bin/custom-installer');
  assert.deepEqual(args, ['--ci']);
});

test('parseInstallCmd: rejects empty input', () => {
  assert.throws(() => parseInstallCmd(''), /at least one token/);
  assert.throws(() => parseInstallCmd('   '), /at least one token/);
});
