/**
 * Unit tests for `review-provider-factory.js`.
 *
 * Story #2825 (Epic #2815) — verifies:
 *   - Unset `codeReview.provider` defaults to `native`.
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
  DEFAULT_PROVIDER_NAME,
  listRegisteredProviders,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/review-provider-factory.js';

test('createReviewProvider: defaults to native when codeReview is unset', () => {
  const provider = createReviewProvider(undefined);
  assert.equal(typeof provider.runReview, 'function');
});

test('createReviewProvider: defaults to native when provider field is missing', () => {
  const provider = createReviewProvider({ providerConfig: {} });
  assert.equal(typeof provider.runReview, 'function');
});

test('createReviewProvider: explicit native selection returns a provider', () => {
  const provider = createReviewProvider({ provider: 'native' });
  assert.equal(typeof provider.runReview, 'function');
});

test('createReviewProvider: throws with remediation text on unknown provider', () => {
  assert.throws(
    () => createReviewProvider({ provider: 'gemini' }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Unknown codeReview\.provider "gemini"/);
      assert.match(err.message, /Supported values:/);
      assert.match(err.message, /native/);
      assert.match(err.message, /codex/);
      assert.match(err.message, /\.agentrc\.json/);
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
    { provider: 'codex' },
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
        { provider: 'codex' },
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
    { provider: 'fake' },
    { registry: { fake: () => sentinel } },
  );
  assert.strictEqual(provider, sentinel);
  // Smoke-call the stub to keep the contract intact.
  const findings = await provider.runReview({
    scope: 'story',
    ticketId: 1,
    baseRef: 'main',
    headRef: 'story-1',
  });
  assert.deepEqual(findings, []);
});

test('DEFAULT_PROVIDER_NAME is native', () => {
  assert.equal(DEFAULT_PROVIDER_NAME, 'native');
});

test('listRegisteredProviders returns the registered names sorted', () => {
  const names = listRegisteredProviders();
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('native'));
});
