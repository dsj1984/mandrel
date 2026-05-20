import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  resolveRuntime,
  resolveSessionId,
  resolveWorkingPath,
  resolveWorktreeEnabled,
} from '../.agents/scripts/lib/config-resolver.js';

describe('resolveWorktreeEnabled', () => {
  const cfgOn = {
    config: { delivery: { worktreeIsolation: { enabled: true } } },
  };
  const cfgOff = {
    config: { delivery: { worktreeIsolation: { enabled: false } } },
  };
  const cfgMissing = { config: { delivery: {} } };

  it("returns true when AP_WORKTREE_ENABLED === 'true' overrides config-off", () => {
    assert.equal(
      resolveWorktreeEnabled(cfgOff, { AP_WORKTREE_ENABLED: 'true' }),
      true,
    );
  });

  it("returns false when AP_WORKTREE_ENABLED === 'false' overrides config-on", () => {
    assert.equal(
      resolveWorktreeEnabled(cfgOn, { AP_WORKTREE_ENABLED: 'false' }),
      false,
    );
  });

  it('ignores non-strict AP_WORKTREE_ENABLED values ("", "0", "TRUE") and falls through', () => {
    assert.equal(
      resolveWorktreeEnabled(cfgOn, { AP_WORKTREE_ENABLED: '' }),
      true,
    );
    assert.equal(
      resolveWorktreeEnabled(cfgOn, { AP_WORKTREE_ENABLED: '0' }),
      true,
    );
    assert.equal(
      resolveWorktreeEnabled(cfgOn, { AP_WORKTREE_ENABLED: 'TRUE' }),
      true,
    );
    assert.equal(
      resolveWorktreeEnabled(cfgOff, { AP_WORKTREE_ENABLED: '1' }),
      false,
    );
  });

  it("returns false when CLAUDE_CODE_REMOTE === 'true' and AP_WORKTREE_ENABLED is unset", () => {
    assert.equal(
      resolveWorktreeEnabled(cfgOn, { CLAUDE_CODE_REMOTE: 'true' }),
      false,
    );
  });

  it('AP_WORKTREE_ENABLED outranks CLAUDE_CODE_REMOTE', () => {
    assert.equal(
      resolveWorktreeEnabled(cfgOff, {
        AP_WORKTREE_ENABLED: 'true',
        CLAUDE_CODE_REMOTE: 'true',
      }),
      true,
    );
  });

  it('returns the config value when no env overrides are set', () => {
    assert.equal(resolveWorktreeEnabled(cfgOn, {}), true);
    assert.equal(resolveWorktreeEnabled(cfgOff, {}), false);
  });

  it('returns false when config is missing worktreeIsolation and no env signals', () => {
    assert.equal(resolveWorktreeEnabled(cfgMissing, {}), false);
    assert.equal(resolveWorktreeEnabled({}, {}), false);
    assert.equal(resolveWorktreeEnabled({ config: null }, {}), false);
  });

  it('ignores non-string AP_WORKTREE_ENABLED (no environments pass non-strings, guard anyway)', () => {
    assert.equal(
      resolveWorktreeEnabled(cfgOff, { AP_WORKTREE_ENABLED: undefined }),
      false,
    );
  });
});

describe('resolveSessionId', () => {
  it('returns the remote id lower-cased and truncated to 12 chars', () => {
    const id = resolveSessionId({
      CLAUDE_CODE_REMOTE_SESSION_ID: 'ABCDEF0123456789XYZ',
    });
    assert.equal(id, 'abcdef012345');
    assert.equal(id.length, 12);
  });

  it('preserves remote ids shorter than 12 chars', () => {
    const id = resolveSessionId({ CLAUDE_CODE_REMOTE_SESSION_ID: 'abc123' });
    assert.equal(id, 'abc123');
  });

  it('strips disallowed characters from the remote id', () => {
    const id = resolveSessionId({
      CLAUDE_CODE_REMOTE_SESSION_ID: 'AB-CD_EF/01:23.45!XYZ',
    });
    // After strip + lowercase: abcdef012345xyz → truncated to 12
    assert.equal(id, 'abcdef012345');
  });

  it('falls back to a local id when the remote value sanitises to empty', () => {
    const id = resolveSessionId({
      CLAUDE_CODE_REMOTE_SESSION_ID: '!@#$%^&*()',
    });
    assert.match(id, /^[a-z0-9]{1,12}$/);
    // Must not be the empty-sanitised remote value
    assert.notEqual(id, '');
  });

  it('falls back to a local id when CLAUDE_CODE_REMOTE_SESSION_ID is unset', () => {
    const id = resolveSessionId({});
    assert.match(id, /^[a-z0-9]{1,12}$/);
  });

  it('falls back to a local id when CLAUDE_CODE_REMOTE_SESSION_ID is empty string', () => {
    const id = resolveSessionId({ CLAUDE_CODE_REMOTE_SESSION_ID: '' });
    assert.match(id, /^[a-z0-9]{1,12}$/);
  });

  it('local ids vary across calls (entropy present)', () => {
    const a = resolveSessionId({});
    const b = resolveSessionId({});
    // Collisions with 4 random bytes should be astronomically rare; assert
    // inequality so a regression that drops entropy fails loudly.
    assert.notEqual(a, b);
  });
});

