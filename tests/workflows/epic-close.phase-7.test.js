/**
 * epic-close.phase-7 — pins the JS-side wiring of Phase 7 (Finalize)
 * after the named-sub-phase refactor.
 *
 * Three scenarios:
 *   (a) batched-success: deleteBranchesBatched issues a single git
 *       call and returns every input as deleted.
 *   (b) batched-failure -> per-ref fallback: the batched call fails
 *       (e.g. "remote ref does not exist" for one of the names) and
 *       deleteBranchesBatched falls back to per-ref deletes, treating
 *       not-found as idempotent success and recording true errors.
 *   (c) descendant-enumeration failure: phaseEnumerateEpicBranches
 *       degrades gracefully — the warning lands in the structured
 *       result, and the legacy story/* and task/* patterns are still
 *       matched so Epic-namespaced branches are not orphaned.
 *
 * Tests use the __setGitRunners seam already established by
 * tests/lib/git-branch-cleanup.test.js, so no real git is invoked.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

import { phaseEnumerateEpicBranches } from '../../.agents/scripts/epic-close.js';
import { deleteBranchesBatched } from '../../.agents/scripts/lib/git-branch-cleanup.js';
import { __setGitRunners } from '../../.agents/scripts/lib/git-utils.js';

after(() => {
  __setGitRunners(execFileSync, spawnSync);
});

const OK = { status: 0, stdout: '', stderr: '' };

/**
 * Scripted spawn — each call pulls the next entry from `results`. The
 * spawn invocation's args are recorded so the test can assert call
 * shape. exec is stubbed to '' (epic-close paths under test only use
 * gitSpawn).
 */
function scriptedSpawn(results) {
  const calls = [];
  __setGitRunners(
    () => '',
    (_cmd, args) => {
      calls.push(args);
      if (calls.length > results.length) {
        throw new Error(`Unexpected extra git call: ${args.join(' ')}`);
      }
      return results[calls.length - 1];
    },
  );
  return calls;
}

function silentLogger() {
  const lines = [];
  return {
    logger: (...rest) => lines.push(rest),
    lines,
  };
}

// (a) batched-success ------------------------------------------------------

describe('deleteBranchesBatched — batched-success path', () => {
  it('local: a single batched git call deletes every input branch', () => {
    const calls = scriptedSpawn([OK]);
    const result = deleteBranchesBatched(['epic/123', 'story-42', 'story-43'], {
      scope: 'local',
      cwd: '/repo',
    });
    assert.deepEqual(result, {
      deleted: ['epic/123', 'story-42', 'story-43'],
      failed: [],
    });
    assert.equal(calls.length, 1, 'one batched call, no per-ref fallback');
    assert.deepEqual(calls[0], [
      'branch',
      '-D',
      'epic/123',
      'story-42',
      'story-43',
    ]);
  });

  it('remote: forwards --delete + --no-verify and returns the full list', () => {
    const calls = scriptedSpawn([OK]);
    const result = deleteBranchesBatched(['epic/7', 'story-7'], {
      scope: 'remote',
      remote: 'origin',
      cwd: '/repo',
      noVerify: true,
    });
    assert.deepEqual(result, {
      deleted: ['epic/7', 'story-7'],
      failed: [],
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      'push',
      '--no-verify',
      'origin',
      '--delete',
      'epic/7',
      'story-7',
    ]);
  });
});

// (b) batched-failure -> per-ref fallback ---------------------------------

