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
 * Asserts:
 *   AC-1: when the worktree is the active work tree and the main checkout has
 *         uncommitted tracked-path changes, the guard throws (close aborts)
 *         and posts a `friction` comment naming the stray files.
 *   AC-2: the helper workflow doc states the worktree-scope requirement for
 *         the path-based edit tools, not only for the Bash cwd (asserted in a
 *         sibling doc-contract assertion at the bottom of this file).
 *   - The guard does not fire in single-tree mode (worktree === main checkout).
 *   - The guard does not fire when no worktree exists.
 *   - The guard ignores untracked (`??`) files — only tracked-path edits count.
 *   - The guard fails open on a git probe error (never blocks a valid close).
 *
 * Tests exercise the pure helpers directly (`parsePorcelainStatus`,
 * `collectStrayTrackedPaths`, `guardApplies`, `formatWrongTreeFinding`) and the
 * orchestration wrapper (`runWrongTreeGuardPhase`) with an in-memory provider
 * and an injected fake `gitSpawn` so no real git or GitHub call is made.
 */

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectStrayTrackedPaths,
  formatWrongTreeFinding,
  guardApplies,
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

/** Build a fake `gitSpawn` result envelope. */
function spawnResult(stdout, { status = 0, stderr = '' } = {}) {
  return () => ({ status, stdout, stderr });
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

  it('collapses a rename to its destination path', () => {
    const entries = parsePorcelainStatus('R  old.js -> new.js');
    assert.equal(entries[0].path, 'new.js');
    assert.equal(entries[0].untracked, false);
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
// formatWrongTreeFinding — pure unit
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

// ---------------------------------------------------------------------------
// runWrongTreeGuardPhase — orchestration contract tests
// ---------------------------------------------------------------------------

describe('runWrongTreeGuardPhase — AC-1: aborts on stray main-checkout edits', () => {
  it('throws and posts a friction comment naming the stray files', async () => {
    const storyId = 200;
    const provider = makeProvider();

    await assert.rejects(
      () =>
        runWrongTreeGuardPhase({
          cwd: '/repo',
          worktreePath: '/repo/.worktrees/story-200',
          storyId,
          provider,
          progress: noop,
          gitSpawn: spawnResult(' M .agents/scripts/foo.js\nM  docs/bar.md'),
        }),
      /Wrong-tree edits detected/,
    );

    const comments = await provider.getTicketComments(storyId);
    assert.equal(comments.length, 1, 'expected one friction comment');
    assert.equal(comments[0].type, 'friction');
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
          storyId: 201,
          provider,
          progress: noop,
          gitSpawn: spawnResult(' M src/leaked.js'),
        }),
      /src\/leaked\.js/,
    );
  });
});

describe('runWrongTreeGuardPhase — clean main checkout proceeds', () => {
  it('returns applied:true and does not throw when main checkout is clean', async () => {
    const provider = makeProvider();
    const result = await runWrongTreeGuardPhase({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-202',
      storyId: 202,
      provider,
      progress: noop,
      gitSpawn: spawnResult(''),
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
      storyId: 203,
      provider,
      progress: noop,
      gitSpawn: spawnResult('?? temp/scratch.json\n?? notes.txt'),
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
      storyId: 205,
      provider: makeProvider(),
      progress: noop,
      gitSpawn: spawnResult(' M src/a.js'),
    });
    assert.equal(result.applied, false);
  });
});

describe('runWrongTreeGuardPhase — fail-open on probe error', () => {
  it('does not throw when gitSpawn throws (probe hiccup never blocks close)', async () => {
    const result = await runWrongTreeGuardPhase({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-206',
      storyId: 206,
      provider: makeProvider(),
      progress: noop,
      gitSpawn: () => {
        throw new Error('git not found');
      },
    });
    assert.equal(result.applied, false);
  });

  it('does not throw when git status exits non-zero', async () => {
    const result = await runWrongTreeGuardPhase({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-207',
      storyId: 207,
      provider: makeProvider(),
      progress: noop,
      gitSpawn: spawnResult('', { status: 128, stderr: 'fatal: not a repo' }),
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
