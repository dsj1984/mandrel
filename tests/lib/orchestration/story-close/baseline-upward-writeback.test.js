/**
 * tests/lib/orchestration/story-close/baseline-upward-writeback.test.js —
 * Story #5224.
 *
 * The upward write-back is the only step in the close that *writes* to a
 * committed baseline, so the tests that matter are the ones that pin what it
 * must never write: a regression, a row for a file outside the branch's own
 * changed set, or a second commit over an already-refreshed tree.
 *
 * Every collaborator is injected per `.agents/rules/test-seams.md` — no git is
 * spawned, no baseline is scored, and nothing touches the real filesystem. The
 * `git` stub records its argv so the assertions can read what the step
 * actually staged and committed rather than inferring it from a return value.
 *
 * One suite is the deliberate exception (Story #5277): the rollback on a
 * rejected commit is a claim about the FILE, and the pre-fix implementation
 * issued a plausible-looking `git checkout -- <path>` that restored nothing.
 * Argv could only ever agree with it, so that suite drives a real repository
 * and reads the bytes back.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { gitSync } from '../../../../.agents/scripts/lib/git-utils.js';
import { runBaselineUpwardWriteback } from '../../../../.agents/scripts/lib/orchestration/story-close/baseline-upward-writeback.js';
import { makeTempDir } from '../../../../.agents/scripts/lib/test-temp.js';

function makeLogger() {
  const logs = { info: [], warn: [], error: [] };
  return {
    logs,
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
  };
}

/**
 * Git stub covering the four subcommands the step issues: the changed-file
 * diff, the branch assertion, `add` and `commit`, plus the `rev-parse` that
 * reports the new SHA.
 */
function makeGit({
  changedFiles = ['.agents/scripts/lib/a.js'],
  onBranch = 'story-5224',
  commitFails = false,
  dirty = [],
  statusFails = false,
  hasOriginRef = true,
} = {}) {
  const calls = [];
  // Matches `git-utils.gitSync`: `(cwd, ...args) => trimmed stdout`, throwing
  // on a non-zero exit.
  const git = (_cwd, ...args) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === 'diff') return `${changedFiles.join('\n')}\n`;
    if (cmd === 'status') {
      if (statusFails) throw new Error('not a git repository');
      return dirty.map((p) => ` M ${p}`).join('\n');
    }
    if (cmd === 'rev-parse' && args.includes('--abbrev-ref'))
      return `${onBranch}\n`;
    if (cmd === 'rev-parse' && args.includes('--verify')) {
      if (hasOriginRef) return 'cafebabe\n';
      const err = new Error('needed a single revision');
      err.status = 1;
      throw err;
    }
    if (cmd === 'rev-parse') return 'feedface\n';
    if (cmd === 'commit' && commitFails) {
      const err = new Error('commitlint rejected the subject');
      err.status = 1;
      throw err;
    }
    return '';
  };
  git.calls = calls;
  git.argvFor = (cmd) => calls.filter((c) => c[0] === cmd);
  return git;
}

/** A refresh stub that records what it was asked to persist. */
function makeRefresh({ wrote = true } = {}) {
  const seen = [];
  const refresh = async (opts) => {
    seen.push(opts);
    return { wrote, envelope: {}, kind: opts.kind, writePath: opts.writePath };
  };
  refresh.seen = seen;
  return refresh;
}

/**
 * Drive the step with a hermetic default wiring. `baselineRows` is the
 * committed baseline; `scored` is what the scorer reports for the branch's
 * changed files.
 */
function run({
  baselineRows,
  scored,
  git = makeGit(),
  refresh = makeRefresh(),
  logger = makeLogger(),
  config,
  storyBranch = 'story-5224',
} = {}) {
  return runBaselineUpwardWriteback({
    cwd: '/repo',
    worktreePath: '/repo/.worktrees/story-5224',
    storyId: 5224,
    baseBranch: 'main',
    storyBranch,
    config,
    logger,
    gitSync: git,
    loadBaselineRows: () => baselineRows,
    scoreFiles: () => scored,
    refreshBaseline: refresh,
    resolveWritePath: ({ cwd }) => `${cwd}/baselines/maintainability.json`,
  });
}

