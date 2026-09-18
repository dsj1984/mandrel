import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import {
  branchExistsLocally,
  branchExistsRemotely,
  branchExistsViaTrackingRef,
  checkoutStoryBranch,
  classifyBranchSeed,
  currentBranch,
  ensureLocalBranch,
  seedStoryBranchRef,
} from '../../.agents/scripts/lib/git-branch-lifecycle.js';
import { __setGitRunners } from '../../.agents/scripts/lib/git-utils.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { seedGitIdentity } from '../fixtures/git-fixture.js';

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

/**
 * Story #4780 — `seedStoryBranchRef` scored CRAP 123.8, the worst method in
 * the repo: the single-homed story-branch seed switch that every `/mandrel-deliver`
 * run goes through had no test at all.
 *
 * Its git seams are supplied through the function's own parameters — plain
 * stubs, never a module mock (`docs/contributing/test-seams.md` rules 3 and 5) —
 * and the defaults-bind-to-cwd contract (rule 1) is proven against a real
 * throwaway repository rather than by mocking.
 */
describe('classifyBranchSeed', () => {
  it('maps the (local, remote) presence matrix onto the three actions', () => {
    assert.equal(
      classifyBranchSeed({ localHas: true, remoteHas: true }),
      'local',
    );
    assert.equal(
      classifyBranchSeed({ localHas: true, remoteHas: false }),
      'local',
    );
    assert.equal(
      classifyBranchSeed({ localHas: false, remoteHas: true }),
      'fetch',
    );
    assert.equal(
      classifyBranchSeed({ localHas: false, remoteHas: false }),
      'create',
    );
  });
});

describe('seedStoryBranchRef', () => {
  const messages = {
    reuse: (b) => `reuse ${b}`,
    fetch: (b) => `fetch ${b}`,
    create: (b, ref) => `create ${b} from ${ref}`,
    createRace: (b) => `race ${b}`,
    createError: (b, ref, stderr) => `createError ${b} ${ref} ${stderr}`,
    fetchError: (b, stderr) => `fetchError ${b} ${stderr}`,
  };

  /**
   * @param {{ local?: boolean, remote?: boolean, spawnResult?: object }} opts
   */
  function seams({ local = false, remote = false, spawnResult = OK() } = {}) {
    const spawned = [];
    const progressed = [];
    return {
      spawned,
      progressed,
      args: {
        storyBranch: 'story-4780',
        baseRef: 'main',
        spawn: (a) => {
          spawned.push(a);
          return typeof spawnResult === 'function'
            ? spawnResult(a)
            : spawnResult;
        },
        existsLocally: () => local,
        existsRemotely: () => remote,
        progress: (level, message) => progressed.push(`${level}:${message}`),
        messages,
      },
    };
  }

  it('reuses an existing local ref without spawning git', () => {
    const s = seams({ local: true, remote: true });
    seedStoryBranchRef(s.args);
    assert.deepEqual(s.spawned, []);
    assert.deepEqual(s.progressed, ['GIT:reuse story-4780']);
  });

  it('materialises a remote-only ref with a fetch', () => {
    const s = seams({ remote: true });
    seedStoryBranchRef(s.args);
    assert.deepEqual(s.spawned, [['fetch', 'origin', 'story-4780:story-4780']]);
    assert.deepEqual(s.progressed, ['GIT:fetch story-4780']);
  });

  it('throws the caller-supplied fetch error when the fetch fails', () => {
    const s = seams({ remote: true, spawnResult: FAIL('no such ref') });
    assert.throws(
      () => seedStoryBranchRef(s.args),
      /fetchError story-4780 no such ref/,
    );
  });

  it('reports "(no stderr)" when a failing fetch says nothing', () => {
    const s = seams({
      remote: true,
      spawnResult: { status: 1, stdout: '', stderr: '' },
    });
    assert.throws(
      () => seedStoryBranchRef(s.args),
      /fetchError story-4780 \(no stderr\)/,
    );
  });

  it('does not inspect the fetch exit status when no fetchError message is given', () => {
    const s = seams({ remote: true, spawnResult: FAIL('ignored') });
    s.args.messages = { ...messages, fetchError: undefined };
    assert.doesNotThrow(() => seedStoryBranchRef(s.args));
  });

  it('creates the branch from the base ref when neither side has it', () => {
    const s = seams();
    seedStoryBranchRef(s.args);
    assert.deepEqual(s.spawned, [['branch', 'story-4780', 'main']]);
    assert.deepEqual(s.progressed, ['GIT:create story-4780 from main']);
  });

  it('throws the caller-supplied create error when the create fails', () => {
    const s = seams({ spawnResult: FAIL('fatal: bad object') });
    assert.throws(
      () => seedStoryBranchRef(s.args),
      /createError story-4780 main fatal: bad object/,
    );
  });

  it('falls back to stdout when a failing create wrote nothing to stderr', () => {
    const s = seams({
      spawnResult: { status: 1, stdout: 'on stdout', stderr: '' },
    });
    assert.throws(
      () => seedStoryBranchRef(s.args),
      /createError story-4780 main on stdout/,
    );
  });

  it('swallows an "already exists" create race only when asked to', () => {
    const racing = seams({
      spawnResult: FAIL('fatal: a branch named ... already exists'),
    });
    racing.args.swallowCreateRace = true;
    assert.doesNotThrow(() => seedStoryBranchRef(racing.args));
    assert.equal(racing.progressed.at(-1), 'GIT:race story-4780');

    const strict = seams({
      spawnResult: FAIL('fatal: a branch named ... already exists'),
    });
    assert.throws(() => seedStoryBranchRef(strict.args), /createError/);
  });

  it('still throws under swallowCreateRace for any other create failure', () => {
    const s = seams({ spawnResult: FAIL('fatal: not a valid object name') });
    s.args.swallowCreateRace = true;
    assert.throws(() => seedStoryBranchRef(s.args), /createError/);
  });

  it('uses a no-op progress sink when none is supplied', () => {
    const s = seams({ local: true });
    delete s.args.progress;
    assert.doesNotThrow(() => seedStoryBranchRef(s.args));
  });

  it('defaults its git seams to the real implementation bound to cwd', () => {
    const repo = makeTempDir('seed-story-branch-');
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
      );
      const git = (...args) =>
        execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
      git('init', '--initial-branch=main');
      seedGitIdentity(repo);
      git('commit', '--allow-empty', '-m', 'root');

      // No spawn / existsLocally / existsRemotely passed: the defaults must
      // reach real git in `cwd` and create the branch.
      seedStoryBranchRef({
        storyBranch: 'story-4780',
        baseRef: 'main',
        cwd: repo,
        messages,
      });
      assert.match(git('branch', '--list', 'story-4780'), /story-4780/);

      // Re-running is a no-op: the local ref now exists, so the classifier
      // returns `local` and nothing is re-created.
      assert.doesNotThrow(() =>
        seedStoryBranchRef({
          storyBranch: 'story-4780',
          baseRef: 'main',
          cwd: repo,
          messages,
        }),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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
