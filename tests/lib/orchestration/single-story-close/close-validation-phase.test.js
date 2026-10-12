import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { runCloseValidationPhase } from '../../../../.agents/scripts/lib/orchestration/single-story-close/phases/close-validation.js';
import { makeTempDir } from '../../../../.agents/scripts/lib/test-temp.js';

/**
 * Story #4250 — standalone close-validation phase.
 *
 * Two contracts:
 *   1. The phase passes `standalone: true` (not `epicId: null`) into
 *      `runCloseValidation`, so the storyId-anchored evidence keyspace is
 *      consulted instead of the structurally-disabled Epic-keyed path.
 *   2. The phase runs `runScopedFormatAutofix` (with `baseBranch` as the diff
 *      anchor and the worktree as the commit target) BEFORE the gate chain.
 *
 * Story #5224 adds a third: the upward baseline write-back runs alongside the
 * format self-heal, ahead of the gates, on the same branch pair and worktree —
 * and, like the self-heal, can never fail the close.
 */

function noopProgress() {}

describe('runCloseValidationPhase — standalone parity (Story #4250)', () => {
  it('passes standalone:true into runCloseValidation (not epicId)', async () => {
    let observed = null;
    await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-4250',
      config: {},
      baseBranch: 'main',
      storyBranch: 'story-4250',
      storyId: 4250,
      progress: noopProgress,
      runCloseValidation: (opts) => {
        observed = opts;
        return { ok: true, failed: [], skipped: [] };
      },
      buildDefaultGates: () => [
        { name: 'lint', cmd: 'npm', args: ['run', 'lint'] },
      ],
      runBaselineUpwardWriteback: () => ({
        ran: false,
        committed: false,
        reason: 'stub',
      }),
      runScopedFormatAutofix: () => ({ ran: false, committed: false }),
    });
    assert.equal(observed.standalone, true);
    assert.equal(observed.storyId, 4250);
    // The phase must NOT thread a positive/zero epicId into the Epic path.
    assert.ok(
      observed.epicId == null,
      'standalone phase must not feed an epicId into runCloseValidation',
    );
  });

  it('runs scoped format-autofix before validation with baseBranch as the diff anchor', async () => {
    const order = [];
    const autofixArgs = [];
    await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-4250',
      config: {},
      baseBranch: 'main',
      storyBranch: 'story-4250',
      storyId: 4250,
      progress: noopProgress,
      runCloseValidation: () => {
        order.push('validate');
        return { ok: true, failed: [], skipped: [] };
      },
      buildDefaultGates: () => [],
      runBaselineUpwardWriteback: () => ({
        ran: false,
        committed: false,
        reason: 'stub',
      }),
      runScopedFormatAutofix: (args) => {
        order.push('autofix');
        autofixArgs.push(args);
        return { ran: true, committed: false };
      },
    });
    assert.deepEqual(
      order,
      ['autofix', 'validate'],
      'format-autofix must run before the gate chain',
    );
    assert.equal(autofixArgs[0].baseBranch, 'main');
    assert.equal(autofixArgs[0].storyBranch, 'story-4250');
    assert.equal(
      autofixArgs[0].worktreePath,
      '/main/repo/.worktrees/story-4250',
      'autofix must target the Story worktree',
    );
  });

  it('skips scoped format-autofix when no storyBranch is supplied', async () => {
    let autofixCalled = false;
    await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: null,
      config: {},
      baseBranch: 'main',
      storyBranch: undefined,
      storyId: 4250,
      progress: noopProgress,
      runCloseValidation: () => ({ ok: true, failed: [], skipped: [] }),
      buildDefaultGates: () => [],
      runBaselineUpwardWriteback: () => ({
        ran: false,
        committed: false,
        reason: 'stub',
      }),
      runScopedFormatAutofix: () => {
        autofixCalled = true;
        return { ran: false, committed: false };
      },
    });
    assert.equal(
      autofixCalled,
      false,
      'autofix must be skipped without a story branch',
    );
  });

  it('swallows a format-autofix throw (best-effort self-heal) and still validates', async () => {
    let validated = false;
    await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-4250',
      config: {},
      baseBranch: 'main',
      storyBranch: 'story-4250',
      storyId: 4250,
      progress: noopProgress,
      runCloseValidation: () => {
        validated = true;
        return { ok: true, failed: [], skipped: [] };
      },
      buildDefaultGates: () => [],
      runBaselineUpwardWriteback: () => ({
        ran: false,
        committed: false,
        reason: 'stub',
      }),
      runScopedFormatAutofix: () => {
        throw new Error('git diff failed: missing ref');
      },
    });
    assert.equal(
      validated,
      true,
      'a format-autofix throw must not abort the close-validation phase',
    );
  });

  it('throws on a failed gate with the gate name and hint', async () => {
    await assert.rejects(
      () =>
        runCloseValidationPhase({
          cwd: '/main/repo',
          worktreePath: '/main/repo/.worktrees/story-4250',
          config: {},
          baseBranch: 'main',
          storyBranch: 'story-4250',
          storyId: 4250,
          progress: noopProgress,
          runCloseValidation: () => ({
            ok: false,
            failed: [
              {
                gate: { name: 'lint', hint: 'fix lint' },
                status: 2,
                cwd: '/main/repo/.worktrees/story-4250',
              },
            ],
            skipped: [],
          }),
          buildDefaultGates: () => [],
          runBaselineUpwardWriteback: () => ({
            ran: false,
            committed: false,
            reason: 'stub',
          }),
          runScopedFormatAutofix: () => ({ ran: false, committed: false }),
        }),
      (err) =>
        err instanceof Error &&
        err.message.includes('lint') &&
        err.message.includes('fix lint'),
    );
  });
});

