import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { replaceBeneathCloses } from '../../.agents/scripts/lib/pr-body-lines.js';

const isOwned = (line) => line.startsWith('Owned:');

describe('replaceBeneathCloses', () => {
  test('places the block directly beneath the Closes line', () => {
    const body = 'Summary\n\nCloses #12\n\nDetails';
    assert.equal(
      replaceBeneathCloses(body, isOwned, ['', 'Owned: a']),
      'Summary\n\nCloses #12\n\nOwned: a\n\nDetails',
    );
  });

  test('replaces earlier owned lines and the blank line each followed', () => {
    const body = 'Closes #3\n\nOwned: old\nTail';
    assert.equal(
      replaceBeneathCloses(body, isOwned, ['', 'Owned: new']),
      'Closes #3\n\nOwned: new\nTail',
    );
  });

  test('keeps a non-blank line that precedes an owned line', () => {
    const body = 'Closes #3\nNote\nOwned: old';
    assert.equal(replaceBeneathCloses(body, isOwned, []), 'Closes #3\nNote');
  });

  test('appends the block when the body has no Closes line', () => {
    assert.equal(
      replaceBeneathCloses('Summary', isOwned, ['Owned: a']),
      'Summary\nOwned: a',
    );
  });

  test('removes owned lines from a CRLF body', () => {
    const body = 'Closes #3\r\n\r\nOwned: old\r\nTail';
    assert.equal(
      replaceBeneathCloses(body, isOwned, ['', 'Owned: new']),
      'Closes #3\n\nOwned: new\nTail',
    );
  });

  test('treats a missing body as empty', () => {
    assert.equal(
      replaceBeneathCloses(null, isOwned, ['Owned: a']),
      '\nOwned: a',
    );
    assert.equal(replaceBeneathCloses(undefined, isOwned, []), '');
  });
});
