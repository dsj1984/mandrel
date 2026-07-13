/**
 * Unit tests for the v2 spec spill-to-doc helper.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SPEC_BODY_TOKEN_BUDGET,
  sanitizeStoryId,
  spillSpecIfOverBudget,
} from '../../../.agents/scripts/lib/orchestration/spec-spill.js';

/** In-memory fs double capturing writes. */
function fakeFs() {
  const writes = new Map();
  const dirs = [];
  return {
    writes,
    dirs,
    writeFileSync: (p, c) => writes.set(p, c),
    mkdirSync: (p) => dirs.push(p),
  };
}

describe('sanitizeStoryId', () => {
  it('strips leading #, lowercases, and slugs unsafe runs', () => {
    assert.equal(sanitizeStoryId('#4512'), '4512');
    assert.equal(sanitizeStoryId('Story/Foo Bar!'), 'story-foo-bar');
    assert.equal(sanitizeStoryId('  keep_this.one  '), 'keep_this.one');
  });
});

describe('spillSpecIfOverBudget — under budget', () => {
  it('keeps a small spec inline and writes nothing', () => {
    const io = fakeFs();
    const res = spillSpecIfOverBudget(
      { storyId: 's1', spec: 'short spec' },
      { fs: io },
    );
    assert.equal(res.spilled, false);
    assert.equal(res.docPath, null);
    assert.equal(res.reference, null);
    assert.equal(res.content, 'short spec');
    assert.equal(io.writes.size, 0);
  });
});

describe('spillSpecIfOverBudget — over budget', () => {
  const bigSpec = 'x'.repeat((DEFAULT_SPEC_BODY_TOKEN_BUDGET + 100) * 4);

  it('spills to docs/specs/<id>.md and returns a references entry', () => {
    const io = fakeFs();
    const res = spillSpecIfOverBudget(
      { storyId: '#4512', spec: bigSpec },
      { fs: io, repoRoot: '/repo' },
    );
    assert.equal(res.spilled, true);
    assert.equal(res.docPath, 'docs/specs/4512.md');
    assert.deepEqual(res.reference, {
      path: 'docs/specs/4512.md',
      assumption: 'creates',
    });
    assert.equal(io.writes.get('/repo/docs/specs/4512.md'), `${bigSpec}\n`);
    assert.deepEqual(io.dirs, ['/repo/docs/specs']);
  });

  it('honors a custom budget and specsDir', () => {
    const io = fakeFs();
    const res = spillSpecIfOverBudget(
      { storyId: 's1', spec: 'x'.repeat(41) },
      { fs: io, tokenBudget: 10, specsDir: 'specs', repoRoot: '/r' },
    );
    assert.equal(res.spilled, true); // 41 chars ≈ 11 tokens > 10
    assert.equal(res.docPath, 'specs/s1.md');
  });

  it('does not write when opts.write is false (dry run)', () => {
    const io = fakeFs();
    const res = spillSpecIfOverBudget(
      { storyId: 's1', spec: bigSpec },
      { fs: io, write: false },
    );
    assert.equal(res.spilled, true);
    assert.equal(res.docPath, 'docs/specs/s1.md');
    assert.equal(io.writes.size, 0);
  });

  it('throws when an over-budget spec has no usable storyId', () => {
    assert.throws(
      () =>
        spillSpecIfOverBudget(
          { storyId: '  ', spec: bigSpec },
          { write: false },
        ),
      /non-empty storyId is required/,
    );
  });
});
