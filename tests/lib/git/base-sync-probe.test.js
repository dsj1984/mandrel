import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  describeProbe,
  probeBaseSync,
} from '../../../.agents/scripts/lib/git/base-sync-probe.js';
import { gitSpawn } from '../../../.agents/scripts/lib/git-utils.js';
import {
  copyGitRepo,
  makeGitTemplate,
  runGit,
  writeFiles,
} from '../../fixtures/git-fixture.js';

// Story #5954 — the conflict-only base-sync probe, on real git repos. The
// fetch is stubbed; `origin/main` is a local remote-tracking ref.

for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}

const LINES = Array.from(
  { length: 12 },
  (_, i) => `export const v${i} = ${i};`,
);
const body = (edit = {}) => `${LINES.map((l, i) => edit[i] ?? l).join('\n')}\n`;

/** Each incoming main-side commit, prebuilt on a `sync/<name>` branch. */
const SYNCS = {
  disjoint: { 'src/b.js': 'export const b = 2;\n', 'docs/x.md': '# x\n' },
  conflict: { 'src/a.js': body({ 0: 'export const v0 = "main";' }) },
  intersects: { 'src/a.js': body({ 11: 'export const v11 = "main";' }) },
  baseline: {
    'baselines/coverage.json': body({ 11: 'export const v11 = "main";' }),
  },
  rename: { 'src/old.js': body({ 11: 'export const v11 = "main";' }) },
};

let template;

before(() => {
  template = makeGitTemplate({
    prefix: 'base-sync-probe-',
    files: {
      'src/a.js': body(),
      'src/b.js': 'export const b = 1;\n',
      'src/old.js': body(),
      'baselines/coverage.json': body(),
    },
  });
  const git = (...args) => runGit(template, ...args);
  const commit = () => {
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'work');
  };
  for (const [name, files] of Object.entries(SYNCS)) {
    git('checkout', '-q', '-b', `sync/${name}`, 'main');
    writeFiles(template, files);
    commit();
  }
  git('checkout', '-q', '-b', 'story', 'main');
  writeFiles(template, {
    'src/a.js': body({ 0: 'export const v0 = "story";' }),
    'baselines/coverage.json': body({ 0: 'export const v0 = "story";' }),
  });
  git('mv', 'src/old.js', 'src/new.js');
  commit();
});

/** A copy whose `origin/main` sits at `sync/<name>`. */
async function probeAt(name, opts = {}) {
  const dir = copyGitRepo(template);
  runGit(dir, 'update-ref', 'refs/remotes/origin/main', name);
  return probeBaseSync({
    cwd: dir,
    baseBranch: 'main',
    gitFetchWithRetry: async () => ({ status: opts.fetchStatus ?? 0 }),
    gitSpawn: opts.gitSpawn ?? gitSpawn,
  });
}

describe('probeBaseSync (Story #5954)', () => {
  it('skips a conflict-free, disjoint merge and counts the incoming paths', async () => {
    const probe = await probeAt('sync/disjoint');
    assert.equal(probe.skip, true);
    assert.equal(probe.incoming, 2);
    assert.match(probe.mergeBase, /^[0-9a-f]{40}$/);
    assert.match(describeProbe(probe), /skipped .*2 incoming path\(s\)/);
  });

  it('answers already-current when origin is an ancestor of HEAD', async () => {
    const probe = await probeAt('main');
    assert.deepEqual(probe, { skip: false, reason: 'already-current' });
  });

  it('merges on a conflict', async () => {
    const probe = await probeAt('sync/conflict');
    assert.deepEqual(probe, { skip: false, reason: 'conflict' });
  });

  it('merges when a clean merge still shares a path, naming it', async () => {
    const probe = await probeAt('sync/intersects');
    assert.deepEqual(probe, {
      skip: false,
      reason: 'intersects',
      path: 'src/a.js',
    });
    assert.match(describeProbe(probe), /intersects \(src\/a\.js\)/);
  });

  it('a shared baselines/ file intersects', async () => {
    const probe = await probeAt('sync/baseline');
    assert.deepEqual(probe, {
      skip: false,
      reason: 'intersects',
      path: 'baselines/coverage.json',
    });
  });

  it("a renamed file's old path intersects", async () => {
    const probe = await probeAt('sync/rename');
    assert.deepEqual(probe, {
      skip: false,
      reason: 'intersects',
      path: 'src/old.js',
    });
  });

  it('a merge-tree that exits neither 0 nor 1 is unsupported', async () => {
    const probe = await probeAt('sync/disjoint', {
      gitSpawn: (cwd, ...args) =>
        args[0] === 'merge-tree'
          ? { status: 129, stdout: '' }
          : gitSpawn(cwd, ...args),
    });
    assert.deepEqual(probe, { skip: false, reason: 'unsupported' });
  });

  it('a failed fetch merges', async () => {
    const probe = await probeAt('sync/disjoint', { fetchStatus: 1 });
    assert.deepEqual(probe, { skip: false, reason: 'fetch-failed' });
  });
});
