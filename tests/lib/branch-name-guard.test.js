/**
 * branch-name-guard — canonical branch-name safety assertion.
 *
 * Covers the union of checks previously inlined in `git-branch-lifecycle.js`
 * and `git-branch-cleanup.js` (default behavior), plus the opt-in
 * protected-ref deny list (`main`, `master`, `HEAD`, `refs/*`) used by
 * destructive callers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertBranchSafe,
  isSafeBranchName,
  PROTECTED_BRANCH_NAMES,
} from '../../.agents/scripts/lib/branch-name-guard.js';

describe('isSafeBranchName — default mode (union of existing guards)', () => {
  for (const name of [
    'story-1081',
    'epic/1072',
    'feature/foo.bar_baz',
    'release/2026.05',
    'main', // accepted in default mode — base branches are forwarded as-is
    'master',
    'HEAD',
    'refs/heads/foo',
    'a',
    'A1',
  ]) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      assert.equal(isSafeBranchName(name), true);
    });
  }
});

describe('isSafeBranchName — rejects unsafe inputs in every mode', () => {
  const cases = [
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['object', {}],
    ['leading dash', '-foo'],
    ['leading dash protected', '--all'],
    ['whitespace', 'foo bar'],
    ['shell metachar $', 'foo$bar'],
    ['shell metachar ;', 'foo;rm'],
    ['glob *', 'foo*'],
    ['backtick', 'foo`bar'],
    ['quote', "foo'bar"],
  ];
  for (const [label, value] of cases) {
    it(`rejects ${label} in default mode`, () => {
      assert.equal(isSafeBranchName(value), false);
    });
    it(`rejects ${label} in protected mode`, () => {
      assert.equal(isSafeBranchName(value, { protected: true }), false);
    });
  }
});

describe('isSafeBranchName — protected mode adds deny list', () => {
  const protectedRejected = [
    'main',
    'master',
    'HEAD',
    'refs/heads/foo',
    'refs/tags/v1',
  ];
  for (const name of protectedRejected) {
    it(`rejects ${JSON.stringify(name)} when protected: true`, () => {
      assert.equal(isSafeBranchName(name, { protected: true }), false);
    });
  }
  it('still accepts story-* / epic/* names', () => {
    assert.equal(isSafeBranchName('story-1081', { protected: true }), true);
    assert.equal(isSafeBranchName('epic/1072', { protected: true }), true);
  });
});

describe('PROTECTED_BRANCH_NAMES', () => {
  it('includes main, master, and HEAD', () => {
    assert.deepEqual([...PROTECTED_BRANCH_NAMES].sort(), [
      'HEAD',
      'main',
      'master',
    ]);
  });
});

describe('assertBranchSafe — default mode', () => {
  it('returns void on safe names', () => {
    assert.equal(assertBranchSafe('story-1081'), undefined);
  });

  it('accepts multiple safe names in one call', () => {
    assert.doesNotThrow(() => assertBranchSafe('story-1', 'epic/2', 'main'));
  });

  it('throws on empty string', () => {
    assert.throws(() => assertBranchSafe(''), /Unsafe branch name/);
  });

  it('throws on leading dash', () => {
    assert.throws(() => assertBranchSafe('-rf'), /Unsafe branch name/);
  });

  it('throws on whitespace', () => {
    assert.throws(() => assertBranchSafe('foo bar'), /Unsafe branch name/);
  });

  it('throws when any subsequent argument is unsafe', () => {
    assert.throws(
      () => assertBranchSafe('story-1', 'foo bar'),
      /Unsafe branch name/,
    );
  });

  it('includes the offending value in the message', () => {
    try {
      assertBranchSafe('foo bar');
      assert.fail('expected to throw');
    } catch (err) {
      assert.match(err.message, /"foo bar"/);
    }
  });

  it('stringifies non-string offenders', () => {
    try {
      assertBranchSafe(null);
      assert.fail('expected to throw');
    } catch (err) {
      assert.match(err.message, /null/);
    }
  });
});

describe('assertBranchSafe — protected mode', () => {
  it('throws on main', () => {
    assert.throws(
      () => assertBranchSafe('main', { protected: true }),
      /Unsafe branch name/,
    );
  });

  it('throws on master', () => {
    assert.throws(
      () => assertBranchSafe('master', { protected: true }),
      /Unsafe branch name/,
    );
  });

  it('throws on HEAD', () => {
    assert.throws(
      () => assertBranchSafe('HEAD', { protected: true }),
      /Unsafe branch name/,
    );
  });

  it('throws on refs/* prefix', () => {
    assert.throws(
      () => assertBranchSafe('refs/heads/main', { protected: true }),
      /Unsafe branch name/,
    );
  });

  it('passes safe story branch in protected mode', () => {
    assert.doesNotThrow(() =>
      assertBranchSafe('story-1', 'epic/2', { protected: true }),
    );
  });

  it('mentions protected refs in error message', () => {
    try {
      assertBranchSafe('main', { protected: true });
      assert.fail('expected to throw');
    } catch (err) {
      assert.match(err.message, /protected/i);
    }
  });
});
