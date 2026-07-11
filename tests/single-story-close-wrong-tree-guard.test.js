/**
 * Regression tests for the wrong-tree guard in `single-story-close.js`.
 *
 * Story #3364 — `/single-story-deliver` materializes a per-Story worktree, but
 * on Windows `cd <workCwd>` only steers the Bash tool's cwd: the path-based
 * Edit/Write tools resolve absolute paths and ignore it. An agent can silently
 * edit the MAIN CHECKOUT while its shell sits in the worktree, and nothing in
 * the close path detected it — close would commit an unchanged worktree and
 * open an empty-diff PR.
 *
 * Story #4424 — the raw "main checkout is dirty" signal is too coarse for
 * multi-session operation: stray main-checkout paths can belong to another
 * concurrent session. The guard now intersects the main-checkout stray tracked
 * paths with the Story's own diff-path set (committed diff vs base + the
 * worktree's uncommitted tracked changes):
 *   AC-1 (overlap):     at least one stray path is in the Story diff set →
 *                       throw (close aborts) + friction comment naming strays.
 *   Disjoint downgrade: Story diff set non-empty and fully disjoint from the
 *                       strays → no throw, a "close proceeded" friction comment
 *                       naming the disjoint strays, result identifies the
 *                       downgrade (`overlap: []`).
 *   Empty-diff backstop: empty Story diff set + stray paths → keep the abort
 *                       (the original #3364 silent empty-diff failure mode).
 *   Probe failure:      a main-checkout status probe failure still skips the
 *                       guard (fail-open); a Story-diff probe failure with
 *                       strays present falls back to the coarse abort.
 *   AC-2:               the helper workflow doc states the worktree-scope
 *                       requirement for the path-based edit tools (asserted in
 *                       a sibling doc-contract assertion at the bottom).
 *
 * Tests exercise the pure helpers directly (`parsePorcelainStatus`,
 * `collectStrayTrackedPaths`, `parseDiffNameOnly`, `intersectPaths`,
 * `collectStoryDiffPaths`, `guardApplies`, `formatWrongTreeFinding`,
 * `formatWrongTreeDowngradeFinding`) and the orchestration wrapper
 * (`runWrongTreeGuardPhase`) with an in-memory provider and an injected fake
 * `gitSpawn` so no real git or GitHub call is made.
 */

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectStoryDiffPaths,
  collectStrayTrackedPaths,
  formatWrongTreeDowngradeFinding,
  formatWrongTreeFinding,
  guardApplies,
  intersectPaths,
  parseDiffNameOnly,
  parsePorcelainStatus,
  runWrongTreeGuardPhase,
} from '../.agents/scripts/lib/orchestration/single-story-close/phases/wrong-tree-guard.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * Minimal in-memory provider. The guard only calls `postComment`.
 */
function makeProvider() {
  const comments = [];
  let nextId = 1;
  return {
    comments,
    async postComment(ticketId, { type, body }) {
      const id = nextId++;
      comments.push({ id, ticketId, type, body });
      return { commentId: id };
    },
    async getTicketComments(ticketId) {
      return comments.filter((c) => c.ticketId === ticketId);
    },
  };
}

/**
 * Build a fake `gitSpawn(dir, ...args)` that dispatches by command + tree.
 *
 * `status --porcelain` against a `.worktrees/` path is the worktree probe;
 * against any other dir it is the main-checkout probe. `diff` is the worktree
 * committed-diff probe. Any probe can be forced to throw or exit non-zero.
 */
