import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSummaryLine,
  runBootSweep,
  runBootSweepCli,
  storyIdsFromBranches,
} from '../.agents/scripts/boot-sweep.js';

/** Keep the closed-Story worktree sweep (and its lockfile) out of these cases. */
const NO_WORKTREE_SWEEP = {
  worktreeSweepFn: async () => ({ reaped: [], skipped: [] }),
  acquireLockFn: () => ({ acquired: true, release: () => {} }),
};

/**
 * Story #4780 — the boot sweep's CLI shell scored CRAP 72: the argv →
 * sweep → render path (the one `/mandrel-deliver` and `/mandrel-plan` call at boot) was
 * unreached, so a flag that silently stopped reaching the engine would have
 * shipped green.
 *
 * The sweep engine and the log sink are injected through the optional final
 * `deps` parameter (`docs/contributing/test-seams.md` rules 1 and 5), so no real
 * branch is ever reaped by this suite.
 */

function harness(result = {}) {
  const infos = [];
  const calls = [];
  return {
    infos,
    calls,
    deps: {
      runBootSweepImpl: async (args) => {
        calls.push(args);
        return {
          ok: true,
          localDeleted: 0,
          remoteDeleted: 0,
          protected: [],
          contentMerged: [],
          ...result,
        };
      },
      logger: { info: (m) => infos.push(m) },
    },
  };
}

describe('buildSummaryLine', () => {
  it('stays silent about content-merged branches when there are none', () => {
    assert.equal(
      buildSummaryLine({ localDeleted: 2, remoteDeleted: 1, protected: ['a'] }),
      '[boot-sweep] reaped 2 local + 1 remote; protected 1.',
    );
  });

  it('appends the /clean-git routing hint when content-merged branches exist', () => {
    assert.match(
      buildSummaryLine({
        localDeleted: 0,
        remoteDeleted: 0,
        contentMerged: ['x', 'y'],
      }),
      /2 content-merged branch\(es\) left for \/clean-git/,
    );
  });

  it('treats missing protected/contentMerged arrays as zero', () => {
    assert.equal(
      buildSummaryLine({ localDeleted: 0, remoteDeleted: 0 }),
      '[boot-sweep] reaped 0 local + 0 remote; protected 0.',
    );
  });
});

describe('runBootSweepCli', () => {
  it('prints HELP and runs no sweep under --help', async () => {
    const h = harness();
    const result = await runBootSweepCli(['--help'], h.deps);
    assert.equal(result, undefined);
    assert.equal(h.calls.length, 0);
    assert.match(h.infos[0], /Usage: node \.agents\/scripts\/boot-sweep\.js/);
  });

  it('honours the -h short flag', async () => {
    const h = harness();
    await runBootSweepCli(['-h'], h.deps);
    assert.equal(h.calls.length, 0);
  });

  it('defaults to a fast-forwarding sweep with no include/exclude overrides', async () => {
    const h = harness();
    await runBootSweepCli([], h.deps);
    assert.deepEqual(h.calls[0], {
      cwd: undefined,
      base: undefined,
      include: [],
      exclude: [],
      current: undefined,
      fastForward: true,
    });
  });

  it('threads --cwd, --base, --current and repeated --include/--exclude', async () => {
    const h = harness();
    await runBootSweepCli(
      [
        '--cwd',
        '/repo',
        '--base',
        'trunk',
        '--current',
        'story-1',
        '--include',
        'story-*',
        '--include',
        'fix-*',
        '--exclude',
        'story-9',
      ],
      h.deps,
    );
    assert.deepEqual(h.calls[0], {
      cwd: '/repo',
      base: 'trunk',
      include: ['story-*', 'fix-*'],
      exclude: ['story-9'],
      current: 'story-1',
      fastForward: true,
    });
  });

  it('turns the fast-forward off under --no-fast-forward', async () => {
    const h = harness();
    await runBootSweepCli(['--no-fast-forward'], h.deps);
    assert.equal(h.calls[0].fastForward, false);
  });

  it('renders the one-line summary by default', async () => {
    const h = harness({ localDeleted: 3, remoteDeleted: 2 });
    const result = await runBootSweepCli([], h.deps);
    assert.equal(
      h.infos[0],
      '[boot-sweep] reaped 3 local + 2 remote; protected 0.',
    );
    assert.equal(result.localDeleted, 3);
  });

  it('renders the full envelope under --json', async () => {
    const h = harness({ localDeleted: 1 });
    await runBootSweepCli(['--json'], h.deps);
    assert.equal(JSON.parse(h.infos[0]).localDeleted, 1);
  });
});

