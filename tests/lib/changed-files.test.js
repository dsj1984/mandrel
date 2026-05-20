import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getChangedFiles,
  getStagedFiles,
  resolvePreviewScope,
} from '../../.agents/scripts/lib/changed-files.js';

/**
 * Tests for the `--changed-since` helper. Covers the contract that matters
 * at the CLI boundary: successful diff parsing, empty-diff handling, path
 * normalization, and fail-closed behavior on a bad ref.
 */

function makeGit(result) {
  const calls = [];
  return {
    calls,
    iface: {
      gitSpawn: (cwd, ...args) => {
        calls.push({ cwd, args });
        return result;
      },
      gitSync: () => {
        throw new Error('gitSync not used by getChangedFiles');
      },
    },
  };
}

describe('getChangedFiles', () => {
  it('returns the list from `git diff --name-only <ref>...HEAD`', () => {
    const { iface, calls } = makeGit({
      status: 0,
      stdout: '.agents/scripts/foo.js\n.agents/scripts/bar.js\n',
      stderr: '',
    });
    const out = getChangedFiles({ ref: 'main', cwd: '/repo', git: iface });
    assert.deepEqual(out, ['.agents/scripts/foo.js', '.agents/scripts/bar.js']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, '/repo');
    assert.deepEqual(calls[0].args, ['diff', '--name-only', 'main...HEAD']);
  });

  it('defaults to `main` when ref is not supplied', () => {
    const { iface, calls } = makeGit({ status: 0, stdout: '', stderr: '' });
    getChangedFiles({ cwd: '/repo', git: iface });
    assert.deepEqual(calls[0].args, ['diff', '--name-only', 'main...HEAD']);
  });

  it('returns an empty array when the diff is empty (no newline noise)', () => {
    const { iface } = makeGit({ status: 0, stdout: '', stderr: '' });
    const out = getChangedFiles({ ref: 'main', cwd: '/repo', git: iface });
    assert.deepEqual(out, []);
  });

  it('normalizes Windows-style separators so set-membership lines up with scanner output', () => {
    const { iface } = makeGit({
      status: 0,
      stdout: '.agents\\scripts\\foo.js\n',
      stderr: '',
    });
    const out = getChangedFiles({ ref: 'main', cwd: '/repo', git: iface });
    assert.deepEqual(out, ['.agents/scripts/foo.js']);
  });

  it('throws a clear, ref-naming error on non-zero git exit (bad ref)', () => {
    const { iface } = makeGit({
      status: 128,
      stdout: '',
      stderr:
        "fatal: ambiguous argument 'bogus': unknown revision or path not in the working tree.",
    });
    assert.throws(
      () => getChangedFiles({ ref: 'bogus', cwd: '/repo', git: iface }),
      (err) =>
        err instanceof Error &&
        /unable to resolve ref "bogus"/.test(err.message) &&
        /ambiguous argument/.test(err.message),
    );
  });

  it('throws when git exits non-zero even with no stderr, surfacing the exit code', () => {
    const { iface } = makeGit({ status: 1, stdout: '', stderr: '' });
    assert.throws(
      () => getChangedFiles({ ref: 'main', cwd: '/repo', git: iface }),
      (err) =>
        err instanceof Error &&
        /unable to resolve ref "main"/.test(err.message) &&
        /exit 1/.test(err.message),
    );
  });
});

describe('getStagedFiles', () => {
  it('returns paths from `git diff --name-only --cached`', () => {
    const { iface, calls } = makeGit({
      status: 0,
      stdout: 'lib/staged.js\n',
      stderr: '',
    });
    const out = getStagedFiles({ cwd: '/repo', git: iface });
    assert.deepEqual(out, ['lib/staged.js']);
    assert.deepEqual(calls[0].args, ['diff', '--name-only', '--cached']);
  });

  it('throws on non-zero git exit', () => {
    const { iface } = makeGit({ status: 1, stdout: '', stderr: 'boom' });
    assert.throws(
      () => getStagedFiles({ cwd: '/repo', git: iface }),
      /unable to read cached diff/,
    );
  });
});

describe('resolvePreviewScope', () => {
  it('--staged ignores changedSinceRef and uses cached diff only', () => {
    const calls = [];
    const iface = {
      gitSpawn: (cwd, ...args) => {
        calls.push({ cwd, args });
        if (args.includes('--cached')) {
          return { status: 0, stdout: 'only-staged.js\n', stderr: '' };
        }
        return { status: 0, stdout: 'would-be-diff.js\n', stderr: '' };
      },
      gitSync: () => {
        throw new Error('gitSync not used');
      },
    };
    const out = resolvePreviewScope({
      staged: true,
      changedSinceRef: 'HEAD',
      cwd: '/repo',
      git: iface,
    });
    assert.equal(out.scope, 'staged');
    assert.equal(out.diffRef, null);
    assert.deepEqual([...out.scopeSet], ['only-staged.js']);
    assert.ok(
      calls.some((c) => c.args.includes('--cached')),
      'must not use changed-since diff when staged',
    );
    assert.ok(
      !calls.some((c) => c.args.some((a) => String(a).includes('...HEAD'))),
    );
  });

  it('changed-since uses three-dot diff when not staged', () => {
    const { iface, calls } = makeGit({
      status: 0,
      stdout: 'lib/diff.js\n',
      stderr: '',
    });
    const out = resolvePreviewScope({
      changedSinceRef: 'main',
      cwd: '/repo',
      git: iface,
    });
    assert.equal(out.scope, 'diff');
    assert.equal(out.diffRef, 'main');
    assert.deepEqual([...out.scopeSet], ['lib/diff.js']);
    assert.deepEqual(calls[0].args, ['diff', '--name-only', 'main...HEAD']);
  });

  it('returns full scope when neither staged nor changed-since is set', () => {
    const out = resolvePreviewScope({});
    assert.equal(out.scope, 'full');
    assert.equal(out.scopeSet, null);
    assert.equal(out.diffRef, null);
  });
});
