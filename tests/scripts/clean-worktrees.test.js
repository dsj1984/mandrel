import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLASSES,
  dirSizeBytes,
  formatBytes,
  listProcessCwds,
  renderTable,
  runCleanWorktrees,
  runCleanWorktreesCli,
} from '../../.agents/scripts/clean-worktrees.js';
import { gitSpawn } from '../../.agents/scripts/lib/git-utils.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { makeGitRepo } from '../fixtures/git-fixture.js';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.agents/scripts/clean-worktrees.js',
);

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function git(cwd, ...args) {
  const res = gitSpawn(cwd, ...args);
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * A project with one worktree per class and per kept-reason, plus an
 * `origin` remote so "reachable from a remote-tracking ref" is real.
 */
function buildProject() {
  const repo = fs.realpathSync(makeGitRepo({ prefix: 'clean-wt-' }));
  const outside = fs.realpathSync(makeTempDir('clean-wt-outside-'));
  tmpDirs.push(repo, outside);
  const remote = path.join(outside, 'remote.git');
  git(outside, 'init', '-q', '--bare', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  const mainHead = git(repo, 'rev-parse', 'HEAD');

  const p = (...parts) => path.join(repo, ...parts);
  const add = (rel, ...extra) => git(repo, 'worktree', 'add', ...extra, rel);
  const paths = {
    closed: p('.worktrees', 'story-21'),
    open: p('.worktrees', 'story-22'),
    dirty: p('.worktrees', 'story-23'),
    unpushed: p('.worktrees', 'story-24'),
    merged: p('.worktrees', 'feat-merged'),
    unmerged: p('.worktrees', 'feat-open'),
    detached: p('.claude', 'worktrees', 'wt-1'),
    orphan: p('.worktrees', 'orphan-9'),
    external: path.join(outside, 'ext'),
  };
  add(paths.closed, '-b', 'story-21');
  add(paths.open, '-b', 'story-22');
  add(paths.dirty, '-b', 'story-23');
  add(paths.unpushed, '-b', 'story-24');
  add(paths.merged, '-b', 'feat-merged');
  add(paths.unmerged, '-b', 'feat-open');
  add(paths.detached, '--detach');
  add(paths.external, '-b', 'ext');
  fs.writeFileSync(path.join(paths.dirty, 'wip.txt'), 'unsaved');
  fs.writeFileSync(path.join(paths.unpushed, 'new.txt'), 'local only');
  git(paths.unpushed, 'add', 'new.txt');
  git(
    paths.unpushed,
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'local',
  );
  fs.mkdirSync(paths.orphan, { recursive: true });
  fs.writeFileSync(path.join(paths.orphan, 'stale.txt'), 'x');

  const tickets = {
    21: { id: 21, state: 'closed', labels: ['agent::done'] },
    22: { id: 22, state: 'open', labels: ['agent::executing'] },
    23: { id: 23, state: 'closed', labels: [] },
    24: { id: 24, state: 'open', labels: ['agent::done'] },
  };
  const deps = {
    cwd: repo,
    getTicket: async (id) => tickets[id],
    prLookup: (branch) =>
      branch === 'feat-merged' ? [{ number: 1, headRefOid: mainHead }] : [],
    processCwds: [],
    sizeOf: () => 100,
    logger: { info() {}, warn() {}, error() {} },
  };
  return { repo, paths, deps };
}

function byPath(result) {
  return Object.fromEntries(result.entries.map((e) => [e.path, e]));
}

describe('clean-worktrees — dry run (AC-2)', () => {
  it('puts every worktree in exactly one class or kept-reason and removes nothing', async () => {
    const { repo, paths, deps } = buildProject();
    const result = await runCleanWorktrees(deps);

    assert.equal(result.mode, 'dry-run');
    assert.equal(result.bytesReclaimed, 0);
    assert.equal(result.projectRoot, repo);
    for (const e of result.entries) {
      assert.equal(
        (e.class === null) !== (e.reason === null),
        true,
        `exactly one of class/reason for ${e.path}`,
      );
    }
    const got = byPath(result);
    const verdict = (p) => got[p].class ?? got[p].reason;
    assert.equal(verdict(repo), 'main-checkout');
    assert.equal(verdict(paths.closed), CLASSES.CLOSED_STORY);
    assert.equal(verdict(paths.open), 'story-open');
    assert.equal(verdict(paths.dirty), 'dirty-tree');
    assert.equal(verdict(paths.unpushed), 'unpushed-commits');
    assert.equal(verdict(paths.merged), CLASSES.MERGED_BRANCH);
    assert.equal(verdict(paths.unmerged), 'unmerged-branch');
    assert.equal(verdict(paths.detached), CLASSES.DETACHED);
    assert.equal(verdict(paths.orphan), CLASSES.ORPHAN_DIR);
    assert.equal(verdict(paths.external), 'outside-project');
    assert.equal(result.entries.length, 10, 'registered + orphan, no more');
    for (const p of Object.values(paths)) {
      assert.equal(fs.existsSync(p), true, `dry run kept ${p}`);
    }
    assert.match(renderTable(result), /Dry run — nothing removed/);
  });
});

describe('clean-worktrees — --execute --yes (AC-3, AC-4)', () => {
  it('removes closed-story, merged-branch and orphan-dir; the rest survive', async () => {
    const { paths, deps } = buildProject();
    const result = await runCleanWorktrees({
      ...deps,
      execute: true,
      yes: true,
    });
    const got = byPath(result);

    for (const gone of [paths.closed, paths.merged, paths.orphan]) {
      assert.equal(got[gone].action, 'removed', gone);
      assert.equal(fs.existsSync(gone), false, `${gone} removed`);
    }
    for (const kept of [
      paths.detached,
      paths.dirty,
      paths.unpushed,
      paths.open,
      paths.unmerged,
      paths.external,
    ]) {
      assert.equal(fs.existsSync(kept), true, `${kept} survives`);
    }
    assert.equal(got[paths.detached].action, 'skipped');
    assert.equal(got[paths.detached].reason, 'detached-never-under-yes');
    assert.equal(got[paths.external].action, 'kept');
    assert.equal(got[paths.external].reason, 'outside-project');
    assert.equal(result.bytesReclaimed, 300);
    assert.match(renderTable(result), /Reclaimed 300B/);
  });
});

describe('clean-worktrees — confirmation and live trees', () => {
  it('removes a detached tree only on a per-entry interactive yes', async () => {
    const { paths, deps } = buildProject();
    const asked = [];
    const result = await runCleanWorktrees({
      ...deps,
      execute: true,
      confirm: async (entry) => {
        asked.push(entry.class);
        return entry.class === CLASSES.DETACHED;
      },
    });
    const got = byPath(result);
    assert.equal(got[paths.detached].action, 'removed');
    assert.equal(fs.existsSync(paths.detached), false);
    assert.equal(got[paths.closed].reason, 'declined');
    assert.equal(fs.existsSync(paths.closed), true);
    assert.equal(asked.length, 4, 'asked once per candidate');
  });

  it('removes nothing under --execute with no --yes and no terminal', async () => {
    const { paths, deps } = buildProject();
    const result = await runCleanWorktrees({ ...deps, execute: true });
    for (const e of result.entries.filter((x) => x.class)) {
      assert.equal(e.action, 'skipped');
      assert.equal(e.reason, 'needs-confirmation');
    }
    assert.equal(fs.existsSync(paths.orphan), true);
    assert.equal(result.bytesReclaimed, 0);
  });

  it('keeps trees the running process or a live process uses', async () => {
    const { paths, deps } = buildProject();
    const result = await runCleanWorktrees({
      ...deps,
      runningPaths: [path.join(paths.closed, 'index.js')],
      processCwds: [path.join(paths.merged, 'sub'), paths.orphan],
    });
    const got = byPath(result);
    assert.equal(got[paths.closed].reason, 'running-from-tree');
    assert.equal(got[paths.merged].reason, 'live-process');
    assert.equal(got[paths.orphan].reason, 'live-process');
  });

  it('reports a failed removal instead of counting it', async () => {
    const { deps } = buildProject();
    const result = await runCleanWorktrees({
      ...deps,
      execute: true,
      yes: true,
      removeFn: async () => ({ removed: false, reason: 'EBUSY' }),
    });
    const failed = result.entries.filter((e) => e.action === 'failed');
    assert.equal(failed.length, 3);
    assert.equal(failed[0].reason, 'remove-failed: EBUSY');
    assert.equal(result.bytesReclaimed, 0);
  });

  it('keeps a Story tree whose ticket read or PR lookup fails', async () => {
    const { paths, deps } = buildProject();
    const result = await runCleanWorktrees({
      ...deps,
      getTicket: async () => {
        throw new Error('rate limited');
      },
      prLookup: () => {
        throw new Error('gh missing');
      },
    });
    const got = byPath(result);
    assert.equal(got[paths.closed].reason, 'provider-error: rate limited');
    assert.equal(got[paths.merged].reason, 'pr-lookup-failed: gh missing');
  });
});

describe('clean-worktrees — CLI shell (AC-6)', () => {
  it('--help prints usage to stdout and exits 0 without enumerating', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_LOG_LEVEL: 'silent' },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Usage: node \.agents\/scripts\/clean-worktrees/);
  });

  it('renders the table by default and JSON under --json', async () => {
    const out = [];
    const envelope = {
      kind: 'clean-worktrees',
      mode: 'dry-run',
      projectRoot: '/p',
      entries: [
        {
          path: '/p/.worktrees/story-1',
          branch: null,
          head: 'abcdef0123',
          class: CLASSES.DETACHED,
          reason: null,
          sizeBytes: 2048,
          action: 'candidate',
        },
      ],
      bytesReclaimed: 0,
    };
    const calls = [];
    const deps = {
      runImpl: async (args) => {
        calls.push(args);
        return envelope;
      },
      write: (t) => out.push(t),
      isTTY: true,
    };
    await runCleanWorktreesCli([], deps);
    assert.match(
      out[0],
      /detached\s+\.worktrees\/story-1\s+2\.0KB\s+\(detached abcdef0\)/,
    );
    assert.equal(typeof calls[0].confirm, 'function', 'TTY → prompts');

    await runCleanWorktreesCli(['--json', '--execute', '--yes'], deps);
    assert.deepEqual(JSON.parse(out[1]), envelope);
    assert.equal(calls[1].confirm, null, 'JSON never prompts');
    assert.equal(calls[1].execute, true);
    assert.equal(calls[1].yes, true);
  });
});

