// tests/baselines/git-base.test.js
//
// Story #1962 / Task #1969 — Lock the contract for `readBaseFromGit`:
//
//   - `child_process.spawn`-shaped invocation (no shell).
//   - LRU cache hits skip the subprocess entirely (per-process budget).
//   - Missing path at ref returns `null` rather than throwing.
//
// The "spawn, not exec" assertion uses a mock `spawnSync` so we can
// count invocations and inspect argv. The "real git" acceptance leg that
// actually exercises the subprocess lives in git-base.integration.test.js
// (tagged `test:integration` so it doesn't tax the quick-feedback loop).

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  __resetForTests,
  __setSpawnRunner,
  readBaseFromGit,
  readRangeCommitsTouchingFile,
  readRenamesFromGit,
} from '../../.agents/scripts/lib/baselines/git-base.js';

/** The explicit stdout ceiling both git reads must pass (Story #4914). */
const EXPECTED_MAX_BUFFER = 64 * 1024 * 1024;

describe('readBaseFromGit', () => {
  afterEach(() => {
    __resetForTests();
  });

  it('uses spawn (not exec) and passes ref/file as separate argv tokens', () => {
    let calls = 0;
    let lastArgs = null;
    let lastOpts = null;
    __setSpawnRunner({
      spawn: (cmd, args, opts) => {
        calls += 1;
        lastArgs = [cmd, ...args];
        lastOpts = opts;
        return { status: 0, stdout: '{"floor":40}\n', stderr: '' };
      },
    });

    const out = readBaseFromGit('epic/1943', 'baselines/lint.json');
    assert.equal(out, '{"floor":40}\n');
    assert.equal(calls, 1);
    assert.deepEqual(lastArgs, [
      'git',
      'show',
      'epic/1943:baselines/lint.json',
    ]);
    // Security baseline: shell MUST be false so ref/file cannot be
    // shell-interpolated.
    assert.equal(lastOpts.shell, false);
  });

  it('caches by (ref, file): same key spawns git exactly once', () => {
    let calls = 0;
    __setSpawnRunner({
      spawn: () => {
        calls += 1;
        return { status: 0, stdout: 'cached', stderr: '' };
      },
    });

    const a = readBaseFromGit('main', 'baselines/coverage.json');
    const b = readBaseFromGit('main', 'baselines/coverage.json');
    const c = readBaseFromGit('main', 'baselines/coverage.json');
    assert.equal(a, 'cached');
    assert.equal(b, 'cached');
    assert.equal(c, 'cached');
    assert.equal(calls, 1, 'cache should suppress repeat spawns');
  });

  it('treats different (ref, file) tuples as independent cache entries', () => {
    let calls = 0;
    __setSpawnRunner({
      spawn: (_cmd, args) => {
        calls += 1;
        // Echo back the spec so each entry is distinguishable.
        return { status: 0, stdout: args[1], stderr: '' };
      },
    });

    readBaseFromGit('main', 'baselines/lint.json');
    readBaseFromGit('main', 'baselines/coverage.json');
    readBaseFromGit('epic/1943', 'baselines/lint.json');
    assert.equal(calls, 3);
    // Re-asking for the first key still hits the cache.
    readBaseFromGit('main', 'baselines/lint.json');
    assert.equal(calls, 3);
  });

  it('returns null when git reports the path does not exist at the ref', () => {
    let calls = 0;
    __setSpawnRunner({
      spawn: () => {
        calls += 1;
        return {
          status: 128,
          stdout: '',
          stderr:
            "fatal: path 'baselines/missing.json' does not exist in 'main'",
        };
      },
    });

    const out = readBaseFromGit('main', 'baselines/missing.json');
    assert.equal(out, null);
    assert.equal(calls, 1);
    // Cache hit on missing files too — we should not re-spawn for known nulls.
    const out2 = readBaseFromGit('main', 'baselines/missing.json');
    assert.equal(out2, null);
    assert.equal(calls, 1);
  });

  it('throws on non-128 git failures (bad ref, missing binary, etc.)', () => {
    __setSpawnRunner({
      spawn: () => ({
        status: 1,
        stdout: '',
        stderr: 'fatal: bad revision',
      }),
    });
    assert.throws(
      () => readBaseFromGit('not-a-ref', 'baselines/lint.json'),
      /git show .* failed \(status=1\): fatal: bad revision/,
    );
  });

  it('rejects empty ref or empty file argument', () => {
    assert.throws(
      () => readBaseFromGit('', 'baselines/lint.json'),
      /ref must be a non-empty string/,
    );
    assert.throws(
      () => readBaseFromGit('main', ''),
      /file must be a non-empty string/,
    );
  });

  // Story #4914 / AC-2 — the observed production failure. A base baseline
  // larger than spawnSync's 1 MB default kills the child: `status` is null
  // (died by signal), not a git exit code. That MUST throw, because the
  // compare phase now treats `null` as "path absent at ref" and nothing else.
  it('throws when the child is killed by ENOBUFS (status null / SIGTERM)', () => {
    __setSpawnRunner({
      spawn: () => ({
        status: null,
        signal: 'SIGTERM',
        stdout: 'x'.repeat(1024),
        stderr: '',
        error: Object.assign(new Error('spawnSync git ENOBUFS'), {
          code: 'ENOBUFS',
        }),
      }),
    });
    let thrown = null;
    try {
      readBaseFromGit('main', 'baselines/crap.json');
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      thrown instanceof Error,
      'an ENOBUFS-killed read must throw, never return null',
    );
    assert.match(thrown.message, /status=null/);
  });

  // Story #4914 / AC-3 — the other half of the same distinction: exit 128
  // still means "path absent at ref" and still returns null rather than
  // throwing. AC-2 and AC-3 together pin the contract compare.js depends on.
  it('still returns null (does not throw) on git exit 128, alongside the ENOBUFS throw', () => {
    __setSpawnRunner({
      spawn: () => ({
        status: 128,
        stdout: '',
        stderr: "fatal: path 'baselines/crap.json' does not exist in 'main'",
      }),
    });
    assert.equal(readBaseFromGit('main', 'baselines/crap.json'), null);
  });

  // Story #4914 / AC-4 — read the bound off the mock's recorded options, not
  // off the source text, so the assertion tracks behaviour rather than syntax.
  it('passes an explicit 64 MB maxBuffer to git show', () => {
    let lastOpts = null;
    __setSpawnRunner({
      spawn: (_cmd, _args, opts) => {
        lastOpts = opts;
        return { status: 0, stdout: '{}', stderr: '' };
      },
    });
    readBaseFromGit('main', 'baselines/crap.json');
    assert.equal(lastOpts.maxBuffer, EXPECTED_MAX_BUFFER);
    assert.equal(lastOpts.maxBuffer, 67108864);
  });
});

