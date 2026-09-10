/**
 * Unit tests for `tests/fixtures/git-fixture.js` (Story #5274).
 *
 * `copyGitRepo` is the fixture that went red on an unrelated PR with a bare
 * `ENOENT … /.git/objects` and nothing to attribute it to (#5272). What is
 * spec'd here is therefore the diagnosis, not the copy: that a copy which did
 * not produce a repository is caught rather than handed back, that the retry
 * is against a fresh destination, that a twice-failed copy names both paths
 * and which of them survive — and that none of it costs a subprocess on the
 * happy path, which is Story #5121's result.
 *
 * Every failure below is staged by REMOVING a real directory. Stubbing `fs`
 * would prove the branches run without proving they run against the
 * filesystem this fixture actually loses.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  _currentSuiteTempRoot,
  makeTempDir,
} from '../../.agents/scripts/lib/test-temp.js';
import { copyGitRepo, makeGitRepo, seedGitIdentity } from './git-fixture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * Run `fn` and hand back the error it threw. `assert.throws` returns
 * `undefined`, so it cannot be used to inspect a message.
 *
 * @param {() => unknown} fn
 * @returns {Error}
 */
function captureThrow(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new assert.AssertionError({ message: 'expected a throw, got none' });
}

/**
 * A directory shaped like a `git init` repository, built without git so a
 * test can assert on the *copy* without paying two subprocesses for a
 * fixture it never commits to.
 *
 * @param {string} [prefix]
 * @returns {string}
 */