/**
 * Story #5377 — a full-suite lock wait inside the gate chain. Only a gate that
 * reported the defer exit AND a wait that announced its expiry is a pending
 * close; either half alone is an ordinary gate failure.
 */
describe('runCloseValidationPhase — full-suite lock waits (Story #5377)', () => {
  const phaseWith = (runCloseValidation) =>
    runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: null,
      config: {},
      baseBranch: 'main',
      storyId: 5377,
      progress: noopProgress,
      runCloseValidation,
      buildDefaultGates: () => [{ name: 'coverage-capture' }],
      runPreGateSteps: async () => {},
    });

  it('a defer exit with no expired wait is still a gate failure', async () => {
    await assert.rejects(
      phaseWith(async () => ({
        ok: false,
        failed: [{ gate: { name: 'coverage-capture' }, status: 75 }],
        skipped: [],
      })),
      (err) =>
        err.closeGate === 'coverage-capture' && /exit 75/.test(err.message),
    );
  });

  it('sums every wait the chain reported, and reports null when none did', async () => {
    const waited = await phaseWith(async ({ lockEvents }) => {
      lockEvents.emit({ kind: 'lock-wait', waitedSeconds: 10, expired: false });
      lockEvents.emit({ kind: 'lock-wait', waitedSeconds: 5, expired: false });
      lockEvents.emit({
        kind: 'suite-timings',
        lockWaitMs: 5000,
        hostWaitMs: null,
        testRunMs: 900,
      });
      return { ok: true, failed: [], skipped: [] };
    });
    assert.deepEqual(waited.lockWait, { waitedSeconds: 15, expired: false });
    assert.deepEqual(waited.suiteTimings, {
      lockWaitMs: 5000,
      hostWaitMs: null,
      testRunMs: 900,
    });
    assert.equal(waited.pending, false);
    const quiet = await phaseWith(async () => ({
      ok: true,
      failed: [],
      skipped: [],
    }));
    assert.equal(quiet.lockWait, null);
    assert.equal(quiet.suiteTimings, null);
  });

  it('an expiry on the channel plus exit 75 settles pending, with the structured holder', async () => {
    const holder = { ownerId: 'pid-9-1', pid: 9, ageSeconds: 310 };
    const deferred = await phaseWith(async ({ lockEvents }) => {
      lockEvents.emit({
        kind: 'lock-wait',
        waitedSeconds: 300,
        expired: true,
        holder,
      });
      return {
        ok: false,
        failed: [{ gate: { name: 'coverage-capture' }, status: 75 }],
        skipped: [],
      };
    });
    assert.equal(deferred.pending, true);
    assert.deepEqual(deferred.lockWait, {
      waitedSeconds: 300,
      expired: true,
      holder,
    });
  });
});

