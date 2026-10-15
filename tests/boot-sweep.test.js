import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  buildSummaryLine,
  runBootSweep,
  runBootSweepCli,
  storyIdsFromBranches,
} from '../.agents/scripts/boot-sweep.js';
import { runPostLandTail as realRunPostLandTail } from '../.agents/scripts/lib/orchestration/single-story-close/phases/post-land.js';
import { reconcileStrandedClosing } from '../.agents/scripts/lib/single-story-sweep/reconcile-closing.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

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

/**
 * Story #5652 — a Story whose PR auto-merged after its close process was gone
 * is closed by the `Closes #<id>` footer but strands at `agent::closing`. The
 * boot sweep finishes the flip when the `story-<id>` PR is MERGED.
 */
describe('reconcileStrandedClosing (Story #5652)', () => {
  // The real flip routes through ColumnSync, which writes the project-meta
  // cache under tempRoot; an ABSOLUTE tempRoot keeps it off the shared file.
  let tempRoot;
  beforeEach(() => {
    tempRoot = makeTempDir('mandrel-reconcile-closing-');
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const config = () => ({ project: { paths: { tempRoot } } });
  const quiet = { info: () => {}, warn: () => {} };

  function story(id, extra = {}) {
    return {
      id,
      state: 'closed',
      stateReason: 'completed',
      title: `Story ${id}`,
      labels: ['type::story', 'agent::closing'],
      ...extra,
    };
  }

  /** Each listing returns the closed Stories carrying that label. */
  function fakeProvider(closed, { updateThrows = false } = {}) {
    const byId = new Map(closed.map((t) => [t.id, { ...t }]));
    const updates = [];
    const listCalls = [];
    return {
      listTicketsByLabel: async (opts) => {
        listCalls.push(opts);
        return closed.filter((t) => t.labels.includes(opts.labels));
      },
      getTicket: async (id) => ({ ...byId.get(id) }),
      updateTicket: async (id, patch) => {
        updates.push({ id, patch });
        if (updateThrows) throw new Error('provider failure');
        byId.set(id, { ...byId.get(id), ...patch });
      },
      updates,
      listCalls,
    };
  }

  function fakeGh(rowsByBranch) {
    const calls = [];
    return {
      calls,
      pr: {
        list: async (flags) => {
          calls.push(flags);
          return rowsByBranch[flags[flags.indexOf('--head') + 1]] ?? [];
        },
      },
    };
  }

  /** A land-tail double recording each Story it ran for. */
  function fakeTail() {
    const ran = [];
    const fn = async (args) => {
      ran.push(args);
      return { leaseRelease: true };
    };
    return { ran, fn };
  }

  const merged = (n) => [
    {
      url: `https://github.com/owner/repo/pull/${n}`,
      state: 'MERGED',
      mergedAt: '2026-10-12T19:14:50Z',
    },
  ];

  it('writes agent::done for a closed agent::closing Story whose PR merged', async () => {
    const provider = fakeProvider([story(4561)]);
    const gh = fakeGh({ 'story-4561': merged(4573) });
    const tail = fakeTail();
    const out = await reconcileStrandedClosing({
      provider,
      config: config(),
      cwd: '/repo',
      gh,
      notify: async () => {},
      sleep: async () => {},
      runPostLandTail: tail.fn,
      logger: quiet,
    });

    assert.deepEqual(provider.listCalls, [
      { state: 'closed', labels: 'agent::closing' },
      { state: 'closed', labels: 'agent::blocked' },
    ]);
    assert.deepEqual(
      tail.ran.map((a) => [a.storyId, a.storyBranch, a.baseBranch, a.cwd]),
      [[4561, 'story-4561', 'main', '/repo']],
      'the land tail runs on the sweep path (Story #5705)',
    );
    assert.deepEqual(out, { ok: true, reconciled: [4561], skipped: [] });
    const labelWrites = provider.updates.filter((u) => u.patch.labels);
    assert.equal(labelWrites.length, 1);
    assert.ok(labelWrites[0].patch.labels.add.includes('agent::done'));
    assert.ok(labelWrites[0].patch.labels.remove.includes('agent::closing'));
  });

  it('leaves a Story with no merged PR, and a not_planned one, untouched', async () => {
    const provider = fakeProvider([
      story(10),
      story(11, { stateReason: 'not_planned' }),
    ]);
    const gh = fakeGh({
      'story-10': [{ url: 'https://x/pull/1', state: 'CLOSED' }],
    });
    const out = await reconcileStrandedClosing({
      provider,
      config: config(),
      cwd: '/repo',
      gh,
      logger: quiet,
    });

    assert.equal(provider.updates.length, 0, 'no label write');
    assert.deepEqual(out.reconciled, []);
    assert.deepEqual(out.skipped, [
      { storyId: 10, reason: 'no-merged-pr' },
      { storyId: 11, reason: 'skipped' },
    ]);
    assert.equal(gh.calls.length, 1, 'a not_planned Story needs no PR read');
  });

  it('ignores Epics and Stories that already carry agent::done', async () => {
    const provider = fakeProvider([
      story(20, { labels: ['type::epic', 'agent::closing'] }),
      story(21, { labels: ['type::story', 'agent::closing', 'agent::done'] }),
    ]);
    const gh = fakeGh({});
    const out = await reconcileStrandedClosing({
      provider,
      config: config(),
      cwd: '/repo',
      gh,
      logger: quiet,
    });
    assert.deepEqual(out, { ok: true, reconciled: [], skipped: [] });
    assert.equal(gh.calls.length, 0);
  });

  it('reports a failed agent::done write under skipped instead of throwing', async () => {
    const provider = fakeProvider([story(30)], { updateThrows: true });
    const out = await reconcileStrandedClosing({
      provider,
      config: config(),
      cwd: '/repo',
      gh: fakeGh({ 'story-30': merged(31) }),
      notify: async () => {},
      sleep: async () => {},
      runPostLandTail: fakeTail().fn,
      logger: quiet,
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.reconciled, []);
    assert.deepEqual(out.skipped, [{ storyId: 30, reason: 'flip-failed' }]);
  });

  it('reports a throwing PR lookup as an error outcome', async () => {
    const provider = fakeProvider([story(40)]);
    const gh = {
      pr: {
        list: async () => {
          throw new Error('gh unreachable');
        },
      },
    };
    const out = await reconcileStrandedClosing({
      provider,
      config: config(),
      cwd: '/repo',
      gh,
      logger: quiet,
    });
    assert.deepEqual(out.skipped, [{ storyId: 40, reason: 'error' }]);
    assert.equal(provider.updates.length, 0);
  });

  it('degrades a throwing listing to ok:false with the error named', async () => {
    const warns = [];
    const out = await reconcileStrandedClosing({
      provider: {
        listTicketsByLabel: async () => {
          throw new Error('rate limited');
        },
      },
      config: config(),
      cwd: '/repo',
      logger: { info: () => {}, warn: (m) => warns.push(m) },
    });
    assert.deepEqual(out, {
      ok: false,
      reconciled: [],
      skipped: [],
      error: 'rate limited',
    });
    assert.match(warns[0], /rate limited/);
  });

  it('is a no-op for a provider without listTicketsByLabel', async () => {
    const out = await reconcileStrandedClosing({
      provider: {},
      config: config(),
      cwd: '/repo',
      logger: quiet,
    });
    assert.deepEqual(out, { ok: true, reconciled: [], skipped: [] });
  });

  it('runBootSweep writes agent::done end-to-end and reports it on the envelope', async () => {
    const provider = fakeProvider([story(4549)]);
    const gh = fakeGh({ 'story-4549': merged(4558) });
    const result = await runBootSweep({
      cwd: '/repo',
      ...NO_WORKTREE_SWEEP,
      injectedConfig: config(),
      injectedProvider: provider,
      injectedSweep: async () => ({ ok: true, reaped: [] }),
      purgeFn: async () => ({ purged: [] }),
      // Only the gh/notify/sleep seams are pinned; the reconcile is real.
      closingReconcileFn: (args) =>
        reconcileStrandedClosing({
          ...args,
          gh,
          notify: async () => {},
          sleep: async () => {},
          runPostLandTail: fakeTail().fn,
        }),
      logger: quiet,
    });
    assert.deepEqual(result.closingReconcile.reconciled, [4549]);
    const labelWrites = provider.updates.filter((u) => u.patch.labels);
    assert.equal(labelWrites.length, 1);
    assert.ok(labelWrites[0].patch.labels.add.includes('agent::done'));
  });

  it('releases the lease through the real land tail on the sweep path (Story #5705)', async () => {
    const provider = fakeProvider([story(5682)]);
    const gh = fakeGh({ 'story-5682': merged(5690) });
    const released = [];
    const ok = async () => ({ ok: true });
    const out = await reconcileStrandedClosing({
      provider,
      config: config(),
      cwd: '/repo',
      gh,
      notify: async () => {},
      sleep: async () => {},
      // The real tail, with only its side-effecting step seams pinned.
      runPostLandTail: (args) =>
        realRunPostLandTail({
          ...args,
          emitCloseRecoveredFrictionFn: async () => {},
          emitRecoveredFrictionMarkerFn: async () => {},
          captureStoryFollowUpsFn: ok,
          reassertStatusColumnFn: async () => ({ status: 'skipped' }),
          reapPlanRunLabelsForStoryFn: ok,
          rollUpEpicForStoryFn: ok,
          gitSpawnFn: () => ({ status: 1, stdout: '', stderr: '' }),
          planFastForwardFn: () => ({ action: 'skip', reason: 'test' }),
          executeFastForwardFn: () => ({ ok: true }),
          acquireLockWithWaitFn: async () => ({
            acquired: true,
            release: () => {},
          }),
          reapWorktreePhaseFn: async () => ({ ok: true }),
          purgeStoryTempArtifactsFn: async () => ({ ok: true }),
          releaseStoryLeaseFn: async ({ storyId }) => {
            released.push(storyId);
            return { ok: true };
          },
        }),
      logger: quiet,
    });
    assert.deepEqual(out.reconciled, [5682]);
    assert.deepEqual(released, [5682], 'the operator lease is released');
  });

  it('reconciles a closed agent::blocked Story whose PR merged, and leaves an unmerged one untouched', async () => {
    const blocked = (id) =>
      story(id, { labels: ['type::story', 'agent::blocked'] });
    const provider = fakeProvider([blocked(5684), blocked(60)]);
    const gh = fakeGh({
      'story-5684': merged(5697),
      'story-60': [{ url: 'https://x/pull/61', state: 'CLOSED' }],
    });
    const tail = fakeTail();
    const out = await reconcileStrandedClosing({
      provider,
      config: config(),
      cwd: '/repo',
      gh,
      notify: async () => {},
      sleep: async () => {},
      runPostLandTail: tail.fn,
      logger: quiet,
    });
    assert.deepEqual(out.reconciled, [5684]);
    assert.deepEqual(out.skipped, [{ storyId: 60, reason: 'no-merged-pr' }]);
    assert.deepEqual(
      tail.ran.map((a) => a.storyId),
      [5684],
    );
    const labelWrites = provider.updates.filter((u) => u.patch.labels);
    assert.equal(labelWrites.length, 1, 'only the merged Story is written');
    assert.equal(labelWrites[0].id, 5684);
    assert.ok(labelWrites[0].patch.labels.remove.includes('agent::blocked'));
  });

  it('skips not_planned and duplicate closes on either stranded label', async () => {
    const provider = fakeProvider([
      story(70, { stateReason: 'not_planned' }),
      story(71, {
        stateReason: 'duplicate',
        labels: ['type::story', 'agent::blocked'],
      }),
    ]);
    const gh = fakeGh({ 'story-70': merged(1), 'story-71': merged(2) });
    const tail = fakeTail();
    const out = await reconcileStrandedClosing({
      provider,
      config: config(),
      cwd: '/repo',
      gh,
      runPostLandTail: tail.fn,
      logger: quiet,
    });
    assert.deepEqual(out.skipped, [
      { storyId: 70, reason: 'skipped' },
      { storyId: 71, reason: 'skipped' },
    ]);
    assert.equal(gh.calls.length, 0);
    assert.equal(tail.ran.length, 0);
    assert.equal(provider.updates.length, 0);
  });

  it('lists a Story carrying both stranded labels once', async () => {
    const provider = fakeProvider([
      story(80, {
        labels: ['type::story', 'agent::closing', 'agent::blocked'],
      }),
    ]);
    const seen = [];
    await reconcileStrandedClosing({
      provider,
      config: config(),
      cwd: '/repo',
      logger: quiet,
      reconcileFn: async (ctx) => {
        seen.push(ctx.storyId);
        return 'done';
      },
    });
    assert.deepEqual(seen, [80]);
  });

  it('processes at most the cap per sweep (default 10)', async () => {
    const closed = Array.from({ length: 15 }, (_, i) => story(100 + i));
    const seen = [];
    const out = await reconcileStrandedClosing({
      provider: { listTicketsByLabel: async () => closed },
      config: config(),
      cwd: '/repo',
      logger: quiet,
      reconcileFn: async (ctx) => {
        seen.push(ctx.storyBranch);
        return 'done';
      },
    });
    assert.equal(seen.length, 10);
    assert.equal(seen[0], 'story-100');
    assert.equal(out.reconciled.length, 10);
  });
});

describe('runBootSweep — stranded agent::closing reconcile (Story #5652)', () => {
  it('runs the reconcile and carries its outcome on the envelope and summary', async () => {
    let seen = null;
    const provider = { marker: true };
    const result = await runBootSweep({
      cwd: '/repo',
      ...NO_WORKTREE_SWEEP,
      injectedConfig: { project: { baseBranch: 'main' } },
      injectedProvider: provider,
      injectedSweep: async () => ({
        ok: true,
        localDeleted: 0,
        remoteDeleted: 0,
      }),
      purgeFn: async () => ({ purged: [] }),
      closingReconcileFn: async (args) => {
        seen = args;
        return { ok: true, reconciled: [4549, 4561], skipped: [] };
      },
      logger: { info: () => {}, warn: () => {} },
    });

    assert.equal(seen.provider, provider);
    assert.equal(seen.cwd, path.resolve('/repo'), 'the resolved repo root');
    assert.deepEqual(result.closingReconcile.reconciled, [4549, 4561]);
    assert.match(
      buildSummaryLine(result),
      /flipped 2 stranded agent::closing Story\(ies\) to agent::done/,
    );
  });

  it('keeps the sweep exit-0 path when the reconcile reports a failure', async () => {
    const result = await runBootSweep({
      cwd: '/repo',
      ...NO_WORKTREE_SWEEP,
      injectedConfig: { project: { baseBranch: 'main' } },
      injectedProvider: {
        listTicketsByLabel: async () => {
          throw new Error('rate limited');
        },
      },
      injectedSweep: async () => ({ ok: true, reaped: [] }),
      purgeFn: async () => ({ purged: [] }),
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(result.ok, true, 'the branch sweep envelope survives');
    assert.equal(result.closingReconcile.ok, false);
    assert.equal(result.closingReconcile.error, 'rate limited');
  });
});
