/**
 * Unit tests for the pure helpers extracted from `git-probes.js` and
 * `prompts.js` during the CRAP-40 ratchet (Story #3417). These cover the
 * SHA-normalisation, ls-remote parsing, and stash-decision logic without
 * any git, prompt, or filesystem I/O — the impure wrappers (`branchTipSha`,
 * `promptStashDecision`) stay exercised by the integration suites.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing as probeTesting } from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/git-probes.js';
import { decideStashAnswer } from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/prompts.js';

const { validSha, firstLsRemoteSha } = probeTesting;

describe('validSha', () => {
  it('returns the trimmed SHA when it matches the 7-40 hex shape', () => {
    assert.equal(validSha('  abc1234  '), 'abc1234');
    assert.equal(
      validSha('0123456789abcdef0123456789abcdef01234567'),
      '0123456789abcdef0123456789abcdef01234567',
    );
  });

  it('returns null for non-hex, too-short, or empty input', () => {
    assert.equal(validSha('zzz'), null);
    assert.equal(validSha('abc12'), null); // 5 chars < 7
    assert.equal(validSha(''), null);
    assert.equal(validSha(null), null);
    assert.equal(validSha(undefined), null);
  });
});

describe('firstLsRemoteSha', () => {
  it('extracts the leading SHA token from the first non-empty line', () => {
    const stdout = 'deadbeef1234\trefs/heads/main\nfeedface5678\trefs/heads/x\n';
    assert.equal(firstLsRemoteSha(stdout), 'deadbeef1234');
  });

  it('skips leading blank lines before the SHA line', () => {
    const stdout = '\n   \nabc1234 refs/heads/main\n';
    assert.equal(firstLsRemoteSha(stdout), 'abc1234');
  });

  it('returns empty string when stdout has no usable line', () => {
    assert.equal(firstLsRemoteSha(''), '');
    assert.equal(firstLsRemoteSha('\n\n   \n'), '');
  });
});

describe('decideStashAnswer', () => {
  it('maps drop synonyms to "drop"', () => {
    for (const ans of ['d', 'drop', 'y', 'yes', 'DROP', '  Yes  ']) {
      assert.equal(decideStashAnswer(ans), 'drop', `answer=${ans}`);
    }
  });

  it('maps quit synonyms to "quit"', () => {
    for (const ans of ['q', 'quit', 'QUIT', ' q ']) {
      assert.equal(decideStashAnswer(ans), 'quit', `answer=${ans}`);
    }
  });

  it('defaults everything else (including empty/null) to "keep"', () => {
    for (const ans of ['', 'k', 'keep', 'maybe', null, undefined]) {
      assert.equal(decideStashAnswer(ans), 'keep', `answer=${ans}`);
    }
  });
});
