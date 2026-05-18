import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { componentMatches } from '../../.agents/scripts/lib/baselines/component-matcher.js';

// ---------------------------------------------------------------------------
// component-matcher.test.js — pin the shared componentMatches predicate
// extracted in Story #2464. Six baseline-kind modules previously shipped
// byte-equivalent copies of this function. The contract is:
//
//   (a) nullish or shape-invalid components never match
//   (b) exact-equal paths/routes match
//   (c) directory-prefix-with-slash matches
//   (d) bare prefix without a trailing slash does NOT match (avoids
//       `lib` matching `library/foo.js`)
// ---------------------------------------------------------------------------

describe('componentMatches()', () => {
  describe('null and invalid components', () => {
    it('returns false for null component', () => {
      assert.equal(componentMatches(null, 'src/foo.js'), false);
    });

    it('returns false for undefined component', () => {
      assert.equal(componentMatches(undefined, 'src/foo.js'), false);
    });

    it('returns false when component lacks an includes field', () => {
      assert.equal(componentMatches({}, 'src/foo.js'), false);
    });

    it('returns false when includes is not a string', () => {
      assert.equal(componentMatches({ includes: 123 }, 'src/foo.js'), false);
      assert.equal(componentMatches({ includes: null }, 'src/foo.js'), false);
      assert.equal(componentMatches({ includes: [] }, 'src/foo.js'), false);
    });
  });

  describe('exact match', () => {
    it('returns true when path equals includes exactly', () => {
      assert.equal(
        componentMatches({ includes: 'src/foo.js' }, 'src/foo.js'),
        true,
      );
    });

    it('treats the bare directory name as an exact match', () => {
      assert.equal(componentMatches({ includes: 'src' }, 'src'), true);
    });
  });

  describe('prefix match', () => {
    it('returns true for a path under the includes directory', () => {
      assert.equal(componentMatches({ includes: 'src' }, 'src/foo.js'), true);
    });

    it('returns true for a deeply nested path under the includes directory', () => {
      assert.equal(
        componentMatches({ includes: 'src' }, 'src/a/b/c/foo.js'),
        true,
      );
    });

    it('requires a trailing slash so `lib` does not match `library/foo.js`', () => {
      assert.equal(
        componentMatches({ includes: 'lib' }, 'library/foo.js'),
        false,
      );
    });
  });

  describe('route-shape inputs (lighthouse)', () => {
    // The matcher is identity-or-prefix-with-slash, so it works against
    // any string key — `path` for code rows or `route` for lighthouse rows.
    it('matches a route equal to includes', () => {
      assert.equal(componentMatches({ includes: '/' }, '/'), true);
    });

    it('matches a sub-route prefixed by includes', () => {
      assert.equal(
        componentMatches({ includes: 'dashboard' }, 'dashboard/settings'),
        true,
      );
    });

    it('rejects a sibling route that only shares a prefix substring', () => {
      assert.equal(componentMatches({ includes: 'dash' }, 'dashboard'), false);
    });
  });
});
