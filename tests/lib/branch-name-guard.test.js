/**
 * branch-name-guard — canonical branch-name safety assertion.
 *
 * Covers the union of checks previously inlined in `git-branch-lifecycle.js`
 * and `git-branch-cleanup.js`, plus the explicit protected-ref deny list
 * (`main`, `master`, `HEAD`, `refs/*`) and the leading-dash trap.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertBranchSafe,
  isSafeBranchName,
} from '../../.agents/scripts/lib/branch-name-guard.js';

describe('isSafeBranchName — accepts well-formed branch names', () => {
  for (const name of [
    'story-1081',
    'epic/1072',
    'feature/foo.bar_baz',
    'release/2026.05',
    'a',
    'A1',
    'Main', // case-sensitive — only lowercase main/master are protected
    'MASTER',
    'head', // only canonical HEAD is rejected
  ]) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      assert.equal(isSafeBranchName(name), true);
    });
  }
});

describe('isSafeBranchName — rejects unsafe inputs', () => {
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
    ['main protected', 'main'],
    ['master protected', 'master'],
    ['HEAD protected', 'HEAD'],
    ['refs/heads/foo', 'refs/heads/foo'],
    ['refs/tags/v1', 'refs/tags/v1'],
  ];
  for (const [label, value] of cases) {
    it(`rejects ${label}`, () => {
      assert.equal(isSafeBranchName(value), false);
    });
  }
});

describe('assertBranchSafe', () => {
  it('returns void on safe names', () => {
    assert.equal(assertBranchSafe('story-1081'), undefined);
  });

  it('accepts multiple safe names in one call', () => {
    assert.doesNotThrow(() => assertBranchSafe('story-1', 'epic/2', 'main2'));
  });

  it('throws on the first unsafe name', () => {
    assert.throws(() => assertBranchSafe('main'), /Unsafe branch name/);
  });

  it('throws on empty string', () => {
    assert.throws(() => assertBranchSafe(''), /Unsafe branch name/);
  });

  it('throws on HEAD', () => {
    assert.throws(() => assertBranchSafe('HEAD'), /Unsafe branch name/);
  });

  it('throws on leading dash', () => {
    assert.throws(() => assertBranchSafe('-rf'), /Unsafe branch name/);
  });

  it('throws on refs/* prefix', () => {
    assert.throws(
      () => assertBranchSafe('refs/heads/main'),
      /Unsafe branch name/,
    );
  });

  it('throws when any subsequent argument is unsafe', () => {
    assert.throws(
      () => assertBranchSafe('story-1', 'master'),
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
