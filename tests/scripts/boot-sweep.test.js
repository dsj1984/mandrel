import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runBootSweep } from '../../.agents/scripts/boot-sweep.js';

const CONFIG = {
  project: { baseBranch: 'main', paths: { tempRoot: 'temp' } },
  delivery: { worktreeIsolation: { sweepLockMs: 1234 } },
};

function makeProvider() {
  return { getTicket: async (id) => ({ id, state: 'closed', labels: [] }) };
}

function okEnvelope(extra = {}) {
  return {
    ok: true,
    skipped: false,
    candidates: 0,
    localDeleted: 0,
    remoteDeleted: 0,
    protected: [],
    failures: [],
    ...extra,
  };
}

describe('runBootSweep', () => {
  it('defaults the include glob to story-* and passes a protection ctx', async () => {
    let seen = null;
    await runBootSweep({
      cwd: '/tmp/repo',
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      injectedSweep: (args) => {
        seen = args;
        return okEnvelope();
      },
    });
    assert.deepEqual(seen.include, ['story-*']);
    assert.equal(seen.baseBranch, 'main');
    assert.equal(seen.fastForward, true);
    assert.equal(typeof seen.protectionCtx.getTicket, 'function');
    assert.equal(typeof seen.protectionCtx.ghRunner, 'function');
    assert.equal(seen.protectionCtx.repoRoot, '/tmp/repo');
    assert.match(seen.lockPath, /boot-sweep\.lock$/);
    assert.equal(seen.lockTimeoutMs, 1234);
  });

  it('appends --current to the exclude set', async () => {
    let seen = null;
    await runBootSweep({
      cwd: '/tmp/repo',
      current: 'story-999',
      exclude: ['epic/*'],
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      injectedSweep: (args) => {
        seen = args;
        return okEnvelope();
      },
    });
    assert.deepEqual(seen.exclude, ['epic/*', 'story-999']);
  });

  it('honours a custom include glob and --no-fast-forward', async () => {
    let seen = null;
    await runBootSweep({
      cwd: '/tmp/repo',
      include: ['feat/*'],
      fastForward: false,
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      injectedSweep: (args) => {
        seen = args;
        return okEnvelope();
      },
    });
    assert.deepEqual(seen.include, ['feat/*']);
    assert.equal(seen.fastForward, false);
  });

  it('swallows a sweep error and returns a skipped envelope (never throws)', async () => {
    const warns = [];
    const result = await runBootSweep({
      cwd: '/tmp/repo',
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      logger: { warn: (m) => warns.push(m) },
      injectedSweep: () => {
        throw new Error('lock contention');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.error, /lock contention/);
    assert.equal(
      warns.some((w) => /sweep threw/.test(w)),
      true,
    );
  });

  it('returns the engine envelope verbatim on success', async () => {
    const envelope = okEnvelope({ localDeleted: 3, remoteDeleted: 3 });
    const result = await runBootSweep({
      cwd: '/tmp/repo',
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      injectedSweep: () => envelope,
    });
    assert.equal(result.localDeleted, 3);
    assert.equal(result.remoteDeleted, 3);
  });
});