function makeRepoShapedDir(prefix = 'shaped-') {
  const dir = makeTempDir(prefix);
  mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
  writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

describe('git-fixture — copyGitRepo happy path', () => {
  it('returns a distinct, usable copy of a real repository', () => {
    const src = makeGitRepo({ prefix: 'copy-src-' });

    const dst = copyGitRepo(src);

    assert.notEqual(dst, src);
    assert.ok(existsSync(path.join(dst, '.git', 'HEAD')));
    assert.ok(existsSync(path.join(dst, '.git', 'objects')));
    assert.equal(
      readFileSync(path.join(dst, 'baseline.json'), 'utf-8'),
      readFileSync(path.join(src, 'baseline.json'), 'utf-8'),
    );
  });

  it('produces a copy git itself accepts as a repository', () => {
    const src = makeGitRepo({ prefix: 'copy-real-' });
    const dst = copyGitRepo(src);
    seedGitIdentity(dst);

    const head = execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: dst,
      encoding: 'utf-8',
    }).trim();

    assert.equal(head, 'seed');
  });

  it('mints the copy inside the suite root, so it is reaped with it', () => {
    const dst = copyGitRepo(makeRepoShapedDir('nested-src-'));

    assert.ok(dst.startsWith(`${_currentSuiteTempRoot()}${path.sep}`));
  });

  it('spawns no git subprocess on a first-attempt copy (#5121)', () => {
    // The committed census preload is the honest instrument here: it patches
    // `child_process` before any module imports it, which is exactly what an
    // in-process assertion cannot do for an ESM named import.
    const out = path.join(makeTempDir('census-'), 'census.json');
    const script = `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      const { makeTempDir } = await import(${JSON.stringify(
        pathToFileURL(path.join(REPO_ROOT, '.agents/scripts/lib/test-temp.js'))
          .href,
      )});
      const { copyGitRepo } = await import(${JSON.stringify(
        pathToFileURL(path.join(REPO_ROOT, 'tests/fixtures/git-fixture.js'))
          .href,
      )});
      const src = makeTempDir('census-src-');
      mkdirSync(path.join(src, '.git', 'objects'), { recursive: true });
      writeFileSync(path.join(src, '.git', 'HEAD'), 'ref: refs/heads/main\\n');
      copyGitRepo(src);
    `;
    const env = { ...process.env, SPAWN_CENSUS_OUT: out };
    // The child must be the census ROOT, or it writes lines nobody folds up.
    delete env.SPAWN_CENSUS_ROOT;

    execFileSync(
      process.execPath,
      [
        '--require',
        path.join(REPO_ROOT, 'tests/fixtures/spawn-census.cjs'),
        '--input-type=module',
        '-e',
        script,
      ],
      { env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const report = JSON.parse(readFileSync(out, 'utf-8'));
    assert.equal(report.totals.git, 0, 'the copy path must spawn no git');
  });
});

describe('git-fixture — copyGitRepo retries once', () => {
  it('retries against a freshly-minted destination and succeeds', () => {
    const src = makeRepoShapedDir('retry-src-');
    // A destination the real filesystem refuses: a regular file where a
    // directory must go. `cpSync` creates missing parents, so a *missing*
    // path is not a failure — what a retry has to survive is a destination
    // that cannot be written, and a fresh one is what fixes it.
    const blocked = path.join(makeTempDir('retry-blocked-'), 'in-the-way');
    writeFileSync(blocked, 'not a directory');
    const handed = [blocked, makeTempDir('retry-good-')];
    let calls = 0;

    const dst = copyGitRepo(src, { mintDest: () => handed[calls++] });

    assert.equal(calls, 2, 'the first attempt failed and one retry ran');
    assert.equal(dst, handed[1]);
    assert.ok(existsSync(path.join(dst, '.git', 'objects')));
  });

  it('does not retry when the first attempt produced a repository', () => {
    const src = makeRepoShapedDir('once-src-');
    let calls = 0;

    copyGitRepo(src, {
      mintDest: () => {
        calls += 1;
        return makeTempDir('once-dst-');
      },
    });

    assert.equal(calls, 1);
  });
});

describe('git-fixture — copyGitRepo reports a twice-failed copy', () => {
  it('names source, destination and suite root when the source is gone', () => {
    const src = makeRepoShapedDir('gone-src-');
    rmSync(src, { recursive: true, force: true });

    const err = captureThrow(() => copyGitRepo(src));

    assert.match(err.message, /copyGitRepo failed 2 times/);
    assert.match(err.message, new RegExp(`source: ${src} \\(MISSING\\)`));
    assert.match(err.message, /destination: .+ \(exists\)/);
    assert.match(
      err.message,
      new RegExp(`suite root: ${_currentSuiteTempRoot()} \\(exists\\)`),
    );
    assert.ok(
      err.message.split('\n').length > 1,
      'the raw ENOENT is never the whole message',
    );
  });

  it('rejects a copy that completed but produced no repository', () => {
    const src = makeRepoShapedDir('hollow-src-');
    rmSync(path.join(src, '.git'), { recursive: true, force: true });

    const err = captureThrow(() => copyGitRepo(src));

    assert.match(err.message, /no usable repository/);
    assert.match(err.message, /\.git\/HEAD and \.git\/objects/);
    assert.match(err.message, new RegExp(`source: ${src} \\(exists\\)`));
  });

  it('rejects a copy whose object store did not come across', () => {
    const src = makeRepoShapedDir('headless-src-');
    rmSync(path.join(src, '.git', 'objects'), { recursive: true, force: true });

    assert.throws(() => copyGitRepo(src), /no usable repository/);
  });

  it('reports a destination that was never created', () => {
    const src = makeRepoShapedDir('nodest-src-');
    const doomed = makeTempDir('nodest-doomed-');
    rmSync(doomed, { recursive: true, force: true });

    const err = captureThrow(() =>
      copyGitRepo(src, {
        mintDest: () => {
          throw new Error(`ENOENT: no such file or directory, ${doomed}`);
        },
      }),
    );

    assert.match(err.message, /destination: <never created>/);
    assert.match(err.message, new RegExp(`source: ${src} \\(exists\\)`));
  });
});

describe('git-fixture — makeGitRepo', () => {
  it('builds a repo with one commit and the seeded file at HEAD', () => {
    const dir = makeGitRepo({ prefix: 'made-', fileName: 'x.json' });

    assert.ok(existsSync(path.join(dir, '.git', 'HEAD')));
    assert.ok(existsSync(path.join(dir, 'x.json')));
    const files = execFileSync('git', ['ls-tree', '--name-only', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8',
    }).trim();
    assert.equal(files, 'x.json');
  });
});
