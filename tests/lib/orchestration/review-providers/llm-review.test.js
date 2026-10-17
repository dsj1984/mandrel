/**
 * `llm-review` — the default chain's first-available LLM review (Story
 * #5741). Every CLI is behind an injected probe or spawn seam; no test spawns
 * `claude` or `codex`, so the assertions hold on every platform.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgentrcValidator } from '../../../../.agents/scripts/lib/config-settings-schema.js';
import { CODE_REVIEW_SCHEMA } from '../../../../.agents/scripts/lib/config-settings-schema-quality.js';
import { createCodeReviewProviderForRegistry } from '../../../../.agents/scripts/lib/orchestration/review-providers/code-review.js';
import { createCodexProvider } from '../../../../.agents/scripts/lib/orchestration/review-providers/codex.js';
import {
  buildLlmReviewUnavailableError,
  createLlmReviewProvider,
  resolveLlmReviewDelegate,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/llm-review.js';
import { createReviewProvider } from '../../../../.agents/scripts/lib/orchestration/review-providers/review-provider-factory.js';

const STORY_INPUT = Object.freeze({
  scope: 'story',
  ticketId: 42,
  baseRef: 'main',
  headRef: 'story-42',
  labels: [],
});

/**
 * The real delegates over spawn seams; `calls` records which CLI reviewed.
 *
 * @param {{ claude: boolean, codex: boolean, calls: string[], logs?: string[] }} host
 */
function llmReviewOn({ claude, codex, calls, logs = [] }) {
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
  return createLlmReviewProvider({
    probeClaudeFn: () => claude,
    probeCodexFn: () => codex,
    logger,
    createCodeReviewFn: (deps) =>
      createCodeReviewProviderForRegistry({
        ...deps,
        gitSpawnFn: () => ({
          status: 0,
          stdout: 'diff --git a/x b/x\n',
          stderr: '',
        }),
        authSpawnFn: () => ({
          status: 0,
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
          stderr: '',
        }),
        spawnFn: () => {
          calls.push('claude --print');
          return {
            status: 0,
            stdout: JSON.stringify({
              subtype: 'success',
              is_error: false,
              structured_output: { findings: [] },
            }),
            stderr: '',
          };
        },
      }),
    createCodexFn: (deps) =>
      createCodexProvider({
        ...deps,
        invokeFn: () => {
          calls.push('codex exec');
          return { status: 0, stdout: '[]', stderr: '' };
        },
      }),
  });
}

/** The default chain (no `codeReview.providers`) on a host with these CLIs. */
function defaultChainOn(host, warnings = []) {
  return createReviewProvider(undefined, {
    inlineRegistry: Object.freeze({
      native: () => ({ runReview: async () => [] }),
      'llm-review': () => llmReviewOn(host),
    }),
    promptRegistry: Object.freeze({}),
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
  });
}

test('AC-1: only codex on PATH → the default chain reviews through codex exec', async () => {
  const calls = [];
  await defaultChainOn({ claude: false, codex: true, calls }).runReview(
    STORY_INPUT,
  );
  assert.deepEqual(calls, ['codex exec']);
});

test('AC-1: only claude on PATH → the default chain reviews through claude --print', async () => {
  const calls = [];
  await defaultChainOn({ claude: true, codex: false, calls }).runReview(
    STORY_INPUT,
  );
  assert.deepEqual(calls, ['claude --print']);
});

test('AC-1: both CLIs → exactly one LLM review runs, claude first', async () => {
  const calls = [];
  await defaultChainOn({ claude: true, codex: true, calls }).runReview(
    STORY_INPUT,
  );
  assert.deepEqual(calls, ['claude --print']);
});

test('the review log line names the delegate that reviewed', async () => {
  const logs = [];
  const provider = llmReviewOn({ claude: false, codex: true, calls: [], logs });
  assert.equal(provider.delegate, 'codex');
  await provider.runReview(STORY_INPUT);
  assert.ok(logs.some((m) => /\[llm-review\] Reviewing through codex/.test(m)));
});

test('resolveLlmReviewDelegate prefers claude and stops probing at the first hit', () => {
  const probed = [];
  const chosen = resolveLlmReviewDelegate({
    probeClaudeFn: () => probed.push('claude') > 0,
    probeCodexFn: () => probed.push('codex') > 0,
  });
  assert.equal(chosen.name, 'code-review');
  assert.deepEqual(probed, ['claude']);
  assert.equal(
    resolveLlmReviewDelegate({
      probeClaudeFn: () => false,
      probeCodexFn: () => false,
    }),
    null,
  );
});

test('AC-2: neither CLI → native closes alone with one warning naming both remedies', async () => {
  const warnings = [];
  const calls = [];
  const provider = defaultChainOn(
    { claude: false, codex: false, calls },
    warnings,
  );
  assert.deepEqual(
    provider.chain.inline.map((e) => e.name),
    ['native'],
  );
  await provider.runReview(STORY_INPUT);
  assert.deepEqual(calls, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /llm-review unavailable/);
  assert.match(warnings[0], /Claude Code CLI/);
  assert.match(warnings[0], /@openai\/codex/);
});

test('AC-2: a non-optional llm-review entry with neither CLI hard-fails at construction', () => {
  assert.throws(
    () =>
      createReviewProvider(
        { providers: [{ name: 'llm-review' }] },
        {
          inlineRegistry: Object.freeze({
            'llm-review': () =>
              createLlmReviewProvider({
                probeClaudeFn: () => false,
                probeCodexFn: () => false,
              }),
          }),
        },
      ),
    (err) => err.message === buildLlmReviewUnavailableError().message,
  );
});

test('getDegradations passes the delegate degradations through', () => {
  const provider = createLlmReviewProvider({
    probeClaudeFn: () => true,
    createCodeReviewFn: () => ({
      runReview: async () => [],
      getDegradations: () => [{ tool: 'code-review', reason: 'x' }],
    }),
  });
  assert.deepEqual(provider.getDegradations(), [
    { tool: 'code-review', reason: 'x' },
  ]);
  const bare = createLlmReviewProvider({
    probeClaudeFn: () => false,
    probeCodexFn: () => true,
    createCodexFn: () => ({ runReview: async () => [] }),
  });
  assert.deepEqual(bare.getDegradations(), []);
});

test('schema: llm-review is an accepted codeReview.providers name', () => {
  const names = CODE_REVIEW_SCHEMA.properties.providers.items.properties.name;
  assert.ok(names.enum.includes('llm-review'));
  const validate = getAgentrcValidator();
  const ok = validate({
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
    delivery: {
      codeReview: {
        providers: [
          { name: 'native' },
          { name: 'llm-review', scopes: ['story'], optional: true },
        ],
      },
    },
  });
  assert.equal(ok, true, JSON.stringify(validate.errors));
});
