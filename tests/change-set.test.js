/**
 * tests/change-set.test.js — Story #4593.
 *
 * `change-set.js` is the one Story change-set enumerator every delivery
 * consumer injects from. Its whole value is that two consumers handed the same
 * envelope compare identical lists, so these tests pin the normalization
 * (trimmed / de-duplicated / sorted), the ref provenance that rides along, and
 * the `null` vs `[]` distinction that keeps an unenumerable diff from ever
 * looking like a safe empty one.
 *
 * Unit tier: no real git — the `gitSpawn` seam is injected throughout.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { computeChangeSet } from '../.agents/scripts/lib/orchestration/change-set.js';

/** A `gitSpawn` stub returning `stdout` for a successful diff. */
function gitOk(stdout) {
  return () => ({ status: 0, stdout, stderr: '' });
}

const REFS = { baseRef: 'main', headRef: 'story-4593' };

describe('computeChangeSet — normalization', () => {
  test('parses git diff --name-only output into a file list', () => {
    const { files } = computeChangeSet({
      ...REFS,
      gitSpawnFn: gitOk('a.js\nb.js\n'),
    });
    assert.deepEqual(files, ['a.js', 'b.js']);
  });

  test('trims whitespace and drops blank lines', () => {
    const { files } = computeChangeSet({
      ...REFS,
      gitSpawnFn: gitOk('  a.js  \n\n\t b.js\n   \n'),
    });
    assert.deepEqual(files, ['a.js', 'b.js']);
  });

  test('de-duplicates repeated paths', () => {
    const { files } = computeChangeSet({
      ...REFS,
      gitSpawnFn: gitOk('a.js\nb.js\na.js\n a.js \n'),
    });
    assert.deepEqual(files, ['a.js', 'b.js']);
  });

  test('sorts the output so two consumers compare identical lists', () => {
    const { files } = computeChangeSet({
      ...REFS,
      gitSpawnFn: gitOk('z.js\nm/b.js\na.js\n'),
    });
    assert.deepEqual(files, ['a.js', 'm/b.js', 'z.js']);
  });

  test('a genuinely empty diff is [] — the fact that nothing changed', () => {
    const set = computeChangeSet({ ...REFS, gitSpawnFn: gitOk('') });
    assert.deepEqual(set.files, []);
    assert.equal(set.enumerated, true);
  });
});

describe('computeChangeSet — ref reporting', () => {
  test('reports the refs the set was computed against', () => {
    const set = computeChangeSet({
      baseRef: 'main',
      headRef: 'story-4593',
      gitSpawnFn: gitOk('a.js'),
    });
    assert.equal(set.baseRef, 'main');
    assert.equal(set.headRef, 'story-4593');
    assert.equal(set.enumerated, true);
  });

  test('asks git for the three-dot diff between the supplied refs', () => {
    const calls = [];
    computeChangeSet({
      baseRef: 'main',
      headRef: 'story-4593',
      cwd: '/repo',
      gitSpawnFn: (cwd, ...args) => {
        calls.push({ cwd, args });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, '/repo');
    assert.deepEqual(calls[0].args, [
      'diff',
      '--name-only',
      'main...story-4593',
    ]);
  });

  test('reports the refs even when the diff could not be enumerated', () => {
    const set = computeChangeSet({
      ...REFS,
      gitSpawnFn: () => ({ status: 128, stdout: '', stderr: 'bad ref' }),
    });
    assert.equal(set.baseRef, 'main');
    assert.equal(set.headRef, 'story-4593');
  });
});

describe('computeChangeSet — total, and null is not empty', () => {
  test('a git failure yields files: null, not [] (absence of evidence)', () => {
    const set = computeChangeSet({
      ...REFS,
      gitSpawnFn: () => ({ status: 128, stdout: '', stderr: 'bad ref' }),
    });
    assert.equal(set.files, null);
    assert.equal(set.enumerated, false);
  });

  test('a spawn throw degrades to the unknown envelope rather than throwing', () => {
    const set = computeChangeSet({
      ...REFS,
      gitSpawnFn: () => {
        throw new Error('spawn failed');
      },
    });
    assert.equal(set.files, null);
    assert.equal(set.enumerated, false);
  });

  test('a non-string stdout degrades to the unknown envelope', () => {
    const set = computeChangeSet({
      ...REFS,
      gitSpawnFn: () => ({ status: 0, stdout: undefined, stderr: '' }),
    });
    assert.equal(set.files, null);
  });

  test('missing/blank refs never reach git', () => {
    let called = false;
    const gitSpawnFn = () => {
      called = true;
      return { status: 0, stdout: 'a.js', stderr: '' };
    };
    for (const args of [
      { baseRef: '', headRef: 'story-1' },
      { baseRef: 'main', headRef: '' },
      { baseRef: 'main' },
      {},
    ]) {
      const set = computeChangeSet({ ...args, gitSpawnFn });
      assert.equal(set.files, null);
      assert.equal(set.enumerated, false);
    }
    assert.equal(called, false, 'git must not be spawned for unusable refs');
  });

  test('called with no arguments at all, it still returns the envelope', () => {
    const set = computeChangeSet();
    assert.equal(set.files, null);
    assert.equal(set.enumerated, false);
  });
});
