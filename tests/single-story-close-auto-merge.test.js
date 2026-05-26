/**
 * tests/single-story-close-auto-merge.test.js — unit tests for the
 * auto-merge helpers added to `single-story-close.js` (Story #1815).
 *
 * Covers:
 *   - `parsePrNumber` parses well-formed PR URLs and rejects junk.
 *   - `enableAutoMerge` returns `{ enabled: true }` on `gh` exit 0 and
 *     `{ enabled: false, reason }` on non-zero / spawn errors.
 *   - Spawn args wire `--auto --squash --delete-branch` so GitHub merges
 *     the PR when required checks pass and deletes the source branch.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  enableAutoMerge,
  parsePrNumber,
} from '../.agents/scripts/single-story-close.js';

describe('parsePrNumber', () => {
  it('extracts the numeric id from a canonical GitHub PR URL', () => {
    assert.equal(
      parsePrNumber('https://github.com/dsj1984/mandrel/pull/1815'),
      1815,
    );
  });

  it('handles trailing slashes', () => {
    assert.equal(
      parsePrNumber('https://github.com/dsj1984/mandrel/pull/1815/'),
      1815,
    );
  });

  it('handles query strings and fragments', () => {
    assert.equal(
      parsePrNumber('https://github.com/owner/repo/pull/42?diff=split#diff-1'),
      42,
    );
  });

  it('returns null for URLs without /pull/<n>', () => {
    assert.equal(
      parsePrNumber('https://github.com/dsj1984/mandrel/issues/1815'),
      null,
    );
    assert.equal(parsePrNumber('https://github.com/dsj1984/mandrel'), null);
  });

  it('returns null for non-string inputs', () => {
    assert.equal(parsePrNumber(null), null);
    assert.equal(parsePrNumber(undefined), null);
    assert.equal(parsePrNumber(42), null);
  });
});

describe('enableAutoMerge', () => {
  it('passes --auto --squash --delete-branch to gh and reports enabled on exit 0', async () => {
    let capturedArgs = null;
    let capturedOpts = null;
    const runner = (args, opts) => {
      capturedArgs = args;
      capturedOpts = opts;
      return { status: 0, stdout: 'ok', stderr: '' };
    };
    const result = await enableAutoMerge({
      cwd: '/repo',
      prNumber: 123,
      runner,
    });
    assert.deepEqual(result, { enabled: true });
    assert.deepEqual(capturedArgs, [
      'pr',
      'merge',
      '123',
      '--auto',
      '--squash',
      '--delete-branch',
    ]);
    assert.deepEqual(capturedOpts, { cwd: '/repo' });
  });

  it('reports enabled:false with reason when gh exits non-zero', async () => {
    const runner = () => ({
      status: 22,
      stdout: '',
      stderr: 'Pull request not in a state allowing auto-merge.',
    });
    const result = await enableAutoMerge({
      cwd: '/repo',
      prNumber: 123,
      runner,
    });
    assert.equal(result.enabled, false);
    assert.match(result.reason, /gh-exit-22/);
    assert.match(result.reason, /allowing auto-merge/);
  });

  it('reports enabled:false on spawn errors', async () => {
    const runner = () => {
      throw new Error('ENOENT: gh not installed');
    };
    const result = await enableAutoMerge({
      cwd: '/repo',
      prNumber: 123,
      runner,
    });
    assert.equal(result.enabled, false);
    assert.match(result.reason, /gh-spawn-error/);
    assert.match(result.reason, /ENOENT/);
  });

  it('truncates very long stderr to keep the reason field readable', async () => {
    const longStderr = 'x'.repeat(500);
    const runner = () => ({ status: 1, stderr: longStderr });
    const result = await enableAutoMerge({
      cwd: '/repo',
      prNumber: 123,
      runner,
    });
    assert.ok(result.reason.length < 250);
  });
});
