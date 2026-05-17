import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalizeBaselinePath } from '../../lib/baselines/canonicalize-path.js';

// ---------------------------------------------------------------------------
// canonicalize-path.test.js — pin every rule in the
// canonicalizeBaselinePath() pipeline plus idempotency. Story #2192,
// Epic #2173 (Unified Baseline Refresh Service).
//
// The helper is the single funnel that converts raw filesystem paths (as
// they appear in git diff output or tool reports) into the byte-identical
// POSIX key shape that the refresh service and gate reader compare against.
// Every rule it enforces is asserted explicitly so downstream determinism
// tests can rely on the property without re-proving it.
// ---------------------------------------------------------------------------

describe('canonicalizeBaselinePath()', () => {
  describe('windows drive-letter stripping', () => {
    it("strips a 'C:\\\\' drive prefix and normalises separators", () => {
      assert.equal(canonicalizeBaselinePath('C:\\a\\b'), 'a/b');
    });

    it("strips a forward-slash drive prefix ('C:/foo/bar')", () => {
      assert.equal(canonicalizeBaselinePath('C:/foo/bar'), 'foo/bar');
    });

    it('accepts a lower-case drive letter', () => {
      assert.equal(canonicalizeBaselinePath('d:\\proj\\src\\index.js'), 'proj/src/index.js');
    });
  });

  describe('mixed separator normalisation', () => {
    it("rewrites every '\\\\' to '/'", () => {
      assert.equal(canonicalizeBaselinePath('src\\baselines\\foo.js'), 'src/baselines/foo.js');
    });

    it('normalises a mixed-separator path', () => {
      assert.equal(canonicalizeBaselinePath('src/baselines\\foo.js'), 'src/baselines/foo.js');
    });
  });

  describe('UNC share stripping', () => {
    it("strips a '//server/share/' UNC prefix", () => {
      assert.equal(
        canonicalizeBaselinePath('//server/share/repo/src/foo.js'),
        'repo/src/foo.js',
      );
    });

    it("strips a backslash UNC prefix ('\\\\\\\\server\\\\share\\\\...')", () => {
      assert.equal(
        canonicalizeBaselinePath('\\\\server\\share\\repo\\src\\foo.js'),
        'repo/src/foo.js',
      );
    });
  });

  describe('redundant separator collapsing', () => {
    it("collapses '//' into a single '/'", () => {
      assert.equal(canonicalizeBaselinePath('src//foo.js'), 'src/foo.js');
    });

    it("collapses '///' (three or more) into a single '/'", () => {
      assert.equal(canonicalizeBaselinePath('src///foo.js'), 'src/foo.js');
    });

    it("strips a leading './'", () => {
      assert.equal(canonicalizeBaselinePath('./src/foo.js'), 'src/foo.js');
    });

    it('strips a leading POSIX absolute slash', () => {
      assert.equal(canonicalizeBaselinePath('/abs/path/foo.js'), 'abs/path/foo.js');
    });
  });

  describe('non-string rejection', () => {
    it('throws TypeError on null', () => {
      assert.throws(() => canonicalizeBaselinePath(null), TypeError);
    });

    it('throws TypeError on undefined', () => {
      assert.throws(() => canonicalizeBaselinePath(undefined), TypeError);
    });

    it('throws TypeError on a number', () => {
      assert.throws(() => canonicalizeBaselinePath(42), TypeError);
    });

    it('throws TypeError on an object', () => {
      assert.throws(() => canonicalizeBaselinePath({}), TypeError);
    });
  });

  describe('idempotency', () => {
    const inputs = [
      'src/foo.js',
      'src\\foo.js',
      'C:\\a\\b',
      'C:/a/b',
      './src/foo.js',
      'src//foo.js',
      '//server/share/repo/src/foo.js',
      'D:\\proj\\src\\baselines\\foo.js',
      '/abs/path/foo.js',
    ];

    for (const input of inputs) {
      it(`canonicalize twice produces the same string for ${JSON.stringify(input)}`, () => {
        const once = canonicalizeBaselinePath(input);
        const twice = canonicalizeBaselinePath(once);
        assert.equal(once, twice);
      });
    }
  });
});
