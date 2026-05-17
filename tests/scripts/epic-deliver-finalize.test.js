/**
 * Unit tests for `epic-deliver-finalize.js` — Phase F of `/epic-deliver`.
 *
 * Story #1155 (Epic #1142, 5.40.0). Drives `runEpicDeliverFinalize` end-
 * to-end with stubbed:
 *   - `gitSpawn` (FF check + push)
 *   - `gh` invocation (PR create)
 *   - provider (`getTicket`, `postComment`)
 *   - `upsertStructuredComment` (hand-off)
 *
 * Coverage:
 *   - FF check: `main-ahead` halts before push.
 *   - Push failure halts before `gh pr create`.
 *   - `gh pr create` extracts the PR URL from stdout.
 *   - Hand-off comment is posted with the PR URL embedded.
 *   - Pure helpers (`buildPrTitle`, `buildPrBody`, `buildHandoffBody`,
 *     `buildPrCreateArgs`) produce stable output.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHandoffBody,
  buildPrBody,
  buildPrCreateArgs,
  buildPrTitle,
  checkEpicFastForward,
  classifyFinalizeInvocation,
  GH_SPAWN_USES_SHELL,
  runEpicDeliverFinalize,
} from '../../.agents/scripts/epic-deliver-finalize.js';

// Story #2117: stub reconcileBaselinesFn so the test never invokes the real
// `regenerateMainFromTree`. Without this, tests that progress past the FF
// check call into the real `saveBaseline` (cwd-relative) and silently mutate
// the workspace's `baselines/maintainability.json` under test concurrency.
const noopReconcile = async () => ({
  committed: false,
  didChange: false,
  reason: 'no-change',
});

test('classifyFinalizeInvocation: --help returns help intent', () => {
  assert.deepEqual(classifyFinalizeInvocation({ help: true }), {
    kind: 'help',
  });
});

test('classifyFinalizeInvocation: missing --epic returns usage-error', () => {
  const r = classifyFinalizeInvocation({});
  assert.equal(r.kind, 'usage-error');
  assert.ok(r.messages.some((m) => /required/.test(m)));
});

test('classifyFinalizeInvocation: non-positive --epic returns usage-error', () => {
  const a = classifyFinalizeInvocation({ epic: '0' });
  const b = classifyFinalizeInvocation({ epic: 'abc' });
  assert.equal(a.kind, 'usage-error');
  assert.equal(b.kind, 'usage-error');
});

test('classifyFinalizeInvocation: valid --epic returns run intent', () => {
  // Story #2204 (Epic #2173, AC-4): the `run` intent now carries
  // `fullScope: false` by default — diff-scope is the production default
  // and `--full-scope` is an explicit operator opt-in.
  assert.deepEqual(classifyFinalizeInvocation({ epic: '1178' }), {
    kind: 'run',
    epicId: 1178,
    fullScope: false,
  });
});

function makeGitSpawnFn(routes) {
  // routes is an ordered list of { matcher: (args) => bool, response }.
  const calls = [];
  const fn = (_cwd, ...args) => {
    calls.push(args);
    for (const route of routes) {
      if (route.matcher(args)) {
        return {
          status: route.response.status ?? 0,
          stdout: route.response.stdout ?? '',
          stderr: route.response.stderr ?? '',
        };
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { fn, calls };
}

test('buildPrTitle: strips a leading "Epic — " from the ticket title', () => {
  assert.equal(
    buildPrTitle({ id: 99, title: 'Epic — 5.40.0' }),
    'Epic #99: 5.40.0',
  );
});

test('buildPrTitle: handles empty titles', () => {
  assert.equal(buildPrTitle({ id: 99, title: '' }), 'Epic #99: Delivery');
});

test('buildPrCreateArgs: includes base, head, title, body in expected order', () => {
  const args = buildPrCreateArgs({
    epicId: 1142,
    title: 'T',
    body: 'B',
    baseBranch: 'main',
    epicBranch: 'epic/1142',
  });
  assert.deepEqual(args, [
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    'epic/1142',
    '--title',
    'T',
    '--body',
    'B',
  ]);
});

test('buildPrCreateArgs: preserves whitespace inside title and body as a single argv entry', () => {
  // Regression for the bug observed during Epic #1235 delivery: titles
  // like `Epic #1235: Hands-off PR pipeline` survive the args builder
  // intact (one argv entry per --title / --body). The real-world
  // breakage happened later in spawnSync when shell:true joined argv
  // with spaces and cmd.exe re-tokenized — see GH_SPAWN_USES_SHELL.
  const args = buildPrCreateArgs({
    epicId: 1235,
    title: 'Epic #1235: Hands-off PR pipeline + bot approver',
    body: 'Closes #1235\n\nLine with spaces.',
    baseBranch: 'main',
    epicBranch: 'epic/1235',
  });
  const titleIdx = args.indexOf('--title');
  const bodyIdx = args.indexOf('--body');
  assert.equal(
    args[titleIdx + 1],
    'Epic #1235: Hands-off PR pipeline + bot approver',
  );
  assert.equal(args[bodyIdx + 1], 'Closes #1235\n\nLine with spaces.');
});

test('GH_SPAWN_USES_SHELL is false (Windows argv-shred regression)', () => {
  // The Epic #1235 finalize step failed because the default ghSpawn was
  // configured with shell:true on Windows — Node concatenates argv with
  // spaces, cmd.exe re-tokenizes the result, and `gh pr create` rejects
  // the shredded title with "unknown arguments [...]". The contract: the
  // default ghSpawn MUST NOT use shell mode so spawnSync quotes argv on
  // Windows itself. This guard locks the contract.
  assert.equal(GH_SPAWN_USES_SHELL, false);
});

test('buildPrBody: contains Closes #<epicId> trailer', () => {
  const body = buildPrBody({
    epicId: 1142,
    epicTitle: 'Foo',
    baseBranch: 'main',
    epicBranch: 'epic/1142',
  });
  assert.match(body, /Closes #1142/);
  assert.match(body, /epic\/1142/);
});

test('buildHandoffBody: links the PR URL when supplied', () => {
  const body = buildHandoffBody({
    epicId: 1142,
    prUrl: 'https://github.com/x/y/pull/9',
  });
  assert.match(body, /https:\/\/github\.com\/x\/y\/pull\/9/);
  assert.match(body, /Merge this PR/);
});

test('checkEpicFastForward: ok when base is an ancestor of epic', () => {
  const { fn, calls } = makeGitSpawnFn([
    { matcher: (args) => args[0] === 'merge-base', response: { status: 0 } },
    {
      matcher: (args) => args[0] === 'rev-list',
      response: { status: 0, stdout: '4\n' },
    },
  ]);
  const out = checkEpicFastForward({
    cwd: '.',
    epicBranch: 'epic/1',
    baseRef: 'origin/main',
    gitSpawnFn: fn,
  });
  assert.deepEqual(out, { ok: true, ahead: 4 });
  assert.equal(calls.length, 2);
});

test('checkEpicFastForward: main-ahead when merge-base reports non-ancestor', () => {
  const { fn } = makeGitSpawnFn([
    { matcher: (args) => args[0] === 'merge-base', response: { status: 1 } },
  ]);
  const out = checkEpicFastForward({
    cwd: '.',
    epicBranch: 'epic/1',
    baseRef: 'origin/main',
    gitSpawnFn: fn,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'main-ahead');
});

test('runEpicDeliverFinalize: halts on FF=main-ahead before pushing', async () => {
  const provider = {
    async getTicket() {
      return { id: 7, title: 'X' };
    },
  };
  const { fn: gitSpawnFn } = makeGitSpawnFn([
    // fetch
    { matcher: (args) => args[0] === 'fetch', response: { status: 0 } },
    // merge-base --is-ancestor → 1 (main-ahead)
    { matcher: (args) => args[0] === 'merge-base', response: { status: 1 } },
  ]);
  const ghCalls = [];
  const out = await runEpicDeliverFinalize({
    epicId: 7,
    cwd: '.',
    injectedProvider: provider,
    injectedConfig: {
      agentSettings: { baseBranch: 'main' },
      orchestration: {},
    },
    loggerImpl: { info: () => {}, warn: () => {}, error: () => {} },
    reconcileBaselinesFn: noopReconcile,
    gitSpawnFn,
    ghSpawnFn: (args) => {
      ghCalls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
    upsertCommentFn: async () => ({ commentId: 1 }),
  });
  assert.equal(out.ffOk, false);
  assert.equal(out.pushed, false);
  assert.equal(out.blocker.reason, 'main-ahead');
  assert.equal(ghCalls.length, 0, 'gh should not be called when FF fails');
});

test('runEpicDeliverFinalize: happy path runs FF + push + gh + hand-off + epic-complete fire', async () => {
  const ticketCalls = [];
  const upsertCalls = [];
  const notifyCalls = [];
  const provider = {
    async getTicket(id) {
      ticketCalls.push(id);
      return { id, title: 'Test Title' };
    },
  };
  const { fn: gitSpawnFn, calls: gitCalls } = makeGitSpawnFn([
    { matcher: (args) => args[0] === 'fetch', response: { status: 0 } },
    { matcher: (args) => args[0] === 'merge-base', response: { status: 0 } },
    {
      matcher: (args) => args[0] === 'rev-list',
      response: { status: 0, stdout: '3' },
    },
    {
      matcher: (args) => args[0] === 'push',
      response: { status: 0, stdout: '' },
    },
  ]);
  const ghCalls = [];
  const out = await runEpicDeliverFinalize({
    epicId: 1142,
    cwd: '.',
    injectedProvider: provider,
    injectedConfig: {
      agentSettings: { baseBranch: 'main' },
      orchestration: {},
    },
    loggerImpl: { info: () => {}, warn: () => {}, error: () => {} },
    reconcileBaselinesFn: noopReconcile,
    gitSpawnFn,
    ghSpawnFn: (args) => {
      ghCalls.push(args);
      return {
        status: 0,
        stdout: 'https://github.com/me/repo/pull/55\n',
        stderr: '',
      };
    },
    upsertCommentFn: async (_provider, ticketId, type, body) => {
      upsertCalls.push({ ticketId, type, body });
      return { commentId: 99 };
    },
    notifyFn: (ticketId, payload, opts) => {
      notifyCalls.push({ ticketId, payload, opts });
      return Promise.resolve();
    },
    reconcileAcceptanceSpecFn: async () => ({ ok: true, status: 'waived' }),
  });

  assert.equal(out.ffOk, true);
  assert.equal(out.pushed, true);
  assert.equal(out.prUrl, 'https://github.com/me/repo/pull/55');
  assert.equal(out.prNumber, 55);
  assert.equal(out.postedHandoff, true);
  // Story #2253 (Epic #2172 review High-1): `autoMergeEnabled` is no
  // longer on the envelope. Auto-merge enablement lives on the
  // lifecycle bus (`AutomergeArmer`, Story #2256). Pin its absence so
  // a future regression that re-adds the field gets flagged.
  assert.equal(out.autoMergeEnabled, undefined);
  assert.equal(ticketCalls[0], 1142);

  // gh should have been invoked EXACTLY ONCE: to create the PR. The
  // legacy second call (`gh pr merge --auto --squash --delete-branch`)
  // was deleted in Story #2253 — armed auto-merge is now the
  // AutomergeArmer listener's job, gated on predicate pass.
  assert.equal(ghCalls.length, 1);
  const ghArgs = ghCalls[0];
  assert.equal(ghArgs[0], 'pr');
  assert.equal(ghArgs[1], 'create');
  const baseIdx = ghArgs.indexOf('--base');
  assert.equal(ghArgs[baseIdx + 1], 'main');
  const headIdx = ghArgs.indexOf('--head');
  assert.equal(ghArgs[headIdx + 1], 'epic/1142');

  // The hand-off comment must carry the PR URL.
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].ticketId, 1142);
  assert.match(upsertCalls[0].body, /pull\/55/);

  // Push must have been called against epic/1142.
  const pushCall = gitCalls.find((c) => c[0] === 'push');
  assert.deepEqual(pushCall, ['push', 'origin', 'epic/1142']);

  // The single `epic-complete` webhook fires here, AFTER `gh pr create`
  // succeeded and the PR URL is in hand. The payload carries the URL so
  // operators can click straight from the notification.
  const epicCompleteCalls = notifyCalls.filter(
    (c) => c.payload?.event === 'epic-complete',
  );
  assert.equal(
    epicCompleteCalls.length,
    1,
    'expected exactly one epic-complete fire',
  );
  assert.equal(epicCompleteCalls[0].ticketId, 1142);
  assert.equal(
    epicCompleteCalls[0].payload.prUrl,
    'https://github.com/me/repo/pull/55',
  );
  assert.match(
    epicCompleteCalls[0].payload.message,
    /pull\/55/,
    'epic-complete message should embed the PR URL',
  );
});

test('runEpicDeliverFinalize: does NOT invoke `gh pr merge` (auto-merge lockout, Story #2253 review High-1)', async () => {
  // Regression guard for Epic #2172 Story #2253: the unconditional
  // `gh pr merge <pr> --auto --squash --delete-branch` call was the
  // safety hole this Story closes. Auto-merge enablement now flows
  // through the lifecycle bus (`AutomergeArmer`, Story #2256) only
  // after blocker / review predicates pass. Pin the deletion by
  // counting gh invocations and rejecting any `pr merge` argv.
  const provider = {
    async getTicket(id) {
      return { id, title: 'X' };
    },
  };
  const { fn: gitSpawnFn } = makeGitSpawnFn([
    { matcher: (args) => args[0] === 'fetch', response: { status: 0 } },
    { matcher: (args) => args[0] === 'merge-base', response: { status: 0 } },
    {
      matcher: (args) => args[0] === 'rev-list',
      response: { status: 0, stdout: '3' },
    },
    { matcher: (args) => args[0] === 'push', response: { status: 0 } },
  ]);
  const ghArgvLog = [];
  const out = await runEpicDeliverFinalize({
    epicId: 1142,
    cwd: '.',
    injectedProvider: provider,
    injectedConfig: {
      agentSettings: { baseBranch: 'main' },
      orchestration: {},
    },
    loggerImpl: { info: () => {}, warn: () => {}, error: () => {} },
    reconcileBaselinesFn: noopReconcile,
    gitSpawnFn,
    ghSpawnFn: (args) => {
      ghArgvLog.push(args);
      // pr create succeeds.
      return {
        status: 0,
        stdout: 'https://github.com/me/repo/pull/55\n',
        stderr: '',
      };
    },
    upsertCommentFn: async () => ({ commentId: 99 }),
    notifyFn: () => Promise.resolve(),
    reconcileAcceptanceSpecFn: async () => ({ ok: true, status: 'waived' }),
  });

  assert.equal(out.ffOk, true);
  assert.equal(out.pushed, true);
  assert.equal(out.prUrl, 'https://github.com/me/repo/pull/55');
  assert.equal(out.postedHandoff, true);
  // The envelope no longer carries `autoMergeEnabled` (the field is
  // gone with the deletion).
  assert.equal(out.autoMergeEnabled, undefined);
  // gh CLI invoked exactly once and ONLY for `pr create`.
  assert.equal(ghArgvLog.length, 1);
  assert.equal(ghArgvLog[0][1], 'create');
  for (const argv of ghArgvLog) {
    assert.ok(
      !(argv[0] === 'pr' && argv[1] === 'merge'),
      `auto-merge call must not be invoked: saw ${JSON.stringify(argv)}`,
    );
  }
});

test('runEpicDeliverFinalize: epic-complete is NOT fired when FF blocks before PR open', async () => {
  // The whole point of moving the fire to the post-PR-create boundary is
  // that operators stop getting "Epic complete" notifications with no PR
  // to click. If finalize halts at the FF check, no PR exists yet, so
  // no fire.
  const provider = {
    async getTicket() {
      return { id: 7, title: 'X' };
    },
  };
  const { fn: gitSpawnFn } = makeGitSpawnFn([
    { matcher: (args) => args[0] === 'fetch', response: { status: 0 } },
    { matcher: (args) => args[0] === 'merge-base', response: { status: 1 } },
  ]);
  const notifyCalls = [];
  const out = await runEpicDeliverFinalize({
    epicId: 7,
    cwd: '.',
    injectedProvider: provider,
    injectedConfig: {
      agentSettings: { baseBranch: 'main' },
      orchestration: {},
    },
    loggerImpl: { info: () => {}, warn: () => {}, error: () => {} },
    reconcileBaselinesFn: noopReconcile,
    gitSpawnFn,
    ghSpawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
    upsertCommentFn: async () => ({ commentId: 1 }),
    notifyFn: (ticketId, payload, opts) => {
      notifyCalls.push({ ticketId, payload, opts });
      return Promise.resolve();
    },
  });
  assert.equal(out.ffOk, false);
  const epicCompleteCalls = notifyCalls.filter(
    (c) => c.payload?.event === 'epic-complete',
  );
  assert.equal(
    epicCompleteCalls.length,
    0,
    'epic-complete must not fire when the PR was never opened',
  );
});

test('runEpicDeliverFinalize: gh failure halts before hand-off', async () => {
  const provider = {
    async getTicket() {
      return { id: 8, title: 'X' };
    },
  };
  const { fn: gitSpawnFn } = makeGitSpawnFn([
    { matcher: (args) => args[0] === 'fetch', response: { status: 0 } },
    { matcher: (args) => args[0] === 'merge-base', response: { status: 0 } },
    {
      matcher: (args) => args[0] === 'rev-list',
      response: { status: 0, stdout: '1' },
    },
    { matcher: (args) => args[0] === 'push', response: { status: 0 } },
  ]);
  let upsertCalled = false;
  const out = await runEpicDeliverFinalize({
    epicId: 8,
    cwd: '.',
    injectedProvider: provider,
    injectedConfig: {
      agentSettings: { baseBranch: 'main' },
      orchestration: {},
    },
    loggerImpl: { info: () => {}, warn: () => {}, error: () => {} },
    reconcileBaselinesFn: noopReconcile,
    gitSpawnFn,
    ghSpawnFn: () => ({ status: 1, stdout: '', stderr: 'gh: forbidden' }),
    upsertCommentFn: async () => {
      upsertCalled = true;
      return { commentId: 1 };
    },
  });
  assert.equal(out.prUrl, null);
  assert.equal(out.postedHandoff, false);
  assert.equal(out.blocker.reason, 'pr-create-failed');
  assert.equal(upsertCalled, false);
});

test('runEpicDeliverFinalize: rejects missing/invalid epicId', async () => {
  await assert.rejects(() => runEpicDeliverFinalize({}), /positive integer/);
  await assert.rejects(
    () => runEpicDeliverFinalize({ epicId: 0 }),
    /positive integer/,
  );
});

test('runEpicDeliverFinalize: closes planning artifacts after gh pr create succeeds (Story #1951)', async () => {
  // Verifies the new 3b phase: the Epic's linked PRD and Tech Spec are
  // closed via the injected `closePlanningArtifactsFn` after the PR is
  // opened, and the result is surfaced in the envelope as `planningClose`.
  const provider = {
    async getEpic(id) {
      return {
        id,
        title: 'Test Epic',
        linkedIssues: { prd: 9001, techSpec: 9002 },
      };
    },
    async getTicket(id) {
      return { id, title: 'fallback' };
    },
  };
  const { fn: gitSpawnFn } = makeGitSpawnFn([
    { matcher: (args) => args[0] === 'fetch', response: { status: 0 } },
    { matcher: (args) => args[0] === 'merge-base', response: { status: 0 } },
    {
      matcher: (args) => args[0] === 'rev-list',
      response: { status: 0, stdout: '1' },
    },
    { matcher: (args) => args[0] === 'push', response: { status: 0 } },
  ]);
  const planningCalls = [];
  const closePlanningArtifactsFn = async ({ epicId, epic, provider: p }) => {
    planningCalls.push({
      epicId,
      prd: epic?.linkedIssues?.prd,
      hasProvider: !!p,
    });
    return {
      prd: { id: 9001, status: 'closed' },
      techSpec: { id: 9002, status: 'closed' },
    };
  };
  const out = await runEpicDeliverFinalize({
    epicId: 1942,
    cwd: '.',
    injectedProvider: provider,
    injectedConfig: {
      agentSettings: { baseBranch: 'main' },
      orchestration: {},
    },
    loggerImpl: { info: () => {}, warn: () => {}, error: () => {} },
    reconcileBaselinesFn: noopReconcile,
    gitSpawnFn,
    ghSpawnFn: () => ({
      status: 0,
      stdout: 'https://github.com/me/repo/pull/123\n',
      stderr: '',
    }),
    upsertCommentFn: async () => ({ commentId: 1 }),
    notifyFn: () => Promise.resolve(),
    closePlanningArtifactsFn,
    reconcileAcceptanceSpecFn: async () => ({ ok: true, status: 'waived' }),
  });

  assert.equal(planningCalls.length, 1);
  assert.equal(planningCalls[0].epicId, 1942);
  assert.equal(planningCalls[0].prd, 9001);
  assert.equal(planningCalls[0].hasProvider, true);
  assert.deepEqual(out.planningClose, {
    prd: { id: 9001, status: 'closed' },
    techSpec: { id: 9002, status: 'closed' },
  });
});

test('runEpicDeliverFinalize: planning-close partial failure does not block finalize', async () => {
  // PRD closes ok, Tech Spec transition throws — finalize must still
  // succeed and report `planningClose.techSpec.status === 'failed'`.
  const provider = {
    async getEpic(id) {
      return { id, linkedIssues: { prd: 9001, techSpec: 9002 } };
    },
  };
  const { fn: gitSpawnFn } = makeGitSpawnFn([
    { matcher: (args) => args[0] === 'fetch', response: { status: 0 } },
    { matcher: (args) => args[0] === 'merge-base', response: { status: 0 } },
    {
      matcher: (args) => args[0] === 'rev-list',
      response: { status: 0, stdout: '1' },
    },
    { matcher: (args) => args[0] === 'push', response: { status: 0 } },
  ]);
  const closePlanningArtifactsFn = async () => ({
    prd: { id: 9001, status: 'closed' },
    techSpec: { id: 9002, status: 'failed', detail: 'transient gh 500' },
  });
  const out = await runEpicDeliverFinalize({
    epicId: 1942,
    cwd: '.',
    injectedProvider: provider,
    injectedConfig: {
      agentSettings: { baseBranch: 'main' },
      orchestration: {},
    },
    loggerImpl: { info: () => {}, warn: () => {}, error: () => {} },
    reconcileBaselinesFn: noopReconcile,
    gitSpawnFn,
    ghSpawnFn: () => ({
      status: 0,
      stdout: 'https://github.com/me/repo/pull/123\n',
      stderr: '',
    }),
    upsertCommentFn: async () => ({ commentId: 1 }),
    notifyFn: () => Promise.resolve(),
    closePlanningArtifactsFn,
    reconcileAcceptanceSpecFn: async () => ({ ok: true, status: 'waived' }),
  });

  assert.equal(out.pushed, true);
  assert.equal(out.prUrl, 'https://github.com/me/repo/pull/123');
  assert.equal(out.postedHandoff, true);
  assert.equal(out.blocker, undefined);
  assert.equal(out.planningClose.techSpec.status, 'failed');
});

// ────────────────────────────────────────────────────────────────────────
// Story #2106 / Task #2111 — acceptance-spec reconciliation wiring.
// ────────────────────────────────────────────────────────────────────────

/**
 * Spin up the minimal stub graph needed to drive `runEpicDeliverFinalize`
 * past the FF + push + gh stages so the reconciler call site is reachable.
 */
