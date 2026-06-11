import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInstallCmd } from '../.agents/scripts/lib/install-cmd-parser.js';
import { structuredCommentMarker } from '../.agents/scripts/lib/orchestration/ticketing.js';
import {
  deriveInstallAction,
  resolveInstallCommand,
  runStoryInitPrepare,
} from '../.agents/scripts/story-init.js';

/**
 * Story #4017 — the standalone `story-deliver-prepare.js` CLI was inlined
 * into `story-init.js`. The prepare step now consumes the in-process init
 * result directly (no structured-comment re-read), so these tests drive
 * `runStoryInitPrepare` with a result-shaped object.
 */

function makeProvider() {
  const comments = [];
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

function makeInitResult({ storyId, workCwd, dependenciesInstalled }) {
  return {
    storyId,
    storyBranch: `story-${storyId}`,
    workCwd,
    dependenciesInstalled,
    hierarchy: '3-tier',
  };
}

test('deriveInstallAction: tri-state truth table', () => {
  assert.equal(deriveInstallAction('true'), 'skip');
  assert.equal(deriveInstallAction('skipped'), 'skip');
  assert.equal(deriveInstallAction('false'), 'install');
});

test('deriveInstallAction: skipInstall always wins', () => {
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

test('runStoryInitPrepare: dependenciesInstalled=true skips install + renders init snapshot', async () => {
  const provider = makeProvider();
  let runInstallCalls = 0;

  const result = await runStoryInitPrepare({
    provider,
    storyId: 42,
    result: makeInitResult({
      storyId: 42,
      workCwd: '/tmp/.worktrees/story-42',
      dependenciesInstalled: 'true',
    }),
    runInstall: () => {
      runInstallCalls++;
      return { status: 0 };
    },
  });
  assert.equal(result.installAction, 'skip');
  assert.equal(result.installCmd, null);
  assert.equal(runInstallCalls, 0);
  assert.equal(result.snapshot.phase, 'init');
  assert.equal(Array.isArray(result.snapshot.phases), true);
  assert.ok(result.snapshot.phases.every((p) => p.status === 'pending'));

  // Story #3909 — the redundant per-Story story-run-progress comment is no
  // longer posted; the snapshot is render-only.
  const progressMarker = structuredCommentMarker('story-run-progress');
  const upserted = provider.comments.find(
    (c) => typeof c.body === 'string' && c.body.includes(progressMarker),
  );
  assert.equal(upserted, undefined, 'no story-run-progress comment is posted');
  // renderedBody is still computed and surfaced for chat relay so operators
  // see the initial Story-phase table before the first commit lands.
  assert.ok(result.renderedBody.startsWith('### 📖 Story #42'));
  assert.match(result.renderedBody, /0\/4 phases done/);
});

test('runStoryInitPrepare: dependenciesInstalled=false retries install before rendering', async () => {
  const provider = makeProvider();
  const installs = [];
  const result = await runStoryInitPrepare({
    provider,
    storyId: 50,
    result: makeInitResult({
      storyId: 50,
      workCwd: '/tmp/.worktrees/story-50',
      dependenciesInstalled: 'false',
    }),
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

test('runStoryInitPrepare: failed install bubbles up as an Error', async () => {
  const provider = makeProvider();
  await assert.rejects(
    runStoryInitPrepare({
      provider,
      storyId: 51,
      result: makeInitResult({
        storyId: 51,
        workCwd: '/tmp/.worktrees/story-51',
        dependenciesInstalled: 'false',
      }),
      runInstall: () => ({ status: 7, stderr: 'npm exited 7' }),
    }),
    /install command `npm ci` failed/,
  );
});

test('runStoryInitPrepare: 3-tier snapshot carries phases[] (init/implement/validate/close), never tasks[]', async () => {
  const provider = makeProvider();
  const result = await runStoryInitPrepare({
    provider,
    storyId: 3129,
    result: makeInitResult({
      storyId: 3129,
      workCwd: '/tmp/.worktrees/story-3129',
      dependenciesInstalled: 'true',
    }),
    runInstall: () => ({ status: 0 }),
  });

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
