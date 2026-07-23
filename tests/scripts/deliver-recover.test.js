/**
 * tests/scripts/deliver-recover.test.js — the recovery decision table
 * (Story #4543).
 *
 * `deliver-recover` is probes + a decision table + ONE next command. The
 * table is where the value is, and it is pure, so it is tested directly
 * against already-observed probe shapes rather than through git and GitHub.
 *
 * The rows that matter (from the Story's Spec) each get a case:
 *   - executing with no PR → resume implement
 *   - closing with a pending PR → resume the land
 *   - closing with a red PR → the fix loop
 *   - closing with a merged PR → confirm (the strand a /deliver re-run
 *     refuses outright, because init hard-errors on an already-closed Story)
 *   - done with a drifted board → resync
 *   - blocked → the class-specific remediation the friction comment names
 *
 * Two invariants are pinned beyond the rows themselves: every shape yields
 * exactly one command (never a menu), and that command comes from the SAME
 * vocabulary the pending terminal envelope uses — so recovery and normal
 * resumption cannot drift into two dialects for one state.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decideRecovery,
  probeBranch,
  probePr,
  probeTicket,
  recoverStory,
  renderRecovery,
} from '../../.agents/scripts/lib/orchestration/deliver-recover.js';
import { NEXT_COMMANDS } from '../../.agents/scripts/lib/orchestration/story-deliver-terminal.js';

const STORY_ID = 4543;

const BRANCH_PRESENT = {
  local: true,
  remote: true,
  worktreePath: '.worktrees/story-4543',
};

function ticket(stateLabel, overrides = {}) {
  return {
    ok: true,
    stateLabel,
    labels: [stateLabel],
    issueState: 'open',
    lease: 'someone',
    ...overrides,
  };
}

describe('deliver-recover — the decision table', () => {
  const rows = [
    {
      name: 'executing with no PR → resume implementation',
      probes: {
        ticket: ticket('agent::executing'),
        branch: BRANCH_PRESENT,
        pr: null,
      },
      shape: 'executing-no-pr',
      command: NEXT_COMMANDS.implement(STORY_ID),
    },
    {
      name: 'closing with a healthy open PR → resume the land',
      probes: {
        ticket: ticket('agent::closing'),
        branch: BRANCH_PRESENT,
        pr: { number: 99, state: 'OPEN', checksStatus: 'pending' },
      },
      shape: 'closing-pr-pending',
      command: NEXT_COMMANDS.resumeLand(STORY_ID),
    },
    {
      name: 'closing with a red PR → the fix loop, not another wait',
      probes: {
        ticket: ticket('agent::closing'),
        branch: BRANCH_PRESENT,
        pr: { number: 99, state: 'OPEN', checksStatus: 'failure' },
      },
      shape: 'closing-pr-red',
      command: NEXT_COMMANDS.watchCi(STORY_ID, 99),
    },
    {
      name: 'closing with a MERGED PR → confirm (the strand /deliver refuses)',
      probes: {
        ticket: ticket('agent::closing'),
        branch: BRANCH_PRESENT,
        pr: { number: 99, state: 'MERGED', mergedAt: '2026-07-16T00:00:00Z' },
      },
      shape: 'merged-label-stale',
      command: NEXT_COMMANDS.confirmMerge(STORY_ID),
    },
    {
      name: 'closing with no PR → re-run close',
      probes: {
        ticket: ticket('agent::closing'),
        branch: BRANCH_PRESENT,
        pr: null,
      },
      shape: 'closing-no-pr',
      command: NEXT_COMMANDS.close(STORY_ID),
    },
    {
      name: 'done → resync the board',
      probes: {
        ticket: ticket('agent::done', { issueState: 'closed' }),
        branch: { local: false, remote: false, worktreePath: null },
        pr: { number: 99, state: 'MERGED', mergedAt: '2026-07-16T00:00:00Z' },
      },
      shape: 'done-board-drift',
      command: NEXT_COMMANDS.resync(STORY_ID),
    },
    {
      name: 'blocked → the class-specific remediation already filed',
      probes: {
        ticket: ticket('agent::blocked'),
        branch: BRANCH_PRESENT,
        pr: { number: 99, state: 'OPEN', checksStatus: 'failure' },
      },
      shape: 'blocked',
      command: NEXT_COMMANDS.recover(STORY_ID),
    },
    {
      name: 'executing with a PR → close died before the label flip',
      probes: {
        ticket: ticket('agent::executing'),
        branch: BRANCH_PRESENT,
        pr: { number: 99, state: 'OPEN', checksStatus: 'pending' },
      },
      shape: 'executing-with-pr',
      command: NEXT_COMMANDS.close(STORY_ID),
    },
    {
      name: 'ready → nothing stranded, deliver it normally',
      probes: {
        ticket: ticket('agent::ready'),
        branch: { local: false, remote: false, worktreePath: null },
        pr: null,
      },
      shape: 'ready',
      command: NEXT_COMMANDS.close(STORY_ID),
    },
  ];

  for (const { name, probes, shape, command } of rows) {
    it(name, () => {
      const decision = decideRecovery({ storyId: STORY_ID, ...probes });
      assert.equal(decision.shape, shape);
      assert.equal(decision.nextCommand, command);
      assert.ok(decision.detail.length > 0);
      assert.ok(decision.evidence.length > 0);
    });
  }

  it('each documented strand shape maps to exactly ONE next command', () => {
    const byShape = new Map();
    for (const { probes } of rows) {
      const decision = decideRecovery({ storyId: STORY_ID, ...probes });
      // A string, never an array of candidates: a menu is what the operator
      // already has and cannot act on.
      assert.equal(typeof decision.nextCommand, 'string');
      const seen = byShape.get(decision.shape);
      if (seen !== undefined) {
        assert.equal(
          seen,
          decision.nextCommand,
          `shape "${decision.shape}" resolved to two different commands`,
        );
      }
      byShape.set(decision.shape, decision.nextCommand);
    }
    // Every row is a distinct documented strand shape.
    assert.equal(byShape.size, rows.length);
  });

  it('the next-command vocabulary is shared with the terminal envelope, not a second dialect', () => {
    const vocabulary = new Set(
      Object.values(NEXT_COMMANDS).map((fn) => fn(STORY_ID, 99)),
    );
    for (const { probes } of rows) {
      const { nextCommand } = decideRecovery({ storyId: STORY_ID, ...probes });
      assert.ok(
        vocabulary.has(nextCommand),
        `"${nextCommand}" is not from NEXT_COMMANDS — recovery invented its own dialect`,
      );
    }
  });

  it('a merged PR outranks a stale label — this is the /deliver-refuses strand', () => {
    // `single-story-init.js` hard-errors on an already-closed Story, so a
    // /deliver re-run cannot resolve this. Recovery must, and the confirm CLI
    // is idempotent against an already-merged PR.
    const decision = decideRecovery({
      storyId: STORY_ID,
      ticket: ticket('agent::closing', { issueState: 'closed' }),
      branch: BRANCH_PRESENT,
      pr: { number: 99, state: 'MERGED', mergedAt: '2026-07-16T00:00:00Z' },
    });
    assert.equal(decision.shape, 'merged-label-stale');
    assert.match(decision.detail, /idempotent/);
  });

  it('derives its verdict only from probes it names as evidence', () => {
    const decision = decideRecovery({
      storyId: STORY_ID,
      ticket: ticket('agent::closing', { lease: 'dsj1984' }),
      branch: BRANCH_PRESENT,
      pr: { number: 99, state: 'OPEN', checksStatus: 'pending' },
    });
    const joined = decision.evidence.join(' ');
    for (const probe of [
      'label=',
      'pr=',
      'checks=',
      'branch.local=',
      'worktree=',
      'lease=',
    ]) {
      assert.ok(joined.includes(probe), `evidence omits ${probe}`);
    }
  });
});

describe('deliver-recover — probes are read-only', () => {
  it('probeTicket extracts the agent:: state label and the lease holder', async () => {
    const probe = await probeTicket({
      storyId: STORY_ID,
      provider: {
        getTicket: async () => ({
          id: STORY_ID,
          state: 'open',
          title: 'x',
          labels: ['type::story', 'agent::closing'],
          assignees: ['dsj1984'],
        }),
      },
    });
    assert.equal(probe.ok, true);
    // The agent:: label is the state, picked out of a label set that also
    // carries type:: and other axes.
    assert.equal(probe.stateLabel, 'agent::closing');
    assert.equal(probe.lease, 'dsj1984');
    assert.equal(probe.issueState, 'open');
  });

  it('probeTicket reports an unreadable ticket rather than throwing', async () => {
    const probe = await probeTicket({
      storyId: STORY_ID,
      provider: {
        getTicket: async () => {
          throw new Error('404');
        },
      },
    });
    assert.equal(probe.ok, false);
    assert.match(probe.error, /404/);
  });

  it('probeTicket reports an unclaimed lease as null, not a crash', async () => {
    const probe = await probeTicket({
      storyId: STORY_ID,
      provider: {
        getTicket: async () => ({ id: STORY_ID, state: 'open', labels: [] }),
      },
    });
    assert.equal(probe.ok, true);
    assert.equal(probe.stateLabel, null);
    assert.equal(probe.lease, null);
  });

  it('probeBranch issues only read commands', () => {
    const calls = [];
    probeBranch({
      cwd: '/repo',
      storyBranch: 'story-4543',
      config: {},
      gitSpawnFn: (_cwd, ...args) => {
        calls.push(args);
        return { status: 1, stdout: '' };
      },
    });
    const mutating =
      /^(branch|push|commit|merge|reset|checkout|worktree-remove)$/;
    for (const args of calls) {
      assert.ok(
        !mutating.test(args[0]) || args.includes('list'),
        `probeBranch issued a mutating git command: git ${args.join(' ')}`,
      );
    }
    assert.ok(calls.length > 0);
  });

  it('probePr asks for --state all so a MERGED PR is still found', () => {
    let seenFlags = null;
    probePr({
      storyBranch: 'story-4543',
      gh: {
        pr: {
          list: async (flags) => {
            seenFlags = flags;
            return [];
          },
        },
      },
    });
    // The merged-but-label-stale strand is invisible under `--state open`.
    assert.ok(seenFlags.includes('--state'));
    assert.ok(seenFlags.includes('all'));
  });

  it('probePr degrades to an error probe rather than throwing', async () => {
    const result = await probePr({
      storyBranch: 'story-4543',
      gh: {
        pr: {
          list: async () => {
            throw new Error('ETIMEDOUT');
          },
        },
      },
    });
    assert.match(result.error, /ETIMEDOUT/);
  });
});

describe('deliver-recover — recoverStory', () => {
  const gitStub = (_cwd, ...args) =>
    args[0] === 'worktree'
      ? { status: 0, stdout: 'worktree /repo/.worktrees/story-4543\n' }
      : { status: 0, stdout: '' };

  it('threads the probes into one decision and reports the branch', async () => {
    const recovery = await recoverStory({
      storyId: STORY_ID,
      cwd: '/repo',
      config: {},
      provider: {
        getTicket: async () => ({
          id: STORY_ID,
          state: 'open',
          title: 'x',
          labels: ['agent::closing'],
          assignees: ['dsj1984'],
        }),
      },
      gh: {
        pr: {
          list: async () => [
            { number: 99, url: 'https://x/99', state: 'OPEN' },
          ],
        },
      },
      gitSpawnFn: gitStub,
      sleepFn: async () => {},
    });
    assert.equal(recovery.storyBranch, 'story-4543');
    assert.equal(recovery.shape, 'closing-pr-pending');
    assert.equal(recovery.probes.ticket.lease, 'dsj1984');
    assert.equal(recovery.nextCommand, NEXT_COMMANDS.resumeLand(STORY_ID));
    // Transient shape, unchanged across the settle window → stable verdict.
    assert.deepEqual(recovery.stability, {
      reprobed: true,
      stable: true,
      delayMs: 5000,
    });
  });

  it('throws a named error when the ticket itself is unreadable', async () => {
    await assert.rejects(
      () =>
        recoverStory({
          storyId: STORY_ID,
          cwd: '/repo',
          config: {},
          provider: {
            getTicket: async () => {
              throw new Error('404 Not Found');
            },
          },
          gh: { pr: { list: async () => [] } },
          gitSpawnFn: gitStub,
        }),
      /could not read Story #4543: 404 Not Found/,
    );
  });

  it('renders the shape, the command, and the evidence behind it', () => {
    const rendered = renderRecovery(
      decideRecovery({
        storyId: STORY_ID,
        ticket: ticket('agent::closing'),
        branch: BRANCH_PRESENT,
        pr: { number: 99, state: 'MERGED', mergedAt: '2026-07-16T00:00:00Z' },
      }),
    );
    assert.match(rendered, /merged-label-stale/);
    assert.match(rendered, /Evidence:/);
    assert.match(rendered, /Next command:/);
    assert.match(rendered, /single-story-confirm-merge\.js --story 4543/);
  });
});

describe('deliver-recover — stability re-probe (mid-flight strands)', () => {
  const gitStub = (_cwd, ...args) =>
    args[0] === 'worktree'
      ? { status: 0, stdout: 'worktree /repo/.worktrees/story-4543\n' }
      : { status: 0, stdout: '' };

  const executingProvider = () => ({
    calls: 0,
    getTicket: async function () {
      this.calls += 1;
      return {
        id: STORY_ID,
        state: 'open',
        title: 'x',
        labels: ['agent::executing'],
        assignees: ['dsj1984'],
      };
    },
  });

  it('a shape that flips between probes reports in-transition, not the first guess (the #4712 strand)', async () => {
    // Probe 1 lands before the close's push/PR-open; probe 2 lands after.
    let prCalls = 0;
    const recovery = await recoverStory({
      storyId: STORY_ID,
      cwd: '/repo',
      config: {},
      provider: executingProvider(),
      gh: {
        pr: {
          list: async () => {
            prCalls += 1;
            return prCalls === 1
              ? []
              : [{ number: 4715, url: 'https://x/4715', state: 'OPEN' }];
          },
        },
      },
      gitSpawnFn: gitStub,
      sleepFn: async () => {},
    });
    assert.equal(recovery.shape, 'in-transition');
    assert.equal(recovery.nextCommand, NEXT_COMMANDS.recover(STORY_ID));
    assert.deepEqual(recovery.stability, {
      reprobed: true,
      stable: false,
      delayMs: 5000,
    });
    assert.ok(recovery.evidence.includes('probe1.shape=executing-no-pr'));
    assert.ok(recovery.evidence.includes('probe2.shape=executing-with-pr'));
    assert.match(recovery.detail, /actively\s+mutating/);
  });

  it('a transient shape stable across the settle window returns the fresher verdict', async () => {
    const provider = executingProvider();
    let prCalls = 0;
    const recovery = await recoverStory({
      storyId: STORY_ID,
      cwd: '/repo',
      config: {},
      provider,
      gh: {
        pr: {
          list: async () => {
            prCalls += 1;
            return [];
          },
        },
      },
      gitSpawnFn: gitStub,
      sleepFn: async () => {},
    });
    assert.equal(recovery.shape, 'executing-no-pr');
    assert.equal(provider.calls, 2);
    assert.equal(prCalls, 2);
    assert.deepEqual(recovery.stability, {
      reprobed: true,
      stable: true,
      delayMs: 5000,
    });
  });

  it('a settled shape (blocked) never pays the second probe', async () => {
    const provider = {
      calls: 0,
      getTicket: async function () {
        this.calls += 1;
        return {
          id: STORY_ID,
          state: 'open',
          title: 'x',
          labels: ['agent::blocked'],
          assignees: ['dsj1984'],
        };
      },
    };
    const recovery = await recoverStory({
      storyId: STORY_ID,
      cwd: '/repo',
      config: {},
      provider,
      gh: { pr: { list: async () => [] } },
      gitSpawnFn: gitStub,
      sleepFn: async () => {
        throw new Error('settled shapes must not sleep');
      },
    });
    assert.equal(recovery.shape, 'blocked');
    assert.equal(provider.calls, 1);
    assert.deepEqual(recovery.stability, { reprobed: false });
  });

  it('reprobe: false restores the single-probe verdict even for transient shapes', async () => {
    const provider = executingProvider();
    const recovery = await recoverStory({
      storyId: STORY_ID,
      cwd: '/repo',
      config: {},
      provider,
      gh: { pr: { list: async () => [] } },
      gitSpawnFn: gitStub,
      reprobe: false,
      sleepFn: async () => {
        throw new Error('reprobe:false must not sleep');
      },
    });
    assert.equal(recovery.shape, 'executing-no-pr');
    assert.equal(provider.calls, 1);
    assert.deepEqual(recovery.stability, { reprobed: false });
  });

  it('the settle window is configurable and reaches the sleep seam', async () => {
    const delays = [];
    const recovery = await recoverStory({
      storyId: STORY_ID,
      cwd: '/repo',
      config: {},
      provider: executingProvider(),
      gh: { pr: { list: async () => [] } },
      gitSpawnFn: gitStub,
      stabilityDelayMs: 1234,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });
    assert.deepEqual(delays, [1234]);
    assert.equal(recovery.stability.delayMs, 1234);
  });
});
