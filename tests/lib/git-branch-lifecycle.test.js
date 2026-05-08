import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import {
  branchExistsLocally,
  branchExistsRemotely,
  checkoutStoryBranch,
  currentBranch,
  ensureEpicBranch,
  ensureEpicBranchRef,
  ensureLocalBranch,
} from '../../.agents/scripts/lib/git-branch-lifecycle.js';
import { __setGitRunners } from '../../.agents/scripts/lib/git-utils.js';

const OK = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const FAIL = (stderr = 'fail') => ({ status: 1, stdout: '', stderr });

/**
 * Install a scripted spawn mock. Each call consumes one element from the
 * `script` array (which can be a `GitResult` object or a function taking the
 * args array and returning one). `execFileSync` is also installed so any
 * `gitSync` calls succeed silently — git-branch-lifecycle's `gitSync` calls
 * don't read the return value, so we just record args.
 */
function installScriptedRunner(script) {
  const calls = [];
  const execCalls = [];
  __setGitRunners(
    (_cmd, args) => {
      execCalls.push(args);
      return '';
    },
    (_cmd, args) => {
      calls.push(args);
      const idx = calls.length - 1;
      if (idx >= script.length) {
        throw new Error(
          `Unexpected extra git spawn at index ${idx}: ${args.join(' ')}`,
        );
      }
      const item = script[idx];
      return typeof item === 'function' ? item(args) : item;
    },
  );
  return { calls, execCalls };
}

afterEach(() => {
  __setGitRunners(execFileSync, spawnSync);
});

describe('currentBranch', () => {
  it('returns trimmed stdout when git succeeds', () => {
    installScriptedRunner([OK('main')]);
    assert.equal(currentBranch('/cwd'), 'main');
  });

  it('returns null on detached HEAD (status 0, empty stdout)', () => {
    installScriptedRunner([OK('')]);
    assert.equal(currentBranch('/cwd'), null);
  });

  it('returns null on non-zero exit', () => {
    installScriptedRunner([FAIL()]);
    assert.equal(currentBranch('/cwd'), null);
  });
});

describe('branchExistsLocally / branchExistsRemotely', () => {
  it('local: status 0 → true', () => {
    installScriptedRunner([OK()]);
    assert.equal(branchExistsLocally('feat-x', '/cwd'), true);
  });

  it('local: non-zero status → false', () => {
    installScriptedRunner([FAIL()]);
    assert.equal(branchExistsLocally('feat-x', '/cwd'), false);
  });

  it('remote: status 0 with matching ls-remote stdout → true', () => {
    installScriptedRunner([OK('abc123\trefs/heads/feat-x')]);
    assert.equal(branchExistsRemotely('feat-x', '/cwd'), true);
  });

  it('remote: status 0 but empty stdout → false', () => {
    installScriptedRunner([OK('')]);
    assert.equal(branchExistsRemotely('feat-x', '/cwd'), false);
  });
});

describe('ensureEpicBranch — short-circuit when already on branch', () => {
  it('on-branch + remote present → pull, no checkout', async () => {
    const r = installScriptedRunner([
      OK('epic/42'), // currentBranch
      OK('abc\trefs/heads/epic/42'), // branchExistsRemotely
      OK(), // gitPullWithRetry → pull --rebase ...
    ]);
    await ensureEpicBranch('epic/42', 'main', '/cwd');
    assert.equal(r.calls[2][0], 'pull');
    // No checkout calls (execFileSync is for gitSync; ensure none ran)
    assert.equal(r.execCalls.length, 0);
  });

  it('on-branch + remote missing → push to publish', async () => {
    const r = installScriptedRunner([
      OK('epic/42'), // currentBranch
      OK(''), // branchExistsRemotely → false
    ]);
    await ensureEpicBranch('epic/42', 'main', '/cwd');
    // gitSync push --no-verify -u origin epic/42 ran
    assert.deepEqual(r.execCalls[0], [
      'push',
      '--no-verify',
      '-u',
      'origin',
      'epic/42',
    ]);
  });
});