function buildReconcilerHarness({ reconcileFn, closeFn }) {
  const provider = {
    async getEpic(id) {
      return { id, linkedIssues: { prd: 9001, techSpec: 9002 } };
    },
    async getTicket(id) {
      return { id, title: 'X' };
    },
  };
  const { fn: gitSpawnFn } = makeGitSpawnFn([
    { matcher: (args) => args[0] === 'fetch', response: { status: 0 } },
    { matcher: (args) => args[0] === 'merge-base', response: { status: 0 } },
    {
      matcher: (args) => args[0] === 'rev-list',
      response: { status: 0, stdout: '1' },
    },
    { matcher: (args) => args[0] === 'push', response: { status: 0 } },
  ]);
  return {
    provider,
    gitSpawnFn,
    invocation: {
      epicId: 1942,
      cwd: '.',
      injectedProvider: provider,
      injectedConfig: {
        agentSettings: { baseBranch: 'main' },
        orchestration: {},
      },
      loggerImpl: { info: () => {}, warn: () => {}, error: () => {} },
      gitSpawnFn,
      ghSpawnFn: () => ({
        status: 0,
        stdout: 'https://github.com/me/repo/pull/123\n',
        stderr: '',
      }),
      upsertCommentFn: async () => ({ commentId: 1 }),
      notifyFn: () => Promise.resolve(),
      closePlanningArtifactsFn: closeFn,
      reconcileAcceptanceSpecFn: reconcileFn,
    },
  };
}

