/**
 * Unit tests for `.agents/scripts/providers/github/cache.js`.
 *
 * Covers insert, peek/peekFresh, primeIfAbsent, primeMany, invalidate,
 * and the maxAgeMs eviction branch (the AC's named branch).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const cacheMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'cache.js'),
  ).href
);
const providerMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github.js'),
  ).href
);

const { createInlineTicketCache } = cacheMod;

function ticket(id, extra = {}) {
  return { id, title: `Ticket #${id}`, labels: ['type::task'], ...extra };
}

describe('providers/github/cache.js — createInlineTicketCache', () => {
  it('insert: set() stores a ticket and has()/peek() retrieve it', () => {
    const cache = createInlineTicketCache();
    cache.set(42, ticket(42));
    assert.strictEqual(cache.has(42), true);
    assert.deepStrictEqual(cache.peek(42)?.id, 42);
    assert.strictEqual(cache.has(43), false);
    assert.strictEqual(cache.peek(43), undefined);
  });

  it('peekFresh: returns the ticket when within maxAgeMs', () => {
    let nowVal = 1000;
    const cache = createInlineTicketCache({ now: () => nowVal });
    cache.set(1, ticket(1));
    nowVal = 1500;
    const got = cache.peekFresh(1, 1000);
    assert.strictEqual(got?.id, 1);
  });

  it('peekFresh: maxAgeMs eviction branch — returns undefined when entry is stale', () => {
    let nowVal = 1000;
    const cache = createInlineTicketCache({ now: () => nowVal });
    cache.set(1, ticket(1));
    nowVal = 1000 + 5000; // 5s later
    const got = cache.peekFresh(1, 1000); // 1s window — stale
    assert.strictEqual(
      got,
      undefined,
      'stale entry must evict via peekFresh boundary',
    );
  });

  it('peekFresh: rejects non-finite / negative maxAgeMs', () => {
    const cache = createInlineTicketCache();
    cache.set(1, ticket(1));
    assert.strictEqual(cache.peekFresh(1, Number.NaN), undefined);
    assert.strictEqual(cache.peekFresh(1, Number.POSITIVE_INFINITY), undefined);
    assert.strictEqual(cache.peekFresh(1, -1), undefined);
  });

  it('primeIfAbsent: stores when absent and is a no-op when present', () => {
    const cache = createInlineTicketCache();
    cache.primeIfAbsent(ticket(7));
    assert.strictEqual(cache.has(7), true);

    // Second prime with a different title must NOT overwrite.
    cache.primeIfAbsent({ id: 7, title: 'updated' });
    assert.strictEqual(cache.peek(7)?.title, 'Ticket #7');
  });

  it('primeIfAbsent: ignores non-ticket shapes', () => {
    const cache = createInlineTicketCache();
    cache.primeIfAbsent(null);
    cache.primeIfAbsent({});
    cache.primeIfAbsent({ id: 'not-a-number' });
    assert.strictEqual(cache.has(0), false);
  });

  it('primeIfAbsent: lazily materialises labelSet from labels when missing', () => {
    const cache = createInlineTicketCache();
    cache.primeIfAbsent({ id: 9, labels: ['a', 'b'] });
    const stored = cache.peek(9);
    assert.ok(stored.labelSet instanceof Set);
    assert.deepStrictEqual([...stored.labelSet], ['a', 'b']);
  });

  it('primeMany: bulk-primes only the new tickets, leaves existing untouched', () => {
    const cache = createInlineTicketCache();
    cache.set(1, ticket(1, { title: 'original' }));
    cache.primeMany([{ id: 1, title: 'overwrite' }, ticket(2), ticket(3)]);
    assert.strictEqual(cache.peek(1)?.title, 'original');
    assert.strictEqual(cache.has(2), true);
    assert.strictEqual(cache.has(3), true);
  });

  it('invalidate: removes a single entry', () => {
    const cache = createInlineTicketCache();
    cache.set(1, ticket(1));
    cache.set(2, ticket(2));
    cache.invalidate(1);
    assert.strictEqual(cache.has(1), false);
    assert.strictEqual(cache.has(2), true);
  });
});

describe('providers/github.js — re-export surface', () => {
  it('createInlineTicketCache resolves through the parent import path', () => {
    assert.strictEqual(
      providerMod.createInlineTicketCache,
      createInlineTicketCache,
    );
  });
});
