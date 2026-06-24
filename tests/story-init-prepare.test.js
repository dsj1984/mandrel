import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInstallCmd } from '../.agents/scripts/lib/install-cmd-parser.js';
import { structuredCommentMarker } from '../.agents/scripts/lib/orchestration/ticketing.js';
import {
  deriveInstallAction,
  runStoryInitPrepare,
} from '../.agents/scripts/story-init.js';

/**
 * Story #4017 — the formerly standalone prepare CLI was inlined
 * into `story-init.js`. The prepare step now consumes the in-process init
 * result directly (no structured-comment re-read), so these tests drive
 * `runStoryInitPrepare` with a result-shaped object.
 *
 * Story #4249 — the prepare step's install branch was DELETED. The worktree
 * install is owned by `WorktreeManager.ensure` (PM-aware retry budget); the
 * formerly-hardcoded `npm ci` re-install (and `resolveInstallCommand`) is
 * gone. `runStoryInitPrepare` is now purely the snapshot-render half, and
 * `deriveInstallAction` survives as the canonical tri-state classifier for the
 * `dependenciesInstalled` structured-comment signal.
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
    hierarchy: '2-tier',
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

test('runStoryInitPrepare: renders the init snapshot without running any install (Story #4249)', async () => {
  const provider = makeProvider();

  const result = await runStoryInitPrepare({
    provider,
    storyId: 42,
    result: makeInitResult({
      storyId: 42,
      workCwd: '/tmp/.worktrees/story-42',
      dependenciesInstalled: 'true',
    }),
  });
  // The install branch (and its installAction/installCmd outputs) is gone —
  // the prepare step is purely the snapshot-render half now.
  assert.equal('installAction' in result, false);
  assert.equal('installCmd' in result, false);
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

test('runStoryInitPrepare: renders the snapshot regardless of dependenciesInstalled value (no re-install)', async () => {
  const provider = makeProvider();
  // Even a `false` (init-install-failed) tri-state no longer triggers a
  // prepare-side re-install — the in-`ensure` retry budget already absorbed it.
  const result = await runStoryInitPrepare({
    provider,
    storyId: 50,
    result: makeInitResult({
      storyId: 50,
      workCwd: '/tmp/.worktrees/story-50',
      dependenciesInstalled: 'false',
    }),
  });
  assert.equal(result.snapshot.phase, 'init');
  assert.match(result.renderedBody, /### 📖 Story #50/);
});

test('runStoryInitPrepare: 2-tier snapshot carries phases[] (init/implement/validate/close), never tasks[]', async () => {
  const provider = makeProvider();
  const result = await runStoryInitPrepare({
    provider,
    storyId: 3129,
    result: makeInitResult({
      storyId: 3129,
      workCwd: '/tmp/.worktrees/story-3129',
      dependenciesInstalled: 'true',
    }),
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