test('runEpicDeliverFinalize: aborts when reconciler throws (missing/pending ACs)', async () => {
  // Task #2111 AC: "Finalize aborts with the reconciler's error message
  // when missing or pending ACs exist." The reconciler throws an Error
  // per .agents/rules/orchestration-error-handling.md; that throw must
  // propagate out of `runEpicDeliverFinalize` (so the `runAsCli` boundary
  // maps it to exit 1) and `closePlanningArtifacts` MUST NOT be called
  // (planning artifacts stay open until the AC coverage gap is fixed).
  let closeCalls = 0;
  const reconcileFn = async () => {
    throw new Error(
      '[acceptance-spec-reconciler] Epic #1942 cannot finalize: missing AC-3',
    );
  };
  const closeFn = async () => {
    closeCalls += 1;
    return {
      prd: { id: 9001, status: 'closed' },
      techSpec: { id: 9002, status: 'closed' },
    };
  };
  const { invocation } = buildReconcilerHarness({ reconcileFn, closeFn });
  await assert.rejects(
    () => runEpicDeliverFinalize(invocation),
    /Epic #1942 cannot finalize: missing AC-3/,
  );
  assert.equal(
    closeCalls,
    0,
    'closePlanningArtifacts must not run when the reconciler throws',
  );
});

