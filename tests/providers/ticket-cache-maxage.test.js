/**
 * TTL hit/miss tests for the provider ticket cache.
 *
 * Covers two layers:
 *   1. createTicketCacheManager#peekFresh — returns cached ticket within
 *      maxAgeMs, undefined past it.
 *   2. GitHubProvider#getTicket({ maxAgeMs }) — consecutive reads within
 *      the window collapse into a single HTTP call; reads past the window
 *      refetch.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGh } from '../../.agents/scripts/lib/gh-exec.js';
import { createTicketCacheManager } from '../../.agents/scripts/providers/github/cache-manager.js';
import { GitHubProvider } from '../../.agents/scripts/providers/github.js';

process.env.GITHUB_TOKEN = 'mock-token';

function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

/**
 * gh-exec replacement for `countingFetch`. Returns `{ gh, state }` where
 * `state.calls` is the number of times the underlying `gh api …` invocation
 * was issued. The fake responds to every API call with `issueFactory(call)`.
 */
function countingGh(issueFactory) {
  const state = { calls: 0 };
  const exec = async () => {
    state.calls++;
    return {
      stdout: JSON.stringify(issueFactory(state.calls)),
      stderr: '',
      code: 0,
    };
  };
  return { gh: createGh(exec), state };
}

describe('createTicketCacheManager: insertedAt + peekFresh', () => {
  it('returns cached ticket when age < maxAgeMs', () => {
    const clock = fakeClock();
    const cache = createTicketCacheManager({ now: clock.now });
    cache.set(42, { id: 42, title: 'T' });
    clock.advance(5_000);
    const out = cache.peekFresh(42, 10_000);
    assert.equal(out?.id, 42);
  });

  it('returns undefined when age >= maxAgeMs (refresh required)', () => {
    const clock = fakeClock();
    const cache = createTicketCacheManager({ now: clock.now });
    cache.set(42, { id: 42, title: 'T' });
    clock.advance(15_000);
    assert.equal(cache.peekFresh(42, 10_000), undefined);
  });

  it('set() refreshes insertedAt so a later peekFresh sees the new window', () => {
    const clock = fakeClock();
    const cache = createTicketCacheManager({ now: clock.now });
    cache.set(42, { id: 42, title: 'old' });
    clock.advance(15_000);
    cache.set(42, { id: 42, title: 'new' });
    const out = cache.peekFresh(42, 10_000);
    assert.equal(out?.title, 'new');
  });

  it('peekFresh returns undefined on miss regardless of maxAgeMs', () => {
    const cache = createTicketCacheManager();
    assert.equal(cache.peekFresh(99, 60_000), undefined);
  });

  it('primeIfAbsent timestamps new entries', () => {
    const clock = fakeClock();
    const cache = createTicketCacheManager({ now: clock.now });
    cache.primeIfAbsent({ id: 1, title: 'A', labels: [] });
    clock.advance(5_000);
    const hit = cache.peekFresh(1, 10_000);
    assert.equal(hit?.id, 1);
    clock.advance(10_000);
    assert.equal(cache.peekFresh(1, 10_000), undefined);
  });
});

describe('GitHubProvider.getTicket: maxAgeMs', () => {
  function buildProvider(gh) {
    return new GitHubProvider({ owner: 'o', repo: 'r' }, { gh, token: 'mock' });
  }

  function issuePayload(n) {
    return {
      number: 42,
      id: 1,
      node_id: 'node_42',
      title: `Ticket v${n}`,
      body: '',
      labels: [{ name: 'type::story' }],
      state: 'open',
    };
  }

  it('two reads within maxAgeMs issue exactly 1 HTTP call', async () => {
    const { gh, state } = countingGh(issuePayload);
    const provider = buildProvider(gh);
    const clock = fakeClock();
    provider._cache = createTicketCacheManager({ now: clock.now });

    const first = await provider.getTicket(42, { maxAgeMs: 10_000 });
    clock.advance(5_000);
    const second = await provider.getTicket(42, { maxAgeMs: 10_000 });

    assert.equal(state.calls, 1);
    assert.equal(first.title, 'Ticket v1');
    assert.equal(second.title, 'Ticket v1');
  });

  it('second read past maxAgeMs refetches', async () => {
    const { gh, state } = countingGh(issuePayload);
    const provider = buildProvider(gh);
    const clock = fakeClock();
    provider._cache = createTicketCacheManager({ now: clock.now });

    await provider.getTicket(42, { maxAgeMs: 10_000 });
    clock.advance(15_000);
    const refetched = await provider.getTicket(42, { maxAgeMs: 10_000 });

    assert.equal(state.calls, 2);
    assert.equal(refetched.title, 'Ticket v2');
  });

  it('opts.fresh still bypasses regardless of maxAgeMs', async () => {
    const { gh, state } = countingGh(issuePayload);
    const provider = buildProvider(gh);
    const clock = fakeClock();
    provider._cache = createTicketCacheManager({ now: clock.now });

    await provider.getTicket(42, { maxAgeMs: 10_000 });
    const bypass = await provider.getTicket(42, { fresh: true });

    assert.equal(state.calls, 2);
    assert.equal(bypass.title, 'Ticket v2');
  });

  it('default getTicket (no opts) keeps legacy cache-hit behavior', async () => {
    const { gh, state } = countingGh(issuePayload);
    const provider = buildProvider(gh);

    await provider.getTicket(42);
    await provider.getTicket(42);

    assert.equal(state.calls, 1);
  });
});
