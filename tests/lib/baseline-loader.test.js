import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  cacheKeyFor,
  clearBaselineCache,
  readBaselineAtRef,
} from '../../.agents/scripts/lib/baseline-loader.js';

/**
 * Tests for `lib/baseline-loader.js` — the single seam every close-validation
 * gate uses to read a baseline JSON file at an arbitrary git ref. Covers the
 * five paths the Task acceptance demands: hit, miss, parse-error, missing-ref,
 * and cache-reuse.
 */

function makeGit(byKey) {
  // `byKey` is a map from `<ref>:<path>` to either a `gitSpawn` result-shaped
  // object or a function returning one (so tests can simulate transient
  // failures across calls).
  const calls = [];
  return {
    calls,
    iface: {
      gitSpawn: (cwd, ...args) => {
        calls.push({ cwd, args });
        // We expect `git show <ref>:<path>` shape.
        const showArg = args[1] ?? '';
        const result = byKey[showArg];
        if (!result) {
          return {
            status: 128,
            stdout: '',
            stderr: `unknown ref/path: ${showArg}`,
          };
        }
        return typeof result === 'function' ? result() : result;
      },
      gitSync: () => {
        throw new Error('gitSync not used by baseline-loader');
      },
    },
  };
}

describe('baseline-loader.readBaselineAtRef', () => {
  afterEach(() => {
    clearBaselineCache();
  });

  it('cacheKeyFor composes ref + path so collisions are impossible', () => {
    assert.equal(typeof cacheKeyFor('epic/1114', 'a.json'), 'string');
    // The separator must be something that cannot appear in either a git
    // ref name or a POSIX path component — otherwise (ref="a", path="b:c")
    // would alias (ref="a:b", path="c") in the cache.
    assert.notEqual(
      cacheKeyFor('epic/1114', 'a:b'),
      cacheKeyFor('epic/1114:a', 'b'),
      'colon-bearing paths must not alias other (ref, path) pairs',
    );
    assert.notEqual(
      cacheKeyFor('refs/heads/foo', 'bar.json'),
      cacheKeyFor('refs/heads', 'foo/bar.json'),
      'slash-bearing paths must not alias other (ref, path) pairs',
    );
  });

  it('returns parsed JSON for a successful (hit) read', () => {
    const baselineBody = JSON.stringify({ 'foo.js': 80.0, 'bar.js': 75.5 });
    const { iface, calls } = makeGit({
      'HEAD:baselines/maintainability.json': {
        status: 0,
        stdout: baselineBody,
        stderr: '',
      },
    });
    const out = readBaselineAtRef('HEAD', 'baselines/maintainability.json', {
      cwd: '/repo',
      git: iface,
    });
    assert.deepEqual(out, { 'foo.js': 80.0, 'bar.js': 75.5 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, '/repo');
    assert.deepEqual(calls[0].args, [
      'show',
      'HEAD:baselines/maintainability.json',
    ]);
  });

  it('throws a clearly-typed error naming the ref when git show fails (missing-ref)', () => {
    const { iface } = makeGit({}); // every show fails
    assert.throws(
      () =>
        readBaselineAtRef('does-not-exist', 'baselines/x.json', {
          cwd: '/repo',
          git: iface,
        }),
      (err) =>
        err instanceof Error &&
        err.message.includes('does-not-exist') &&
        err.message.includes('baselines/x.json'),
      'error must name both the ref and the path so operators can act',
    );
  });

  it('throws a parse-error when git show returns non-JSON content', () => {
    const { iface } = makeGit({
      'HEAD:baselines/broken.json': {
        status: 0,
        stdout: 'not-json{',
        stderr: '',
      },
    });
    assert.throws(
      () =>
        readBaselineAtRef('HEAD', 'baselines/broken.json', {
          cwd: '/repo',
          git: iface,
        }),
      (err) =>
        err instanceof Error &&
        err.message.includes('parse-error') &&
        err.message.includes('baselines/broken.json'),
    );
  });

  it('caches the parsed result so repeat (ref, path) calls do NOT re-spawn git show', () => {
    const { iface, calls } = makeGit({
      'epic/1114:baselines/crap.json': {
        status: 0,
        stdout: JSON.stringify({ rows: [], kernelVersion: '1.0.0' }),
        stderr: '',
      },
    });
    const first = readBaselineAtRef('epic/1114', 'baselines/crap.json', {
      cwd: '/repo',
      git: iface,
    });
    const second = readBaselineAtRef('epic/1114', 'baselines/crap.json', {
      cwd: '/repo',
      git: iface,
    });
    assert.equal(calls.length, 1, 'git show must be invoked exactly once');
    assert.equal(first, second, 'cache must hand back the same parsed object');
  });

  it('does NOT cache failures — a transient git failure must not poison the next call', () => {
    let attempt = 0;
    const { iface, calls } = makeGit({
      'epic/1114:baselines/maintainability.json': () => {
        attempt += 1;
        if (attempt === 1) {
          return { status: 128, stdout: '', stderr: 'transient' };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ 'foo.js': 80.0 }),
          stderr: '',
        };
      },
    });
    assert.throws(() =>
      readBaselineAtRef('epic/1114', 'baselines/maintainability.json', {
        cwd: '/repo',
        git: iface,
      }),
    );
    const out = readBaselineAtRef(
      'epic/1114',
      'baselines/maintainability.json',
      { cwd: '/repo', git: iface },
    );
    assert.deepEqual(out, { 'foo.js': 80.0 });
    assert.equal(calls.length, 2, 'failure must not be cached');
  });

  it('keys cache entries by (ref, path) so different refs do not collide', () => {
    const { iface, calls } = makeGit({
      'epic/1114:baselines/crap.json': {
        status: 0,
        stdout: JSON.stringify({ ref: 'epic' }),
        stderr: '',
      },
      'main:baselines/crap.json': {
        status: 0,
        stdout: JSON.stringify({ ref: 'main' }),
        stderr: '',
      },
    });
    const epicVal = readBaselineAtRef('epic/1114', 'baselines/crap.json', {
      cwd: '/repo',
      git: iface,
    });
    const mainVal = readBaselineAtRef('main', 'baselines/crap.json', {
      cwd: '/repo',
      git: iface,
    });
    assert.deepEqual(epicVal, { ref: 'epic' });
    assert.deepEqual(mainVal, { ref: 'main' });
    assert.equal(calls.length, 2);
  });

  it('rejects empty ref or path with a clear validation error', () => {
    assert.throws(() => readBaselineAtRef('', 'baselines/x.json'), /ref/);
    assert.throws(() => readBaselineAtRef('HEAD', ''), /path/);
  });
});
