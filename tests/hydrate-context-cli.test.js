import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runHydrateContext,
  ticketToTask,
} from '../.agents/scripts/hydrate-context.js';
import {
  getEpicBranch,
  getStoryBranch,
} from '../.agents/scripts/lib/git-utils.js';
import { hydrateContext } from '../.agents/scripts/lib/orchestration/context-hydration-engine.js';

class MockProvider {
  constructor() {
    this.calls = [];
  }
  async getTicket(id) {
    this.calls.push(id);
    if (id === 99) {
      return {
        id: 99,
        title: 'Fix issue',
        body: '> Epic: #1 | Feature: #2\n\nFix the bug',
        labels: ['persona::engineer'],
      };
    }
    if (id === 100) {
      return {
        id: 100,
        title: 'Task on parent story',
        body: '> Epic: #1 | parent: #99\n\nFix the child task',
        labels: [],
      };
    }
    if (id === 1) return { id: 1, title: 'Epic', body: 'Epic Body' };
    if (id === 2) return { id: 2, title: 'Feature', body: 'Feature Body' };
    throw new Error(`Ticket #${id} not found`);
  }
}

test('ticketToTask: extracts persona from labels', () => {
  const task = ticketToTask({
    id: 5,
    title: 'T',
    body: 'b',
    labels: ['persona::reviewer', 'skill::audit-architecture', 'type::task'],
  });
  assert.equal(task.persona, 'reviewer');
  assert.deepEqual(task.skills, ['audit-architecture']);
});

test('runHydrateContext: emits the same { prompt } envelope as the MCP tool', async () => {
  const provider = new MockProvider();
  const envelope = await runHydrateContext({
    ticketId: 99,
    epicId: 1,
    provider,
  });
  assert.ok('prompt' in envelope, 'envelope has prompt key');
  assert.equal(Object.keys(envelope).length, 1, 'envelope has exactly one key');
  assert.equal(typeof envelope.prompt, 'string');
});

test('runHydrateContext: prompt matches direct SDK invocation byte-for-byte', async () => {
  const cliProvider = new MockProvider();
  const sdkProvider = new MockProvider();

  const { prompt: cliPrompt } = await runHydrateContext({
    ticketId: 99,
    epicId: 1,
    provider: cliProvider,
  });

  // Direct SDK call with the exact arguments the CLI assembles.
  const ticket = await sdkProvider.getTicket(99);
  const sdkPrompt = await hydrateContext(
    ticketToTask({ ...ticket, id: 99 }),
    sdkProvider,
    getEpicBranch(1),
    getStoryBranch(1, 99),
    1,
  );

  assert.equal(cliPrompt, sdkPrompt);
});

test('runHydrateContext: resolves epic id from body when --epic omitted', async () => {
  const provider = new MockProvider();
  const envelope = await runHydrateContext({ ticketId: 99, provider });
  assert.ok(envelope.prompt.includes('Fix the bug'));
});

test('runHydrateContext: resolves story branch from parent marker', async () => {
  const provider = new MockProvider();
  const envelope = await runHydrateContext({
    ticketId: 100,
    epicId: 1,
    provider,
  });
  assert.ok(envelope.prompt.includes('story-99'));
});

test('runHydrateContext: throws when epic cannot be resolved', async () => {
  const provider = {
    async getTicket(_id) {
      return {
        id: 50,
        title: 'No epic',
        body: 'no hierarchy here',
        labels: [],
      };
    },
  };
  await assert.rejects(
    runHydrateContext({ ticketId: 50, provider }),
    /Could not resolve epic id/,
  );
});

test('hydrateContext: surfaces a failure marker when a hierarchy fetch rejects (failure-signal preservation)', async () => {
  // Story #1001 Task #1012: the hierarchy fetch used to swallow errors with
  // `.catch(() => '')`, leaving the prompt silently incomplete. The new
  // contract emits an `⚠️ unavailable` marker so the agent can see the gap.
  const seen = [];
  const provider = {
    async getTicket(id) {
      seen.push(id);
      if (id === 200) {
        // The "task" itself hydrates fine.
        return {
          id: 200,
          title: 'Child task',
          body: '> Epic: #1\n\nTask body',
          labels: [],
        };
      }
      if (id === 1) {
        // Epic fetch fails — simulates a 403 / 5xx.
        throw new Error('rate limit exceeded');
      }
      throw new Error(`unexpected id #${id}`);
    },
  };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const prompt = await hydrateContext(
      ticketToTask({
        id: 200,
        title: 'Child task',
        body: '> Epic: #1\n\nTask body',
        labels: [],
      }),
      provider,
      'epic/1',
      'story-1',
      1,
    );
    assert.match(
      prompt,
      /Epic: #1 — ⚠️ unavailable \(fetch failed: rate limit exceeded\)/,
      'prompt should carry the failure marker for the missing hierarchy ticket',
    );
    assert.ok(
      warnings.some((w) =>
        /\[Hydrator\] hierarchy fetch failed for Epic #1: rate limit exceeded/.test(
          w,
        ),
      ),
      'a stderr warn must surface the hierarchy-fetch failure',
    );
  } finally {
    console.warn = originalWarn;
  }
});