describe('clean-worktrees — helpers', () => {
  it('formatBytes scales units', () => {
    assert.equal(formatBytes(null), '-');
    assert.equal(formatBytes(512), '512B');
    assert.equal(formatBytes(10.4 * 1024 ** 3), '10.4GB');
  });

  it('listProcessCwds reads /proc on Linux, lsof on macOS, nothing on Windows', () => {
    const fakeFs = {
      readdirSync: () => ['1', '2', 'self'],
      readlinkSync: (p) => {
        if (p === '/proc/2/cwd') throw new Error('EACCES');
        return '/work/a';
      },
    };
    assert.deepEqual(listProcessCwds({ platform: 'linux', fsImpl: fakeFs }), [
      '/work/a',
    ]);
    const spawn = () => ({ status: 0, stdout: 'p1\nfcwd\nn/work/b\np2\nn/c' });
    assert.deepEqual(listProcessCwds({ platform: 'darwin', spawn }), [
      '/work/b',
      '/c',
    ]);
    assert.equal(
      listProcessCwds({ platform: 'darwin', spawn: () => ({ stdout: '' }) }),
      null,
    );
    assert.equal(listProcessCwds({ platform: 'win32' }), null);
  });

  it('dirSizeBytes uses du, else walks without following links', () => {
    assert.equal(
      dirSizeBytes('/x', {
        platform: 'darwin',
        spawn: () => ({ status: 0, stdout: '4\t/x' }),
      }),
      4096,
    );
    const dir = makeTempDir('clean-wt-size-');
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), '12345');
    fs.writeFileSync(path.join(dir, 'b.txt'), '123');
    assert.equal(dirSizeBytes(dir, { platform: 'win32' }), 8);
    assert.equal(
      dirSizeBytes(path.join(dir, 'missing'), { platform: 'win32' }),
      null,
    );
  });
});
