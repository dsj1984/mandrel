import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertCanonical,
  canonicalise,
} from '../../.agents/scripts/lib/baselines/path-canon.js';

// ---------------------------------------------------------------------------
// path-canon.test.js — pin every rule in the canonicalisation pipeline plus
// idempotency. Story #1891, Epic #1786.
//
// The canonicaliser is the single authority for baseline row keys. Every
// rule it enforces is covered here; downstream writer / reader tests assume
// these properties hold and do not re-prove them.
// ---------------------------------------------------------------------------

describe('canonicalise()', () => {
  describe('worktree-prefix stripping', () => {
    it("strips '.worktrees/<workspace>/' prefix", () => {
      assert.equal(canonicalise('.worktrees/story-1/src/foo.ts'), 'src/foo.ts');
    });

    it('strips the prefix when the workspace name contains hyphens and digits', () => {
      assert.equal(
        canonicalise('.worktrees/story-1891-abc/.agents/scripts/x.js'),
        '.agents/scripts/x.js',
      );
    });

    it('only strips a single leading worktree segment (never recursive)', () => {
      // Nested worktrees-of-worktrees are not a real layout, but if the
      // prefix appeared twice we'd want to strip only one — the inner one
      // is a legitimate directory the user named '.worktrees'.
      assert.equal(
        canonicalise('.worktrees/story-1/.worktrees/inner/foo.js'),
        '.worktrees/inner/foo.js',
      );
    });

    it('does not strip when the path merely contains .worktrees mid-stream', () => {
      assert.equal(
        canonicalise('src/.worktrees/story-1/foo.js'),
        'src/.worktrees/story-1/foo.js',
      );
    });
  });

  describe('separator normalisation', () => {
    it("converts backslashes to forward slashes ('src\\\\foo.ts' → 'src/foo.ts')", () => {
      assert.equal(canonicalise('src\\foo.ts'), 'src/foo.ts');
    });

    it('normalises a mixed-separator worktree-prefixed path', () => {
      assert.equal(
        canonicalise('.worktrees\\story-1\\src\\foo.ts'),
        'src/foo.ts',
      );
    });
  });

  describe('leading "./" stripping', () => {
    it("strips a leading './'", () => {
      assert.equal(canonicalise('./src/foo.ts'), 'src/foo.ts');
    });

    it("strips './' that emerges after the worktree prefix is removed", () => {
      // A `.\src` after worktree-stripping normalises to `./src` then to `src`.
      assert.equal(
        canonicalise('.worktrees/story-1/./src/foo.ts'),
        'src/foo.ts',
      );
    });
  });

  describe('double-slash collapse', () => {
    it('collapses accidental // segments into a single /', () => {
      assert.equal(canonicalise('src//foo.ts'), 'src/foo.ts');
    });
  });

  describe('rejections', () => {
    it("throws on POSIX absolute paths ('/abs/path')", () => {
      assert.throws(() => canonicalise('/abs/path'), /absolute paths/);
    });

    it("throws on Windows drive-letter absolute paths ('C:\\\\foo')", () => {
      assert.throws(() => canonicalise('C:\\foo'), /absolute paths/);
    });

    it("throws on Windows drive-letter with forward slash ('C:/foo')", () => {
      assert.throws(() => canonicalise('C:/foo'), /absolute paths/);
    });

    it('throws on .. traversal segments', () => {
      assert.throws(() => canonicalise('src/../evil.js'), /\.\./);
    });

    it('throws on .. with backslash separators', () => {
      assert.throws(() => canonicalise('src\\..\\evil.js'), /\.\./);
    });

    it('throws on empty input', () => {
      assert.throws(() => canonicalise(''), /non-empty/);
    });

    it('throws on non-string input', () => {
      assert.throws(() => canonicalise(null), TypeError);
      assert.throws(() => canonicalise(undefined), TypeError);
      assert.throws(() => canonicalise(42), TypeError);
    });
  });

  describe('idempotency', () => {
    const inputs = [
      'src/foo.ts',
      '.worktrees/story-1/src/foo.ts',
      'src\\foo.ts',
      './src/foo.ts',
      'src//foo.ts',
      '.worktrees\\story-1\\.\\src\\foo.ts',
      '.agents/scripts/lib/baselines/writer.js',
    ];

    for (const input of inputs) {
      it(`canonicalise twice produces the same string for "${input}"`, () => {
        const once = canonicalise(input);
        const twice = canonicalise(once);
        assert.equal(once, twice);
      });
    }
  });
});

describe('assertCanonical()', () => {
  it('accepts a canonical path', () => {
    assert.doesNotThrow(() => assertCanonical('src/foo.ts'));
    assert.doesNotThrow(() =>
      assertCanonical('.agents/scripts/lib/baselines/writer.js'),
    );
  });

  it("throws with a clear error message for '/abs/path'", () => {
    assert.throws(() => assertCanonical('/abs/path'), {
      message: /absolute paths are forbidden/,
    });
  });

  it('throws on a backslash-containing path', () => {
    assert.throws(() => assertCanonical('src\\foo.ts'), /backslash/);
  });

  it('throws on a leading ./', () => {
    assert.throws(() => assertCanonical('./src/foo.ts'), /leading/);
  });

  it("throws on a leading '.worktrees/<workspace>/' prefix", () => {
    assert.throws(
      () => assertCanonical('.worktrees/story-1/src/foo.ts'),
      /\.worktrees/,
    );
  });

  it('throws on double-slash segments', () => {
    assert.throws(() => assertCanonical('src//foo.ts'), /double-slash/);
  });

  it('throws on traversal segments', () => {
    assert.throws(() => assertCanonical('src/../evil.js'), /\.\./);
  });

  it('throws on empty input', () => {
    assert.throws(() => assertCanonical(''), /non-empty/);
  });

  it('throws on non-string input', () => {
    assert.throws(() => assertCanonical(null), TypeError);
  });
});
