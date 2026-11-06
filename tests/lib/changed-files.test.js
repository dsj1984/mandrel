import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  diffNameOnly,
  getChangedFiles,
  getStagedFiles,
  remoteBaseRef,
  resolveCaptureBaseRef,
  resolveChangedFilesRef,
  resolveMergeHead,
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
    // The merge probe runs first; the canned stdout is not an object id, so
    // it resolves to "not merging" and the cached diff keeps its bare form.
    assert.deepEqual(calls[0].args, [
      'rev-parse',
      '-q',
      '--verify',
      'MERGE_HEAD',
    ]);
    assert.deepEqual(calls[1].args, ['diff', '--name-only', '--cached']);
  });

  it('throws on non-zero git exit', () => {
    const { iface } = makeGit({ status: 1, stdout: '', stderr: 'boom' });
    assert.throws(
      () => getStagedFiles({ cwd: '/repo', git: iface }),
      /unable to read cached diff/,
    );
  });
});

const MERGE_SHA = '4f2c276f0959da4563ad973b4d40f068d1315152';

/**
 * A git stub that answers the `MERGE_HEAD` probe and the cached diff
 * separately, so a test can put the repo in — or out of — a merge.
 *
 * @param {{ mergeHead?: string|null, staged?: string, revParseStatus?: number }} opts
 */
function makeMergeGit({ mergeHead = null, staged = '', revParseStatus } = {}) {
  const calls = [];
  return {
    calls,
    iface: {
      gitSpawn: (cwd, ...args) => {
        calls.push({ cwd, args });
        if (args[0] === 'rev-parse') {
          const status = revParseStatus ?? (mergeHead ? 0 : 1);
          return {
            status,
            stdout: mergeHead ? `${mergeHead}\n` : '',
            stderr: '',
          };
        }
        return { status: 0, stdout: staged, stderr: '' };
      },
      gitSync: () => {
        throw new Error('gitSync not used');
      },
    },
  };
}

// Story #5131 — `git diff --cached` diffs the index against HEAD, which during
// a merge is still the pre-merge tip. Left alone it put every file the base
// branch landed into the pre-commit gate's scope.
describe('resolveMergeHead', () => {
  it('returns the object id when a merge is in progress', () => {
    const { iface, calls } = makeMergeGit({ mergeHead: MERGE_SHA });
    assert.equal(resolveMergeHead({ cwd: '/repo', git: iface }), MERGE_SHA);
    assert.deepEqual(calls[0].args, [
      'rev-parse',
      '-q',
      '--verify',
      'MERGE_HEAD',
    ]);
  });

  it('returns null when no merge is in progress (non-zero rev-parse)', () => {
    const { iface } = makeMergeGit({ mergeHead: null });
    assert.equal(resolveMergeHead({ cwd: '/repo', git: iface }), null);
  });

  it('returns null when rev-parse succeeds but prints a non-object-id', () => {
    // `--verify` refuses a multi-head (octopus) MERGE_HEAD; anything that is
    // not a resolved commit must degrade to the plain cached diff rather than
    // narrow the scope on a guess.
    const { iface } = makeMergeGit({
      mergeHead: 'not-a-sha',
      revParseStatus: 0,
    });
    assert.equal(resolveMergeHead({ cwd: '/repo', git: iface }), null);
  });

  it('never throws when the git interface itself throws', () => {
    const iface = {
      gitSpawn: () => {
        throw new Error('git missing');
      },
      gitSync: () => {
        throw new Error('gitSync not used');
      },
    };
    assert.equal(resolveMergeHead({ cwd: '/repo', git: iface }), null);
  });

  it('asks git rather than probing the filesystem for .git/MERGE_HEAD', () => {
    // `.git` is a FILE in a linked worktree, so a path probe would be
    // silently inert exactly where this repo delivers from.
    const { iface, calls } = makeMergeGit({ mergeHead: MERGE_SHA });
    resolveMergeHead({ cwd: '/repo', git: iface });
    assert.ok(
      calls.every((c) => !c.args.some((a) => String(a).includes('.git/'))),
    );
  });
});

