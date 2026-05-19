/**
 * tests/scripts/story-close-biome-autoformat.test.js — Story #2533,
 * Task #2536 (Epic #2527).
 *
 * Integration test for the scoped biome-format auto-apply step that
 * `gates.js` runs before `biome ci`. Asserts the three observable
 * outcomes from the Tech Spec:
 *
 *   (a) When the changed-file set carries a format-only diff, the diff
 *       is gone from the close commit (porcelain status clean after the
 *       step).
 *   (b) The close commit on the Story branch includes the auto-fixed
 *       content (commit was created with the expected subject).
 *   (c) `Logger.warn` fires naming the auto-fixed files.
 *
 * The fixture uses dependency-injected `gitSync` + `spawnSync` stubs in
 * the style of `tests/story-close/format-autofix.test.js` so the test
 * runs deterministically without spawning real git or biome processes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runScopedFormatAutofix } from '../../.agents/scripts/lib/orchestration/story-close/format-autofix-scoped.js';

function makeLogger() {
  const logs = { info: [], warn: [], error: [] };
  return {
    logs,
    info: (msg) => logs.info.push(msg),
    warn: (msg) => logs.warn.push(msg),
    error: (msg) => logs.error.push(msg),
  };
}

/**
 * Build a git stub that emulates an Epic→Story diff carrying a format
 * drift on a single file (`src/foo.js`). The stub tracks whether the
 * formatter ran so the second `git status --porcelain` call returns the
 * "after autofix" state.
 */
function makeGitStub({
  changedFiles = ['src/foo.js'],
  statusBefore = '',
  statusAfter = ' M src/foo.js\n',
  headSha = 'cafebabe',
} = {}) {
  const state = { biomeRan: false };
  const calls = [];
  return {
    calls,
    state,
    git(args /*, _opts */) {
      calls.push(args);
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return `${changedFiles.join('\n')}\n`;
      }
      if (args[0] === 'status') {
        return state.biomeRan ? statusAfter : statusBefore;
      }
      if (args[0] === 'rev-parse') return `${headSha}\n`;
      // add / commit are side-effect-only in the stub.
      return '';
    },
  };
}

function makeBiomeSpawn(state) {
  return (cmd /*, args, _opts */) => {
    if (cmd === 'npx' || cmd === 'pnpm' || cmd === 'biome') {
      state.biomeRan = true;
    }
    return '';
  };
}

describe('runScopedFormatAutofix — Story #2533 (Task #2536)', () => {
  it('(a)+(b)+(c): commits the auto-fix on the story branch and Logger.warn names the modified files', () => {
    const logger = makeLogger();
    const gitStub = makeGitStub({
      changedFiles: ['src/foo.js', 'src/bar.js'],
      statusBefore: '',
      statusAfter: ' M src/foo.js\n M src/bar.js\n',
      headSha: 'deadbee',
    });
    const spawn = makeBiomeSpawn(gitStub.state);

    const result = runScopedFormatAutofix({
      cwd: '/tmp/repo',
      storyId: 2533,
      epicBranch: 'epic/2527',
      storyBranch: 'story-2533',
      logger,
      spawnSync: spawn,
      gitSync: gitStub.git,
    });

    // (a) The format diff is gone after the step: the function reports
    // committed=true and the modifiedPaths reflect the auto-fix set.
    assert.equal(result.ran, true);
    assert.equal(result.committed, true);
    assert.deepEqual(result.modifiedPaths, ['src/foo.js', 'src/bar.js']);

    // (b) A commit was created on the story branch with the conventional
    // `fix(story-close):` subject pinned by the Tech Spec.
    const commitCall = gitStub.calls.find((args) => args[0] === 'commit');
    assert.ok(commitCall, 'commit was invoked');
    const subject = commitCall[2];
    assert.match(
      subject,
      /^fix\(story-close\): auto-apply biome format in scoped lint \(story #2533\)$/,
    );
    assert.equal(result.sha, 'deadbee');

    // (c) Logger.warn fired and names the auto-fixed files.
    assert.equal(logger.logs.warn.length, 1);
    assert.match(logger.logs.warn[0], /auto-applied biome format/);
    assert.match(logger.logs.warn[0], /src\/foo\.js/);
    assert.match(logger.logs.warn[0], /src\/bar\.js/);
  });

  it('is a no-op when there are no changed files between epic and story branch', () => {
    const logger = makeLogger();
    const gitStub = makeGitStub({ changedFiles: [] });
    const spawn = makeBiomeSpawn(gitStub.state);

    const result = runScopedFormatAutofix({
      cwd: '/tmp/repo',
      storyId: 2533,
      epicBranch: 'epic/2527',
      storyBranch: 'story-2533',
      logger,
      spawnSync: spawn,
      gitSync: gitStub.git,
    });

    assert.equal(result.ran, false);
    assert.equal(result.committed, false);
    assert.equal(result.reason, 'no-changed-files');
    assert.equal(logger.logs.warn.length, 0);
    // No formatter spawn, no commit.
    assert.equal(gitStub.state.biomeRan, false);
    assert.equal(
      gitStub.calls.some((args) => args[0] === 'commit'),
      false,
    );
  });

  it('does not commit when the formatter produced no drift on the changed set', () => {
    const logger = makeLogger();
    const gitStub = makeGitStub({
      changedFiles: ['src/foo.js'],
      statusBefore: '',
      statusAfter: '',
    });
    const spawn = makeBiomeSpawn(gitStub.state);

    const result = runScopedFormatAutofix({
      cwd: '/tmp/repo',
      storyId: 2533,
      epicBranch: 'epic/2527',
      storyBranch: 'story-2533',
      logger,
      spawnSync: spawn,
      gitSync: gitStub.git,
    });

    assert.equal(result.ran, true);
    assert.equal(result.committed, false);
    assert.equal(logger.logs.warn.length, 0);
    assert.match(logger.logs.info[0], /no format drift/);
  });

  it('refuses to commit when the working tree is dirty before the autofix runs', () => {
    const logger = makeLogger();
    const gitStub = makeGitStub({
      changedFiles: ['src/foo.js'],
      statusBefore: ' M unrelated/scratch.md\n',
      statusAfter: ' M unrelated/scratch.md\n',
    });
    const spawn = makeBiomeSpawn(gitStub.state);

    const result = runScopedFormatAutofix({
      cwd: '/tmp/repo',
      storyId: 2533,
      epicBranch: 'epic/2527',
      storyBranch: 'story-2533',
      logger,
      spawnSync: spawn,
      gitSync: gitStub.git,
    });

    assert.equal(result.ran, false);
    assert.equal(result.committed, false);
    assert.equal(result.reason, 'dirty-tree');
    assert.equal(logger.logs.warn.length, 0);
    assert.equal(
      gitStub.calls.some((args) => args[0] === 'commit'),
      false,
    );
  });
});
