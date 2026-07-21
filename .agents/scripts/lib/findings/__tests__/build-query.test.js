/**
 * Unit tests for `buildQuery` bounding (Story #4678, AC-4).
 *
 * The query is filled highest-signal-first (title, area, primaryFile basename)
 * up to a character budget on a whole-token boundary, so a long title over a
 * deep path never exceeds GitHub Search's length limit — and it carries the
 * file basename, not the full mangled path.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildQuery } from '../semantic-issue-search.js';

describe('buildQuery bounding', () => {
  it('keeps a short finding query intact and uses the primaryFile basename', () => {
    const q = buildQuery({
      title: 'SQLi in login',
      area: 'security',
      primaryFile: 'src/auth/login.js',
    });
    assert.equal(q, 'sqli in login security login js');
  });

  it('bounds a long title over a deep path to the budget, on a token boundary', () => {
    const longTitle = Array.from({ length: 80 }, (_, i) => `word${i}`).join(
      ' ',
    );
    const budget = 100;
    const q = buildQuery(
      {
        title: longTitle,
        area: 'clean-code',
        primaryFile: 'src/very/deeply/nested/mangled/path/module-name.js',
      },
      { budget },
    );

    assert.ok(
      q.length <= budget,
      `q is ${q.length} chars, must be <= ${budget}`,
    );
    // Whole-token boundary: every kept token is intact (no partial `wordNN`).
    for (const tok of q.split(' ')) {
      assert.match(tok, /^word\d+$/, `token "${tok}" is whole`);
    }
  });

  it('emits the file basename rather than the full path', () => {
    const q = buildQuery({
      title: 'race in scheduler',
      area: '',
      primaryFile: 'a/b/c/d/scheduler-core.js',
    });
    assert.ok(q.includes('scheduler'), 'basename token present');
    assert.ok(!q.includes('a b c d'), 'the full path segments are absent');
  });
});
