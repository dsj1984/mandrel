/**
 * Chain-shape tests for `review-provider-factory.js` — Story #2871.
 *
 * Verifies AC-1, AC-4, AC-5 of the story contract:
 *   - `codeReview.providers` array shape produces a `ChainProvider`
 *     that fans out `runReview` and `getPromptMessages`.
 *   - Inline entries merge `Finding[]` in declaration order.
 *   - `optional: true` skips a construction-throw entry; non-optional
 *     surfaces the error verbatim.
 *   - `manualPrompt: true` routes the entry to the prompt registry;
 *     suggestions never affect severity counts.
 *   - `when.label` and `when.labelAny` gate invocation against the
 *     ticket label set carried on the ReviewInput.
 *   - `scopes` filters by current invocation scope.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_REVIEW_PROVIDERS } from '../../../../.agents/scripts/lib/config/review-chain-default.js';
import { getAgentrcValidator } from '../../../../.agents/scripts/lib/config-settings-schema.js';
import { CODE_REVIEW_SCHEMA } from '../../../../.agents/scripts/lib/config-settings-schema-quality.js';
import { createCodeReviewProviderForRegistry } from '../../../../.agents/scripts/lib/orchestration/review-providers/code-review.js';
import {
  buildGate,
  buildProviderChain,
  createChainProvider,
  createReviewProvider,
  isScopeApplicable,
  listInlineProviders,
  listPromptProviders,
  listRegisteredProviders,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/review-provider-factory.js';

const DELIVERY_SCHEMA_PROVIDERS_DEFAULT =
  CODE_REVIEW_SCHEMA.properties.providers.default;

function inlineRegistry(map) {
  return Object.freeze(map);
}
function promptRegistry(map) {
  return Object.freeze(map);
}

function stubInline(findings = []) {
  return { runReview: async () => findings };
}
function stubPrompt(message) {
  return { renderPrompt: async () => ({ message }) };
}

const INPUT = {
  scope: 'epic',
  ticketId: 42,
  baseRef: 'main',
  headRef: 'epic/42',
  labels: ['risk::high'],
};

test('buildGate: no `when` clause → always-true', () => {
  const gate = buildGate(undefined);
  assert.equal(gate({ scope: 'epic', labels: [] }), true);
});

test('buildGate: when.label matches when label present', () => {
  const gate = buildGate({ label: 'risk::high' });
  assert.equal(gate({ scope: 'epic', labels: ['risk::high'] }), true);
  assert.equal(gate({ scope: 'epic', labels: ['risk::medium'] }), false);
  assert.equal(gate({ scope: 'epic', labels: [] }), false);
});

test('buildGate: when.labelAny matches when ANY label present', () => {
  const gate = buildGate({ labelAny: ['risk::high', 'risk::critical'] });
  assert.equal(gate({ scope: 'epic', labels: ['risk::high'] }), true);
  assert.equal(gate({ scope: 'epic', labels: ['risk::critical'] }), true);
  assert.equal(gate({ scope: 'epic', labels: ['risk::low'] }), false);
});

test('isScopeApplicable: undefined / empty fires on both scopes', () => {
  assert.equal(isScopeApplicable(undefined, 'epic'), true);
  assert.equal(isScopeApplicable([], 'story'), true);
});

test('isScopeApplicable: filters by declared list', () => {
  assert.equal(isScopeApplicable(['epic'], 'epic'), true);
  assert.equal(isScopeApplicable(['epic'], 'story'), false);
  assert.equal(isScopeApplicable(['story', 'epic'], 'story'), true);
});

/**
 * The real `code-review` constructor over injected probe/diff/invoke seams —
 * no test spawns the `claude` binary.
 */
function defaultChainRegistry({ cliPresent, order }) {
  return inlineRegistry({
    native: () => ({
      runReview: async () => {
        order.push('native');
        return [];
      },
    }),
    'code-review': () =>
      createCodeReviewProviderForRegistry({
        probeFn: () => cliPresent,
        gitSpawnFn: () => ({
          status: 0,
          stdout: 'diff --git a/x b/x\n',
          stderr: '',
        }),
        spawnFn: () => {
          order.push('code-review');
          return { status: 0, stdout: '[]', stderr: '' };
        },
      }),
  });
}

const STORY_INPUT = { ...INPUT, scope: 'story', headRef: 'story-42' };

test('default chain: unset config with the claude CLI runs native then code-review', async () => {
  const order = [];
  const provider = createReviewProvider(undefined, {
    inlineRegistry: defaultChainRegistry({ cliPresent: true, order }),
    promptRegistry: promptRegistry({}),
  });
  assert.deepEqual(
    provider.chain.inline.map((e) => e.name),
    ['native', 'code-review'],
  );
  assert.deepEqual(await provider.runReview(STORY_INPUT), []);
  assert.deepEqual(order, ['native', 'code-review']);
});

