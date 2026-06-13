import assert from 'node:assert';
import { test } from 'node:test';
import { resolveContext } from '../../../.agents/scripts/lib/story-init/context-resolver.js';
import { composeStoryBody } from '../../../.agents/scripts/providers/github/tickets.js';

function makeProvider({ tickets = {}, onUpdate } = {}) {
  return {
    async getTicket(id) {
      if (tickets[id]) return tickets[id];
      throw new Error(`not found: #${id}`);
    },
    async updateTicket(id, patch) {
      if (onUpdate) onUpdate(id, patch);
    },
  };
}

test('resolveContext returns hierarchy for a valid Story body', async () => {
  const provider = makeProvider({
    tickets: {
      7: {
        id: 7,
        labels: ['type::story'],
        body: '---\nparent: #5\nEpic: #2',
        title: 'S',
      },
    },
  });
  const out = await resolveContext({
    provider,
    input: { storyId: 7 },
  });
  assert.strictEqual(out.epicId, 2);
  assert.strictEqual(out.parentId, 5);
  assert.strictEqual(out.story.id, 7);
});

test('resolveContext throws when issue is not a type::story', async () => {
  const provider = makeProvider({
    tickets: { 9: { id: 9, labels: ['type::epic'], body: '', title: 'E' } },
  });
  await assert.rejects(
    resolveContext({ provider, input: { storyId: 9 } }),
    /not a Story/,
  );
});

test('resolveContext throws when Epic reference is missing', async () => {
  const provider = makeProvider({
    tickets: {
      4: { id: 4, labels: ['type::story'], body: 'no epic', title: 'S' },
    },
  });
  await assert.rejects(
    resolveContext({ provider, input: { storyId: 4 } }),
    /Epic: #N/,
  );
});

// Story #4102 — a body produced by composeStoryBody for a directly-attached
// 2-tier Story (epicId === parentId) carries an `Epic: #N` line, so
// resolveContext must resolve the hierarchy rather than throw
// `has no "Epic: #N" reference`.
test('resolveContext resolves a directly-attached 2-tier Story body without throwing', async () => {
  const body = composeStoryBody({
    body: '# Story body',
    parentId: 23,
    epicId: 23,
    dependencies: [],
  });
  const provider = makeProvider({
    tickets: {
      23: { id: 23, labels: ['type::story'], body, title: 'S' },
    },
  });
  const out = await resolveContext({ provider, input: { storyId: 23 } });
  assert.strictEqual(out.epicId, 23);
  assert.strictEqual(out.parentId, 23);
});

test('resolveContext rejects self-referential recut', async () => {
  const provider = makeProvider({
    tickets: {
      8: { id: 8, labels: ['type::story'], body: 'Epic: #1', title: 'S' },
    },
  });
  await assert.rejects(
    resolveContext({ provider, input: { storyId: 8, recutOf: 8 } }),
    /cannot point at the Story itself/,
  );
});

test('resolveContext injects recut marker via provider.updateTicket when not dry-run', async () => {
  const updates = [];
  const provider = makeProvider({
    tickets: {
      3: { id: 3, labels: ['type::story'], body: 'Epic: #1', title: 'S' },
    },
    onUpdate: (id, patch) => updates.push({ id, patch }),
  });
  const logMessages = [];
  const out = await resolveContext({
    provider,
    logger: { progress: (p, m) => logMessages.push([p, m]) },
    input: { storyId: 3, recutOf: 11, dryRun: false },
  });
  assert.strictEqual(updates.length, 1);
  assert.ok(out.body.includes('recut-of'));
  assert.ok(logMessages.some(([p]) => p === 'RECUT'));
});

test('resolveContext dry-run skips provider.updateTicket', async () => {
  const updates = [];
  const provider = makeProvider({
    tickets: {
      3: { id: 3, labels: ['type::story'], body: 'Epic: #1', title: 'S' },
    },
    onUpdate: (id, patch) => updates.push({ id, patch }),
  });
  await resolveContext({
    provider,
    input: { storyId: 3, recutOf: 11, dryRun: true },
  });
  assert.strictEqual(updates.length, 0);
});