describe('getStagedFiles during a merge', () => {
  it('diffs the index against MERGE_HEAD', () => {
    const { iface, calls } = makeMergeGit({
      mergeHead: MERGE_SHA,
      staged: 'branch-only.js\nshared.js\n',
    });
    const out = getStagedFiles({ cwd: '/repo', git: iface });
    assert.deepEqual(out, ['branch-only.js', 'shared.js']);
    assert.deepEqual(calls[1].args, [
      'diff',
      '--name-only',
      '--cached',
      MERGE_SHA,
    ]);
  });

  it('falls back to the bare cached diff when the merge head is unusable', () => {
    const { iface, calls } = makeMergeGit({
      mergeHead: 'not-a-sha',
      revParseStatus: 0,
      staged: 'a.js\n',
    });
    assert.deepEqual(getStagedFiles({ cwd: '/repo', git: iface }), ['a.js']);
    assert.deepEqual(calls[1].args, ['diff', '--name-only', '--cached']);
  });

  it('still throws when the cached diff itself fails', () => {
    // Fail closed: the scope must never silently empty.
    const iface = {
      gitSpawn: (_cwd, ...args) =>
        args[0] === 'rev-parse'
          ? { status: 0, stdout: `${MERGE_SHA}\n`, stderr: '' }
          : { status: 128, stdout: '', stderr: 'boom' },
      gitSync: () => {
        throw new Error('gitSync not used');
      },
    };
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

  it('staged during a merge reports the merge head as diffRef', () => {
    const { iface, calls } = makeMergeGit({
      mergeHead: MERGE_SHA,
      staged: 'branch-only.js\nshared.js\n',
    });
    const out = resolvePreviewScope({ staged: true, cwd: '/repo', git: iface });
    assert.equal(out.scope, 'staged');
    assert.equal(out.diffRef, MERGE_SHA);
    assert.deepEqual([...out.scopeSet], ['branch-only.js', 'shared.js']);
    // Resolved once for the whole scope, not once per caller.
    assert.equal(calls.filter((c) => c.args[0] === 'rev-parse').length, 1);
  });
});

// `parseNameOnlyStdout` went module-private in Story #4944 (its last
// out-of-file consumer, `diff-scope-cli.js#resolveDiffScopeFiles`, was
// deleted when the duplication CLI migrated onto `refreshBaseline()`).
// `diffNameOnly` returns its output verbatim, so driving the same inputs
// through the exported function keeps the parsing contract pinned without
// re-exporting a seam only the tests would reach.
describe('name-only stdout parsing (via diffNameOnly)', () => {
  function parseVia(stdout) {
    return diffNameOnly({
      range: 'main...HEAD',
      gitSpawn: () => ({ status: 0, stdout, stderr: '' }),
    });
  }

  it('returns an empty array for null/undefined/empty input', () => {
    assert.deepEqual(parseVia(null), []);
    assert.deepEqual(parseVia(undefined), []);
    assert.deepEqual(parseVia(''), []);
  });

  it('splits on newlines and trims whitespace', () => {
    assert.deepEqual(parseVia('a.js\nb.js\n'), ['a.js', 'b.js']);
  });

  it('filters out blank lines', () => {
    assert.deepEqual(parseVia('a.js\n\nb.js'), ['a.js', 'b.js']);
  });

  it('normalizes Windows backslash separators to forward slashes', () => {
    assert.deepEqual(parseVia('lib\\foo\\bar.js\n'), ['lib/foo/bar.js']);
  });
});

describe('diffNameOnly', () => {
  function makeSpawn(result) {
    const calls = [];
    const gitSpawn = (cwd, ...args) => {
      calls.push({ cwd, args });
      return result;
    };
    return { gitSpawn, calls };
  }

  it('builds a three-dot range from baseRef + headRef and parses the result', () => {
    const { gitSpawn, calls } = makeSpawn({
      status: 0,
      stdout: 'lib/a.js\nlib/b.js\n',
      stderr: '',
    });
    const out = diffNameOnly({
      baseRef: 'origin/epic/1',
      headRef: 'story-99',
      cwd: '/repo',
      gitSpawn,
    });
    assert.deepEqual(out, ['lib/a.js', 'lib/b.js']);
    assert.deepEqual(calls[0].args, [
      'diff',
      '--name-only',
      'origin/epic/1...story-99',
    ]);
  });

  it('defaults headRef to HEAD when only baseRef is supplied', () => {
    const { gitSpawn, calls } = makeSpawn({
      status: 0,
      stdout: '',
      stderr: '',
    });
    diffNameOnly({ baseRef: 'main', cwd: '/repo', gitSpawn });
    assert.deepEqual(calls[0].args, ['diff', '--name-only', 'main...HEAD']);
  });

  it('uses a two-dot range when threeDot is false', () => {
    const { gitSpawn, calls } = makeSpawn({
      status: 0,
      stdout: '',
      stderr: '',
    });
    diffNameOnly({
      baseRef: 'main',
      headRef: 'HEAD',
      threeDot: false,
      cwd: '/repo',
      gitSpawn,
    });
    assert.deepEqual(calls[0].args, ['diff', '--name-only', 'main..HEAD']);
  });

  it('uses the pre-built range string when supplied, ignoring baseRef/headRef', () => {
    const { gitSpawn, calls } = makeSpawn({
      status: 0,
      stdout: 'x.js\n',
      stderr: '',
    });
    const out = diffNameOnly({
      range: 'epic/3599...story-3636',
      baseRef: 'ignored',
      headRef: 'ignored',
      cwd: '/repo',
      gitSpawn,
    });
    assert.deepEqual(out, ['x.js']);
    assert.deepEqual(calls[0].args, [
      'diff',
      '--name-only',
      'epic/3599...story-3636',
    ]);
  });

  it('throws a descriptive error on non-zero git exit', () => {
    const { gitSpawn } = makeSpawn({
      status: 128,
      stdout: '',
      stderr: 'fatal: not a git repo',
    });
    assert.throws(
      () => diffNameOnly({ range: 'main...HEAD', cwd: '/repo', gitSpawn }),
      (err) =>
        err instanceof Error &&
        /\[diff-name-only\]/.test(err.message) &&
        /fatal: not a git repo/.test(err.message),
    );
  });

  it('returns an empty array for an empty diff', () => {
    const { gitSpawn } = makeSpawn({ status: 0, stdout: '', stderr: '' });
    assert.deepEqual(
      diffNameOnly({ range: 'main...HEAD', cwd: '/repo', gitSpawn }),
      [],
    );
  });

  it('normalizes backslash separators in the output', () => {
    const { gitSpawn } = makeSpawn({
      status: 0,
      stdout: 'lib\\foo.js\n',
      stderr: '',
    });
    assert.deepEqual(
      diffNameOnly({ range: 'main...HEAD', cwd: '/repo', gitSpawn }),
      ['lib/foo.js'],
    );
  });
});

// Story #5962 — the default is the remote-tracking base, so a local base that
// trails origin cannot widen a Story's change set.
describe('resolveChangedFilesRef / resolveCaptureBaseRef', () => {
  const CONFIGURED = { incrementalCoverage: { baseRef: 'upstream/dev' } };
  const noProbe = () => {
    throw new Error('a named or configured ref must not be probed');
  };

  it('AC-1: defaults to origin/<baseBranch>', () => {
    assert.equal(
      resolveChangedFilesRef({ crap: {}, ref: null }),
      'origin/main',
    );
    assert.equal(
      resolveChangedFilesRef({ crap: {}, ref: null, baseBranch: 'trunk' }),
      'origin/trunk',
    );
    assert.equal(remoteBaseRef('origin/main'), 'origin/main');
  });

  it('AC-2: a named ref, then a configured baseRef, win unprobed', () => {
    assert.deepEqual(
      resolveCaptureBaseRef({
        crap: CONFIGURED,
        ref: 'feature',
        baseBranch: 'trunk',
        gitSpawnFn: noProbe,
      }),
      { ref: 'feature', source: 'flag' },
    );
    assert.deepEqual(
      resolveCaptureBaseRef({
        crap: CONFIGURED,
        ref: null,
        baseBranch: 'trunk',
        gitSpawnFn: noProbe,
      }),
      { ref: 'upstream/dev', source: 'config' },
    );
  });

  it('probes origin/<baseBranch> and uses it when it resolves', () => {
    const calls = [];
    const out = resolveCaptureBaseRef({
      crap: {},
      baseBranch: 'trunk',
      cwd: '/repo',
      gitSpawnFn: (cwd, ...args) => {
        calls.push([cwd, ...args]);
        return { status: 0 };
      },
    });
    assert.deepEqual(out, { ref: 'origin/trunk', source: 'remote' });
    assert.deepEqual(calls, [
      ['/repo', 'rev-parse', '--verify', '--quiet', 'origin/trunk^{commit}'],
    ]);
  });

  it('AC-4: falls back to the local base when the remote ref is missing', () => {
    const expected = {
      ref: 'trunk',
      source: 'local-fallback',
      unresolved: 'origin/trunk',
    };
    for (const gitSpawnFn of [
      () => ({ status: 1 }),
      () => {
        throw new Error('spawn failed');
      },
    ]) {
      assert.deepEqual(
        resolveCaptureBaseRef({ crap: {}, baseBranch: 'trunk', gitSpawnFn }),
        expected,
      );
    }
  });
});