test('default chain: without the claude CLI code-review is skipped and native runs alone', async () => {
  const order = [];
  const warnings = [];
  const provider = createReviewProvider(
    { providers: [] },
    {
      inlineRegistry: defaultChainRegistry({ cliPresent: false, order }),
      promptRegistry: promptRegistry({}),
      logger: { warn: (m) => warnings.push(m) },
    },
  );
  assert.deepEqual(
    provider.chain.inline.map((e) => e.name),
    ['native'],
  );
  await provider.runReview(STORY_INPUT);
  assert.deepEqual(order, ['native']);
  assert.ok(warnings.some((m) => /code-review unavailable/.test(m)));
});

test('default chain: the factory fallback is the shared DEFAULT_REVIEW_PROVIDERS constant', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_REVIEW_PROVIDERS)), [
    { name: 'native' },
    { name: 'code-review', scopes: ['story'], optional: true },
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(DELIVERY_SCHEMA_PROVIDERS_DEFAULT)),
    JSON.parse(JSON.stringify(DEFAULT_REVIEW_PROVIDERS)),
  );
});

test('createReviewProvider: providers chain returns ChainProvider', async () => {
  const inline = inlineRegistry({
    fake: () => stubInline([{ severity: 'medium', title: 't', body: 'b' }]),
  });
  const provider = createReviewProvider(
    { providers: [{ name: 'fake' }] },
    {
      inlineRegistry: inline,
      promptRegistry: promptRegistry({}),
    },
  );
  assert.equal(typeof provider.runReview, 'function');
  assert.equal(typeof provider.getPromptMessages, 'function');
  const findings = await provider.runReview(INPUT);
  assert.equal(findings.length, 1);
});

test('chain: inline providers run in declaration order, findings merged', async () => {
  const order = [];
  const inline = inlineRegistry({
    a: () => ({
      runReview: async () => {
        order.push('a');
        return [{ severity: 'medium', title: 'A1', body: 'b' }];
      },
    }),
    b: () => ({
      runReview: async () => {
        order.push('b');
        return [{ severity: 'high', title: 'B1', body: 'b' }];
      },
    }),
  });
  const provider = createReviewProvider(
    { providers: [{ name: 'a' }, { name: 'b' }] },
    { inlineRegistry: inline, promptRegistry: promptRegistry({}) },
  );
  const findings = await provider.runReview(INPUT);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].title, 'A1');
  assert.equal(findings[1].title, 'B1');
});

test('chain: optional construction throw → skip + warn; non-optional → throw', () => {
  const explodes = () => {
    throw new Error('plugin missing');
  };
  const warnings = [];
  // Optional path — chain proceeds, builds with one entry.
  const provider = createReviewProvider(
    {
      providers: [{ name: 'broken', optional: true }, { name: 'ok' }],
    },
    {
      inlineRegistry: inlineRegistry({
        broken: explodes,
        ok: () => stubInline([]),
      }),
      promptRegistry: promptRegistry({}),
      logger: { warn: (m) => warnings.push(m) },
    },
  );
  assert.equal(provider.chain.inline.length, 1);
  assert.equal(provider.chain.inline[0].name, 'ok');
  assert.ok(warnings.some((m) => /broken.*skipping/i.test(m)));

  // Non-optional path — bubbles up.
  assert.throws(
    () =>
      createReviewProvider(
        { providers: [{ name: 'broken' }] },
        {
          inlineRegistry: inlineRegistry({ broken: explodes }),
          promptRegistry: promptRegistry({}),
        },
      ),
    /plugin missing/,
  );
});

test('chain: manualPrompt routes to prompt registry, contributes suggestions', async () => {
  const provider = createReviewProvider(
    {
      providers: [{ name: 'a' }, { name: 'p', manualPrompt: true }],
    },
    {
      inlineRegistry: inlineRegistry({
        a: () => stubInline([{ severity: 'medium', title: 't', body: 'b' }]),
      }),
      promptRegistry: promptRegistry({ p: () => stubPrompt('🟢 try it') }),
    },
  );
  const findings = await provider.runReview(INPUT);
  const messages = await provider.getPromptMessages(INPUT);
  assert.equal(findings.length, 1);
  assert.deepEqual(messages, ['🟢 try it']);
});