function fakeGit({
  main = '',
  mainStatus = 0,
  mainThrows = null,
  diff = '',
  diffStatus = 0,
  diffThrows = null,
  wtStatus = '',
  wtStatusCode = 0,
} = {}) {
  return (dir, ...args) => {
    if (args[0] === 'status') {
      const isWorktree = String(dir).includes('.worktrees');
      if (isWorktree) {
        return { status: wtStatusCode, stdout: wtStatus, stderr: '' };
      }
      if (mainThrows) throw new Error(mainThrows);
      return {
        status: mainStatus,
        stdout: main,
        stderr: mainStatus === 0 ? '' : 'main status err',
      };
    }
    if (args[0] === 'diff') {
      if (diffThrows) throw new Error(diffThrows);
      return {
        status: diffStatus,
        stdout: diff,
        stderr: diffStatus === 0 ? '' : 'diff err',
      };
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function noop() {}

// ---------------------------------------------------------------------------
// parsePorcelainStatus — pure unit
// ---------------------------------------------------------------------------

describe('parsePorcelainStatus — pure unit', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(parsePorcelainStatus(''), []);
    assert.deepEqual(parsePorcelainStatus('   '), []);
    assert.deepEqual(parsePorcelainStatus(undefined), []);
  });

  it('parses modified tracked file', () => {
    const entries = parsePorcelainStatus(' M src/a.js');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'src/a.js');
    assert.equal(entries[0].untracked, false);
  });

  it('parses staged + modified tracked files', () => {
    const entries = parsePorcelainStatus('M  src/a.js\n M src/b.js');
    assert.deepEqual(
      entries.map((e) => e.path),
      ['src/a.js', 'src/b.js'],
    );
    assert.ok(entries.every((e) => e.untracked === false));
  });

  it('flags untracked files via the ?? status', () => {
    const entries = parsePorcelainStatus('?? scratch.txt');
    assert.equal(entries[0].untracked, true);
  });

  it('keeps BOTH sides of a rename (origin first, then destination)', () => {
    // A stray main-checkout rename whose ORIGIN is in the Story's diff
    // set must intersect — collapsing to the destination only let that
    // stray downgrade to proceed (Epic #4406 review finding).
    const entries = parsePorcelainStatus('R  old.js -> new.js');
    assert.deepEqual(
      entries.map((e) => e.path),
      ['old.js', 'new.js'],
    );
    assert.equal(entries[0].untracked, false);
    assert.equal(entries[1].untracked, false);
  });

  it('strips surrounding quotes from special-char paths', () => {
    const entries = parsePorcelainStatus(' M "src/with space.js"');
    assert.equal(entries[0].path, 'src/with space.js');
  });

  it('tolerates carriage returns (Windows CRLF git output)', () => {
    const entries = parsePorcelainStatus(' M src/a.js\r\n M src/b.js\r');
    assert.deepEqual(
      entries.map((e) => e.path),
      ['src/a.js', 'src/b.js'],
    );
  });
});

// ---------------------------------------------------------------------------
// collectStrayTrackedPaths — pure unit
// ---------------------------------------------------------------------------

describe('collectStrayTrackedPaths — pure unit', () => {
  it('returns tracked-path changes only, sorted', () => {
    const entries = parsePorcelainStatus(' M src/z.js\nM  src/a.js');
    assert.deepEqual(collectStrayTrackedPaths(entries), [
      'src/a.js',
      'src/z.js',
    ]);
  });

  it('excludes untracked files', () => {
    const entries = parsePorcelainStatus(' M src/a.js\n?? scratch.txt');
    assert.deepEqual(collectStrayTrackedPaths(entries), ['src/a.js']);
  });

  it('returns empty when only untracked files are present', () => {
    const entries = parsePorcelainStatus('?? a.txt\n?? b.txt');
    assert.deepEqual(collectStrayTrackedPaths(entries), []);
  });
});

// ---------------------------------------------------------------------------
// parseDiffNameOnly — pure unit
// ---------------------------------------------------------------------------

describe('parseDiffNameOnly — pure unit', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(parseDiffNameOnly(''), []);
    assert.deepEqual(parseDiffNameOnly('  '), []);
    assert.deepEqual(parseDiffNameOnly(undefined), []);
  });

  it('splits newline-separated paths and trims CR', () => {
    assert.deepEqual(parseDiffNameOnly('src/a.js\nsrc/b.js\r'), [
      'src/a.js',
      'src/b.js',
    ]);
  });
});

// ---------------------------------------------------------------------------
// intersectPaths — pure unit
// ---------------------------------------------------------------------------

describe('intersectPaths — pure unit', () => {
  it('returns the sorted shared paths', () => {
    assert.deepEqual(
      intersectPaths(['b.js', 'a.js', 'c.js'], ['c.js', 'a.js']),
      ['a.js', 'c.js'],
    );
  });

  it('returns empty for disjoint sets', () => {
    assert.deepEqual(intersectPaths(['x.js'], ['y.js']), []);
  });

  it('uses repo-relative path equality regardless of probe tree', () => {
    // The same file edited in both trees must intersect even though the probes
    // ran in different working directories.
    assert.deepEqual(
      intersectPaths(['.agents/scripts/foo.js'], ['.agents/scripts/foo.js']),
      ['.agents/scripts/foo.js'],
    );
  });
});

// ---------------------------------------------------------------------------
// collectStoryDiffPaths — pure unit
// ---------------------------------------------------------------------------

