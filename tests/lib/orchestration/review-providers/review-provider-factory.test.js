/**
 * Unit tests for `review-provider-factory.js`.
 *
 * Story #2825 (Epic #2815) — verifies:
 *   - Unset / empty `codeReview.providers` falls back to the default
 *     chain (`native` + optional `code-review`).
 *   - Unknown provider name throws an Error whose message names the
 *     unknown value, lists the supported values, and points the
 *     operator at `.agentrc.json` for remediation.
 *   - A custom registry can be injected for adapter-extension tests.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX_REMEDIATIONS,
  createCodexProvider,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/codex.js';
import {
  createReviewProvider,
  listRegisteredProviders,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/review-provider-factory.js';

// Stub registry: the real `code-review` constructor probes the `claude` CLI,
// and no test may spawn it.
const STUB_DEFAULT_REGISTRY = Object.freeze({
  native: () => ({ runReview: async () => [] }),
  'code-review': () => ({ runReview: async () => [] }),
});

test('createReviewProvider: unset codeReview falls back to the default chain', () => {
  const provider = createReviewProvider(undefined, {
    registry: STUB_DEFAULT_REGISTRY,
  });
  assert.equal(typeof provider.runReview, 'function');
  assert.equal(typeof provider.getPromptMessages, 'function');
  assert.deepEqual(
    provider.chain.inline.map((e) => e.name),
    ['native', 'code-review'],
  );
});

test('createReviewProvider: missing or empty providers falls back to the default chain', () => {
  for (const config of [{ providerConfig: {} }, { providers: [] }]) {
    const provider = createReviewProvider(config, {
      registry: STUB_DEFAULT_REGISTRY,
    });
    assert.deepEqual(
      provider.chain.inline.map((e) => e.name),
      ['native', 'code-review'],
    );
  }
});

test('createReviewProvider: explicit native chain entry returns a provider', () => {
  const provider = createReviewProvider({ providers: [{ name: 'native' }] });
  assert.equal(typeof provider.runReview, 'function');
});

test('createReviewProvider: throws with remediation text on unknown provider', () => {
  assert.throws(
    () => createReviewProvider({ providers: [{ name: 'gemini' }] }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Unknown inline provider "gemini"/);
      assert.match(err.message, /Supported values for this slot:/);
      assert.match(err.message, /native/);
      assert.match(err.message, /codex/);
      assert.match(err.message, /codeReview\.providers chain/);
      return true;
    },
  );
});

test('createReviewProvider: codex is a registered provider name', () => {
  // The registry has codex wired up; whether construction succeeds
  // depends on the probe (see codex-specific tests below). Listing
  // registered names is enough here.
  assert.ok(listRegisteredProviders().includes('codex'));
});

test('createReviewProvider: codex selection with present probe returns a provider', () => {
  const provider = createReviewProvider(
    { providers: [{ name: 'codex' }] },
    {
      registry: {
        codex: () => createCodexProvider({ probeFn: () => true }),
      },
    },
  );
  assert.equal(typeof provider.runReview, 'function');
});

test('createReviewProvider: codex selection hard-fails when probe reports absent', () => {
  // Build a registry that mirrors the production wiring but injects
  // a probe stub that reports absent. The factory MUST surface the
  // remediation Error verbatim (no silent fallback to native).
  assert.throws(
    () =>
      createReviewProvider(
        { providers: [{ name: 'codex' }] },
        {
          registry: {
            codex: () => createCodexProvider({ probeFn: () => false }),
          },
        },
      ),
    (err) => {
      assert.ok(err instanceof Error);
      // Both remediations MUST be named in the message.
      assert.ok(err.message.includes(CODEX_REMEDIATIONS.install));
      assert.ok(err.message.includes(CODEX_REMEDIATIONS.fallback));
      assert.match(err.message, /openai\/codex-plugin-cc/);
      assert.match(err.message, /provider.*native/);
      return true;
    },
  );
});

test('createReviewProvider: honors injected registry for adapter tests', async () => {
  const sentinel = { runReview: async () => [] };
  const provider = createReviewProvider(
    { providers: [{ name: 'fake' }] },
    { registry: { fake: () => sentinel } },
  );
  assert.strictEqual(provider.chain.inline[0].provider, sentinel);
  // Smoke-call the stub to keep the contract intact.
  const findings = await provider.runReview({
    scope: 'story',
    ticketId: 1,
    baseRef: 'main',
    headRef: 'story-1',
  });
  assert.deepEqual(findings, []);
});

test('listRegisteredProviders includes code-review', () => {
  assert.ok(listRegisteredProviders().includes('code-review'));
});

test('listRegisteredProviders returns the registered names sorted', () => {
  const names = listRegisteredProviders();
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('native'));
});
