import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseArgv,
  runDeliverRecover,
} from '../.agents/scripts/deliver-recover.js';
import {
  decideRecovery,
  probePr,
  recoverStory,
} from '../.agents/scripts/lib/orchestration/deliver-recover.js';
import { NEXT_COMMANDS } from '../.agents/scripts/lib/orchestration/story-deliver-terminal.js';

/**
 * Story #4780 — `runDeliverRecover` scored CRAP 85.4: the read-only probe an
 * operator reaches for when a Story is stranded had no test file, so its
 * argument contract (the one that decides whether it prints a command or
 * refuses) was unverified.
 *
 * Config resolution, provider construction, the probe, the renderer, and the
 * log sink are all injected through the optional final `deps` parameter
 * (`docs/contributing/test-seams.md` rules 1 and 5): no GitHub call, no git
 * spawn, no module mocking.
 */

function harness(
  recovery = { shape: 'merged-label-stale', nextCommand: 'gh x' },
) {
  const infos = [];
  const probes = [];
  return {
    infos,
    probes,
    recovery,
    deps: {
      resolveConfigImpl: (args) => ({ resolvedFor: args?.cwd }),
      createProviderImpl: (config) => ({ providerFor: config.resolvedFor }),
      recoverStoryImpl: async (args) => {
        probes.push(args);
        return recovery;
      },
      renderRecoveryImpl: (r) => `PROSE:${r.shape}`,
      logger: { info: (m) => infos.push(m) },
    },
  };
}

describe('deliver-recover parseArgv', () => {
  it('parses a full argv', () => {
    assert.deepEqual(
      parseArgv([
        '--story',
        '4780',
        '--cwd',
        '/repo',
        '--json',
        '--no-reprobe',
      ]),
      { storyId: 4780, cwd: '/repo', json: true, reprobe: false, help: false },
    );
  });

  it('defaults cwd to null, json to false, and reprobe to true', () => {
    assert.deepEqual(parseArgv(['--story', '12']), {
      storyId: 12,
      cwd: null,
      json: false,
      reprobe: true,
      help: false,
    });
  });

  it('yields NaN for a missing or non-numeric --story', () => {
    assert.ok(Number.isNaN(parseArgv([]).storyId));
    assert.ok(Number.isNaN(parseArgv(['--story', 'abc']).storyId));
  });

  it('records --help', () => {
    assert.equal(parseArgv(['--help']).help, true);
  });
});