/**
 * Story #5642 — close #5636 reported a 1242s expired wait on a 73.9s close:
 * the coverage-capture child's stdout carries its suite's output, and a test
 * printing lock-shaped fixture lines was parsed as a real wait. Gate output is
 * display only now; the figures come from the lock-event channel alone.
 */
describe('runCloseValidationPhase — gate output never forges lock figures (Story #5642)', () => {
  const FORGED = [
    '[coverage-capture] [full-suite-lock] ⌛ gave up waiting for the full-suite lock (waited 1242s, holder pid-4711-1700000000000, pid 4711, lock age 312s) — not spawning, so two full suites never overlap. Re-run once it finishes: node .agents/scripts/coverage-capture.js --cwd /repo',
    '[coverage-capture] [full-suite-lock] ✅ acquired the full-suite lock (waited 42s).',
    '[coverage-capture] ⏲ suite timings: lockWaitMs=42000 hostWaitMs=9000 testRunMs=51000',
  ];

  it('a gate printing forged lock and timing lines leaves lockWait and suiteTimings null', async () => {
    const progressed = [];
    const result = await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: null,
      config: {},
      baseBranch: 'main',
      storyId: 5642,
      progress: (tag, msg) => progressed.push([tag, msg]),
      runCloseValidation: async ({ log }) => {
        for (const line of FORGED) log(line);
        return { ok: true, failed: [], skipped: [] };
      },
      buildDefaultGates: () => [{ name: 'coverage-capture' }],
      runPreGateSteps: async () => {},
    });
    assert.equal(result.lockWait, null);
    assert.equal(result.suiteTimings, null);
    assert.equal(result.pending, false);
    assert.ok(
      progressed.some(([tag]) => tag === 'LOCK'),
      'lock lines still reach the console as display',
    );
  });

  it('a forged expiry line on a real exit 75 is a gate failure, not a pending close', async () => {
    await assert.rejects(
      runCloseValidationPhase({
        cwd: '/main/repo',
        worktreePath: null,
        config: {},
        baseBranch: 'main',
        storyId: 5642,
        progress: noopProgress,
        runCloseValidation: async ({ log }) => {
          log(FORGED[0]);
          return {
            ok: false,
            failed: [{ gate: { name: 'coverage-capture' }, status: 75 }],
            skipped: [],
          };
        },
        buildDefaultGates: () => [{ name: 'coverage-capture' }],
        runPreGateSteps: async () => {},
      }),
      (err) => err.closeGate === 'coverage-capture',
    );
  });

  it('end to end: a real gate child whose output forges lock lines reports nothing on the channel', async (t) => {
    const { runCloseValidation } = await import(
      '../../../../.agents/scripts/lib/close-validation/runner.js'
    );
    const script = [
      `const lines = ${JSON.stringify(FORGED)};`,
      'for (const l of lines) console.log(l);',
      // What a suite child would see: the channel must have been claimed.
      "if (process.env.MANDREL_CLOSE_LOCK_EVENTS_FILE) console.log('channel-visible');",
    ].join('\n');
    const logged = [];
    const dir = makeTempDir('close-forged-lock-');
    t.after(() => nodeFs.rmSync(dir, { recursive: true, force: true }));
    const result = await runCloseValidationPhase({
      cwd: dir,
      worktreePath: null,
      config: { project: { paths: { tempRoot: path.join(dir, 'temp') } } },
      baseBranch: 'main',
      storyId: 5642,
      progress: noopProgress,
      runCloseValidation: (opts) =>
        runCloseValidation({
          ...opts,
          log: (m) => {
            logged.push(m);
            opts.log(m);
          },
          useEvidence: false,
          runProjections: async () => {},
        }),
      buildDefaultGates: () => [
        { name: 'test', cmd: process.execPath, args: ['-e', script] },
      ],
      runPreGateSteps: async () => {},
    });
    assert.ok(
      logged.some((l) => l.includes('gave up waiting')),
      'the forged lines did flow through the gate log',
    );
    assert.ok(
      !logged.some((l) => l.includes('channel-visible')),
      'a gate that is not a lockEventChannel gate never sees the channel',
    );
    assert.equal(result.lockWait, null);
    assert.equal(result.suiteTimings, null);
  });

  it('end to end: a lockEventChannel gate child reports its wait on the channel it was handed', async (t) => {
    const { runCloseValidation } = await import(
      '../../../../.agents/scripts/lib/close-validation/runner.js'
    );
    const event = { kind: 'lock-wait', waitedSeconds: 7, expired: false };
    const script = [
      "const fs = require('node:fs');",
      `fs.appendFileSync(process.env.MANDREL_CLOSE_LOCK_EVENTS_FILE, ${JSON.stringify(`${JSON.stringify(event)}\n`)});`,
    ].join('\n');
    const dir = makeTempDir('close-channel-gate-');
    t.after(() => nodeFs.rmSync(dir, { recursive: true, force: true }));
    const result = await runCloseValidationPhase({
      cwd: dir,
      worktreePath: null,
      config: { project: { paths: { tempRoot: path.join(dir, 'temp') } } },
      baseBranch: 'main',
      storyId: 5642,
      progress: noopProgress,
      runCloseValidation: (opts) =>
        runCloseValidation({
          ...opts,
          useEvidence: false,
          runProjections: async () => {},
        }),
      buildDefaultGates: () => [
        {
          name: 'coverage-capture',
          cmd: process.execPath,
          args: ['-e', script],
          lockEventChannel: true,
        },
      ],
      runPreGateSteps: async () => {},
    });
    assert.deepEqual(result.lockWait, { waitedSeconds: 7, expired: false });
  });
});

