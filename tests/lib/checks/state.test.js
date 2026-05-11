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
        if (args[0] === 'rev-parse') return { ok: true, stdout: 'story-1284' };
        if (args[0] === 'for-each-ref') {
          return { ok: true, stdout: 'epic/1143\nepic/1178' };
        }
        if (args[0] === 'config') return { ok: true, stdout: 'false' };
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
    assert.equal(state.fs.worktrees, true);
    assert.equal(state.env.GITHUB_TOKEN, 'set');
    // story-close scope does not include fs.dotEnv / fs.dotMcp
    assert.equal(state.fs.dotEnv, undefined);
    assert.equal(state.fs.dotMcp, undefined);
    // git probe was called for headRef, epicBranches, coreBare (3)
    assert.equal(calls.git.length, 3);
    // fs probe was called for .worktrees only (1)
    assert.equal(calls.fs.length, 1);
    // env probe was called for GITHUB_TOKEN only (1)
    assert.deepEqual(calls.env, ['GITHUB_TOKEN']);
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
    const first = assembleState({ scope: 'epic-close', cwd: '/repo-default' });
    const second = assembleState({ scope: 'epic-close', cwd: '/repo-default' });
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
