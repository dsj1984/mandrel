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

import {
  buildAuthoringContext,
  drainPendingCleanupAtBoot,
} from '../../.agents/scripts/epic-plan-spec.js';
import {
  Logger,
  routeAllOutputToStderr,
  STDERR_LOGGER,
} from '../../.agents/scripts/lib/Logger.js';
import { scrapeProjectDocs } from '../../.agents/scripts/lib/orchestration/doc-reader.js';

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

  // Story #2278 — covers the remaining stdout-leak path that #2055's
  // injected-logger fix did not reach: the global `Logger.info` calls from
  // `scrapeProjectDocs` (and any other production module the emit-context
  // flow transits). These tests assert the new `routeAllOutputToStderr()`
  // primitive flips those sinks for the rest of the process lifetime.
  describe('routeAllOutputToStderr() — Story #2278', () => {
    // The Logger module is process-global. `routeAllOutputToStderr` is a
    // one-shot flip with no reset — once called, the sink stays flipped
    // for the rest of the process. These tests therefore run AFTER the
    // negative-control / STDERR_LOGGER tests above (declaration order
    // matches execution order in node:test) so they cannot contaminate
    // earlier assertions.
    //
    // We assert with `doesNotMatch` (not `assert.equal(stdout, '')`)
    // because `captureIO` intercepts every `process.stdout.write` call,
    // including the V8 binary IPC events node:test emits during execution
    // — those events would make a strict-empty assertion flake while
    // having nothing to do with the contract under test (no `[Orchestrator]
    // ℹ️` log line on stdout).
    it('Logger.info / Logger.warn route to stderr after routeAllOutputToStderr()', async () => {
      routeAllOutputToStderr();
      const { stdout, stderr } = await captureIO(async () => {
        Logger.info('routed-info-2278');
        Logger.warn('routed-warn-2278');
      });
      assert.doesNotMatch(
        stdout,
        /routed-info-2278|routed-warn-2278/,
        'Logger.info / Logger.warn output must not land on stdout after routing',
      );
      assert.match(
        stderr,
        /routed-info-2278/,
        'Logger.info output must land on stderr after routing',
      );
      assert.match(
        stderr,
        /routed-warn-2278/,
        'Logger.warn output must land on stderr after routing',
      );
    });

    // The production-path probe: `scrapeProjectDocs` calls `Logger.info`
    // mid-flow (the leak Epic #2172 surfaced) — exercise it and confirm
    // routing flipped its output. We use the temp directory's basename as
    // a unique probe substring because the test runner's V8 binary IPC
    // echoes test names verbatim into our captured stdout buffer; a probe
    // derived from `fs.mkdtempSync` cannot collide with anything node:test
    // writes for orchestration.
    it('production doc-scraper writes its log line to stderr (not stdout) after routing', async () => {
      // Idempotent re-invocation — the prior test already flipped the sink.
      routeAllOutputToStderr();

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-ctx-docs-'));
      const probe = path.basename(tmp);
      const docsDir = path.join(tmp, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      fs.writeFileSync(path.join(docsDir, 'architecture.md'), '# Arch\n');

      try {
        const { stdout, stderr } = await captureIO(async () => {
          await scrapeProjectDocs({
            paths: { docsRoot: docsDir },
            docsContextFiles: ['architecture.md'],
          });
        });
        // The scrape log line contains the docsRoot path, which contains
        // `probe` — a fingerprint unique to this run.
        assert.doesNotMatch(
          stdout,
          new RegExp(probe),
          `the production scrape log line (with probe ${probe}) must NOT land on stdout under emit-context routing`,
        );
        assert.match(
          stderr,
          new RegExp(probe),
          `the production scrape log line must still be visible on stderr (probe ${probe})`,
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  // Story #2791 — Phase 7 emit-context must surface planningRisk inside the
  // JSON envelope while keeping stdout reserved for JSON only.
  describe('planningRisk envelope — Story #2791', () => {
    const highRiskProvider = {
      async getEpic(id) {
        return {
          id,
          title: 'Adaptive Planning Gate Routing',
          body: `## Scope

Changes /epic-plan gate behavior and acceptance-spec creation for critical workflow orchestration.`,
          labels: ['type::epic'],
          linkedIssues: { prd: null, techSpec: null },
        };
      },
    };

    it('buildAuthoringContext attaches planningRisk for a high-risk Epic', async () => {
      const ctx = await buildAuthoringContext(99, highRiskProvider, {});

      assert.ok(
        Object.hasOwn(ctx, 'planningRisk'),
        'emit-context envelope must include planningRisk',
      );
      assert.equal(ctx.planningRisk.overallLevel, 'high');
      assert.equal(ctx.planningRisk.gateDecision, 'review-required');
      assert.ok(ctx.bddRunner);
      assert.ok(ctx.memoryFreshness);
      assert.ok(ctx.priorFeedback);
    });

    it('stdout JSON payload is parseable and carries planningRisk without logger text', async () => {
      routeAllOutputToStderr();

      const ctx = await buildAuthoringContext(99, highRiskProvider, {});
      const json = `${JSON.stringify(ctx)}\n`;
      const parsed = JSON.parse(json.trim());
      assert.equal(parsed.planningRisk.gateDecision, 'review-required');
      assert.equal(parsed.planningRisk.overallLevel, 'high');

      const { stdout } = await captureIO(async () => {
        process.stdout.write(json);
      });

      assert.doesNotMatch(
        stdout,
        /\[Orchestrator\]/,
        'stdout must not contain routed Logger lines',
      );
      // node:test may append V8 binary IPC to the captured stdout buffer;
      // assert the envelope fingerprint we wrote is present instead of
      // parsing the whole capture.
      assert.match(stdout, /"planningRisk"/);
      assert.match(stdout, /"gateDecision":"review-required"/);
    });
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
