/**
 * Unit tests for `lib/orchestration/resolves-token.js`
 * (Epic #3316 / Story #3346 — single-source the `(resolves #N)` marker).
 *
 * Pure-function coverage of the four public exports plus the boundary-safe
 * matching invariant: a Story id that is a prefix of another id, and prose
 * that merely mentions "resolves #N", must not false-match.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseResolvesStoryId,
  RESOLVES_TRAILER_RE,
  resolvesGrepArgs,
  resolvesToken,
} from '../../../.agents/scripts/lib/orchestration/resolves-token.js';

describe('resolvesToken', () => {
  it('emits the exact ` (resolves #N)` suffix the runtime already writes', () => {
    // Backward-compat anchor: peer closes in flight wrote this exact text.
    assert.equal(resolvesToken(3346), ' (resolves #3346)');
  });

  it('accepts a string storyId without coercion artifacts', () => {
    assert.equal(resolvesToken('42'), ' (resolves #42)');
  });
});

describe('RESOLVES_TRAILER_RE', () => {
  it('captures the digits of the trailer', () => {
    const m = RESOLVES_TRAILER_RE.exec('feat: do a thing (resolves #1851)');
    assert.ok(m);
    assert.equal(m[1], '1851');
  });

  it('matches case-insensitively', () => {
    assert.ok(RESOLVES_TRAILER_RE.test('chore: x (Resolves #7)'));
  });

  it('does not match bare prose without the parenthesized form', () => {
    assert.equal(
      RESOLVES_TRAILER_RE.test('this resolves #7 eventually'),
      false,
    );
  });

  it('is stateless (no global flag) across repeated tests', () => {
    const s = 'feat: y (resolves #9)';
    assert.ok(RESOLVES_TRAILER_RE.test(s));
    assert.ok(RESOLVES_TRAILER_RE.test(s));
  });
});

describe('parseResolvesStoryId', () => {
  it('parses the Story id out of a canonical merge subject', () => {
    assert.equal(
      parseResolvesStoryId('feat(scope): title (resolves #2466)'),
      2466,
    );
  });

  it('returns null when no trailer is present', () => {
    assert.equal(parseResolvesStoryId('chore: unrelated commit'), null);
  });

  it('returns null for prose mentioning resolves #N without parens', () => {
    assert.equal(
      parseResolvesStoryId('docs: explain how it resolves #5'),
      null,
    );
  });

  it('returns null for non-string input', () => {
    assert.equal(parseResolvesStoryId(undefined), null);
    assert.equal(parseResolvesStoryId(null), null);
    assert.equal(parseResolvesStoryId(123), null);
  });
});

describe('resolvesGrepArgs (boundary-safe matching)', () => {
  // `resolvesGrepArgs` returns the `-E --grep=...` argument list. We can
  // assert the boundary-safe contract without spawning git by compiling
  // the emitted POSIX-extended pattern into a JS RegExp and probing it
  // against the canonical merge subjects.
  function grepRegex(storyId) {
    const args = resolvesGrepArgs(storyId);
    assert.equal(args[0], '-E');
    const pattern = args[1].replace(/^--grep=/, '');
    return new RegExp(pattern);
  }

  it('returns the `-E` flag and a `--grep=` pattern', () => {
    const args = resolvesGrepArgs(12);
    assert.deepEqual(args, ['-E', '--grep=resolves #12( |\\)|$)']);
  });

  it('matches a canonical merge subject for the exact id', () => {
    const re = grepRegex(12);
    assert.ok(re.test('feat: thing (resolves #12)'));
  });

  it('does not false-match a longer id that shares the prefix', () => {
    // The crux: grepping for #12 must not match a subject naming #1234.
    const re = grepRegex(12);
    assert.equal(re.test('feat: thing (resolves #1234)'), false);
  });

  it('does not false-match a shorter id whose digits the prefix contains', () => {
    const re = grepRegex(1234);
    assert.equal(re.test('feat: thing (resolves #12)'), false);
  });

  it('matches when the trailer is followed by a space (non-canonical placement)', () => {
    const re = grepRegex(12);
    assert.ok(re.test('feat: resolves #12 mid-subject thing'));
  });
});
