import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import {
  branchExistsLocally,
  branchExistsRemotely,
  branchExistsViaTrackingRef,
  checkoutStoryBranch,
  currentBranch,
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

describe('branchExistsViaTrackingRef', () => {
  it('returns true when refs/remotes/origin/<branch> exists (status 0)', () => {
    const r = installScriptedRunner([OK()]);
    assert.equal(branchExistsViaTrackingRef('feat-x', '/cwd'), true);
    // Verify the correct ref path is passed — no ls-remote, no network call
    assert.deepEqual(r.calls[0], [
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/feat-x',
    ]);
  });

  it('returns false when the tracking ref is absent (non-zero status)', () => {
    const r = installScriptedRunner([FAIL()]);
    assert.equal(branchExistsViaTrackingRef('feat-x', '/cwd'), false);
    assert.deepEqual(r.calls[0], [
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/feat-x',
    ]);
  });

  it('uses rev-parse, not ls-remote, so no network args appear', () => {
    const r = installScriptedRunner([OK()]);
    branchExistsViaTrackingRef('epic/42', '/cwd');
    assert.equal(r.calls[0][0], 'rev-parse');
    // ls-remote would have 'ls-remote' as the first arg — assert it does not
    assert.notEqual(r.calls[0][0], 'ls-remote');
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