test('chain: scopes filter — entry scoped to "epic" does not fire on a Story-scope input', async () => {
  const inline = inlineRegistry({
    a: () => stubInline([{ severity: 'medium', title: 'A', body: 'b' }]),
    e: () => stubInline([{ severity: 'high', title: 'E', body: 'b' }]),
  });
  const provider = createReviewProvider(
    {
      providers: [{ name: 'a' }, { name: 'e', scopes: ['epic'] }],
    },
    { inlineRegistry: inline, promptRegistry: promptRegistry({}) },
  );
  const storyFindings = await provider.runReview({
    ...INPUT,
    scope: 'story',
  });
  assert.equal(storyFindings.length, 1);
  assert.equal(storyFindings[0].title, 'A');
});

test('chain: when.label gating — present runs, absent skips', async () => {
  const provider = createReviewProvider(
    {
      providers: [{ name: 'a', when: { label: 'risk::high' } }],
    },
    {
      inlineRegistry: inlineRegistry({
        a: () => stubInline([{ severity: 'medium', title: 'A', body: 'b' }]),
      }),
      promptRegistry: promptRegistry({}),
    },
  );
  const withLabel = await provider.runReview({
    ...INPUT,
    labels: ['risk::high'],
  });
  const withoutLabel = await provider.runReview({
    ...INPUT,
    labels: ['risk::low'],
  });
  assert.equal(withLabel.length, 1);
  assert.equal(withoutLabel.length, 0);
});

test('chain: manual-prompt provider throw is caught (never blocks chain)', async () => {
  const provider = createReviewProvider(
    { providers: [{ name: 'p', manualPrompt: true }] },
    {
      inlineRegistry: inlineRegistry({}),
      promptRegistry: promptRegistry({
        p: () => ({
          renderPrompt: async () => {
            throw new Error('boom');
          },
        }),
      }),
    },
  );
  const messages = await provider.getPromptMessages(INPUT);
  assert.deepEqual(messages, []);
});

test('chain: unknown inline provider throws with supported-list remediation', () => {
  assert.throws(
    () =>
      createReviewProvider(
        { providers: [{ name: 'gemini' }] },
        {
          inlineRegistry: inlineRegistry({ native: () => stubInline([]) }),
          promptRegistry: promptRegistry({}),
        },
      ),
    /Unknown inline provider "gemini"/,
  );
});

test('chain: entry missing `name` throws', () => {
  assert.throws(
    () =>
      createReviewProvider(
        { providers: [{}] },
        {
          inlineRegistry: inlineRegistry({}),
          promptRegistry: promptRegistry({}),
        },
      ),
    /missing required `name`/,
  );
});

test('buildProviderChain: classifies inline vs prompt by `manualPrompt`', () => {
  const chain = buildProviderChain(
    [{ name: 'i' }, { name: 'p', manualPrompt: true }],
    {
      inlineRegistry: inlineRegistry({ i: () => stubInline([]) }),
      promptRegistry: promptRegistry({ p: () => stubPrompt('m') }),
    },
  );
  assert.equal(chain.inline.length, 1);
  assert.equal(chain.prompts.length, 1);
  assert.equal(chain.inline[0].name, 'i');
  assert.equal(chain.prompts[0].name, 'p');
});

test('createChainProvider: empty chain returns empty findings + empty messages', async () => {
  const provider = createChainProvider({ inline: [], prompts: [] });
  const findings = await provider.runReview(INPUT);
  const messages = await provider.getPromptMessages(INPUT);
  assert.deepEqual(findings, []);
  assert.deepEqual(messages, []);
});

test('createChainProvider: inline returning non-array throws TypeError', async () => {
  const provider = createChainProvider({
    inline: [
      {
        name: 'bad',
        provider: { runReview: async () => 'not-an-array' },
        gate: () => true,
      },
    ],
    prompts: [],
  });
  await assert.rejects(() => provider.runReview(INPUT), TypeError);
});

test('runtime .agentrc validator accepts a codeReview.providers block naming code-review', () => {
  const validate = getAgentrcValidator();
  const ok = validate({
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
    delivery: {
      codeReview: {
        providers: [
          { name: 'native' },
          { name: 'code-review', scopes: ['story'], optional: true },
        ],
      },
    },
  });
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test('listInlineProviders: includes native + code-review + codex + security-review', () => {
  const names = listInlineProviders();
  assert.ok(names.includes('native'));
  assert.ok(names.includes('code-review'));
  assert.ok(names.includes('codex'));
  assert.ok(names.includes('security-review'));
});

test('listPromptProviders: includes ultrareview', () => {
  const names = listPromptProviders();
  assert.ok(names.includes('ultrareview'));
});

test('listRegisteredProviders: unions inline + prompt names', () => {
  const all = listRegisteredProviders();
  assert.ok(all.includes('native'));
  assert.ok(all.includes('ultrareview'));
  assert.ok(all.includes('security-review'));
});