describe('runBootSweep', () => {
  it('swallows a throwing sweep and returns the skipped envelope (host continues)', async () => {
    const warns = [];
    const result = await runBootSweep({
      cwd: '/repo',
      ...NO_WORKTREE_SWEEP,
      injectedConfig: { project: { baseBranch: 'main' } },
      injectedProvider: {},
      injectedSweep: () => {
        throw new Error('lock contention');
      },
      logger: { info: () => {}, warn: (m) => warns.push(m) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.error, 'lock contention');
    assert.match(warns[0], /sweep threw \(host continues\): lock contention/);
  });

  it('defaults the include glob to story-* and appends --current to the excludes', async () => {
    let seen;
    await runBootSweep({
      cwd: '/repo',
      ...NO_WORKTREE_SWEEP,
      current: 'story-4780',
      injectedConfig: { project: { baseBranch: 'main' } },
      injectedProvider: {},
      injectedSweep: async (args) => {
        seen = args;
        return { ok: true };
      },
      logger: { info: () => {}, warn: () => {} },
    });
    assert.deepEqual(seen.include, ['story-*']);
    assert.deepEqual(seen.exclude, ['story-4780']);
    assert.equal(seen.baseBranch, 'main');
    assert.equal(seen.logTag, '[boot-sweep]');
  });
});

/**
 * Story #4794 — the temp-retention catch-up. The sweep already confirms each
 * merge it reaps (merged PR + matching headRefOid), so those branch names are
 * the evidence the purge needs; the age floor collects the rest. The purge is
 * injected here so no suite run touches a real temp tree.
 */
describe('storyIdsFromBranches', () => {
  it('reads the id out of the canonical branch shape only', () => {
    assert.deepEqual(
      storyIdsFromBranches([
        'story-4794',
        'story-101',
        'feature/story-999',
        'story-abc',
        'main',
      ]),
      [4794, 101],
      'an ad-hoc branch that merely matched the glob contributes no id',
    );
  });

  it('treats a missing or non-array reaped list as no ids', () => {
    assert.deepEqual(storyIdsFromBranches(undefined), []);
    assert.deepEqual(storyIdsFromBranches(null), []);
  });
});

describe('runBootSweep — temp-retention catch-up (Story #4794)', () => {
  it('hands the purge exactly the Story ids whose merge the sweep confirmed', async () => {
    let seen = null;
    const result = await runBootSweep({
      cwd: '/repo',
      ...NO_WORKTREE_SWEEP,
      injectedConfig: { project: { baseBranch: 'main' } },
      injectedProvider: {},
      injectedSweep: async () => ({
        ok: true,
        reaped: ['story-4794', 'story-4780'],
      }),
      purgeFn: async (args) => {
        seen = args;
        return { purged: [{ path: '/repo/temp/x.log', bytes: 10 }] };
      },
      logger: { info: () => {}, warn: () => {} },
    });

    assert.deepEqual(seen.mergedStoryIds, [4794, 4780]);
    assert.equal(seen.label, 'boot-sweep');
    assert.deepEqual(
      seen.config,
      { project: { baseBranch: 'main' } },
      'the purge resolves its tempRoot from the same config the sweep used',
    );
    assert.equal(result.tempPurge.purged.length, 1);
    assert.equal(result.ok, true, 'the sweep envelope survives alongside it');
  });

  it('still runs the age-floored purge when the sweep reaped nothing', async () => {
    let called = false;
    await runBootSweep({
      cwd: '/repo',
      ...NO_WORKTREE_SWEEP,
      injectedConfig: { project: { baseBranch: 'main' } },
      injectedProvider: {},
      injectedSweep: async () => ({ ok: true, reaped: [] }),
      purgeFn: async (args) => {
        called = true;
        assert.deepEqual(args.mergedStoryIds, []);
        return { purged: [] };
      },
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(
      called,
      true,
      'the backlog is reclaimed by age even with no branch to reap',
    );
  });

  it('degrades to the swallowed envelope when the purge throws (exit stays 0)', async () => {
    const warns = [];
    const result = await runBootSweep({
      cwd: '/repo',
      ...NO_WORKTREE_SWEEP,
      injectedConfig: { project: { baseBranch: 'main' } },
      injectedProvider: {},
      injectedSweep: async () => ({ ok: true, reaped: [] }),
      purgeFn: async () => {
        throw new Error('temp root unreadable');
      },
      logger: { info: () => {}, warn: (m) => warns.push(m) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(warns[0], /host continues/);
  });
});
