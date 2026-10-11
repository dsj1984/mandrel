import assert from 'node:assert/strict';
import os from 'node:os';
import { describe, it } from 'node:test';

import { runCleanup } from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/cli.js';

const CWD = os.tmpdir();

/** Stub drivers that record their calls and return canned phase results. */
function stubDeps(overrides = {}) {
  const calls = [];
  const written = [];
  const deps = {
    runFastForwardPhase: async (_o, _c, base) => {
      calls.push(['fastForward', base]);
      return { ok: true, applied: false };
    },
    runPrunePhase: async () => {
      calls.push(['prune']);
      return { ok: true, pruned: [] };
    },
    runBranchPhase: async (_o, _c, base) => {
      calls.push(['branches', base]);
      return { plan: { candidates: [], skipped: [] }, result: null };
    },
    runStashPhase: async () => {
      calls.push(['stashes']);
      return { ok: true, actions: [] };
    },
    resolveConfig: () => ({ project: { baseBranch: 'trunk' } }),
    write: (text) => written.push(text),
    ...overrides,
  };
  return { deps, calls, written };
}

describe('git-cleanup runCleanup — injected active-phase runner', () => {
  it('runs every phase against the configured base and exits 2 when idle', async () => {
    const { deps, calls, written } = stubDeps();
    const { exitCode } = await runCleanup({ argv: ['--cwd', CWD], deps });
    assert.deepEqual(calls, [
      ['fastForward', 'trunk'],
      ['prune'],
      ['branches', 'trunk'],
      ['stashes'],
    ]);
    assert.equal(exitCode, 2);
    assert.deepEqual(written, []);
  });

  it('runs only the flagged phase and honours --base over config', async () => {
    const { deps, calls } = stubDeps({
      resolveConfig: () => {
        throw new Error('must not resolve config when --base is given');
      },
    });
    await runCleanup({
      argv: ['--cwd', CWD, '--branches', '--base', 'dev'],
      deps,
    });
    assert.deepEqual(calls, [['branches', 'dev']]);
  });

  it('falls back to main when config resolution throws or names no base', async () => {
    for (const resolveConfig of [
      () => {
        throw new Error('no config');
      },
      () => ({}),
    ]) {
      const { deps, calls } = stubDeps({ resolveConfig });
      await runCleanup({ argv: ['--cwd', CWD, '--fast-forward-main'], deps });
      assert.deepEqual(calls, [['fastForward', 'main']]);
    }
  });

  it('emits the JSON envelope and exits 0 when a phase did work', async () => {
    const { deps, written } = stubDeps({
      runBranchPhase: async () => ({
        plan: { candidates: [{ branch: 'fix/a' }], skipped: [] },
        result: {
          ok: true,
          worktrees: [],
          local: [],
          remote: [],
          failures: [],
        },
      }),
    });
    const { exitCode } = await runCleanup({
      argv: ['--cwd', CWD, '--branches', '--json'],
      deps,
    });
    assert.equal(exitCode, 0);
    assert.equal(written.length, 1);
    const envelope = JSON.parse(written[0]);
    assert.equal(envelope.baseBranch, 'trunk');
    assert.deepEqual(envelope.candidates, [{ branch: 'fix/a' }]);
  });

  it('emits an empty-plan envelope and exits 1 when a phase failed', async () => {
    const { deps, written } = stubDeps({
      runPrunePhase: async () => ({ ok: false, pruned: [] }),
    });
    const { exitCode } = await runCleanup({
      argv: ['--cwd', CWD, '--prune-remotes', '--json'],
      deps,
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(JSON.parse(written[0]).candidates, []);
  });

  it('writes the envelope to stdout when no writer is injected', async () => {
    const { deps } = stubDeps();
    delete deps.write;
    const captured = [];
    const original = process.stdout.write;
    process.stdout.write = (chunk) => captured.push(String(chunk));
    try {
      await runCleanup({ argv: ['--cwd', CWD, '--stashes', '--json'], deps });
    } finally {
      process.stdout.write = original;
    }
    assert.equal(JSON.parse(captured[0]).baseBranch, 'trunk');
  });

  it('defaults the working directory to the project root', async () => {
    const { deps, calls } = stubDeps();
    await runCleanup({ argv: ['--stashes'], deps });
    assert.deepEqual(calls, [['stashes']]);
  });
});
