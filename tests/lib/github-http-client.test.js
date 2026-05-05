import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GithubHttpClient } from '../../.agents/scripts/providers/github-http-client.js';

describe('GithubHttpClient', () => {
  function makeFetchStub(responses) {
    let call = 0;
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const spec = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (spec instanceof Error) throw spec;
      return {
        ok: spec.ok ?? spec.status < 400,
        status: spec.status,
        headers: {
          get: (k) => spec.headers?.[k.toLowerCase()] ?? null,
        },
        json: async () => spec.body ?? {},
        text: async () => (typeof spec.body === 'string' ? spec.body : ''),
      };
    };
    return { fetchImpl, calls };
  }

  it('token is lazily resolved via tokenProvider on first access', () => {
    let calls = 0;
    const client = new GithubHttpClient({
      tokenProvider: () => {
        calls += 1;
        return 'abc123';
      },
    });
    assert.equal(calls, 0);
    assert.equal(client.token, 'abc123');
    assert.equal(client.token, 'abc123');
    assert.equal(calls, 1, 'tokenProvider called exactly once');
  });

  it('rest: issues GET with Bearer + API version headers', async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { status: 200, body: { ok: true } },
    ]);
    const client = new GithubHttpClient({
      tokenProvider: () => 'T',
      fetchImpl,
    });
    const result = await client.rest('/repos/o/r/issues/1');
    assert.deepEqual(result, { ok: true });
    const headers = calls[0].init.headers;
    assert.equal(headers.Authorization, 'Bearer T');
    assert.equal(headers['X-GitHub-Api-Version'], '2022-11-28');
  });

  it('rest: throws on non-ok with context in the message', async () => {
    const { fetchImpl } = makeFetchStub([{ status: 404, body: 'not found' }]);
    const client = new GithubHttpClient({
      tokenProvider: () => 'T',
      fetchImpl,
    });
    await assert.rejects(
      () => client.rest('/repos/o/r/issues/404'),
      /GET.*\/issues\/404.*404.*not found/s,
    );
  });

  it('rest: returns null on 204 No Content', async () => {
    const { fetchImpl } = makeFetchStub([{ status: 204 }]);
    const client = new GithubHttpClient({
      tokenProvider: () => 'T',
      fetchImpl,
    });
    const result = await client.rest('/repos/o/r/issues/1', {
      method: 'DELETE',
    });
    assert.equal(result, null);
  });

  it('graphql: throws when response contains errors[]', async () => {
    const { fetchImpl } = makeFetchStub([
      {
        status: 200,
        body: { errors: [{ message: 'field missing' }] },
      },
    ]);
    const client = new GithubHttpClient({
      tokenProvider: () => 'T',
      fetchImpl,
    });
    await assert.rejects(
      () => client.graphql('query { viewer { login } }'),
      /GraphQL errors.*field missing/s,
    );
  });

  it('rest: retries on HTTP 403 secondary rate limit, then succeeds', async () => {
    const { fetchImpl, calls } = makeFetchStub([
      {
        status: 403,
        headers: { 'retry-after': '0' },
        body: 'You have exceeded a secondary rate limit and have been temporarily blocked from content creation.',
      },
      { status: 201, body: { number: 42 } },
    ]);
    const client = new GithubHttpClient({
      tokenProvider: () => 'T',
      fetchImpl,
    });
    // Stub setTimeout off the event loop so the test doesn't actually sleep
    // the secondary-RL backoff (30s+).
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => originalSetTimeout(fn, 0);
    try {
      const result = await client.rest('/repos/o/r/issues', {
        method: 'POST',
        body: { title: 'x' },
      });
      assert.deepEqual(result, { number: 42 });
      assert.equal(calls.length, 2, 'must retry once');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('rest: does NOT retry on a generic 403 (auth failure) and surfaces the body', async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { status: 403, body: 'Resource not accessible by integration' },
    ]);
    const client = new GithubHttpClient({
      tokenProvider: () => 'T',
      fetchImpl,
    });
    await assert.rejects(
      () => client.rest('/repos/o/r/issues/1'),
      /403.*Resource not accessible by integration/s,
    );
    assert.equal(calls.length, 1, 'must not retry generic 403');
  });

  it('rest: fires onTransientFailure on secondary RL retry', async () => {
    const events = [];
    const { fetchImpl } = makeFetchStub([
      { status: 403, body: 'secondary rate limit hit' },
      { status: 200, body: { ok: true } },
    ]);
    const client = new GithubHttpClient({
      tokenProvider: () => 'T',
      fetchImpl,
      onTransientFailure: (info) => events.push(info),
    });
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => originalSetTimeout(fn, 0);
    try {
      await client.rest('/repos/o/r/issues');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'secondary-rate-limit');
    assert.equal(events[0].status, 403);
  });

  it('restPaginated: stops when batch size < 100', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({ id: 100 + i }));
    const { fetchImpl, calls } = makeFetchStub([
      { status: 200, body: page1 },
      { status: 200, body: page2 },
    ]);
    const client = new GithubHttpClient({
      tokenProvider: () => 'T',
      fetchImpl,
    });
    const all = await client.restPaginated('/repos/o/r/issues');
    assert.equal(all.length, 150);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.includes('page=1'));
    assert.ok(calls[1].url.includes('page=2'));
  });
});