describe('runDeliverRecover', () => {
  it('prints the help text and probes nothing under --help', async () => {
    const h = harness();
    const result = await runDeliverRecover({ argv: ['--help'] }, h.deps);
    assert.deepEqual(result, { success: true, result: null });
    assert.equal(h.probes.length, 0);
    assert.match(
      h.infos[0],
      /Usage: node \.agents\/scripts\/deliver-recover\.js/,
    );
    assert.match(h.infos[0], /Read-only: mutates nothing/);
  });

  it('refuses a missing, non-numeric, zero, or negative story id', async () => {
    for (const argv of [
      [],
      ['--story', 'abc'],
      ['--story', '0'],
      ['--story', '-3'],
    ]) {
      const h = harness();
      await assert.rejects(
        () => runDeliverRecover({ argv }, h.deps),
        /Usage: node deliver-recover\.js --story <STORY_ID>/,
      );
      assert.equal(h.probes.length, 0);
    }
  });

  it('probes the parsed story and renders prose by default', async () => {
    const h = harness();
    const result = await runDeliverRecover(
      { argv: ['--story', '4780', '--cwd', '/repo'] },
      h.deps,
    );
    assert.equal(result.success, true);
    assert.equal(h.probes[0].storyId, 4780);
    assert.equal(h.probes[0].cwd, '/repo');
    assert.equal(h.probes[0].reprobe, true);
    assert.equal(h.infos[0], 'PROSE:merged-label-stale');
  });

  it('emits the full envelope as JSON under --json', async () => {
    const h = harness();
    await runDeliverRecover({ argv: ['--story', '1', '--json'] }, h.deps);
    assert.deepEqual(JSON.parse(h.infos[0]), h.recovery);
  });

  it('takes the direct-argument path over argv when storyId is supplied', async () => {
    const h = harness();
    await runDeliverRecover(
      {
        storyId: 99,
        cwd: '/other',
        json: true,
        reprobe: false,
        argv: ['--story', '1'],
      },
      h.deps,
    );
    assert.equal(h.probes[0].storyId, 99);
    assert.equal(h.probes[0].cwd, '/other');
    assert.equal(h.probes[0].reprobe, false);
    assert.deepEqual(JSON.parse(h.infos[0]), h.recovery);
  });

  it('defaults cwd, json and reprobe on the direct-argument path', async () => {
    const h = harness();
    await runDeliverRecover({ storyId: 7 }, h.deps);
    assert.equal(h.probes[0].reprobe, true);
    assert.equal(h.infos[0], 'PROSE:merged-label-stale');
    assert.equal(typeof h.probes[0].cwd, 'string');
  });

  it('turns the stability re-probe off under --no-reprobe', async () => {
    const h = harness();
    await runDeliverRecover({ argv: ['--story', '1', '--no-reprobe'] }, h.deps);
    assert.equal(h.probes[0].reprobe, false);
  });

  it('prefers an injected config and provider over the resolver seams', async () => {
    const h = harness();
    await runDeliverRecover(
      {
        argv: ['--story', '1'],
        injectedConfig: { injected: true },
        injectedProvider: { injectedProvider: true },
      },
      h.deps,
    );
    assert.deepEqual(h.probes[0].config, { injected: true });
    assert.deepEqual(h.probes[0].provider, { injectedProvider: true });
  });

  it('builds config and provider from the seams when none are injected', async () => {
    const h = harness();
    await runDeliverRecover(
      { argv: ['--story', '1', '--cwd', '/repo'] },
      h.deps,
    );
    assert.deepEqual(h.probes[0].config, { resolvedFor: '/repo' });
    assert.deepEqual(h.probes[0].provider, { providerFor: '/repo' });
  });

  it('threads the gh, git-spawn and sleep seams to the probe only when given', async () => {
    const h = harness();
    const gh = () => {};
    const gitSpawn = () => {};
    const sleepFn = async () => {};
    await runDeliverRecover(
      {
        storyId: 1,
        injectedGh: gh,
        injectedGitSpawn: gitSpawn,
        injectedSleepFn: sleepFn,
      },
      h.deps,
    );
    assert.equal(h.probes[0].gh, gh);
    assert.equal(h.probes[0].gitSpawnFn, gitSpawn);
    assert.equal(h.probes[0].sleepFn, sleepFn);

    const bare = harness();
    await runDeliverRecover({ storyId: 1 }, bare.deps);
    assert.equal('sleepFn' in bare.probes[0], false);
  });
});

/**
 * Story #5533 AC-6 — under `agent::closing`, a conflicted PR and a PR a new
 * head disarmed each get their own settled shape, checked before the red one.
 */
