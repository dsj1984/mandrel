import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import {
  renderStoryInitCommentBody,
  runStoryInit,
} from '../.agents/scripts/story-init.js';

const SCRIPT_PATH = path.resolve('.agents/scripts/story-init.js');

test('story-init script', async (t) => {
  await t.test('fails without --story argument', () => {
    const result = spawnSync('node', [SCRIPT_PATH]);
    assert.strictEqual(result.status, 1);
    assert.match(
      result.stderr.toString() + result.stdout.toString(),
      /Usage: node story-init\.js --story <STORY_ID>/,
    );
  });
});

// -----------------------------------------------------------------------------
// Pipeline integration tests — exercise the composed 6-stage pipeline via
// runStoryInit with an injected provider and injected config so no real git
// or GitHub calls are made. Uses --dry-run to stay out of the branch /
// task-state stages.
// -----------------------------------------------------------------------------

function makePipelineProvider({ story, epic, subTickets = [], blockers = {} }) {
  const calls = { getTicket: [], getEpic: [], getSubTickets: [] };
  return {
    calls,
    async getTicket(id) {
      calls.getTicket.push(id);
      if (id === story.id) return story;
      if (blockers[id]) return blockers[id];
      throw new Error(`unexpected getTicket(${id})`);
    },
    async getEpic(id) {
      calls.getEpic.push(id);
      return epic;
    },
    async getSubTickets(storyId) {
      calls.getSubTickets.push(storyId);
      return subTickets;
    },
    async updateTicket() {
      throw new Error('updateTicket should not be called in dry-run');
    },
  };
}

function baseConfig() {
  return {
    agentSettings: { baseBranch: 'main' },
    orchestration: {
      worktreeIsolation: { enabled: false },
      notifications: { level: 'silent', channels: [] },
    },
  };
}

test('runStoryInit dry-run composes all stages end-to-end', async () => {
  const story = {
    id: 701,
    title: 'Demo Story',
    labels: ['type::story'],
    body: '---\nparent: #500\nEpic: #400',
    state: 'open',
  };
  const epic = {
    id: 400,
    labels: ['type::epic'],
    linkedIssues: { prd: 401, techSpec: 402 },
  };
  const subTickets = [
    {
      id: 801,
      title: 't1',
      labels: ['type::task'],
      body: 'blocked by #802',
      state: 'open',
    },
    {
      id: 802,
      title: 't2',
      labels: ['type::task'],
      body: '',
      state: 'open',
    },
  ];
  const provider = makePipelineProvider({ story, epic, subTickets });

  const out = await runStoryInit({
    storyId: 701,
    dryRun: true,
    injectedProvider: provider,
    injectedConfig: baseConfig(),
  });

  assert.strictEqual(out.success, true);
  const r = out.result;
  assert.strictEqual(r.storyId, 701);
  assert.strictEqual(r.epicId, 400);
  assert.strictEqual(r.storyBranch, 'story-701');
  assert.strictEqual(r.epicBranch, 'epic/400');
  assert.strictEqual(r.worktreeEnabled, false);
  assert.strictEqual(r.worktreeCreated, false);
  assert.strictEqual(r.dryRun, true);
  // Dry-run never executes the branch-initializer, so installStatus stays
  // at the dry-run sentinel and `dependenciesInstalled` collapses to
  // 'skipped' for the workflow.
  assert.deepStrictEqual(r.installStatus, {
    status: 'skipped',
    reason: 'dry-run',
  });
  assert.strictEqual(r.dependenciesInstalled, 'skipped');
  assert.strictEqual(r.installFailed, false);
  assert.deepStrictEqual(r.context, {
    featureId: 500,
    prdId: 401,
    techSpecId: 402,
  });
  // task-graph-builder must topologically sort #802 before #801.
  assert.deepStrictEqual(
    r.tasks.map((t) => t.id),
    [802, 801],
  );
  // hierarchy-tracer and task-graph-builder each make exactly one call.
  assert.deepStrictEqual(provider.calls.getEpic, [400]);
  assert.deepStrictEqual(provider.calls.getSubTickets, [701]);
});

test('runStoryInit short-circuits with {blocked:true} when blockers are open', async () => {
  const story = {
    id: 701,
    title: 'S',
    labels: ['type::story'],
    body: 'Epic: #400\n\nblocked by #999',
    state: 'open',
  };
  const epic = {
    id: 400,
    labels: ['type::epic'],
    linkedIssues: {},
  };
  const blocker = {
    id: 999,
    title: 'dep',
    labels: ['type::task', 'agent::executing'],
    state: 'open',
  };
  const provider = makePipelineProvider({
    story,
    epic,
    blockers: { 999: blocker },
  });

  const out = await runStoryInit({
    storyId: 701,
    dryRun: false,
    injectedProvider: provider,
    injectedConfig: baseConfig(),
  });

  assert.strictEqual(out.success, false);
  assert.strictEqual(out.blocked, true);
  assert.strictEqual(out.openBlockers.length, 1);
  assert.strictEqual(out.openBlockers[0].id, 999);
  // Must not reach the task-graph stage after a blocker short-circuit.
  assert.deepStrictEqual(provider.calls.getSubTickets, []);
});