describe('collectStoryDiffPaths — pure unit', () => {
  it('unions committed diff and uncommitted tracked changes, sorted', () => {
    const result = collectStoryDiffPaths({
      worktreePath: '/repo/.worktrees/story-1',
      baseBranch: 'main',
      gitSpawnFn: fakeGit({
        diff: 'src/b.js\nsrc/a.js',
        wtStatus: ' M src/c.js',
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.paths, ['src/a.js', 'src/b.js', 'src/c.js']);
  });

  it('deduplicates a path present in both committed and uncommitted sets', () => {
    const result = collectStoryDiffPaths({
      worktreePath: '/repo/.worktrees/story-1',
      baseBranch: 'main',
      gitSpawnFn: fakeGit({ diff: 'src/a.js', wtStatus: ' M src/a.js' }),
    });
    assert.deepEqual(result.paths, ['src/a.js']);
  });

  it('excludes untracked worktree files from the diff set', () => {
    const result = collectStoryDiffPaths({
      worktreePath: '/repo/.worktrees/story-1',
      baseBranch: 'main',
      gitSpawnFn: fakeGit({ diff: '', wtStatus: '?? scratch.txt' }),
    });
    assert.deepEqual(result.paths, []);
  });

  it('reports ok:false when the diff probe throws', () => {
    const result = collectStoryDiffPaths({
      worktreePath: '/repo/.worktrees/story-1',
      baseBranch: 'main',
      gitSpawnFn: fakeGit({ diffThrows: 'git not found' }),
    });
    assert.equal(result.ok, false);
  });

  it('reports ok:false when the diff probe exits non-zero', () => {
    const result = collectStoryDiffPaths({
      worktreePath: '/repo/.worktrees/story-1',
      baseBranch: 'main',
      gitSpawnFn: fakeGit({ diffStatus: 128 }),
    });
    assert.equal(result.ok, false);
  });

  it('reports ok:false when the worktree status probe exits non-zero', () => {
    const result = collectStoryDiffPaths({
      worktreePath: '/repo/.worktrees/story-1',
      baseBranch: 'main',
      gitSpawnFn: fakeGit({ diff: 'src/a.js', wtStatusCode: 128 }),
    });
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// guardApplies — pure unit
// ---------------------------------------------------------------------------

describe('guardApplies — pure unit', () => {
  it('is false when no worktree exists', () => {
    assert.equal(guardApplies({ cwd: '/repo', worktreePath: null }), false);
  });

  it('is false in single-tree mode (worktree === main checkout)', () => {
    assert.equal(guardApplies({ cwd: '/repo', worktreePath: '/repo' }), false);
  });

  it('is true when the worktree is a distinct directory', () => {
    assert.equal(
      guardApplies({
        cwd: '/repo',
        worktreePath: '/repo/.worktrees/story-1',
      }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// formatWrongTreeFinding / formatWrongTreeDowngradeFinding — pure unit
// ---------------------------------------------------------------------------

describe('formatWrongTreeFinding — pure unit', () => {
  it('names each stray file and the story id', () => {
    const body = formatWrongTreeFinding({
      storyId: 42,
      strayFiles: ['src/a.js', 'src/b.js'],
      worktreePath: '/repo/.worktrees/story-42',
    });
    assert.match(body, /#42/);
    assert.match(body, /`src\/a\.js`/);
    assert.match(body, /`src\/b\.js`/);
  });

  it('states close was aborted', () => {
    const body = formatWrongTreeFinding({
      storyId: 1,
      strayFiles: ['x.js'],
      worktreePath: '/wt',
    });
    assert.match(body, /aborted/i);
  });
});

describe('formatWrongTreeDowngradeFinding — pure unit', () => {
  it('states close proceeded and names the disjoint stray files', () => {
    const body = formatWrongTreeDowngradeFinding({
      storyId: 7,
      strayFiles: ['other/session.js'],
      worktreePath: '/repo/.worktrees/story-7',
    });
    assert.match(body, /#7/);
    assert.match(body, /proceeded/i);
    assert.match(body, /disjoint/i);
    assert.match(body, /`other\/session\.js`/);
    assert.doesNotMatch(body, /aborted/i);
  });
});

// ---------------------------------------------------------------------------
// runWrongTreeGuardPhase — orchestration contract tests
// ---------------------------------------------------------------------------

describe('runWrongTreeGuardPhase — AC-1: aborts on overlap with the Story diff', () => {
  it('throws and posts a friction comment naming the stray files when a stray path is in the Story diff', async () => {
    const storyId = 200;
    const provider = makeProvider();

    await assert.rejects(
      () =>
        runWrongTreeGuardPhase({
          cwd: '/repo',
          worktreePath: '/repo/.worktrees/story-200',
          baseBranch: 'main',
          storyId,
          provider,
          progress: noop,
          // Main checkout has two stray files; the Story's committed diff
          // touches one of them → overlap → abort.
          gitSpawn: fakeGit({
            main: ' M .agents/scripts/foo.js\nM  docs/bar.md',
            diff: '.agents/scripts/foo.js',
          }),
        }),
      /Wrong-tree edits detected/,
    );

    const comments = await provider.getTicketComments(storyId);
    assert.equal(comments.length, 1, 'expected one friction comment');
    assert.equal(comments[0].type, 'friction');
    assert.match(comments[0].body, /aborted/i);
    assert.match(comments[0].body, /`\.agents\/scripts\/foo\.js`/);
    assert.match(comments[0].body, /`docs\/bar\.md`/);
  });

  it('error message lists the stray files for the operator', async () => {
    const provider = makeProvider();
    await assert.rejects(
      () =>
        runWrongTreeGuardPhase({
          cwd: '/repo',
          worktreePath: '/repo/.worktrees/story-201',
          baseBranch: 'main',
          storyId: 201,
          provider,
          progress: noop,
          gitSpawn: fakeGit({
            main: ' M src/leaked.js',
            diff: 'src/leaked.js',
          }),
        }),
      /src\/leaked\.js/,
    );
  });

  it('intersects an uncommitted worktree change (not only the committed diff)', async () => {
    const provider = makeProvider();
    await assert.rejects(
      () =>
        runWrongTreeGuardPhase({
          cwd: '/repo',
          worktreePath: '/repo/.worktrees/story-208',
          baseBranch: 'main',
          storyId: 208,
          provider,
          progress: noop,
          // No committed diff, but the worktree has an uncommitted edit to the
          // same file that is stray in the main checkout → overlap → abort.
          gitSpawn: fakeGit({
            main: ' M src/shared.js',
            diff: '',
            wtStatus: ' M src/shared.js',
          }),
        }),
      /Wrong-tree edits detected/,
    );
  });
});

describe('runWrongTreeGuardPhase — disjoint downgrade proceeds without throwing', () => {
  it('does not throw, posts a proceeded-wording friction comment naming the disjoint strays, and reports overlap:[]', async () => {
    const storyId = 210;
    const provider = makeProvider();
    const result = await runWrongTreeGuardPhase({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-210',
      baseBranch: 'main',
      storyId,
      provider,
      progress: noop,
      // Main-checkout strays belong to another session; the Story diff is a
      // non-empty, fully disjoint set → downgrade → proceed.
      gitSpawn: fakeGit({
        main: ' M other/alpha.js\nM  other/beta.js',
        diff: 'src/mine.js',
      }),
    });

    assert.equal(result.applied, true);
    assert.deepEqual(result.overlap, []);
    assert.deepEqual(result.strayFiles, ['other/alpha.js', 'other/beta.js']);

    const comments = await provider.getTicketComments(storyId);
    assert.equal(comments.length, 1, 'expected one telemetry friction comment');
    assert.equal(comments[0].type, 'friction');
    assert.match(comments[0].body, /proceeded/i);
    assert.doesNotMatch(comments[0].body, /aborted/i);
    assert.match(comments[0].body, /`other\/alpha\.js`/);
    assert.match(comments[0].body, /`other\/beta\.js`/);
  });
});

describe('runWrongTreeGuardPhase — empty-diff backstop keeps the abort', () => {
  it('throws when the Story diff-path set is empty and the main checkout has stray tracked paths', async () => {
    const storyId = 211;
    const provider = makeProvider();
    await assert.rejects(
      () =>
        runWrongTreeGuardPhase({
          cwd: '/repo',
          worktreePath: '/repo/.worktrees/story-211',
          baseBranch: 'main',
          storyId,
          provider,
          progress: noop,
          // The worktree has no committed diff and no uncommitted tracked
          // changes → empty Story diff set → keep the #3364 abort.
          gitSpawn: fakeGit({
            main: ' M src/leaked.js',
            diff: '',
            wtStatus: '',
          }),
        }),
      /Wrong-tree edits detected/,
    );
    const comments = await provider.getTicketComments(storyId);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /aborted/i);
  });
});

describe('runWrongTreeGuardPhase — Story-diff probe failure falls back to abort', () => {
  it('throws (coarse abort) when strays are present but the diff probe fails', async () => {
    const storyId = 212;
    const provider = makeProvider();
    await assert.rejects(
      () =>
        runWrongTreeGuardPhase({
          cwd: '/repo',
          worktreePath: '/repo/.worktrees/story-212',
          baseBranch: 'main',
          storyId,
          provider,
          progress: noop,
          // Main checkout dirty, but the Story-diff probe blows up → must NOT
          // silently pass; fall back to the coarse abort.
          gitSpawn: fakeGit({
            main: ' M src/leaked.js',
            diffThrows: 'git boom',
          }),
        }),
      /Wrong-tree edits detected/,
    );
    const comments = await provider.getTicketComments(storyId);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /aborted/i);
  });
});

describe('runWrongTreeGuardPhase — clean / ignored main checkout proceeds', () => {
  it('returns applied:true and does not throw when main checkout is clean', async () => {
    const provider = makeProvider();
    const result = await runWrongTreeGuardPhase({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-202',
      baseBranch: 'main',
      storyId: 202,
      provider,
      progress: noop,
      gitSpawn: fakeGit({ main: '' }),
    });
    assert.equal(result.applied, true);
    assert.deepEqual(result.strayFiles, []);
    const comments = await provider.getTicketComments(202);
    assert.equal(comments.length, 0);
  });

  it('ignores untracked-only changes (scratch files are not wrong-tree edits)', async () => {
    const provider = makeProvider();
    const result = await runWrongTreeGuardPhase({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-203',
      baseBranch: 'main',
      storyId: 203,
      provider,
      progress: noop,
      gitSpawn: fakeGit({ main: '?? temp/scratch.json\n?? notes.txt' }),
    });
    assert.equal(result.applied, true);
    assert.deepEqual(result.strayFiles, []);
    const comments = await provider.getTicketComments(203);
    assert.equal(comments.length, 0);
  });
});

describe('runWrongTreeGuardPhase — guard does not apply', () => {
  it('no-ops in single-tree mode (worktree === main checkout)', async () => {
    let probed = false;
    const result = await runWrongTreeGuardPhase({
      cwd: '/repo',
      worktreePath: '/repo',
      baseBranch: 'main',
      storyId: 204,
      provider: makeProvider(),
      progress: noop,
      gitSpawn: () => {
        probed = true;
        return { status: 0, stdout: ' M src/a.js', stderr: '' };
      },
    });
    assert.equal(result.applied, false);
    assert.equal(probed, false, 'must not probe git when guard does not apply');
  });

  it('no-ops when no worktree exists', async () => {
    const result = await runWrongTreeGuardPhase({
      cwd: '/repo',
      worktreePath: null,
      baseBranch: 'main',
      storyId: 205,
      provider: makeProvider(),
      progress: noop,
      gitSpawn: fakeGit({ main: ' M src/a.js' }),
    });
    assert.equal(result.applied, false);
  });
});

describe('runWrongTreeGuardPhase — fail-open on main-checkout probe error', () => {
  it('does not throw when gitSpawn throws (probe hiccup never blocks close)', async () => {
    const result = await runWrongTreeGuardPhase({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-206',
      baseBranch: 'main',
      storyId: 206,
      provider: makeProvider(),
      progress: noop,
      gitSpawn: fakeGit({ mainThrows: 'git not found' }),
    });
    assert.equal(result.applied, false);
  });

  it('does not throw when main git status exits non-zero', async () => {
    const result = await runWrongTreeGuardPhase({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-207',
      baseBranch: 'main',
      storyId: 207,
      provider: makeProvider(),
      progress: noop,
      gitSpawn: fakeGit({ mainStatus: 128 }),
    });
    assert.equal(result.applied, false);
  });
});

// ---------------------------------------------------------------------------
// AC-2: helper workflow doc states the path-based edit-tool scope requirement.
// ---------------------------------------------------------------------------

describe('AC-2: single-story-deliver doc clarifies path-based edit scope', () => {
  it('Step 0.5 instructs prefixing Edit/Write paths with the worktree root', () => {
    const docPath = path.join(
      REPO_ROOT,
      '.agents',
      'workflows',
      'helpers',
      'single-story-deliver.md',
    );
    const doc = nodeFs.readFileSync(docPath, 'utf8');
    // The doc must mention the path-based Edit/Write tools (not only Bash cwd).
    assert.match(doc, /Edit\/Write/);
    // And it must say those paths are prefixed/scoped with the worktree root.
    assert.match(
      doc,
      /absolute worktree root|prefix[^\n]*workCwd|worktree root/i,
    );
  });
});