test('runEpicDeliverFinalize: proceeds normally when reconciler reports ok=true', async () => {
  // Task #2111 AC: "Finalize proceeds normally when reconciler reports
  // ok true." A passing reconciliation must let `closePlanningArtifacts`
  // fire and the result envelope must report a clean finalize.
  const reconcileCalls = [];
  let closeCalls = 0;
  const reconcileFn = async (args) => {
    reconcileCalls.push(args);
    return {
      ok: true,
      status: 'ok',
      epicId: 1942,
      acceptanceSpecId: 9500,
      acIds: ['AC-1'],
      satisfied: ['AC-1'],
      pending: [],
      missing: [],
      featureFilesScanned: 1,
    };
  };
  const closeFn = async () => {
    closeCalls += 1;
    return {
      prd: { id: 9001, status: 'closed' },
      techSpec: { id: 9002, status: 'closed' },
    };
  };
  const { invocation } = buildReconcilerHarness({ reconcileFn, closeFn });
  const out = await runEpicDeliverFinalize(invocation);
  assert.equal(reconcileCalls.length, 1);
  assert.equal(reconcileCalls[0].epicId, 1942);
  assert.equal(closeCalls, 1);
  assert.equal(out.pushed, true);
  assert.equal(out.prUrl, 'https://github.com/me/repo/pull/123');
  assert.equal(out.blocker, undefined);
});

test('runEpicDeliverFinalize: reconciler short-circuits with status=waived under acceptance::n-a', async () => {
  // Task #2111 AC: "Finalize skips reconciler entirely when Epic has
  // acceptance::n-a label." The skip is enforced **inside** the
  // reconciler (it returns `status: 'waived'` without scanning features)
  // rather than at the finalize call site so the wiring stays simple:
  // finalize always invokes the reconciler and trusts it to no-op on the
  // waiver. The test asserts that the reconciler is still invoked once
  // (so the waiver decision is logged/observable) and that
  // `closePlanningArtifacts` still runs.
  let reconcileCalls = 0;
  let closeCalls = 0;
  const reconcileFn = async () => {
    reconcileCalls += 1;
    return { ok: true, status: 'waived' };
  };
  const closeFn = async () => {
    closeCalls += 1;
    return {
      prd: { id: 9001, status: 'closed' },
      techSpec: { id: 9002, status: 'closed' },
    };
  };
  const { invocation } = buildReconcilerHarness({ reconcileFn, closeFn });
  const out = await runEpicDeliverFinalize(invocation);
  assert.equal(reconcileCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(out.blocker, undefined);
});