describe('ensureEpicBranch — full state matrix when off-branch', () => {
  it('!local && !remote → checkout base, pull, checkout -b, push, assert', async () => {
    const r = installScriptedRunner([
      OK('main'), // currentBranch (not on epic)
      FAIL(), // local? no
      OK(''), // remote? no
      OK(), // pull --rebase origin main
      OK('epic/42'), // _assertOnBranch → currentBranch
    ]);
    await ensureEpicBranch('epic/42', 'main', '/cwd');
    // expect: checkout main, checkout -b epic/42, push -u origin
    assert.deepEqual(r.execCalls[0], ['checkout', 'main']);
    assert.deepEqual(r.execCalls[1], ['checkout', '-b', 'epic/42']);
    assert.deepEqual(r.execCalls[2], [
      'push',
      '--no-verify',
      '-u',
      'origin',
      'epic/42',
    ]);
  });

  it('local && !remote → checkout, push -u, assert', async () => {
    const r = installScriptedRunner([
      OK('main'),
      OK(), // local? yes
      OK(''), // remote? no
      OK('epic/42'), // _assertOnBranch
    ]);
    await ensureEpicBranch('epic/42', 'main', '/cwd');
    assert.deepEqual(r.execCalls[0], ['checkout', 'epic/42']);
    assert.deepEqual(r.execCalls[1], [
      'push',
      '--no-verify',
      '-u',
      'origin',
      'epic/42',
    ]);
  });

  it('!local && remote → checkout -b tracking origin, pull, assert', async () => {
    const r = installScriptedRunner([
      OK('main'),
      FAIL(), // local? no
      OK('abc\trefs/heads/epic/42'), // remote? yes
      OK(), // pull --rebase
      OK('epic/42'),
    ]);
    await ensureEpicBranch('epic/42', 'main', '/cwd');
    assert.deepEqual(r.execCalls[0], [
      'checkout',
      '-b',
      'epic/42',
      'origin/epic/42',
    ]);
  });

  it('local && remote → checkout, pull, assert', async () => {
    const r = installScriptedRunner([
      OK('main'),
      OK(), // local? yes
      OK('abc'), // remote? yes
      OK(), // pull
      OK('epic/42'),
    ]);
    await ensureEpicBranch('epic/42', 'main', '/cwd');
    assert.deepEqual(r.execCalls[0], ['checkout', 'epic/42']);
  });

  it('_assertOnBranch throws when HEAD diverged after checkout', async () => {
    installScriptedRunner([
      OK('main'),
      FAIL(),
      OK(''),
      OK(), // pull base
      OK('different-branch'), // _assertOnBranch sees wrong branch
    ]);
    await assert.rejects(
      () => ensureEpicBranch('epic/42', 'main', '/cwd'),
      /Branch assertion failed/,
    );
  });
});

describe('checkoutStoryBranch', () => {
  it('on-branch + remote present → pull only', async () => {
    const r = installScriptedRunner([
      OK('story-100'), // currentBranch
      OK('abc'), // remote? yes
      OK(), // pull
    ]);
    await checkoutStoryBranch('story-100', 'epic/1', '/cwd');
    assert.equal(r.execCalls.length, 0); // no gitSync checkout
  });

  it('on-branch + no remote → no-op (no pull, no push)', async () => {
    const r = installScriptedRunner([
      OK('story-100'),
      OK(''), // remote? no
    ]);
    await checkoutStoryBranch('story-100', 'epic/1', '/cwd');
    assert.equal(r.execCalls.length, 0);
    assert.equal(r.calls.length, 2);
  });

  it('local + remote → checkout, pull', async () => {
    const r = installScriptedRunner([
      OK('main'), // off-branch
      OK(), // local? yes
      OK('abc'), // remote? yes
      OK(), // pull
    ]);
    await checkoutStoryBranch('story-100', 'epic/1', '/cwd');
    assert.deepEqual(r.execCalls[0], ['checkout', 'story-100']);
  });

  it('!local + remote → checkout -b tracking origin', async () => {
    const r = installScriptedRunner([
      OK('main'),
      FAIL(), // local? no
      OK('abc'), // remote? yes
    ]);
    await checkoutStoryBranch('story-100', 'epic/1', '/cwd');
    assert.deepEqual(r.execCalls[0], [
      'checkout',
      '-b',
      'story-100',
      'origin/story-100',
    ]);
  });

  it('!local + !remote → create from epic branch', async () => {
    const r = installScriptedRunner([OK('main'), FAIL(), OK('')]);
    await checkoutStoryBranch('story-100', 'epic/1', '/cwd');
    assert.deepEqual(r.execCalls[0], ['checkout', '-b', 'story-100', 'epic/1']);
  });
});

