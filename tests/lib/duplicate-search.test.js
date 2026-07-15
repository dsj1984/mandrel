/**
 * tests/lib/duplicate-search.test.js — unit tests for the cross-Story
 * duplicate detector used by `/plan`.
 *
 * Covers:
 *  - overlap scoring (Jaccard) returns expected ordering and respects
 *    stopword filtering
 *  - empty/no-match short-circuit returns []
 *  - search-narrowed path prefers provider.searchIssues
 *  - listIssuesByLabel fallback when search errors
 *  - provider errors propagate verbatim on the list path
 *  - input validation rejects missing seed / provider ports
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOpenStorySearchQuery,
  findSimilarOpenStories,
  overlapScore,
  pickSearchTokens,
  tokenize,
} from '../../.agents/scripts/lib/duplicate-search.js';

function makeListProvider(stories) {
  return {
    async listIssuesByLabel(_filters) {
      return stories.map((s) => ({
        number: s.id,
        title: s.title,
        body: s.body,
        html_url: s.url,
      }));
    },
  };
}

function makeSearchProvider(stories, { onSearch, failSearch } = {}) {
  return {
    async searchIssues({ query }) {
      if (onSearch) onSearch(query);
      if (failSearch) throw failSearch;
      return stories.map((s) => ({
        number: s.id,
        title: s.title,
        body: s.body,
        state: 'open',
        html_url: s.url,
      }));
    },
    async listIssuesByLabel() {
      throw new Error('listIssuesByLabel should not be called on search path');
    },
  };
}

const WEBHOOK_STORIES = [
  {
    id: 101,
    title: 'Webhook duplicate detection for incoming events',
    body: 'Detect duplicate webhook payloads by hashing the body.',
  },
  {
    id: 102,
    title: 'Marketing landing page redesign',
    body: 'Refresh hero copy and call-to-action buttons.',
  },
  {
    id: 103,
    title: 'Webhook payload deduplication store',
    body: 'Store webhook fingerprints to short-circuit duplicates.',
  },
];

describe('duplicate-search', () => {
  describe('tokenize', () => {
    it('lowercases, drops stopwords, and dedupes', () => {
      const out = tokenize('The Quick brown FOX jumps over the lazy fox');
      assert.ok(out.has('quick'));
      assert.ok(out.has('brown'));
      assert.ok(out.has('jumps'));
      assert.ok(!out.has('the'));
      assert.ok(out.has('over')); // 'over' is not in the stopword set
      // 'fox' appears twice but the set dedupes
      assert.equal([...out].filter((t) => t === 'fox').length, 1);
    });

    it('returns empty set for empty / non-string input', () => {
      assert.equal(tokenize('').size, 0);
      assert.equal(tokenize(null).size, 0);
      assert.equal(tokenize(undefined).size, 0);
      assert.equal(tokenize(42).size, 0);
    });
  });

  describe('pickSearchTokens / buildOpenStorySearchQuery', () => {
    it('prefers longer tokens and caps at N', () => {
      const tokens = pickSearchTokens(
        'webhook fingerprint hashing service for duplicate payloads',
        3,
      );
      assert.equal(tokens.length, 3);
      assert.ok(tokens.every((t) => typeof t === 'string' && t.length >= 3));
      // Longer tokens sort first
      assert.ok(tokens[0].length >= tokens[1].length);
    });

    it('builds a label + state + free-text Search query', () => {
      const q = buildOpenStorySearchQuery(
        'Detect duplicate webhook payloads via fingerprint hashing.',
      );
      assert.match(q, /label:"type::story"/);
      assert.match(q, /\bstate:open\b/);
      assert.match(q, /webhook/);
      assert.match(q, /fingerprint|hashing|duplicate|payloads/);
    });
  });

  describe('overlapScore', () => {
    it('returns 1.0 for identical sets', () => {
      const a = new Set(['alpha', 'beta', 'gamma']);
      const b = new Set(['alpha', 'beta', 'gamma']);
      assert.equal(overlapScore(a, b), 1);
    });

    it('returns 0 for disjoint sets', () => {
      const a = new Set(['alpha']);
      const b = new Set(['beta']);
      assert.equal(overlapScore(a, b), 0);
    });

    it('returns 0 when either side is empty', () => {
      assert.equal(overlapScore(new Set(), new Set(['x'])), 0);
      assert.equal(overlapScore(new Set(['x']), new Set()), 0);
    });

    it('returns a partial overlap for shared tokens', () => {
      const a = new Set(['alpha', 'beta']);
      const b = new Set(['beta', 'gamma']);
      // intersection = 1, union = 3
      assert.equal(overlapScore(a, b), 1 / 3);
    });
  });

  describe('findSimilarOpenStories — ranking', () => {
    it('returns ranked candidates above the minScore floor with URLs', async () => {
      const provider = makeListProvider(WEBHOOK_STORIES);

      const seed = 'Detect duplicate webhook payloads via fingerprint hashing.';

      const out = await findSimilarOpenStories({
        seed,
        provider,
        owner: 'acme',
        repo: 'core',
      });

      assert.ok(out.length >= 1, 'at least one match expected');
      const ids = out.map((c) => c.id);
      assert.ok(ids.includes(101) || ids.includes(103));
      assert.ok(!ids.includes(102), 'unrelated Story must be filtered out');
      for (const c of out) {
        assert.ok(
          c.url.startsWith('https://github.com/acme/core/issues/'),
          `unexpected URL: ${c.url}`,
        );
        assert.ok(typeof c.score === 'number' && c.score > 0);
      }
      for (let i = 1; i < out.length; i += 1) {
        assert.ok(out[i - 1].score >= out[i].score);
      }
    });

    it('excludes source ticket ids from the ranking', async () => {
      const provider = makeListProvider([
        {
          id: 101,
          title: 'Webhook duplicate detection for incoming events',
          body: 'Detect duplicate webhook payloads by hashing the body.',
        },
        {
          id: 103,
          title: 'Webhook duplicate detection for incoming events',
          body: 'Detect duplicate webhook payloads by hashing the body.',
        },
      ]);
      const out = await findSimilarOpenStories({
        seed: 'Detect duplicate webhook payloads via fingerprint hashing.',
        provider,
        excludeIds: [101],
      });
      assert.ok(!out.some((c) => c.id === 101));
      assert.ok(out.some((c) => c.id === 103));
    });
  });

  describe('findSimilarOpenStories — search-narrowed path', () => {
    it('queries searchIssues with label/state/seed tokens and ranks that set', async () => {
      let seenQuery;
      const provider = makeSearchProvider(WEBHOOK_STORIES, {
        onSearch: (q) => {
          seenQuery = q;
        },
      });

      const seed = 'Detect duplicate webhook payloads via fingerprint hashing.';
      const out = await findSimilarOpenStories({
        seed,
        provider,
        owner: 'acme',
        repo: 'core',
      });

      assert.match(seenQuery, /label:"type::story"/);
      assert.match(seenQuery, /\bstate:open\b/);
      assert.match(seenQuery, /webhook/);
      assert.ok(out.length >= 1);
      assert.ok(out.some((c) => c.id === 101 || c.id === 103));
      assert.ok(!out.some((c) => c.id === 102));
      assert.ok(out.every((c) => typeof c.score === 'number'));
    });

    it('does not call listIssuesByLabel when search succeeds', async () => {
      let listCalled = false;
      const provider = {
        async searchIssues() {
          return [
            {
              number: 101,
              title: 'Webhook duplicate detection for incoming events',
              body: 'Detect duplicate webhook payloads by hashing the body.',
              state: 'open',
            },
          ];
        },
        async listIssuesByLabel() {
          listCalled = true;
          return [];
        },
      };
      await findSimilarOpenStories({
        seed: 'Detect duplicate webhook payloads via fingerprint hashing.',
        provider,
      });
      assert.equal(listCalled, false);
    });
  });

  describe('findSimilarOpenStories — search → list fallback', () => {
    it('falls back to listIssuesByLabel when searchIssues throws', async () => {
      let listCalled = false;
      const provider = {
        async searchIssues() {
          throw new Error('Search API unavailable');
        },
        async listIssuesByLabel(_filters) {
          listCalled = true;
          return WEBHOOK_STORIES.map((s) => ({
            number: s.id,
            title: s.title,
            body: s.body,
          }));
        },
      };

      const out = await findSimilarOpenStories({
        seed: 'Detect duplicate webhook payloads via fingerprint hashing.',
        provider,
        owner: 'acme',
        repo: 'core',
      });

      assert.equal(listCalled, true);
      assert.ok(out.length >= 1);
      assert.ok(out.some((c) => c.id === 101 || c.id === 103));
    });
  });

  describe('findSimilarOpenStories — no-match short-circuit', () => {
    it('returns [] when the provider has no open Stories', async () => {
      const provider = makeListProvider([]);
      const out = await findSimilarOpenStories({
        seed: 'A perfectly novel idea no one has ever proposed.',
        provider,
      });
      assert.deepEqual(out, []);
    });

    it('returns [] when nothing crosses the minScore threshold', async () => {
      const provider = makeListProvider([
        {
          id: 200,
          title: 'Completely unrelated topic',
          body: 'Nothing here resembles the seed at all.',
        },
      ]);
      const out = await findSimilarOpenStories({
        seed: 'Webhook fingerprint hashing service',
        provider,
        minScore: 0.5,
      });
      assert.deepEqual(out, []);
    });

    it('returns [] when the seed has no scoreable tokens', async () => {
      let fetched = false;
      const provider = {
        async listIssuesByLabel() {
          fetched = true;
          return [{ number: 1, title: 'Some Story', body: 'with content' }];
        },
      };
      const out = await findSimilarOpenStories({
        seed: 'a an the of', // all stopwords
        provider,
      });
      assert.deepEqual(out, []);
      assert.equal(fetched, false, 'must not hit the network for empty seeds');
    });
  });

  describe('findSimilarOpenStories — error propagation', () => {
    it('propagates listIssuesByLabel errors when search is unavailable', async () => {
      const boom = new Error('GitHub API rate limit exceeded');
      const provider = {
        async listIssuesByLabel() {
          throw boom;
        },
      };
      await assert.rejects(
        () =>
          findSimilarOpenStories({
            seed: 'something meaningful enough',
            provider,
          }),
        (err) => err === boom,
      );
    });

    it('propagates search errors when listIssuesByLabel is missing', async () => {
      const boom = new Error('Search API rate limit exceeded');
      const provider = {
        async searchIssues() {
          throw boom;
        },
      };
      await assert.rejects(
        () =>
          findSimilarOpenStories({
            seed: 'something meaningful enough',
            provider,
          }),
        (err) => err === boom,
      );
    });

    it('rejects missing seed', async () => {
      const provider = makeListProvider([]);
      await assert.rejects(
        () => findSimilarOpenStories({ seed: '', provider }),
        /seed must be a non-empty string/,
      );
    });

    it('rejects providers without searchIssues or listIssuesByLabel', async () => {
      await assert.rejects(
        () =>
          findSimilarOpenStories({
            seed: 'something meaningful enough',
            provider: {},
          }),
        /provider must implement searchIssues\(\) or listIssuesByLabel/,
      );
    });
  });
});