describe('deleteBranchesBatched — per-ref fallback path', () => {
  it('falls back to per-ref deletes when the batched call fails', () => {
    // Batched call rejects: pretend git could not enqueue the batch.
    // Then per-ref: story-42 succeeds, story-99 returns "not found"
    // (idempotent success), story-100 errors with a real failure.
    const calls = scriptedSpawn([
      { status: 1, stdout: '', stderr: 'fatal: bad batch' },
      OK, // story-42 -> deleted
      {
        status: 1,
        stdout: '',
        stderr: "error: branch 'story-99' not found.",
      }, // -> not-found = deleted: true
      { status: 1, stdout: '', stderr: 'error: cannot lock ref' }, // -> error
    ]);
    const result = deleteBranchesBatched(
      ['story-42', 'story-99', 'story-100'],
      { scope: 'local', cwd: '/repo' },
    );
    assert.equal(calls.length, 4, 'one batched + three per-ref calls');
    assert.deepEqual(calls[0], [
      'branch',
      '-D',
      'story-42',
      'story-99',
      'story-100',
    ]);
    // Per-ref calls reuse deleteBranchLocal -> branch -D <name>.
    assert.deepEqual(calls[1], ['branch', '-D', 'story-42']);
    assert.deepEqual(calls[2], ['branch', '-D', 'story-99']);
    assert.deepEqual(calls[3], ['branch', '-D', 'story-100']);
    assert.deepEqual(result.deleted.sort(), ['story-42', 'story-99']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].name, 'story-100');
    assert.equal(result.failed[0].reason, 'error');
    assert.match(result.failed[0].stderr, /cannot lock ref/);
  });

  it('remote fallback: not-found stderr resolves as idempotent success', () => {
    const calls = scriptedSpawn([
      { status: 1, stdout: '', stderr: 'fatal: batch push refused' },
      OK, // epic/7 -> deleted on remote
      {
        status: 1,
        stdout: '',
        stderr: "error: unable to delete 'story-99': remote ref does not exist",
      }, // -> not-found
    ]);
    const result = deleteBranchesBatched(['epic/7', 'story-99'], {
      scope: 'remote',
      remote: 'origin',
      cwd: '/repo',
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(result.deleted.sort(), ['epic/7', 'story-99']);
    assert.equal(result.failed.length, 0);
  });
});

// (c) descendant-enumeration failure --------------------------------------

describe('phaseEnumerateEpicBranches — descendant-enumeration failure', () => {
  it('records a warning and still matches legacy story/* and task/* patterns', async () => {
    const provider = {
      async getSubTickets() {
        throw new Error('GitHub API rate-limit hit');
      },
    };
    // git invocations: branch -r, branch.
    scriptedSpawn([
      {
        status: 0,
        stdout: [
          '  origin/main',
          '  origin/epic/777',
          '  origin/story/epic-777/login-flow',
          '  origin/task/epic-777/db-schema',
          // story-2001 should NOT match: descendant set is empty so
          // the modern naming path is unreachable when enumeration
          // fails — we don't want to delete live work whose Epic is
          // unknown.
          '  origin/story-2001',
          '  origin/feature/unrelated',
          '',
        ].join('\n'),
        stderr: '',
      },
      {
        status: 0,
        stdout: [
          '* main',
          '  epic/777',
          '  story/epic-777/login-flow',
          '  task/epic-777/db-schema',
          '  story-2001',
          '  feature/unrelated',
          '',
        ].join('\n'),
        stderr: '',
      },
    ]);

    const { logger } = silentLogger();
    const result = await phaseEnumerateEpicBranches(provider, 777, {
      logger,
      projectRoot: '/repo',
    });

    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /descendant enumeration/);
    assert.match(result.warnings[0], /rate-limit/);

    // Epic (always prepended) + legacy story/* and task/* matched.
    // story-2001 (modern naming) is excluded because validTicketIds is
    // empty under failed enumeration. Unrelated feature branches are
    // never matched. `epic/777` itself does not satisfy
    // matchesEpicBranch (no `story/epic-/` or `task/epic-/` substring,
    // doesn't match `^story-\d+$`) — it appears exactly once via the
    // prepend, not twice.
    const expected = [
      'epic/777',
      'story/epic-777/login-flow',
      'task/epic-777/db-schema',
    ];
    assert.deepEqual(result.remoteToDelete.sort(), expected.sort());
    assert.deepEqual(result.localToDelete.sort(), expected.sort());

    assert.ok(
      !result.remoteToDelete.includes('story-2001'),
      'story-<id> branches must NOT match when descendant enumeration failed',
    );
    assert.ok(
      !result.remoteToDelete.includes('feature/unrelated'),
      'unrelated branches must never match',
    );
  });

  it('happy path: matches the descendant set when enumeration succeeds', async () => {
    const provider = {
      async getSubTickets(parentId) {
        if (parentId === 50) {
          return [
            { id: 51, body: '', labels: [] },
            { id: 52, body: '', labels: [] },
          ];
        }
        return [];
      },
    };
    scriptedSpawn([
      {
        status: 0,
        stdout: [
          '  origin/main',
          '  origin/epic/50',
          '  origin/story-51',
          '  origin/story-52',
          '  origin/story-99', // not a descendant — must not match
          '',
        ].join('\n'),
        stderr: '',
      },
      {
        status: 0,
        stdout: ['* main', '  epic/50', '  story-51', ''].join('\n'),
        stderr: '',
      },
    ]);

    const { logger } = silentLogger();
    const result = await phaseEnumerateEpicBranches(provider, 50, {
      logger,
      projectRoot: '/repo',
    });

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.remoteToDelete.sort(), [
      'epic/50',
      'story-51',
      'story-52',
    ]);
    assert.deepEqual(result.localToDelete.sort(), ['epic/50', 'story-51']);
    assert.ok(
      !result.remoteToDelete.includes('story-99'),
      'non-descendant story-<id> branches must not match',
    );
  });
});
