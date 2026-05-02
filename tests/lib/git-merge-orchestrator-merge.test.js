import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * Pin the `mergeFeatureBranch` short-circuit for the
 * "git merge exits non-zero with zero unmerged files" case.
 *
 * Reproduces the failure that stranded story-close.js for Story #969:
 *   - `git merge --no-ff` exited non-zero (e.g. a hook returned non-zero
 *     after the merge commit was already created).
 *   - `analyzeConflicts` correctly reported `{ files: 0, lines: 0 }`.
 *   - The orchestrator still fell through to `commitAutoResolution`,
 *     which failed with "nothing to commit, working tree clean".
 *
 * The fix: when the index has no unmerged entries and no leftover
 * conflict markers, treat the merge as already complete and return
 * `{ merged: true, alreadyMerged: true }` without attempting another
 * commit.
 */

const gitUtilsUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../.agents/scripts/lib/git-utils.js'),
).href;

const calls = [];

mock.module(gitUtilsUrl, {
  namedExports: {
    gitSpawn: (_cwd, ...args) => {
      calls.push(args);
      const cmd = args[0];

      if (cmd === 'merge' && args[1] === '--no-ff') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'diff' && args[1] === '--name-only') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'diff' && args[1] === '--check') {
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(
        `unexpected gitSpawn call after short-circuit: ${args.join(' ')}`,
      );
    },
    gitSync: () => ({ status: 0, stdout: '', stderr: '' }),
  },
});

const { mergeFeatureBranch } = await import(
  '../../.agents/scripts/lib/git-merge-orchestrator.js'
);

test('mergeFeatureBranch: short-circuits when merge exits non-zero with zero unmerged files', () => {
  calls.length = 0;
  const vlogCalls = [];
  const result = mergeFeatureBranch(
    '/tmp/repo',
    'story-969',
    (...a) => vlogCalls.push(a),
    { message: 'feat: example (resolves #969)' },
  );

  assert.deepEqual(result, { merged: true, alreadyMerged: true });
  // Must NOT attempt a follow-up commit, abort, or checkout --theirs.
  const followUp = calls.filter(
    (a) => a[0] === 'commit' || a[0] === 'checkout' || a[0] === 'add',
  );
  assert.deepEqual(
    followUp,
    [],
    'no commit/checkout/add calls should be made when there is nothing to resolve',
  );
  // Conflict warning is suppressed in the short-circuit path — the merge
  // is treated as successful, not as a 0-file conflict.
  assert.equal(
    vlogCalls.length,
    0,
    'vlog should not be invoked when there are no real conflicts to report',
  );
});