test('renderStoryInitCommentBody surfaces dependenciesInstalled tri-state + installStatus', () => {
  const body = renderStoryInitCommentBody({
    storyId: 701,
    epicId: 400,
    storyBranch: 'story-701',
    epicBranch: 'epic/400',
    worktreeEnabled: true,
    workCwd: '/tmp/wt/story-701',
    worktreeCreated: true,
    dependenciesInstalled: 'true',
    installStatus: { status: 'installed' },
  });
  assert.match(body, /## Story init/);
  assert.match(body, /\*\*dependenciesInstalled:\*\* `true`/);
  assert.match(body, /\*\*installStatus.status:\*\* `installed`/);
  // Embedded JSON block is canonical for downstream `jq` extraction.
  const jsonBlock = body.match(/```json\n([\s\S]*?)\n```/)?.[1];
  assert.ok(jsonBlock, 'expected fenced JSON payload');
  const payload = JSON.parse(jsonBlock);
  assert.strictEqual(payload.dependenciesInstalled, 'true');
  assert.deepStrictEqual(payload.installStatus, { status: 'installed' });
  assert.strictEqual(payload.workCwd, '/tmp/wt/story-701');
});

test('renderStoryInitCommentBody handles failed install', () => {
  const body = renderStoryInitCommentBody({
    storyId: 1,
    epicId: 2,
    storyBranch: 'story-1',
    epicBranch: 'epic/2',
    worktreeEnabled: true,
    workCwd: '/tmp/wt',
    worktreeCreated: true,
    dependenciesInstalled: 'false',
    installStatus: { status: 'failed', reason: 'install-command-nonzero' },
  });
  assert.match(body, /\*\*dependenciesInstalled:\*\* `false`/);
  assert.match(body, /\*\*installStatus.reason:\*\* `install-command-nonzero`/);
});

test('renderStoryInitCommentBody handles skipped install', () => {
  const body = renderStoryInitCommentBody({
    storyId: 1,
    epicId: 2,
    storyBranch: 'story-1',
    epicBranch: 'epic/2',
    worktreeEnabled: false,
    workCwd: '/repo',
    worktreeCreated: false,
    dependenciesInstalled: 'skipped',
    installStatus: { status: 'skipped', reason: 'single-tree-mode' },
  });
  assert.match(body, /\*\*dependenciesInstalled:\*\* `skipped`/);
  assert.match(body, /\*\*installStatus.reason:\*\* `single-tree-mode`/);
});

test('renderStoryInitCommentBody embeds tasks[] in the fenced payload', () => {
  // The downstream `story-execute-prepare.js` consumer reads
  // `initPayload.tasks` to seed the initial `story-run-progress` snapshot.
  // Without this, the snapshot was empty and every later `story-task-progress`
  // call failed with "task not found".
  const body = renderStoryInitCommentBody({
    storyId: 800,
    epicId: 900,
    storyBranch: 'story-800',
    epicBranch: 'epic/900',
    worktreeEnabled: true,
    workCwd: '/tmp/wt/story-800',
    worktreeCreated: true,
    dependenciesInstalled: 'true',
    installStatus: { status: 'installed' },
    tasks: [
      { id: 801, title: 'first', labels: [], dependencies: [] },
      { id: 802, title: 'second', labels: [], dependencies: [] },
    ],
  });
  const jsonBlock = body.match(/```json\n([\s\S]*?)\n```/)?.[1];
  const payload = JSON.parse(jsonBlock);
  assert.deepStrictEqual(payload.tasks, [
    { id: 801, title: 'first' },
    { id: 802, title: 'second' },
  ]);
});

test('renderStoryInitCommentBody coerces missing tasks to []', () => {
  const body = renderStoryInitCommentBody({
    storyId: 1,
    epicId: 2,
    storyBranch: 'story-1',
    epicBranch: 'epic/2',
    worktreeEnabled: false,
    workCwd: '/repo',
    worktreeCreated: false,
    dependenciesInstalled: 'skipped',
    installStatus: { status: 'skipped' },
    // tasks intentionally omitted
  });
  const jsonBlock = body.match(/```json\n([\s\S]*?)\n```/)?.[1];
  const payload = JSON.parse(jsonBlock);
  assert.deepStrictEqual(payload.tasks, []);
});

test('runStoryInit rejects an issue that is not a type::story', async () => {
  const story = {
    id: 42,
    title: 'not a story',
    labels: ['type::epic'],
    body: 'Epic: #1',
    state: 'open',
  };
  const provider = makePipelineProvider({ story, epic: {} });
  await assert.rejects(
    runStoryInit({
      storyId: 42,
      dryRun: true,
      injectedProvider: provider,
      injectedConfig: baseConfig(),
    }),
    /not a Story/,
  );
});