describe('deliver-recover — conflicted and un-armed closing PRs (Story #5533)', () => {
  const closing = {
    ok: true,
    stateLabel: 'agent::closing',
    labels: ['agent::closing'],
    issueState: 'open',
    lease: 'someone',
  };
  const branch = {
    local: true,
    remote: true,
    worktreePath: '.worktrees/story-5533',
  };
  const decide = (pr) =>
    decideRecovery({ storyId: 5533, ticket: closing, branch, pr });

  it('a DIRTY PR is closing-pr-conflicted and names close, the worktree and its recreation', () => {
    const d = decide({
      number: 9,
      state: 'OPEN',
      checksStatus: 'pending',
      mergeStateStatus: 'DIRTY',
      autoMergeArmed: true,
    });
    assert.equal(d.shape, 'closing-pr-conflicted');
    assert.equal(d.nextCommand, NEXT_COMMANDS.close(5533));
    assert.match(d.detail, /\.worktrees\/story-5533/);
    assert.match(d.detail, /recreating that worktree when it is missing/);
    assert.match(d.detail, /conflicted files/);
    assert.ok(d.evidence.includes('mergeState=DIRTY'));
  });

  it('DIRTY outranks red: a conflicted head cannot be fixed by the red loop alone', () => {
    const d = decide({
      number: 9,
      state: 'OPEN',
      checksStatus: 'failure',
      mergeStateStatus: 'DIRTY',
    });
    assert.equal(d.shape, 'closing-pr-conflicted');
  });

  it('an open, un-armed, not-red PR is closing-pr-unarmed and resumes the re-arming wait', () => {
    const d = decide({
      number: 9,
      state: 'OPEN',
      checksStatus: 'pending',
      mergeStateStatus: 'BLOCKED',
      autoMergeArmed: false,
      inMergeQueue: false,
      queueRequired: false,
    });
    assert.equal(d.shape, 'closing-pr-unarmed');
    assert.equal(d.nextCommand, NEXT_COMMANDS.resumeLand(5533));
    assert.match(d.detail, /new head disarmed/);
    assert.match(d.detail, /gh pr merge 9 --auto --squash --delete-branch/);
    assert.ok(d.evidence.includes('autoMerge=unarmed'));
  });

  it('names the queue equivalent when the base requires a merge queue', () => {
    const d = decide({
      number: 9,
      state: 'OPEN',
      checksStatus: 'pending',
      autoMergeArmed: false,
      queueRequired: true,
    });
    assert.equal(d.shape, 'closing-pr-unarmed');
    assert.match(d.detail, /gh pr merge 9 --auto`/);
    assert.match(d.detail, /merge queue/);
  });

  it('a red, a queued or an armed PR is not un-armed', () => {
    const base = { number: 9, state: 'OPEN', autoMergeArmed: false };
    assert.equal(
      decide({ ...base, checksStatus: 'failure' }).shape,
      'closing-pr-red',
    );
    assert.equal(
      decide({ ...base, checksStatus: 'success', inMergeQueue: true }).shape,
      'closing-pr-pending',
    );
    assert.equal(
      decide({ ...base, checksStatus: 'pending', autoMergeArmed: true }).shape,
      'closing-pr-pending',
    );
    assert.equal(
      decide({ number: 9, state: 'OPEN', checksStatus: 'pending' }).shape,
      'closing-pr-pending',
      'an unread auto-merge field never reads as a disarm',
    );
  });

  it('probePr reads the merge state, the auto-merge request and the head, and reads the queue only for an un-armed PR', async () => {
    const queueReads = [];
    const probe = (row) =>
      probePr({
        storyBranch: 'story-5533',
        gh: { pr: { list: async () => [row] } },
        readMergeQueueStateFn: async (args) => {
          queueReads.push(args);
          return { inQueue: false, queueRequired: true, prNodeId: 'PR_x' };
        },
      });
    const unarmed = await probe({
      number: 9,
      state: 'OPEN',
      id: 'PR_x',
      mergeStateStatus: 'BLOCKED',
      autoMergeRequest: null,
      headRefOid: 'abc',
      statusCheckRollup: [],
    });
    assert.equal(unarmed.autoMergeArmed, false);
    assert.equal(unarmed.mergeStateStatus, 'BLOCKED');
    assert.equal(unarmed.headSha, 'abc');
    assert.equal(unarmed.inMergeQueue, false);
    assert.equal(unarmed.queueRequired, true);
    assert.equal(queueReads[0].prNodeId, 'PR_x');

    const armed = await probe({
      number: 9,
      state: 'OPEN',
      autoMergeRequest: { enabledAt: 'x' },
      statusCheckRollup: [],
    });
    assert.equal(armed.autoMergeArmed, true);
    assert.equal(queueReads.length, 1, 'no queue read for an armed PR');
  });

  it('both shapes are settled — no stability re-probe', async () => {
    let lists = 0;
    let slept = false;
    const recovery = await recoverStory({
      storyId: 5533,
      cwd: '/repo',
      config: {},
      provider: {
        getTicket: async () => ({
          id: 5533,
          state: 'open',
          labels: ['agent::closing'],
        }),
      },
      gh: {
        pr: {
          list: async () => {
            lists += 1;
            return [
              {
                number: 9,
                state: 'OPEN',
                mergeStateStatus: 'DIRTY',
                statusCheckRollup: [],
              },
            ];
          },
        },
      },
      gitSpawnFn: () => ({ status: 1, stdout: '' }),
      sleepFn: async () => {
        slept = true;
      },
    });
    assert.equal(recovery.shape, 'closing-pr-conflicted');
    assert.equal(lists, 1);
    assert.equal(slept, false);
  });
});
