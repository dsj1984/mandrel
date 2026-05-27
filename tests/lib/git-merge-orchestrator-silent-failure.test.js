import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * Pin the `mergeFeatureBranch` HEAD-advance guard added in Epic #3078.
 *
 * Reproduces the silent-failure mode that stranded story-close.js across
 * Stories #3097, #3098, and #3099:
 *   - `git merge --no-ff` exited 0 (lint-staged ran successfully).
 *   - But the resulting merge commit was never actually recorded — the
 *     pre-commit hook's stash-and-restore dance left the index with the
 *     merge content and no commit.
 *   - Without the guard, the orchestrator returned `{ merged: true }`,
 *     story-close logged "Merge successful" and proceeded to push, only
 *     for `assertMergeReachable` to fail with no recoverable signal.
 *
 * The fix: capture HEAD before and after the merge. If status is 0 but
 * HEAD did not advance and stdout does not say "Already up to date",
 * throw — surfacing the silent failure as a clear blocker.
 */

const gitUtilsUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../.agents/scripts/lib/git-utils.js'),
).href;

// node:test only permits one mock.module call per target URL across the file,
// so we install a mutable controller once and reassign scenarios per test.
let scenario = {
  headBefore: 'aaa',
  headAfter: 'aaa',
  mergeStdout: '',
};

mock.module(gitUtilsUrl, {
  namedExports: {
    gitSpawn: (() => {
      let revParseCallCount = 0;
      return (_cwd, ...args) => {
        const cmd = args[0];
        if (cmd === 'rev-parse' && args[1] === 'HEAD') {
          revParseCallCount += 1;
          const head =
            revParseCallCount % 2 === 1
              ? scenario.headBefore
              : scenario.headAfter;
          return { status: 0, stdout: head, stderr: '' };
        }
        if (cmd === 'merge' && args[1] === '--no-ff') {
          return { status: 0, stdout: scenario.mergeStdout, stderr: '' };
        }
        if (cmd === 'diff') {
          return { status: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected gitSpawn call: ${args.join(' ')}`);
      };
    })(),
    gitSync: () => ({ status: 0, stdout: '', stderr: '' }),
  },
});

const { mergeFeatureBranch } = await import(
  '../../.agents/scripts/lib/git-merge-orchestrator.js'
);

test('mergeFeatureBranch: throws when status=0 but HEAD did not advance', () => {
  scenario = {
    headBefore: 'abc123def',
    headAfter: 'abc123def', // same — silent commit drop
    mergeStdout: '', // no "Already up to date" message
  };
  assert.throws(
    () =>
      mergeFeatureBranch('/tmp/repo', 'story-3098', () => {}, {
        message: 'feat: example (resolves #3107)',
      }),
    /HEAD did not advance/,
    'must throw when merge succeeds at the exit-code level but no commit landed',
  );
});

test('mergeFeatureBranch: returns alreadyMerged when stdout says Already up to date', () => {
  scenario = {
    headBefore: 'abc123def',
    headAfter: 'abc123def', // unchanged but legitimately a no-op
    mergeStdout: 'Already up to date.\n',
  };
  const result = mergeFeatureBranch('/tmp/repo', 'story-3098', () => {}, {
    message: 'feat: example (resolves #3107)',
  });
  assert.deepEqual(
    result,
    { merged: true, alreadyMerged: true },
    'must treat "Already up to date" as a clean no-op',
  );
});

test('mergeFeatureBranch: returns merged:true on normal HEAD advance', () => {
  scenario = {
    headBefore: 'abc123def',
    headAfter: 'fed987abc', // advanced — merge commit recorded
    mergeStdout: '',
  };
  const result = mergeFeatureBranch('/tmp/repo', 'story-3098', () => {}, {
    message: 'feat: example (resolves #3107)',
  });
  assert.deepEqual(
    result,
    { merged: true },
    'must return merged:true on normal HEAD advance',
  );
});