/**
 * Story #4736 — the success path's stdout bound.
 *
 * A passing `npm test` alone used to put ~50KB of gate output on the invoking
 * agent's stdout, past the host's inline tool-result ceiling: the caller got a
 * truncated preview, read the persisted file anyway, and re-ran close for a
 * clean envelope. These tests pin the fix at the real wiring — no injected
 * sink, so a future change that routes gate output back to `Logger.info`
 * fails here.
 */
describe('runCloseValidationPhase — bounded gate output (Story #4736)', () => {
  const GATE_LINE = `[test] ${'x'.repeat(120)}`;
  const GATE_LINES = 2_000;
  const STDOUT_BOUND_BYTES = 2048;

  let tmpDir;
  let stdout;
  let realLog;

  before(() => {
    tmpDir = makeTempDir('close-gate-out-');
  });

  after(() => {
    if (realLog) console.log = realLog;
    nodeFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Run the phase with a validation stub that streams `GATE_LINES` fat lines
   * through the phase's own `log` seam, capturing everything the default
   * Logger routes to stdout.
   */
  async function runCapturing({ ok }) {
    stdout = [];
    realLog = console.log;
    console.log = (m) => stdout.push(String(m));
    try {
      const args = {
        cwd: tmpDir,
        worktreePath: null,
        // Story #4794 — an absolute, non-default tempRoot. The gate sink used
        // to join a hardcoded `temp` onto `cwd`; it now resolves the configured
        // root, so pinning a relocated one here proves the artifact follows the
        // config rather than the working directory.
        config: {
          project: { paths: { tempRoot: path.join(tmpDir, 'relocated-temp') } },
        },
        baseBranch: 'main',
        storyBranch: 'story-4736',
        storyId: 4736,
        progress: () => {},
        runCloseValidation: ({ log }) => {
          for (let i = 0; i < GATE_LINES; i += 1) log(`${GATE_LINE} ${i}`);
          return ok
            ? { ok: true, failed: [], skipped: [] }
            : {
                ok: false,
                failed: [
                  {
                    gate: { name: 'test', hint: 'fix it' },
                    status: 1,
                    cwd: tmpDir,
                  },
                ],
                skipped: [],
              };
        },
        buildDefaultGates: () => [],
        runBaselineUpwardWriteback: () => ({
          ran: false,
          committed: false,
          reason: 'stub',
        }),
        runScopedFormatAutofix: () => ({ ran: false, committed: false }),
      };
      if (ok) await runCloseValidationPhase(args);
      else await assert.rejects(() => runCloseValidationPhase(args));
    } finally {
      console.log = realLog;
      realLog = null;
    }
    return stdout.join('\n');
  }

  it('keeps a successful close under ~2KB of stdout and persists the full output (AC-3)', async () => {
    const captured = await runCapturing({ ok: true });
    const bytes = Buffer.byteLength(captured, 'utf8');

    assert.ok(
      bytes <= STDOUT_BOUND_BYTES,
      `a successful close must emit ≤ ~${STDOUT_BOUND_BYTES}B to stdout (was ${bytes}B): ${captured.slice(0, 400)}`,
    );
    assert.ok(
      !captured.includes(GATE_LINE),
      'no raw gate line may reach stdout on the success path',
    );

    const artifact = path.join(
      tmpDir,
      'relocated-temp',
      'orchestration',
      'close-gates-4736.log',
    );
    const written = nodeFs.readFileSync(artifact, 'utf8');
    assert.equal(
      written.split('\n').filter(Boolean).length,
      GATE_LINES,
      'every gate line must survive in the artifact under the temp tree',
    );
  });

  it('replays gate evidence inline when a gate fails (AC-4)', async () => {
    const captured = await runCapturing({ ok: false });

    assert.ok(
      captured.includes(GATE_LINE),
      'a failed close must put the gate evidence back in front of the caller',
    );
    assert.ok(
      Buffer.byteLength(captured, 'utf8') > STDOUT_BOUND_BYTES,
      'the size bound is deliberately success-path-only — the diagnostic tail is not truncated to fit it',
    );
  });
});

describe('runCloseValidationPhase — upward baseline write-back (Story #5224)', () => {
  it('runs the write-back before the gate chain, on the story worktree', async () => {
    const order = [];
    const seen = [];
    await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-5224',
      config: { marker: 'resolved-config' },
      baseBranch: 'main',
      storyBranch: 'story-5224',
      storyId: 5224,
      progress: noopProgress,
      runCloseValidation: () => {
        order.push('validate');
        return { ok: true, failed: [], skipped: [] };
      },
      buildDefaultGates: () => [],
      runScopedFormatAutofix: () => {
        order.push('autofix');
        return { ran: false, committed: false };
      },
      runBaselineUpwardWriteback: (args) => {
        order.push('writeback');
        seen.push(args);
        return {
          ran: true,
          committed: true,
          sha: 'abc1234',
          improvedPaths: [],
        };
      },
    });
    assert.deepEqual(
      order,
      ['autofix', 'writeback', 'validate'],
      'the write-back must land its commit before the gates score the tree',
    );
    assert.equal(seen[0].baseBranch, 'main');
    assert.equal(seen[0].storyBranch, 'story-5224');
    assert.equal(seen[0].worktreePath, '/main/repo/.worktrees/story-5224');
    assert.equal(seen[0].config.marker, 'resolved-config');
  });

  it('swallows a write-back throw — check-baselines stays authoritative', async () => {
    let validated = false;
    await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-5224',
      config: {},
      baseBranch: 'main',
      storyBranch: 'story-5224',
      storyId: 5224,
      progress: noopProgress,
      runCloseValidation: () => {
        validated = true;
        return { ok: true, failed: [], skipped: [] };
      },
      buildDefaultGates: () => [],
      runScopedFormatAutofix: () => ({ ran: false, committed: false }),
      runBaselineUpwardWriteback: () => {
        throw new Error('scorer exploded');
      },
    });
    assert.equal(
      validated,
      true,
      'a write-back throw must not abort the close-validation phase',
    );
  });

  it('skips the write-back when no storyBranch is supplied', async () => {
    let called = false;
    await runCloseValidationPhase({
      cwd: '/main/repo',
      worktreePath: null,
      config: {},
      baseBranch: 'main',
      storyBranch: undefined,
      storyId: 5224,
      progress: noopProgress,
      runCloseValidation: () => ({ ok: true, failed: [], skipped: [] }),
      buildDefaultGates: () => [],
      runScopedFormatAutofix: () => ({ ran: false, committed: false }),
      runBaselineUpwardWriteback: () => {
        called = true;
        return { ran: false, committed: false };
      },
    });
    assert.equal(
      called,
      false,
      'without a story branch there is no branch to commit a refreshed row on',
    );
  });
});