describe('runBaselineUpwardWriteback — Story #5224', () => {
  it('AC-1: persists an improved row and commits it on the story branch', async () => {
    const git = makeGit();
    const refresh = makeRefresh();
    const logger = makeLogger();

    const result = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
      refresh,
      logger,
    });

    assert.equal(result.committed, true);
    assert.equal(result.sha, 'feedface');
    assert.deepEqual(result.improvedPaths, ['.agents/scripts/lib/a.js']);

    // The improved head row is what reaches the write funnel.
    assert.equal(refresh.seen.length, 1);
    assert.equal(refresh.seen[0].kind, 'maintainability');
    assert.deepEqual(await refresh.seen[0].scorer(), [
      { path: '.agents/scripts/lib/a.js', mi: 78 },
    ]);

    // Staged the baseline file by path, then committed it.
    assert.deepEqual(git.argvFor('add')[0], [
      'add',
      '--',
      'baselines/maintainability.json',
    ]);
    assert.equal(git.argvFor('commit').length, 1);
    assert.match(logger.logs.warn.join('\n'), /wrote back 1 improved/);
  });

  it('AC-2: writes only rows for files in the branch changed set', async () => {
    const refresh = makeRefresh();

    const result = await run({
      // `b.js` is stale by 20 points but the branch never touched it, so the
      // scorer never reports it and it must not be rewritten.
      baselineRows: [
        { path: '.agents/scripts/lib/a.js', mi: 70 },
        { path: '.agents/scripts/lib/b.js', mi: 60 },
      ],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      refresh,
    });

    assert.deepEqual(result.improvedPaths, ['.agents/scripts/lib/a.js']);
    assert.deepEqual(refresh.seen[0].scopeFiles, ['.agents/scripts/lib/a.js']);
  });

  it('AC-3: never rewrites a regressed row, and commits nothing for it', async () => {
    const git = makeGit();
    const refresh = makeRefresh();

    const result = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 80 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 61 }],
      git,
      refresh,
    });

    assert.equal(result.committed, false);
    assert.equal(result.reason, 'no-improvements');
    assert.equal(refresh.seen.length, 0);
    assert.equal(git.argvFor('commit').length, 0);
  });

  it('AC-3: a regression alongside an improvement leaves the regressed row alone', async () => {
    const refresh = makeRefresh();

    const result = await run({
      baselineRows: [
        { path: '.agents/scripts/lib/a.js', mi: 70 },
        { path: '.agents/scripts/lib/b.js', mi: 90 },
      ],
      scored: [
        { path: '.agents/scripts/lib/a.js', mi: 78 },
        { path: '.agents/scripts/lib/b.js', mi: 71 },
      ],
      refresh,
    });

    assert.deepEqual(result.improvedPaths, ['.agents/scripts/lib/a.js']);
    assert.deepEqual(refresh.seen[0].scopeFiles, ['.agents/scripts/lib/a.js']);
  });

  it('AC-4: a tree with no improvement produces no commit', async () => {
    const git = makeGit();

    const result = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
    });

    assert.equal(result.committed, false);
    assert.equal(result.reason, 'no-improvements');
    assert.equal(git.argvFor('commit').length, 0);
  });

  it('AC-4: idempotent — the second run over the refreshed tree commits nothing', async () => {
    const first = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
    });
    assert.equal(first.committed, true);

    // Re-run against the tree the first run produced: the committed row now
    // carries the improved score, so nothing is left to write.
    const git = makeGit();
    const second = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
    });
    assert.equal(second.committed, false);
    assert.equal(second.reason, 'no-improvements');
    assert.equal(git.argvFor('commit').length, 0);
  });

  it('AC-4: a write the funnel short-circuits produces no commit', async () => {
    const git = makeGit();
    const result = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
      refresh: makeRefresh({ wrote: false }),
    });

    assert.equal(result.committed, false);
    assert.equal(result.reason, 'unchanged');
    assert.equal(git.argvFor('commit').length, 0);
  });

  it('AC-5: the subject is conventional, carries the refresh marker, and fits commitlint', async () => {
    const git = makeGit();
    await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
    });

    const [commit] = git.argvFor('commit');
    const subject = commit[commit.indexOf('-m') + 1];
    assert.match(subject, /^chore\(baselines\): /);
    assert.ok(
      subject.includes('baseline-refresh:'),
      `subject must carry the acknowledgement marker: ${subject}`,
    );
    assert.ok(
      subject.length <= 100,
      `subject must fit commitlint's 100-char cap (was ${subject.length})`,
    );
    assert.equal(subject.includes('\n'), false);

    // Non-empty body naming the rows, per the drift-check remedy contract.
    const body = commit[commit.lastIndexOf('-m') + 1];
    assert.ok(body.length > 0);
    assert.match(body, /\.agents\/scripts\/lib\/a\.js: 70\.00 -> 78\.00/);
  });

  it('AC-6: only the maintainability baseline is ever written', async () => {
    const refresh = makeRefresh();
    const git = makeGit();
    await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
      refresh,
    });

    assert.deepEqual(
      refresh.seen.map((o) => o.kind),
      ['maintainability'],
    );
    for (const argv of git.argvFor('add')) {
      assert.equal(argv.includes('baselines/crap.json'), false);
    }
  });

  it('honours the CONFIGURED gate tolerance, not just the framework default', async () => {
    // +4.0 clears the 0.5 default comfortably, so a step reading the wrong
    // tolerance source would write this row. The gate declares 5.
    const opts = {
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 74 }],
    };
    const tightened = await run({
      ...opts,
      config: {
        delivery: {
          quality: {
            gates: {
              maintainability: { tolerance: { kind: 'absolute', value: 5 } },
            },
          },
        },
      },
    });
    assert.equal(tightened.committed, false);
    assert.equal(tightened.reason, 'no-improvements');

    // Same movement, framework default tolerance → written.
    const byDefault = await run(opts);
    assert.equal(byDefault.committed, true);
  });

  it('a file new to the baseline is an addition, not an improvement', async () => {
    const refresh = makeRefresh();
    const result = await run({
      baselineRows: [{ path: '.agents/scripts/lib/other.js', mi: 90 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 88 }],
      refresh,
    });
    assert.equal(result.committed, false);
    assert.equal(result.reason, 'no-improvements');
    assert.equal(refresh.seen.length, 0);
  });

  it('refuses to write when the worktree is not on the story branch', async () => {
    const git = makeGit({ onBranch: 'main' });
    const refresh = makeRefresh();
    const result = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
      refresh,
    });

    assert.equal(result.reason, 'wrong-branch');
    // The refusal must precede the write, not follow it.
    assert.equal(refresh.seen.length, 0);
    assert.equal(git.argvFor('add').length, 0);
  });

  it('skips when the gate is disabled', async () => {
    const refresh = makeRefresh();
    const result = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      refresh,
      config: {
        delivery: {
          quality: { gates: { maintainability: { enabled: false } } },
        },
      },
    });
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'gate-disabled');
    assert.equal(refresh.seen.length, 0);
  });

  it('skips when the branch changed no scorable file', async () => {
    const refresh = makeRefresh();
    const result = await run({
      git: makeGit({ changedFiles: ['docs/architecture.md', 'README.md'] }),
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      refresh,
    });
    assert.equal(result.reason, 'no-changed-files');
    assert.equal(refresh.seen.length, 0);
  });

  it('skips when there is no committed baseline to improve on', async () => {
    const result = await run({
      baselineRows: null,
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
    });
    assert.equal(result.reason, 'no-baseline');
  });

  it('skips when the scorer produced nothing', async () => {
    const result = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [],
    });
    assert.equal(result.reason, 'no-scored-rows');
  });

  it('restores the baseline file when the commit is rejected', async () => {
    // Argv is deliberately NOT the assertion here — see the real-repository
    // suite below. `git checkout -- <path>` also records as a rollback and
    // restores nothing, because the index it restores from is the one `git
    // add` just overwrote.
    const git = makeGit({ commitFails: true });
    await assert.rejects(
      run({
        baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
        scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
        git,
      }),
      /commitlint rejected/,
    );
    assert.equal(git.argvFor('restore').length, 1);
  });

  it('AC-6: skips with dirty-tree when the baseline file is already modified', async () => {
    // An uncommitted edit on the baseline would be swept into a commit
    // authored by close and tagged `baseline-refresh:` — the marker
    // `refresh-ack.js` VOUCHES for. An absorbed edit is not merely unrelated;
    // it arrives pre-acknowledged.
    const git = makeGit({ dirty: ['baselines/maintainability.json'] });
    const refresh = makeRefresh();
    const result = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
      refresh,
    });
    assert.equal(result.reason, 'dirty-tree');
    assert.equal(result.ran, false, 'a guard stopped it before any work');
    assert.equal(result.committed, false);
    assert.deepEqual(refresh.seen, [], 'nothing was scored or written');
    assert.equal(git.argvFor('add').length, 0);
  });

  it('AC-6: an unrelated dirty path does not block the write-back', async () => {
    const git = makeGit({ dirty: ['.agents/scripts/lib/a.js'] });
    const result = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
    });
    assert.equal(result.committed, true);
  });

  it('AC-6: an unreadable git status fails closed', async () => {
    const git = makeGit({ statusFails: true });
    const result = await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
    });
    assert.equal(result.reason, 'dirty-tree');
  });

  it('AC-7: scopes the changed set to origin/<baseBranch> when that ref exists', async () => {
    // A worktree is seeded once and never pulled again, so its local `main`
    // drifts behind the remote — and a stale base widens the three-dot range
    // to commits that landed after the branch forked. Every file in that
    // widening would be scored and written back by this Story's PR.
    const git = makeGit();
    await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
    });
    const verify = git.argvFor('rev-parse').find((c) => c.includes('--verify'));
    assert.deepEqual(verify, [
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/main',
    ]);
    const diff = git.argvFor('diff')[0].join(' ');
    assert.match(diff, /origin\/main\.\.\.story-5224/);
  });

  it('AC-7: falls back to the local base branch when origin/<baseBranch> is absent', async () => {
    const git = makeGit({ hasOriginRef: false });
    await run({
      baselineRows: [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
      scored: [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
      git,
    });
    const diff = git.argvFor('diff')[0].join(' ');
    assert.match(diff, /(?<!origin\/)main\.\.\.story-5224/);
  });

  it('rejects a call missing the branch pair rather than guessing one', async () => {
    await assert.rejects(
      runBaselineUpwardWriteback({ cwd: '/repo', storyBranch: 'story-5224' }),
      /baseBranch is required/,
    );
    await assert.rejects(
      runBaselineUpwardWriteback({ cwd: '/repo', baseBranch: 'main' }),
      /storyBranch is required/,
    );
    await assert.rejects(runBaselineUpwardWriteback({}), /cwd is required/);
  });
});

