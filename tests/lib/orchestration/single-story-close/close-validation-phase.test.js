import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { runCloseValidationPhase } from '../../../../.agents/scripts/lib/orchestration/single-story-close/phases/close-validation.js';

/**
 * Story #4250 — standalone close-validation phase.
 *
 * Two contracts:
 *   1. The phase passes `standalone: true` (not `epicId: null`) into
 *      `runCloseValidation`, so the storyId-anchored evidence keyspace is
 *      consulted instead of the structurally-disabled Epic-keyed path.
 *   2. The phase runs `runScopedFormatAutofix` (with `baseBranch` as the diff
 *      anchor and the worktree as the commit target) BEFORE the gate chain.
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
    tmpDir = nodeFs.mkdtempSync(path.join(nodeOs.tmpdir(), 'close-gate-out-'));
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
        config: {},
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
      'temp',
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
