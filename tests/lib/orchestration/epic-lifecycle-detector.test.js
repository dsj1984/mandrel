import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const notifyModuleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../../.agents/scripts/notify.js'),
).href;

mock.module(notifyModuleUrl, {
  namedExports: {
    notify: async () => {},
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
  assert.match(calls[0].opts.body, /\/epic-close 42/);
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