describe('runBaselineUpwardWriteback — rollback in a real repository (AC-5)', () => {
  const REL = 'baselines/maintainability.json';

  /** An envelope carrying one row at `mi`. */
  const envelope = (mi) =>
    `${JSON.stringify(
      {
        $schema: '.agents/schemas/baselines/maintainability.schema.json',
        kernelVersion: '1.0.0',
        generatedAt: '2026-01-01T00:00:00.000Z',
        rollup: { '*': { min: mi } },
        rows: [{ path: '.agents/scripts/lib/a.js', mi }],
      },
      null,
      2,
    )}\n`;

  /**
   * A repo on `story-5224` with the baseline committed at mi 70, and a
   * `commit-msg` hook that rejects — the shape commitlint produces, and the
   * one that made the pre-Story-#5277 rollback observable.
   */
  function repoWithRejectingCommitHook() {
    const dir = makeTempDir('writeback-rollback-');
    const run = (...args) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    run('init', '--initial-branch=main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(dir, 'baselines'), { recursive: true });
    fs.writeFileSync(path.join(dir, REL), envelope(70));
    run('add', '-A');
    run('commit', '-m', 'chore: seed');
    run('checkout', '-b', 'story-5224');
    // One scorable file changed on the branch, so the step's own changed-file
    // scope is non-empty and it reaches the commit.
    fs.mkdirSync(path.join(dir, '.agents/scripts/lib'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agents/scripts/lib/a.js'),
      'export const a = 1;\n',
    );
    run('add', '-A');
    run('commit', '-m', 'feat: a');

    const hooks = path.join(dir, '.githooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(
      path.join(hooks, 'commit-msg'),
      '#!/bin/sh\necho "commitlint rejected the subject" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    run('config', 'core.hooksPath', '.githooks');
    // The rollback assertion compares the file byte-for-byte against what the
    // test wrote. `git restore` re-materializes it through the checkout
    // filters, so a Windows runner defaulting to `core.autocrlf=true` hands
    // back CRLF and the comparison fails on line endings alone. Pinning the
    // fixture keeps the assertion about the rollback rather than the platform.
    run('config', 'core.autocrlf', 'false');
    return dir;
  }

  it('leaves the worktree and the index at HEAD when the commit is rejected', async () => {
    const dir = repoWithRejectingCommitHook();
    const committed = fs.readFileSync(path.join(dir, REL), 'utf8');

    await assert.rejects(
      runBaselineUpwardWriteback({
        cwd: dir,
        worktreePath: dir,
        storyId: 5224,
        baseBranch: 'main',
        storyBranch: 'story-5224',
        logger: makeLogger(),
        gitSync,
        loadBaselineRows: () => [{ path: '.agents/scripts/lib/a.js', mi: 70 }],
        scoreFiles: () => [{ path: '.agents/scripts/lib/a.js', mi: 78 }],
        // The one collaborator that must be real for this assertion: the
        // rollback is about a file that was genuinely written and staged.
        refreshBaseline: async ({ writePath }) => {
          fs.writeFileSync(writePath, envelope(78));
          return { wrote: true };
        },
        resolveWritePath: ({ cwd }) => path.join(cwd, REL),
      }),
      /commit/i,
    );

    // The file itself — not the argv that was supposed to restore it. The
    // pre-fix rollback (`git checkout -- <path>`) restored the worktree FROM
    // the index, and the index was exactly what `git add` had just
    // overwritten, so this read returned the rewritten row at 78.
    assert.equal(
      fs.readFileSync(path.join(dir, REL), 'utf8'),
      committed,
      'the worktree copy must equal HEAD',
    );
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    assert.equal(staged, '', 'nothing may be left staged');
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((l) => l.includes(REL));
    assert.deepEqual(dirty, [], 'nothing may be left modified');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
