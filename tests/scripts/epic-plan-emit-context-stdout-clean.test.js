/**
 * tests/scripts/epic-plan-emit-context-stdout-clean.test.js — Story #2055
 *
 * Contract: when `epic-plan-spec.js` / `epic-plan-decompose.js` boot in
 * `--emit-context` mode, stdout is reserved for the JSON envelope. Every
 * worktree-sweep / pending-cleanup drain log line must arrive on stderr so
 * the captured file is unconditionally parseable as JSON by downstream
 * skills (no `tail -n +N` workarounds required).
 *
 * The two scripts share the same `drainPendingCleanupAtBoot` wrapper plus
 * the `sweepStaleStoryWorktrees` callee under it; both honour the optional
 * `logger` argument. Exercising the wrapper with the production wiring is
 * sufficient to lock the contract — the CLI `main()` paths in both scripts
 * now compute `emitContext` once and forward `STDERR_LOGGER` into this
 * same entry point.
 *
 * Negative control: invoking the wrapper with the legacy default (`console`)
 * proves the bug exists today — the `[epic-plan-spec] worktree sweep:
 * reaped=…` summary line lands on stdout via `console.info`. The positive
 * test then proves that swapping to `STDERR_LOGGER` removes every stdout
 * write while keeping the same log line visible on stderr.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { drainPendingCleanupAtBoot } from '../../.agents/scripts/epic-plan-spec.js';
import { STDERR_LOGGER } from '../../.agents/scripts/lib/Logger.js';

function tmpRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-ctx-stdout-'));
  fs.mkdirSync(path.join(tmp, '.worktrees'), { recursive: true });
  return tmp;
}

function stubGitEmptyWorktreeList() {
  return {
    gitSpawn: (_cwd, ...args) => {
      // `git worktree list --porcelain` returns an empty list (no
      // registered worktrees → sweep emits its summary line with reaped=0).
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      // `git worktree prune` at the end of the sweep — no-op.
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

function stubProviderWithGetTicket() {
  return {
    getTicket: async () => null,
  };
}

/**
 * Capture every byte that would have been written to a stdio stream's
 * write surface during `fn`. Hooks both `console.log`/`console.info`/etc.
 * and the underlying `process.stdout.write` / `process.stderr.write` so a
 * caller using either channel is intercepted.
 */
async function captureIO(fn) {
  const stdout = [];
  const stderr = [];

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origConsoleLog = console.log;
  const origConsoleInfo = console.info;
  const origConsoleWarn = console.warn;
  const origConsoleError = console.error;
  const origConsoleDebug = console.debug;

  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  console.log = (...args) => stdout.push(`${args.join(' ')}\n`);
  console.info = (...args) => stdout.push(`${args.join(' ')}\n`);
  console.warn = (...args) => stderr.push(`${args.join(' ')}\n`);
  console.error = (...args) => stderr.push(`${args.join(' ')}\n`);
  console.debug = (...args) => stderr.push(`${args.join(' ')}\n`);

  try {
    await fn();
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origConsoleLog;
    console.info = origConsoleInfo;
    console.warn = origConsoleWarn;
    console.error = origConsoleError;
    console.debug = origConsoleDebug;
  }

  return { stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('epic-plan --emit-context: stdout is reserved for JSON', () => {
  it("NEGATIVE CONTROL: default logger leaks sweep summary to stdout (today's bug)", async () => {
    const repoRoot = tmpRepo();
    try {
      const { stdout } = await captureIO(async () => {
        await drainPendingCleanupAtBoot({
          repoRoot,
          orchestration: undefined,
          provider: stubProviderWithGetTicket(),
          git: stubGitEmptyWorktreeList(),
        });
      });
      assert.match(
        stdout,
        /worktree sweep:/i,
        'default logger (console.info) writes the sweep summary to stdout — this is the bug Story #2055 fixes',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('STDERR_LOGGER routes the sweep summary off stdout entirely', async () => {
    const repoRoot = tmpRepo();
    try {
      const { stdout, stderr } = await captureIO(async () => {
        await drainPendingCleanupAtBoot({
          repoRoot,
          orchestration: undefined,
          provider: stubProviderWithGetTicket(),
          git: stubGitEmptyWorktreeList(),
          logger: STDERR_LOGGER,
        });
      });
      assert.equal(
        stdout,
        '',
        `stdout must be empty under STDERR_LOGGER; got: ${JSON.stringify(stdout)}`,
      );
      assert.match(
        stderr,
        /worktree sweep:/i,
        'sweep summary is still visible — just on stderr where the operator can see it',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('STDERR_LOGGER preserves the legacy result shape (drained/persistent/remaining)', async () => {
    const repoRoot = tmpRepo();
    try {
      const result = await drainPendingCleanupAtBoot({
        repoRoot,
        orchestration: undefined,
        provider: stubProviderWithGetTicket(),
        git: stubGitEmptyWorktreeList(),
        logger: STDERR_LOGGER,
      });
      assert.ok('drained' in result, 'result has drained alias');
      assert.ok('persistent' in result, 'result has persistent alias');
      assert.equal(typeof result.remaining, 'number', 'remaining is numeric');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
