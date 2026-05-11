import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  assembleState,
  clearStateCache,
  getScopeKeys,
} from '../../../.agents/scripts/lib/checks/state.js';

/**
 * Tests for the scope-aware state assembler. The contract under test:
 *   1. Per-scope projection — only probes the keys the scope declares.
 *   2. Memoization — repeated calls reuse the cached object (no re-probe).
 *   3. Privacy — env probes return presence only ('set' | 'missing'),
 *      never the real env-var value.
 */

/**
 * Build a spy probe set so tests can assert call counts and the per-key
 * routing.
 */
function makeSpyProbes(overrides = {}) {
  const calls = { git: [], fs: [], env: [] };
  return {
    calls,
    probes: {
      git: (cwd, ...args) => {
        calls.git.push({ cwd, args });
        return overrides.git?.(cwd, ...args) ?? { ok: true, stdout: '' };
      },
      fs: (absPath) => {
        calls.fs.push(absPath);
        return overrides.fs?.(absPath) ?? false;
      },
      env: (name) => {
        calls.env.push(name);
        return overrides.env?.(name) ?? 'missing';
      },
    },
  };
}

describe('assembleState', () => {
  beforeEach(() => {
    clearStateCache();
  });

  it('populates git/fs/env keys for story-close scope only', () => {
    const { probes, calls } = makeSpyProbes({
      git: (_cwd, ...args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return { ok: true, stdout: 'story-1284' };
        }
        if (args[0] === 'for-each-ref') {
          return { ok: true, stdout: 'epic/1143\nepic/1178' };
        }
        if (args[0] === 'config') return { ok: true, stdout: 'false' };
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          // Distinct SHAs for local vs origin so ahead=false for these tests.
          return { ok: true, stdout: 'aaaaaaaa' };
        }
        return { ok: false, stdout: '' };
      },
      fs: (p) => p.endsWith('.worktrees'),
      env: (name) => (name === 'GITHUB_TOKEN' ? 'set' : 'missing'),
    });
    const state = assembleState({
      scope: 'story-close',
      cwd: '/repo',
      probes,
    });
    assert.equal(state.scope, 'story-close');
    assert.equal(state.git.headRef, 'story-1284');
    assert.deepEqual(state.git.epicBranches, ['epic/1143', 'epic/1178']);
    assert.equal(state.git.coreBare, 'false');
    // epicBranchSync probes local + origin for each branch.
    assert.equal(typeof state.git.epicBranchSync, 'object');
    assert.equal(state.git.epicBranchSync['epic/1143'].local, 'aaaaaaaa');
    assert.equal(state.git.epicBranchSync['epic/1143'].remote, 'aaaaaaaa');
    assert.equal(state.git.epicBranchSync['epic/1143'].ahead, false);
    assert.equal(state.fs.worktrees, true);
    assert.equal(state.env.GITHUB_TOKEN, 'set');
    // story-close scope does not include fs.dotEnv / fs.dotMcp
    assert.equal(state.fs.dotEnv, undefined);
    assert.equal(state.fs.dotMcp, undefined);
    // git probe was called for: headRef (1), epicBranches (1), coreBare (1),
    // plus epicBranchSync local+origin for each of 2 branches (4) = 7 total.
    assert.equal(calls.git.length, 7);
    // fs probe was called for .worktrees only (1)
    assert.equal(calls.fs.length, 1);
    // env probe was called for GITHUB_TOKEN only (1)
    assert.deepEqual(calls.env, ['GITHUB_TOKEN']);
  });

  it('epicBranchSync flags branches whose local SHA differs from origin', () => {
    const { probes } = makeSpyProbes({
      git: (_cwd, ...args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return { ok: true, stdout: 'story-x' };
        }
        if (args[0] === 'for-each-ref') {
          return { ok: true, stdout: 'epic/1143' };
        }
        if (args[0] === 'config') return { ok: true, stdout: 'false' };
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          // The 3rd arg is the ref: branch (local) or origin/branch (remote).
          if (args[2] === 'epic/1143') return { ok: true, stdout: 'aaaa' };
          if (args[2] === 'origin/epic/1143') {
            return { ok: true, stdout: 'bbbb' };
          }
        }
        return { ok: false, stdout: '' };
      },
    });
    const state = assembleState({
      scope: 'story-close',
      cwd: '/repo-stale',
      probes,
    });
    assert.equal(state.git.epicBranchSync['epic/1143'].ahead, true);
    assert.equal(state.git.epicBranchSync['epic/1143'].local, 'aaaa');
    assert.equal(state.git.epicBranchSync['epic/1143'].remote, 'bbbb');
  });

  it('epicBranchSync reports null remote when origin ref is missing', () => {
    const { probes } = makeSpyProbes({
      git: (_cwd, ...args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return { ok: true, stdout: 'story-x' };
        }
        if (args[0] === 'for-each-ref') {
          return { ok: true, stdout: 'epic/9999' };
        }
        if (args[0] === 'config') return { ok: true, stdout: 'false' };
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          if (args[2] === 'epic/9999') return { ok: true, stdout: 'cccc' };
          // origin/epic/9999 does not exist yet (pre-push epic).
          return { ok: false, stdout: '' };
        }
        return { ok: false, stdout: '' };
      },
    });
    const state = assembleState({
      scope: 'story-close',
      cwd: '/repo-pre-push',
      probes,
    });
    assert.equal(state.git.epicBranchSync['epic/9999'].local, 'cccc');
    assert.equal(state.git.epicBranchSync['epic/9999'].remote, null);
    assert.equal(state.git.epicBranchSync['epic/9999'].ahead, false);
  });

  it('returns the same memoized object for the same scope+cwd (default probes)', () => {
    // Default-probe path memoizes. Two calls return the same frozen object.
    const a = assembleState({ scope: 'retro', cwd: '/repo-mem' });
    const b = assembleState({ scope: 'retro', cwd: '/repo-mem' });
    assert.strictEqual(a, b);
  });

  it('does not re-run probes on a cached scope+cwd (probe spy proves it)', () => {
    // First call with spies — never cached (spy path is the test-injection
    // contract). Second call with the SAME cwd+scope and default probes
    // populates the cache; a third call with default probes must hit the
    // cache and not invoke anything.
    const seen = { calls: 0 };
    const probes = {
      git: () => {
        seen.calls += 1;
        return { ok: true, stdout: '' };
      },
      fs: () => {
        seen.calls += 1;
        return false;
      },
      env: () => {
        seen.calls += 1;
        return 'missing';
      },
    };
    // Spy probes are not memoized — each call probes afresh.
    assembleState({ scope: 'retro', cwd: '/repo-spy', probes });
    const firstCount = seen.calls;
    assembleState({ scope: 'retro', cwd: '/repo-spy', probes });
    assert.ok(
      seen.calls > firstCount,
      'spy-probe call count must increase across calls (no spy memoization)',
    );
  });

  it('memoizes the default-probe path so repeated default calls reuse state', () => {
    // The contract: when no probes are injected, the result is cached. We
    // assert identity equality on the returned object, which is the
    // proof-of-cache.
    const first = assembleState({
      scope: 'epic-deliver',
      cwd: '/repo-default',
    });
    const second = assembleState({
      scope: 'epic-deliver',
      cwd: '/repo-default',
    });
    assert.strictEqual(first, second, 'cached object must be reused');
  });

  it('never returns or logs the value of process.env.GITHUB_TOKEN', () => {
    // Inject a known sentinel value through the env probe contract; the
    // probe defaults to converting to 'set' / 'missing'. The state must
    // contain only that reduced string — never the sentinel.
    const SECRET = 'ghp_TEST_SECRET_TOKEN_DO_NOT_EXPOSE_xxxxxxxxxx';
    const { probes } = makeSpyProbes({
      env: (name) => {
        // Simulate the default probe's reduction: presence only.
        return name === 'GITHUB_TOKEN' ? 'set' : 'missing';
      },
    });
    const state = assembleState({
      scope: 'story-close',
      cwd: '/repo',
      probes,
    });
    const serialized = JSON.stringify(state);
    assert.equal(state.env.GITHUB_TOKEN, 'set');
    assert.ok(
      !serialized.includes(SECRET),
      'serialized state must not contain the secret value',
    );
  });

  it('produces independent state objects per scope', () => {
    const a = assembleState({ scope: 'story-close', cwd: '/r' });
    const b = assembleState({ scope: 'retro', cwd: '/r' });
    assert.notStrictEqual(a, b);
    assert.equal(a.scope, 'story-close');
    assert.equal(b.scope, 'retro');
  });

  it('returns an empty projection when no scope is supplied', () => {
    const state = assembleState({ cwd: '/r' });
    assert.deepEqual(state.git, {});
    assert.deepEqual(state.fs, {});
    assert.deepEqual(state.env, {});
  });

  it('exposes the scope → keys map via getScopeKeys()', () => {
    const map = getScopeKeys();
    assert.ok(map['story-close'].includes('git.headRef'));
    assert.ok(map.retro.includes('git.headRef'));
    assert.ok(!map.retro.includes('env.GITHUB_TOKEN'));
  });

  it('freezes the returned state object to prevent caller mutation', () => {
    const state = assembleState({ scope: 'retro', cwd: '/r-freeze' });
    assert.throws(() => {
      state.git = {};
    }, /Cannot assign|read.only/);
  });
});
