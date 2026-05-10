/**
 * tests/lib/duplicate-search.test.js — unit tests for the cross-Epic
 * duplicate detector used by `/epic-plan` Phase 0b.
 *
 * Covers:
 *  - overlap scoring (Jaccard) returns expected ordering and respects
 *    stopword filtering
 *  - empty/no-match short-circuit returns []
 *  - provider errors propagate verbatim
 *  - input validation rejects missing onePager / provider
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findSimilarOpenEpics,
  overlapScore,
  tokenize,
} from '../../.agents/scripts/lib/duplicate-search.js';

function makeProvider(epics) {
  return {
    async getEpics(_filters) {
      return epics;
    },
  };
}

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

  describe('findSimilarOpenEpics — ranking', () => {
    it('returns ranked candidates above the minScore floor with URLs', async () => {
      const provider = makeProvider([
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
      ]);

      const onePager =
        'Detect duplicate webhook payloads via fingerprint hashing.';

      const out = await findSimilarOpenEpics({
        onePager,
        provider,
        owner: 'acme',
        repo: 'core',
      });

      assert.ok(out.length >= 1, 'at least one match expected');
      // Both webhook epics should be ranked above the marketing one (which
      // should not appear at all).
      const ids = out.map((c) => c.id);
      assert.ok(ids.includes(101) || ids.includes(103));
      assert.ok(!ids.includes(102), 'unrelated epic must be filtered out');
      // URL is built from owner/repo
      for (const c of out) {
        assert.ok(
          c.url.startsWith('https://github.com/acme/core/issues/'),
          `unexpected URL: ${c.url}`,
        );
        assert.ok(typeof c.score === 'number' && c.score > 0);
      }
      // Highest score ranks first
      for (let i = 1; i < out.length; i += 1) {
        assert.ok(out[i - 1].score >= out[i].score);
      }
    });
  });

  describe('findSimilarOpenEpics — no-match short-circuit', () => {
    it('returns [] when the provider has no open epics', async () => {
      const provider = makeProvider([]);
      const out = await findSimilarOpenEpics({
        onePager: 'A perfectly novel idea no one has ever proposed.',
        provider,
      });
      assert.deepEqual(out, []);
    });

    it('returns [] when nothing crosses the minScore threshold', async () => {
      const provider = makeProvider([
        {
          id: 200,
          title: 'Completely unrelated topic',
          body: 'Nothing here resembles the seed at all.',
        },
      ]);
      const out = await findSimilarOpenEpics({
        onePager: 'Webhook fingerprint hashing service',
        provider,
        minScore: 0.5,
      });
      assert.deepEqual(out, []);
    });

    it('returns [] when the onePager has no scoreable tokens', async () => {
      const provider = makeProvider([
        { id: 1, title: 'Some Epic', body: 'with content' },
      ]);
      const out = await findSimilarOpenEpics({
        onePager: 'a an the of', // all stopwords
        provider,
      });
      assert.deepEqual(out, []);
    });
  });

  describe('findSimilarOpenEpics — error propagation', () => {
    it('propagates provider errors verbatim', async () => {
      const boom = new Error('GitHub API rate limit exceeded');
      const provider = {
        async getEpics() {
          throw boom;
        },
      };
      await assert.rejects(
        () =>
          findSimilarOpenEpics({
            onePager: 'something',
            provider,
          }),
        (err) => err === boom,
      );
    });

    it('rejects missing onePager', async () => {
      const provider = makeProvider([]);
      await assert.rejects(
        () => findSimilarOpenEpics({ onePager: '', provider }),
        /onePager must be a non-empty string/,
      );
    });

    it('rejects providers without getEpics', async () => {
      await assert.rejects(
        () =>
          findSimilarOpenEpics({
            onePager: 'something',
            provider: {},
          }),
        /provider must implement getEpics/,
      );
    });
  });
});
