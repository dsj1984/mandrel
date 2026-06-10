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
  storyBranch,
  hierarchy,
}) {
  const marker = structuredCommentMarker('story-init');
  const payload = {
    storyId,
    storyBranch: storyBranch ?? `story-${storyId}`,
    workCwd,
    dependenciesInstalled,
  };
  if (hierarchy) payload.hierarchy = hierarchy;
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
  assert.equal(Array.isArray(result.snapshot.phases), true);
  assert.ok(result.snapshot.phases.every((p) => p.status === 'pending'));

  // Story #3909 — the redundant per-Story story-run-progress comment is no
  // longer posted. The init story-init comment is the only comment present.
  const progressMarker = structuredCommentMarker('story-run-progress');
  const upserted = provider.comments.find(
    (c) => typeof c.body === 'string' && c.body.includes(progressMarker),
  );
  assert.equal(upserted, undefined, 'no story-run-progress comment is posted');
  // renderedBody is still computed and surfaced for chat relay by
  // `/story-deliver` so operators see the initial Story-phase table before
  // the first commit lands.
  assert.ok(result.renderedBody.startsWith('### 📖 Story #42'));
  assert.match(result.renderedBody, /0\/4 phases done/);
});

test('runStoryDeliverPrepare: dependenciesInstalled=false runs install before upserting', async () => {
  const provider = makeProvider([
    makeStoryInitComment({
      storyId: 50,
      workCwd: '/tmp/.worktrees/story-50',
      dependenciesInstalled: 'false',
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

test('runStoryDeliverPrepare: 3-tier hierarchy emits phases[] snapshot (init/implement/validate/close)', async () => {
  // Under the 3-tier hierarchy (Epic → Feature → Story) the
  // inline-acceptance Story is the only ticket shape, so the prepare CLI
  // always seeds the initial snapshot with a `phases[]` array — never a
  // `tasks[]` list — letting the parent `/epic-deliver` aggregator render
  // a coarse Story-phase progress bar without walking Task tickets that do
  // not exist.
  const provider = makeProvider([
    makeStoryInitComment({
      storyId: 3129,
      workCwd: '/tmp/.worktrees/story-3129',
      dependenciesInstalled: 'true',
      hierarchy: '3-tier',
    }),
  ]);

  const result = await runStoryDeliverPrepare({
    storyId: 3129,
    provider,
    runInstall: () => ({ status: 0 }),
  });

  assert.equal(result.hierarchy, '3-tier');
  assert.equal(result.snapshot.phase, 'init');
  assert.equal(
    'tasks' in result.snapshot,
    false,
    'snapshot must not carry tasks[]',
  );
  assert.equal(Array.isArray(result.snapshot.phases), true);
  assert.deepEqual(
    result.snapshot.phases.map((p) => p.name),
    ['init', 'implement', 'validate', 'close'],
  );
  // Every phase pending + null timestamps at init time.
  for (const p of result.snapshot.phases) {
    assert.equal(p.status, 'pending');
    assert.equal(p.startedAt, null);
    assert.equal(p.endedAt, null);
  }
  // Rendered body uses the phase header.
  assert.match(result.renderedBody, /### 📖 Story #3129/);
  assert.match(result.renderedBody, /0\/4 phases done/);
});

test('runStoryDeliverPrepare: omitted hierarchy still emits the phases[] snapshot', async () => {
  // A story-init payload that omits `hierarchy` defaults to the 3-tier
  // shape, so the snapshot is still the Story-phase `phases[]` array.
  const provider = makeProvider([
    makeStoryInitComment({
      storyId: 200,
      workCwd: '/tmp/.worktrees/story-200',
      dependenciesInstalled: 'true',
    }),
  ]);
  const result = await runStoryDeliverPrepare({
    storyId: 200,
    provider,
    runInstall: () => ({ status: 0 }),
  });
  assert.equal(Array.isArray(result.snapshot.phases), true);
  assert.equal('tasks' in result.snapshot, false);
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
