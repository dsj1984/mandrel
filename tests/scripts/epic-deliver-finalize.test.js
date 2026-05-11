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
  GH_SPAWN_USES_SHELL,
  runEpicDeliverFinalize,
} from '../../.agents/scripts/epic-deliver-finalize.js';

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
  });

  assert.equal(out.ffOk, true);
  assert.equal(out.pushed, true);
  assert.equal(out.prUrl, 'https://github.com/me/repo/pull/55');
  assert.equal(out.prNumber, 55);
  assert.equal(out.postedHandoff, true);
  assert.equal(out.autoMergeEnabled, true);
  assert.equal(ticketCalls[0], 1142);

  // gh should have been invoked twice: once to create the PR, then again
  // to enable native auto-merge with --auto --squash --delete-branch.
  assert.equal(ghCalls.length, 2);
  const ghArgs = ghCalls[0];
  assert.equal(ghArgs[0], 'pr');
  assert.equal(ghArgs[1], 'create');
  const baseIdx = ghArgs.indexOf('--base');
  assert.equal(ghArgs[baseIdx + 1], 'main');
  const headIdx = ghArgs.indexOf('--head');
  assert.equal(ghArgs[headIdx + 1], 'epic/1142');

  // The second call enables native auto-merge on the PR just opened.
  const autoMergeArgs = ghCalls[1];
  assert.deepEqual(autoMergeArgs, [
    'pr',
    'merge',
    '55',
    '--auto',
    '--squash',
    '--delete-branch',
  ]);

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

test('runEpicDeliverFinalize: auto-merge enablement failure is non-fatal (finalize still succeeds)', async () => {
  // `gh pr merge --auto` may fail for benign reasons — repo without
  // auto-merge enabled, token missing scope, etc. The finalize result
  // must still report success and post the hand-off so the operator can
  // merge through the GitHub UI; only autoMergeEnabled flips to false.
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
  let ghCallIdx = 0;
  const out = await runEpicDeliverFinalize({
    epicId: 1142,
    cwd: '.',
    injectedProvider: provider,
    injectedConfig: {
      agentSettings: { baseBranch: 'main' },
      orchestration: {},
    },
    loggerImpl: { info: () => {}, warn: () => {}, error: () => {} },
    gitSpawnFn,
    ghSpawnFn: () => {
      ghCallIdx += 1;
      if (ghCallIdx === 1) {
        // pr create succeeds
        return {
          status: 0,
          stdout: 'https://github.com/me/repo/pull/55\n',
          stderr: '',
        };
      }
      // pr merge --auto fails
      return {
        status: 1,
        stdout: '',
        stderr: 'Pull request is not in a mergeable state.',
      };
    },
    upsertCommentFn: async () => ({ commentId: 99 }),
    notifyFn: () => Promise.resolve(),
  });

  assert.equal(out.ffOk, true);
  assert.equal(out.pushed, true);
  assert.equal(out.prUrl, 'https://github.com/me/repo/pull/55');
  assert.equal(out.postedHandoff, true);
  assert.equal(
    out.autoMergeEnabled,
    false,
    'auto-merge enablement failure should surface as autoMergeEnabled:false but not block finalize',
  );
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
