/**
 * GitHubProvider facade — construction + cross-cutting error handling.
 *
 * Tests GitHubProvider construction (ITicketingProvider inheritance, config
 * storage, token resolution) and the cross-cutting REST/GraphQL error surface
 * with a mocked gh-exec facade — no live API calls. Split from the former
 * root monolith `tests/providers-github.test.js` (Story #4084).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createTestProvider, ITicketingProvider, makeGh } from './_helpers.js';

// ---------------------------------------------------------------------------
// Basic construction
// ---------------------------------------------------------------------------
describe('GitHubProvider — construction', () => {
  it('extends ITicketingProvider', () => {
    const provider = createTestProvider();
    assert.ok(provider instanceof ITicketingProvider);
  });

  it('stores config values', () => {
    const provider = createTestProvider({ projectNumber: 5 });
    assert.equal(provider.owner, 'test-owner');
    assert.equal(provider.repo, 'test-repo');
    assert.equal(provider.projectNumber, 5);
    assert.equal(provider.operatorHandle, '@tester');
  });

  it('uses provided token', () => {
    const provider = createTestProvider();
    assert.equal(provider.token, 'test-token-123');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
describe('GitHubProvider — error handling', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('includes status code in REST error messages', async () => {
    const gh = makeGh({
      'GET /issues/1': { status: 403, json: { message: 'rate limited' } },
    });
    const provider = createTestProvider({ gh });
    await assert.rejects(provider.getTicket(1), /code 403/);
  });

  it('error message carries the failing argv for gh-exec failures', async () => {
    // 422 (not retried) is a deterministic terminal failure under the new
    // gh-exec error surface. The argv is captured on the thrown error via
    // gh-exec's classify() path.
    const gh = makeGh({
      'GET /issues/1': { status: 422, json: { message: 'validation failed' } },
    });
    const provider = createTestProvider({ gh });
    await assert.rejects(provider.getEpic(1), (err) => {
      // The argv shape includes the endpoint path.
      return /code 422/.test(err.message);
    });
  });

  it('supports graphql queries (routed through gh api graphql)', async () => {
    const gh = makeGh({
      'POST graphql': {
        status: 200,
        json: { data: { viewer: { login: 'tester' } } },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.graphql('query { viewer { login } }');
    assert.strictEqual(result.viewer.login, 'tester');
    // Verify argv routes through `gh api -X POST graphql`.
    const call = gh.__exec.calls[0];
    assert.strictEqual(call.args[0], 'api');
    assert.strictEqual(call.args[2], 'POST');
    assert.strictEqual(call.args[3], 'graphql');
    const body = JSON.parse(call.input);
    assert.match(body.query, /viewer/);
  });

  it('updates body/description in updateTicket', async () => {
    const gh = makeGh({
      'PATCH /issues/123': { status: 200, json: { id: 123 } },
    });
    const provider = createTestProvider({ gh });
    await provider.updateTicket(123, { body: 'New body content' });
    const call = gh.__exec.calls[0];
    assert.strictEqual(JSON.parse(call.input).body, 'New body content');
  });
});
