/**
 * tests/scripts/deliver-recover.test.js — the recovery decision table
 * (Story #4543).
 *
 * `deliver-recover` is probes + a decision table + ONE next command. The
 * table is where the value is, and it is pure, so it is tested directly
 * against already-observed probe shapes rather than through git and GitHub.
 *
 * The rows that matter (from the Story's Spec) each get a case:
 *   - executing, branch unpushed, no PR → resume implement
 *   - executing, branch pushed, no PR → run close (Story #5267)
 *   - closing with a pending PR → resume the land
 *   - closing with a red PR → the fix loop
 *   - closing with a merged PR → confirm (the strand a /mandrel-deliver re-run
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
  probeCloseArtifacts,
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

/**
 * The same branch before its push. Story #5267 made this the ONE reading that
 * means "implementation never finished", so the rows that claim it have to
 * state it rather than inherit a pushed fixture.
 */
const BRANCH_UNPUSHED = {
  local: true,
  remote: false,
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
      name: 'executing, branch unpushed, no PR → resume implementation',
      probes: {
        ticket: ticket('agent::executing'),
        branch: BRANCH_UNPUSHED,
        pr: null,
      },
      shape: 'executing-no-pr',
      command: NEXT_COMMANDS.implement(STORY_ID),
    },
    {
      name: 'executing, branch PUSHED, no PR → run close, not re-init',
      probes: {
        ticket: ticket('agent::executing'),
        branch: BRANCH_PRESENT,
        pr: null,
      },
      shape: 'executing-pushed-no-pr',
      command: NEXT_COMMANDS.close(STORY_ID),
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
      name: 'closing with a MERGED PR → confirm (the strand /mandrel-deliver refuses)',
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
    // /mandrel-deliver re-run cannot resolve this. Recovery must, and the confirm CLI
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
  // `show-ref` on the remote tracking ref answers "absent", so the threaded
  // probes read an UNPUSHED branch — the shape these cases are about (Story
  // #5267 split the pushed reading onto its own row).
  const gitStub = (_cwd, ...args) => {
    if (args[0] === 'worktree') {
      return { status: 0, stdout: 'worktree /repo/.worktrees/story-4543\n' };
    }
    if (args[0] === 'show-ref' && args.at(-1).startsWith('refs/remotes/')) {
      return { status: 1, stdout: '' };
    }
    return { status: 0, stdout: '' };
  };

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
  // `show-ref` on the remote tracking ref answers "absent", so the threaded
  // probes read an UNPUSHED branch — the shape these cases are about (Story
  // #5267 split the pushed reading onto its own row).
  const gitStub = (_cwd, ...args) => {
    if (args[0] === 'worktree') {
      return { status: 0, stdout: 'worktree /repo/.worktrees/story-4543\n' };
    }
    if (args[0] === 'show-ref' && args.at(-1).startsWith('refs/remotes/')) {
      return { status: 1, stdout: '' };
    }
    return { status: 0, stdout: '' };
  };

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

describe('deliver-recover — a live close is not a dead implementation (#4816)', () => {
  /**
   * The one ambiguous row in the whole table: `agent::executing` with no PR
   * reads identically for an implementation that died and for a close that is
   * halfway through its gate chain. Everything below is that row.
   */
  const EXECUTING_NO_PR = {
    storyId: STORY_ID,
    ticket: ticket('agent::executing'),
    branch: BRANCH_UNPUSHED,
    pr: null,
  };

  const NOW = 1_800_000_000_000;

  /**
   * A `probeCloseArtifacts` reading, built by hand. `gateLogFresh` is stated
   * outright rather than recomputed from the window: the table reads the flag,
   * and the window that produces it is the probe's business (pinned in the
   * probe suite below).
   */
  function artifacts({
    envelope = null,
    gateLogAgeMs = null,
    gateLogFresh = gateLogAgeMs !== null,
    envelopeAgeMs = 0,
  }) {
    return {
      envelope,
      envelopePath: '/tmp/orchestration/story-deliver-terminal-4543.json',
      envelopeMtimeMs: envelope ? NOW - envelopeAgeMs : null,
      gateLogPath: '/tmp/orchestration/close-gates-4543.log',
      gateLogAgeMs,
      gateLogMtimeMs: gateLogAgeMs === null ? null : NOW - gateLogAgeMs,
      gateLogFresh,
    };
  }

  it('reports close-in-flight, not "implementation never finished"', () => {
    // The observed defect: the probe said "Implementation never finished"
    // while the gate log had been appended one second earlier.
    const decision = decideRecovery({
      ...EXECUTING_NO_PR,
      closeArtifacts: artifacts({ gateLogAgeMs: 1000 }),
    });
    assert.equal(decision.shape, 'close-in-flight');
    assert.ok(!/never finished/i.test(decision.detail));
  });

  it('names the re-init hazard rather than leaving it implied', () => {
    // Acting on the old verdict re-inits a worktree underneath a running
    // close and risks two closes racing on one PR.
    const { detail } = decideRecovery({
      ...EXECUTING_NO_PR,
      closeArtifacts: artifacts({ gateLogAgeMs: 1000 }),
    });
    assert.match(detail, /single-story-init\.js/);
    assert.match(detail, /Do not run/i);
  });

  it('routes a live close back to the read-only probe, never to a mutation', () => {
    const { nextCommand } = decideRecovery({
      ...EXECUTING_NO_PR,
      closeArtifacts: artifacts({ gateLogAgeMs: 1000 }),
    });
    assert.equal(nextCommand, NEXT_COMMANDS.recover(STORY_ID));
    assert.notEqual(nextCommand, NEXT_COMMANDS.implement(STORY_ID));
  });

  it('treats a gate log older than the window as a dead close', () => {
    const decision = decideRecovery({
      ...EXECUTING_NO_PR,
      closeArtifacts: artifacts({
        gateLogAgeMs: 10 * 60_000,
        gateLogFresh: false,
      }),
    });
    assert.equal(decision.shape, 'executing-no-pr');
    assert.equal(decision.nextCommand, NEXT_COMMANDS.implement(STORY_ID));
  });

  it('answers a finished-but-orphaned close from its persisted envelope', () => {
    // The handoff gap itself: the close completed and emitted its verdict
    // into a turn nobody was reading. The verdict is on disk — relay it
    // rather than re-deriving a status from labels.
    const decision = decideRecovery({
      ...EXECUTING_NO_PR,
      closeArtifacts: artifacts({
        envelope: {
          status: 'pending',
          phase: 'confirm-merge',
          nextCommand: NEXT_COMMANDS.resumeLand(STORY_ID),
        },
      }),
    });
    assert.equal(decision.shape, 'close-envelope-on-disk');
    assert.equal(decision.nextCommand, NEXT_COMMANDS.resumeLand(STORY_ID));
    assert.match(decision.detail, /story-deliver-terminal-4543\.json/);
  });

  it('falls back to the idempotent confirm for a landed envelope naming none', () => {
    const decision = decideRecovery({
      ...EXECUTING_NO_PR,
      closeArtifacts: artifacts({
        envelope: { status: 'landed', phase: 'post-land', nextCommand: null },
      }),
    });
    assert.equal(decision.shape, 'close-envelope-on-disk');
    assert.equal(decision.nextCommand, NEXT_COMMANDS.confirmMerge(STORY_ID));
  });

  it('lets a live close outrank a STALE envelope from a previous attempt', () => {
    // A Story can be closed more than once. An envelope written before the
    // current attempt started must not out-argue the gate log that attempt is
    // appending to right now.
    const decision = decideRecovery({
      ...EXECUTING_NO_PR,
      closeArtifacts: artifacts({
        envelope: { status: 'blocked', phase: 'close-validation' },
        envelopeAgeMs: 60_000,
        gateLogAgeMs: 2_000,
      }),
    });
    assert.equal(decision.shape, 'close-in-flight');
  });

  it('prefers the envelope when it is newer than the gate log', () => {
    const decision = decideRecovery({
      ...EXECUTING_NO_PR,
      closeArtifacts: artifacts({
        envelope: {
          status: 'pending',
          phase: 'confirm-merge',
          nextCommand: 'x',
        },
        envelopeAgeMs: 1_000,
        gateLogAgeMs: 30_000,
      }),
    });
    assert.equal(decision.shape, 'close-envelope-on-disk');
  });

  it('preserves the genuinely-stranded verdict when neither artifact exists', () => {
    const decision = decideRecovery({
      ...EXECUTING_NO_PR,
      closeArtifacts: artifacts({}),
    });
    assert.equal(decision.shape, 'executing-no-pr');
    assert.equal(decision.nextCommand, NEXT_COMMANDS.implement(STORY_ID));
  });

  it('is inert on every other row of the table', () => {
    // The artifacts get the first word in ONE place. A closing Story with a
    // healthy PR is unambiguous already, and a fresh gate log must not
    // reroute it.
    const decision = decideRecovery({
      storyId: STORY_ID,
      ticket: ticket('agent::closing'),
      branch: BRANCH_PRESENT,
      pr: { number: 7, state: 'OPEN', checksStatus: 'pending' },
      closeArtifacts: artifacts({ gateLogAgeMs: 1000 }),
    });
    assert.equal(decision.shape, 'closing-pr-pending');
  });

  it('reports both artifacts as evidence, on every shape', () => {
    const decision = decideRecovery({
      ...EXECUTING_NO_PR,
      closeArtifacts: artifacts({ gateLogAgeMs: 5_000 }),
    });
    assert.ok(decision.evidence.includes('closeEnvelope=none'));
    assert.ok(decision.evidence.includes('gateLogAge=5s'));

    const bare = decideRecovery(EXECUTING_NO_PR);
    assert.ok(bare.evidence.includes('gateLogAge=none'));
  });
});

describe('probeCloseArtifacts — reading the close’s leavings (#4816)', () => {
  const paths = {
    envelope: /story-deliver-terminal-4543\.json$/,
    gateLog: /close-gates-4543\.log$/,
  };

  it('reads the envelope and both mtimes when the close left them', () => {
    const NOW = 1_800_000_000_000;
    const fsImpl = {
      readFileSync: () => JSON.stringify({ status: 'landed', phase: 'done' }),
      statSync: (target) => ({
        mtimeMs: paths.gateLog.test(target) ? NOW - 3_000 : NOW - 1_000,
      }),
    };
    const probed = probeCloseArtifacts({
      storyId: STORY_ID,
      fsImpl,
      nowMs: NOW,
    });
    assert.equal(probed.envelope.status, 'landed');
    assert.match(probed.envelopePath, paths.envelope);
    assert.match(probed.gateLogPath, paths.gateLog);
    assert.equal(probed.gateLogAgeMs, 3_000);
    assert.equal(probed.gateLogFresh, true);
  });

  it('degrades to a null reading rather than throwing on missing artifacts', () => {
    // An absent artifact is the common case — most Stories are probed long
    // after their close. The table must fall back to its label-only verdict,
    // not crash the read-only CLI.
    const fsImpl = {
      readFileSync: () => {
        throw new Error('ENOENT');
      },
      statSync: () => {
        throw new Error('ENOENT');
      },
    };
    const probed = probeCloseArtifacts({ storyId: STORY_ID, fsImpl });
    assert.equal(probed.envelope, null);
    assert.equal(probed.gateLogAgeMs, null);
    assert.equal(probed.gateLogFresh, false);
  });

  it('treats an unparseable or non-object envelope as absent', () => {
    for (const body of ['{not json', '"a string"', '[1,2]']) {
      const probed = probeCloseArtifacts({
        storyId: STORY_ID,
        fsImpl: {
          readFileSync: () => body,
          statSync: () => ({ mtimeMs: 0 }),
        },
      });
      assert.equal(probed.envelope, null, `body: ${body}`);
    }
  });

  it('flips gateLogFresh across the default two-minute window', () => {
    // Generous on purpose: gate output arrives in bursts, and reading a
    // slow-but-healthy close as dead re-opens the exact misdiagnosis this
    // exists to remove. Being wrong the other way costs one re-probe.
    const NOW = 1_800_000_000_000;
    const at = (ageMs) =>
      probeCloseArtifacts({
        storyId: STORY_ID,
        nowMs: NOW,
        fsImpl: {
          readFileSync: () => {
            throw new Error('ENOENT');
          },
          statSync: () => ({ mtimeMs: NOW - ageMs }),
        },
      }).gateLogFresh;
    assert.equal(at(119_000), true);
    assert.equal(at(121_000), false);
  });

  it('is re-read on every round of the stability pass', async () => {
    // A second look is exactly how a close that has since written its
    // envelope gets noticed — so the probe cannot be hoisted out of the loop.
    let reads = 0;
    const provider = {
      getTicket: async () => ({
        labels: ['agent::executing'],
        state: 'open',
        assignees: [],
      }),
    };
    await recoverStory({
      storyId: STORY_ID,
      cwd: '/repo',
      provider,
      gh: { pr: { list: async () => [] } },
      gitSpawnFn: () => ({ status: 1, stdout: '' }),
      fsImpl: {
        readFileSync: () => {
          reads += 1;
          throw new Error('ENOENT');
        },
        statSync: () => {
          throw new Error('ENOENT');
        },
      },
      stabilityDelayMs: 0,
      sleepFn: async () => {},
    });
    assert.equal(reads, 2, 'both probe rounds read the artifacts');
  });
});

describe('close-in-flight earns the stability re-probe (#4816)', () => {
  it('is treated as mid-flight, not as a settled verdict', async () => {
    // Membership in TRANSIENT_SHAPES is not directly observable, so pin the
    // behaviour it buys: a shape whose whole definition is "a process is
    // mutating this Story right now" must get the second look. Here the close
    // opens its PR between the probes, and the diverging shapes report
    // `in-transition` — proof the second round ran at all.
    let round = 0;
    const provider = {
      getTicket: async () => ({
        labels: ['agent::executing'],
        state: 'open',
        assignees: [],
      }),
    };
    const recovery = await recoverStory({
      storyId: STORY_ID,
      cwd: '/repo',
      provider,
      gh: {
        pr: {
          list: async () => {
            round += 1;
            return round === 1
              ? []
              : [{ number: 9, state: 'OPEN', statusCheckRollup: [] }];
          },
        },
      },
      gitSpawnFn: () => ({ status: 1, stdout: '' }),
      fsImpl: {
        readFileSync: () => {
          throw new Error('ENOENT');
        },
        statSync: () => ({ mtimeMs: Date.now() }),
      },
      stabilityDelayMs: 0,
      sleepFn: async () => {},
    });
    assert.equal(recovery.stability.reprobed, true);
    assert.equal(recovery.shape, 'in-transition');
    assert.match(recovery.detail, /close-in-flight/);
  });
});

describe('deliver-recover — push state splits the executing strand (#5267)', () => {
  /**
   * The reordering this Story landed made the push the LAST thing a worker
   * does before its creditable capture, so `agent::executing` + no PR now
   * carries two genuinely different meanings and must not answer with one
   * command. Getting it wrong is expensive in one direction specifically:
   * telling an operator to re-init on top of a branch that already carries
   * finished work.
   */
  const EXECUTING = {
    storyId: STORY_ID,
    ticket: ticket('agent::executing'),
    pr: null,
  };

  it('an unpushed branch and a pushed one disagree on both command and detail', () => {
    const unpushed = decideRecovery({ ...EXECUTING, branch: BRANCH_UNPUSHED });
    const pushed = decideRecovery({ ...EXECUTING, branch: BRANCH_PRESENT });

    assert.notEqual(unpushed.shape, pushed.shape);
    assert.notEqual(unpushed.nextCommand, pushed.nextCommand);
    assert.notEqual(unpushed.detail, pushed.detail);
    assert.equal(unpushed.nextCommand, NEXT_COMMANDS.implement(STORY_ID));
    assert.equal(pushed.nextCommand, NEXT_COMMANDS.close(STORY_ID));
  });

  it('the unpushed detail says implementation never finished', () => {
    const { detail } = decideRecovery({
      ...EXECUTING,
      branch: BRANCH_UNPUSHED,
    });
    assert.match(detail, /UNPUSHED/);
    assert.match(detail, /implementation never finished/);
  });

  it('the pushed detail names the hand-off and forbids the re-init', () => {
    const { detail } = decideRecovery({ ...EXECUTING, branch: BRANCH_PRESENT });
    assert.match(detail, /PUSHED/);
    assert.match(detail, /handed off/);
    assert.match(detail, /Do NOT re-init/);
  });

  it('the close artifacts still outrank push state', () => {
    // A pushed branch does NOT mean "run close" while a close is already
    // running against it — #4816's rows keep the first word.
    const live = decideRecovery({
      ...EXECUTING,
      branch: BRANCH_PRESENT,
      closeArtifacts: {
        envelope: null,
        envelopeMtimeMs: null,
        gateLogPath: '/tmp/gates.log',
        gateLogAgeMs: 1000,
        gateLogMtimeMs: 1,
        gateLogFresh: true,
      },
    });
    assert.equal(live.shape, 'close-in-flight');
  });

  it('the pushed shape earns the stability re-probe like its unpushed sibling', async () => {
    // Membership in TRANSIENT_SHAPES is not directly observable; pin the
    // behaviour it buys. A pushed branch with no PR is exactly the window in
    // which a close is about to open one.
    let round = 0;
    const recovery = await recoverStory({
      storyId: STORY_ID,
      cwd: '/repo',
      config: {},
      provider: {
        getTicket: async () => ({
          state: 'open',
          labels: ['agent::executing'],
          assignees: [],
        }),
      },
      gh: {
        pr: {
          list: async () => {
            round += 1;
            return round === 1 ? [] : [{ number: 9, state: 'OPEN' }];
          },
        },
      },
      // Every ref resolves, so the branch reads as pushed.
      gitSpawnFn: () => ({ status: 0, stdout: '' }),
      fsImpl: {
        readFileSync: () => {
          throw new Error('ENOENT');
        },
        statSync: () => {
          throw new Error('ENOENT');
        },
      },
      stabilityDelayMs: 0,
      sleepFn: async () => {},
    });
    assert.equal(recovery.stability.reprobed, true);
    assert.equal(recovery.shape, 'in-transition');
    assert.ok(
      recovery.evidence.includes('probe1.shape=executing-pushed-no-pr'),
    );
  });
});
