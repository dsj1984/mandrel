/**
 * Integration tests for `runCodeReview()` + provider chain — Story #2871.
 *
 * Verifies:
 *   - When the factory returns a `ChainProvider`, the orchestrator
 *     feature-detects `getPromptMessages()` and renders a trailing
 *     "Manual Review Suggestions" section in the structured comment.
 *   - Manual-prompt messages do NOT affect severity counts or
 *     `halted` on the result envelope.
 *   - The orchestrator passes `labels` (default []) on ReviewInput so
 *     chain gates can evaluate against the ticket's label set.
 *   - Critical findings emitted by ANY inline provider in the chain
 *     trigger the halt gate.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runCodeReview } from '../../../.agents/scripts/lib/orchestration/code-review.js';
import { createChainProvider } from '../../../.agents/scripts/lib/orchestration/review-providers/review-provider-factory.js';

const stubBus = { emit: async () => {} };
function noopUpsert() {
  return async () => {};
}
function recordingUpsert() {
  const calls = [];
  return {
    calls,
    fn: async (...args) => {
      calls.push(args);
    },
  };
}
function baseConfig() {
  return {
    project: { baseBranch: 'main' },
    delivery: { codeReview: { provider: 'native' } },
  };
}

test('runCodeReview: chain provider with prompt → comment body contains suggestions section', async () => {
  const chain = createChainProvider({
    inline: [
      {
        name: 'fake',
        provider: {
          runReview: async () => [
            { severity: 'medium', title: 't', body: 'b' },
          ],
        },
        gate: () => true,
      },
    ],
    prompts: [
      {
        name: 'prompty',
        provider: {
          renderPrompt: async () => ({
            message: 'consider running /ultrareview',
          }),
        },
        gate: () => true,
      },
    ],
  });
  const upsert = recordingUpsert();
  const out = await runCodeReview({
    epicId: 42,
    provider: {},
    bus: stubBus,
    reviewProvider: chain,
    resolveConfigFn: baseConfig,
    upsertCommentFn: upsert.fn,
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.halted, false);
  // Manual-prompt content does NOT change the severity totals.
  assert.deepEqual(out.severity, {
    critical: 0,
    high: 0,
    medium: 1,
    suggestion: 0,
  });
  const [, , , body] = upsert.calls[0];
  assert.match(body, /Manual Review Suggestions/);
  assert.match(body, /consider running \/ultrareview/);
});

test('runCodeReview: empty prompt list omits the suggestions section', async () => {
  const chain = createChainProvider({
    inline: [
      {
        name: 'fake',
        provider: { runReview: async () => [] },
        gate: () => true,
      },
    ],
    prompts: [],
  });
  const upsert = recordingUpsert();
  await runCodeReview({
    epicId: 42,
    provider: {},
    bus: stubBus,
    reviewProvider: chain,
    resolveConfigFn: baseConfig,
    upsertCommentFn: upsert.fn,
  });
  const [, , , body] = upsert.calls[0];
  assert.doesNotMatch(body, /Manual Review Suggestions/);
});

test('runCodeReview: ticketLabels opt is forwarded into ReviewInput.labels', async () => {
  const seen = [];
  const adapter = {
    runReview: async (input) => {
      seen.push(input.labels);
      return [];
    },
  };
  await runCodeReview({
    epicId: 42,
    provider: {},
    bus: stubBus,
    reviewProvider: adapter,
    resolveConfigFn: baseConfig,
    upsertCommentFn: noopUpsert(),
    ticketLabels: ['risk::high', 'persona::engineer'],
  });
  assert.deepEqual(seen[0], ['risk::high', 'persona::engineer']);
});

test('runCodeReview: chain critical finding triggers halted=true', async () => {
  const chain = createChainProvider({
    inline: [
      {
        name: 'a',
        provider: { runReview: async () => [] },
        gate: () => true,
      },
      {
        name: 'b',
        provider: {
          runReview: async () => [
            { severity: 'critical', title: 'kaboom', body: 'b' },
          ],
        },
        gate: () => true,
      },
    ],
    prompts: [],
  });
  const out = await runCodeReview({
    epicId: 42,
    provider: {},
    bus: stubBus,
    reviewProvider: chain,
    resolveConfigFn: baseConfig,
    upsertCommentFn: noopUpsert(),
  });
  assert.equal(out.halted, true);
  assert.equal(out.severity.critical, 1);
  assert.match(out.blockerReason, /1 critical/);
});

test('runCodeReview: getPromptMessages throw is swallowed (treated as empty)', async () => {
  const chain = {
    runReview: async () => [],
    getPromptMessages: async () => {
      throw new Error('boom');
    },
  };
  const upsert = recordingUpsert();
  const out = await runCodeReview({
    epicId: 42,
    provider: {},
    bus: stubBus,
    reviewProvider: chain,
    resolveConfigFn: baseConfig,
    upsertCommentFn: upsert.fn,
  });
  assert.equal(out.status, 'ok');
  const [, , , body] = upsert.calls[0];
  assert.doesNotMatch(body, /Manual Review Suggestions/);
});

test('runCodeReview: provider name in comment reflects chain shape when configured', async () => {
  const adapter = {
    runReview: async () => [{ severity: 'medium', title: 't', body: 'b' }],
  };
  const upsert = recordingUpsert();
  await runCodeReview({
    epicId: 42,
    provider: {},
    bus: stubBus,
    reviewProvider: adapter, // legacy injection seam
    resolveConfigFn: () => ({
      project: { baseBranch: 'main' },
      delivery: {
        codeReview: {
          providers: [
            { name: 'native' },
            { name: 'ultrareview', manualPrompt: true },
          ],
        },
      },
    }),
    upsertCommentFn: upsert.fn,
  });
  const [, , , body] = upsert.calls[0];
  assert.match(body, /chain\[native,ultrareview\]/);
});