describe('resolveRuntime', () => {
  const cfgOn = {
    config: { delivery: { worktreeIsolation: { enabled: true } } },
  };
  const cfgOff = {
    config: { delivery: { worktreeIsolation: { enabled: false } } },
  };

  it('records env-override as the worktree source when AP_WORKTREE_ENABLED is set', () => {
    const r = resolveRuntime(cfgOn, { AP_WORKTREE_ENABLED: 'false' });
    assert.equal(r.worktreeEnabled, false);
    assert.equal(r.worktreeEnabledSource, 'env-override');
  });

  it('records remote-auto as the source under CLAUDE_CODE_REMOTE without operator override', () => {
    const r = resolveRuntime(cfgOn, { CLAUDE_CODE_REMOTE: 'true' });
    assert.equal(r.worktreeEnabled, false);
    assert.equal(r.worktreeEnabledSource, 'remote-auto');
    assert.equal(r.isRemote, true);
  });

  it('records config as the source when no env signals are set', () => {
    const r = resolveRuntime(cfgOn, {});
    assert.equal(r.worktreeEnabled, true);
    assert.equal(r.worktreeEnabledSource, 'config');
    assert.equal(r.isRemote, false);
  });

  it('reports remote session-id source when CLAUDE_CODE_REMOTE_SESSION_ID sanitises non-empty', () => {
    const r = resolveRuntime(cfgOff, {
      CLAUDE_CODE_REMOTE_SESSION_ID: 'abc123',
    });
    assert.equal(r.sessionIdSource, 'remote');
    assert.equal(r.sessionId, 'abc123');
  });

  it('reports local session-id source when the remote value sanitises to empty', () => {
    const r = resolveRuntime(cfgOff, { CLAUDE_CODE_REMOTE_SESSION_ID: '!@#$' });
    assert.equal(r.sessionIdSource, 'local');
    assert.match(r.sessionId, /^[a-z0-9]{1,12}$/);
  });

  it('reports local session-id source when the remote env var is unset', () => {
    const r = resolveRuntime(cfgOff, {});
    assert.equal(r.sessionIdSource, 'local');
  });
});

describe('resolveWorkingPath', () => {
  const repoRoot = path.resolve('/repo');

  it('returns the resolved repoRoot when worktreeEnabled is false', () => {
    const p = resolveWorkingPath({ worktreeEnabled: false, repoRoot });
    assert.equal(p, repoRoot);
  });

  it('returns the resolved repoRoot without requiring storyId on the off-branch', () => {
    assert.doesNotThrow(() =>
      resolveWorkingPath({ worktreeEnabled: false, repoRoot }),
    );
  });

  it('joins the default .worktrees root when worktreeEnabled is true', () => {
    const p = resolveWorkingPath({
      worktreeEnabled: true,
      repoRoot,
      storyId: 42,
    });
    assert.equal(p, path.join(repoRoot, '.worktrees', 'story-42'));
  });

  it('honours a custom worktreeRoot', () => {
    const p = resolveWorkingPath({
      worktreeEnabled: true,
      repoRoot,
      storyId: 7,
      worktreeRoot: 'wt',
    });
    assert.equal(p, path.join(repoRoot, 'wt', 'story-7'));
  });

  it('throws when storyId is missing on the on-branch', () => {
    assert.throws(
      () => resolveWorkingPath({ worktreeEnabled: true, repoRoot }),
      /storyId is required/,
    );
  });

  it('throws when repoRoot is missing', () => {
    assert.throws(
      () => resolveWorkingPath({ worktreeEnabled: false }),
      /repoRoot is required/,
    );
  });

  it('passes repoRoot through unchanged (caller is responsible for absoluteness)', () => {
    // Production callers thread `path.resolve(...)` upstream. The helper
    // preserves whatever was passed so unit-test fixtures using sentinel
    // strings like "/repo" stay platform-agnostic on Windows.
    const sentinel = '/repo-fixture';
    assert.equal(
      resolveWorkingPath({ worktreeEnabled: false, repoRoot: sentinel }),
      sentinel,
    );
  });
});