describe('readRangeCommitsTouchingFile (Story #4914, #5179)', () => {
  afterEach(() => {
    __resetForTests();
  });

  // AC-4 — the second spawn site carries the same bound. A refresh-tag walk
  // over a long range is exactly as capable of overflowing 1 MB.
  it('passes the same explicit 64 MB maxBuffer to git log', () => {
    let lastOpts = null;
    __setSpawnRunner({
      spawn: (_cmd, _args, opts) => {
        lastOpts = opts;
        return { status: 0, stdout: 'abc123\u0000chore: seed\n', stderr: '' };
      },
    });
    const commits = readRangeCommitsTouchingFile(
      'main',
      'baselines/maintainability.json',
    );
    assert.deepEqual(commits, [{ sha: 'abc123', subject: 'chore: seed' }]);
    assert.equal(lastOpts.maxBuffer, 67108864);
  });

  // Story #5179 — the SHA is the whole point of this read: without a commit
  // handle the acknowledgment cannot ask what the refresh actually rewrote.
  it('asks git for SHA and subject, NUL-separated', () => {
    let lastArgs = null;
    __setSpawnRunner({
      spawn: (_cmd, args) => {
        lastArgs = args;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    readRangeCommitsTouchingFile('main', 'baselines/coverage.json');
    assert.deepEqual(lastArgs, [
      'log',
      'main..HEAD',
      '--format=%H%x00%s',
      '--',
      'baselines/coverage.json',
    ]);
  });

  it('parses multiple commits newest-first and keeps subjects intact', () => {
    __setSpawnRunner({
      spawn: () => ({
        status: 0,
        stdout:
          'sha2\u0000chore(baselines): baseline-refresh: re-anchor\n' +
          'sha1\u0000feat: something with -- dashes\n',
        stderr: '',
      }),
    });
    assert.deepEqual(
      readRangeCommitsTouchingFile('main', 'baselines/maintainability.json'),
      [
        {
          sha: 'sha2',
          subject: 'chore(baselines): baseline-refresh: re-anchor',
        },
        { sha: 'sha1', subject: 'feat: something with -- dashes' },
      ],
    );
  });

  it('skips malformed lines carrying no NUL separator', () => {
    __setSpawnRunner({
      spawn: () => ({
        status: 0,
        stdout: 'garbage-without-separator\nsha1\u0000chore: real\n',
        stderr: '',
      }),
    });
    assert.deepEqual(
      readRangeCommitsTouchingFile('main', 'baselines/maintainability.json'),
      [{ sha: 'sha1', subject: 'chore: real' }],
    );
  });

  // AC-8 — the tolerant contract is deliberate and unchanged: this path
  // reports "no acknowledging commit found", which is the safe answer when
  // the range cannot be walked. It must never throw into the gate.
  it('still returns [] (never throws) on a non-zero git status', () => {
    __setSpawnRunner({
      spawn: () => ({ status: 128, stdout: '', stderr: 'fatal: bad revision' }),
    });
    assert.deepEqual(
      readRangeCommitsTouchingFile('nope', 'baselines/maintainability.json'),
      [],
    );
  });

  it('still returns [] when the spawn itself throws', () => {
    __setSpawnRunner({
      spawn: () => {
        throw new Error('spawnSync git ENOENT');
      },
    });
    assert.deepEqual(
      readRangeCommitsTouchingFile('main', 'baselines/maintainability.json'),
      [],
    );
  });
});

describe('readRenamesFromGit (Story #6068)', () => {
  afterEach(() => {
    __resetForTests();
  });

  it('maps each rename target to its source', () => {
    let lastArgs = null;
    __setSpawnRunner({
      spawn: (_cmd, args) => {
        lastArgs = args;
        return {
          status: 0,
          stdout: 'R100\tsrc/old.js\tsrc/new.js\nR087\ta.js\tb.js\n',
          stderr: '',
        };
      },
    });
    const renames = readRenamesFromGit('main');
    assert.deepEqual(
      [...renames],
      [
        ['src/new.js', 'src/old.js'],
        ['b.js', 'a.js'],
      ],
    );
    assert.ok(lastArgs.includes('--diff-filter=R'));
    assert.ok(lastArgs.includes('main...HEAD'));
  });

  it('returns an empty map on a failed probe, a throw, or no ref', () => {
    __setSpawnRunner({
      spawn: () => ({ status: 128, stdout: '', stderr: 'bad ref' }),
    });
    assert.equal(readRenamesFromGit('main').size, 0);
    __setSpawnRunner({
      spawn: () => {
        throw new Error('spawn failed');
      },
    });
    assert.equal(readRenamesFromGit('main').size, 0);
    assert.equal(readRenamesFromGit('').size, 0);
  });
});