describe('ensureEpicBranchRef — every action arm', () => {
  it("action='noop' when both refs exist", () => {
    const r = installScriptedRunner([OK(), OK('abc')]);
    ensureEpicBranchRef('epic/42', 'main', '/cwd');
    assert.equal(r.execCalls.length, 0);
  });

  it("action='fetch' when only remote exists", () => {
    const r = installScriptedRunner([
      FAIL(), // local? no
      OK('abc'), // remote? yes
      OK(), // git fetch origin epic/42:epic/42
    ]);
    ensureEpicBranchRef('epic/42', 'main', '/cwd');
    assert.deepEqual(r.calls[2], ['fetch', 'origin', 'epic/42:epic/42']);
    assert.equal(r.execCalls.length, 0);
  });

  it("action='fetch' surfaces non-zero exit as a thrown Error", () => {
    installScriptedRunner([FAIL(), OK('abc'), FAIL('refusing')]);
    assert.throws(
      () => ensureEpicBranchRef('epic/42', 'main', '/cwd'),
      /failed to fetch epic\/42/,
    );
  });

  it("action='publish-existing' when only local exists", () => {
    const r = installScriptedRunner([OK(), OK('')]);
    ensureEpicBranchRef('epic/42', 'main', '/cwd');
    assert.deepEqual(r.execCalls[0], [
      'push',
      '--no-verify',
      '-u',
      'origin',
      'epic/42',
    ]);
  });

  it("action='create-and-publish' when neither exists", () => {
    const r = installScriptedRunner([FAIL(), OK('')]);
    ensureEpicBranchRef('epic/42', 'main', '/cwd');
    assert.deepEqual(r.execCalls[0], ['branch', 'epic/42', 'main']);
    assert.deepEqual(r.execCalls[1], [
      'push',
      '--no-verify',
      '-u',
      'origin',
      'epic/42',
    ]);
  });
});

describe('ensureLocalBranch', () => {
  it('no-op when branch already exists', () => {
    const logs = [];
    const r = installScriptedRunner([OK()]);
    ensureLocalBranch('feat-x', 'main', '/cwd', { log: (m) => logs.push(m) });
    assert.equal(r.execCalls.length, 0);
    assert.match(logs[0], /Branch already exists/);
  });

  it('creates the branch and restores HEAD when missing', () => {
    const logs = [];
    const r = installScriptedRunner([FAIL()]);
    ensureLocalBranch('feat-x', 'main', '/cwd', { log: (m) => logs.push(m) });
    assert.deepEqual(r.execCalls[0], ['checkout', '-b', 'feat-x', 'main']);
    assert.deepEqual(r.execCalls[1], ['checkout', 'main']);
    assert.match(logs[0], /Created branch: feat-x/);
  });

  it('uses default no-op log when none supplied', () => {
    const r = installScriptedRunner([OK()]);
    assert.doesNotThrow(() => ensureLocalBranch('feat-x', 'main', '/cwd'));
    assert.equal(r.execCalls.length, 0);
  });
});
