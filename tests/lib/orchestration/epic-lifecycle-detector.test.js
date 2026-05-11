import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

// Even though `epic-lifecycle-detector.js` no longer imports `notify` (the
// `epic-complete` fire moved to `epic-deliver-finalize.js`, post-PR-create),
// we keep the module mock in place: it lets us observe regressions where
// the webhook leaks back into this code path. The `seen` array stays empty
// in the steady state — any push to it is a bug.
const notifyModuleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../../.agents/scripts/notify.js'),
).href;

const notifyCalls = [];
mock.module(notifyModuleUrl, {
  namedExports: {
    notify: async (...args) => {
      notifyCalls.push(args);
    },
  },
});

const { detectEpicCompletion } = await import(
  '../../../.agents/scripts/lib/orchestration/epic-lifecycle-detector.js'
);

function makeManifest() {
  return {
    summary: { progressPercent: 100 },
    generatedAt: '2026-04-20T00:00:00.000Z',
  };
}

test('detectEpicCompletion: no-op when tasks list is empty', async () => {
  const calls = [];
  const provider = { postComment: async (...a) => calls.push(a) };
  await detectEpicCompletion({
    epicId: 1,
    tasks: [],
    manifest: makeManifest(),
    provider,
    settings: {},
    dryRun: false,
  });
  assert.equal(calls.length, 0);
});

test('detectEpicCompletion: no-op when any task is not agent::done', async () => {
  const calls = [];
  const provider = { postComment: async (...a) => calls.push(a) };
  await detectEpicCompletion({
    epicId: 1,
    tasks: [
      { id: 1, title: 't1', status: 'agent::done' },
      { id: 2, title: 't2', status: 'agent::executing' },
    ],
    manifest: makeManifest(),
    provider,
    settings: {},
    dryRun: false,
  });
  assert.equal(calls.length, 0);
});

test('detectEpicCompletion: posts summary comment when every task is done', async () => {
  const calls = [];
  const provider = {
    postComment: async (id, opts) => calls.push({ id, opts }),
  };
  await detectEpicCompletion({
    epicId: 42,
    tasks: [
      { id: 1, title: 't1', status: 'agent::done' },
      { id: 2, title: 't2', status: 'agent::done' },
    ],
    manifest: makeManifest(),
    provider,
    settings: {},
    dryRun: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 42);
  assert.match(calls[0].opts.body, /Epic #42 Complete/);
  assert.match(calls[0].opts.body, /\/epic-deliver 42/);
});

test('detectEpicCompletion: dry-run skips posting', async () => {
  const calls = [];
  const provider = { postComment: async (...a) => calls.push(a) };
  await detectEpicCompletion({
    epicId: 1,
    tasks: [{ id: 1, title: 't', status: 'agent::done' }],
    manifest: makeManifest(),
    provider,
    settings: {},
    dryRun: true,
  });
  assert.equal(calls.length, 0);
});

test('detectEpicCompletion: never fires the epic-complete webhook (moved to PR-create)', async () => {
  // Regression guard for the duplicate-fire bug: the detector posts an
  // operator-visible comment on the Epic ticket but the webhook is owned
  // by `epic-deliver-finalize.js` after `gh pr create` succeeds. If the
  // detector imports `notify` again, this test catches it.
  notifyCalls.length = 0;
  const provider = { postComment: async () => {} };
  await detectEpicCompletion({
    epicId: 99,
    tasks: [{ id: 1, title: 't', status: 'agent::done' }],
    manifest: makeManifest(),
    provider,
    settings: {},
    dryRun: false,
  });
  assert.equal(
    notifyCalls.length,
    0,
    `notify must not be called from the legacy detector; got ${notifyCalls.length} calls`,
  );
});
