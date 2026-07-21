/**
 * Unit tests for the composed `/search/issues` query bound (Story #4678, AC-5).
 *
 * The guard lives where the qualifiers are known: it truncates the free-text
 * portion on a whole-token boundary so the whole composed `q` fits GitHub
 * Search's 256-character limit, and never drops the load-bearing qualifiers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  composeBoundedQuery,
  fitTokens,
  GITHUB_SEARCH_MAX_QUERY,
} from '../search-query.js';

const QUALIFIERS = ['repo:dsj1984/mandrel', 'type:issue'];

describe('composeBoundedQuery', () => {
  it('leaves a short query untouched', () => {
    const q = composeBoundedQuery('sqli login', QUALIFIERS);
    assert.equal(q, 'sqli login repo:dsj1984/mandrel type:issue');
  });

  it('bounds an over-long free text to at most 256 chars, keeping the qualifiers', () => {
    const longFree = Array.from({ length: 60 }, (_, i) => `token${i}`).join(
      ' ',
    );
    const q = composeBoundedQuery(longFree, QUALIFIERS);

    assert.ok(
      q.length <= GITHUB_SEARCH_MAX_QUERY,
      `composed q is ${q.length} chars, must be <= ${GITHUB_SEARCH_MAX_QUERY}`,
    );
    assert.ok(q.endsWith('repo:dsj1984/mandrel type:issue'), 'qualifiers kept');
    // Truncated on a whole-token boundary: no partial `tokenNN` fragment.
    const free = q.replace(' repo:dsj1984/mandrel type:issue', '');
    for (const tok of free.split(/\s+/).filter(Boolean)) {
      assert.match(tok, /^token\d+$/, `token "${tok}" is whole`);
    }
  });

  it('returns just the qualifiers when even the first token cannot fit', () => {
    const hugeToken = 'x'.repeat(300);
    const q = composeBoundedQuery(hugeToken, QUALIFIERS);
    assert.equal(q, 'repo:dsj1984/mandrel type:issue');
  });
});

describe('fitTokens', () => {
  it('keeps as many leading tokens as fit on a whole-token boundary', () => {
    assert.equal(fitTokens(['aa', 'bb', 'cc'], 5), 'aa bb');
  });

  it('returns empty when the first token overflows the budget', () => {
    assert.equal(fitTokens(['toolong'], 3), '');
  });
});
