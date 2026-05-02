#!/usr/bin/env node

/**
 * evidence-gate.js — evidence-aware wrapper around a single shell gate.
 *
 * Tech Spec #819 §"Evidence record (Story 7)" — `epic-close.md` Phase 4
 * runs `npm run lint` and `npm test` against the Epic branch before merge.
 * If the same gate has already passed against the current `git rev-parse
 * HEAD` (recorded earlier in the local hot path), this wrapper logs a skip
 * and exits 0 instead of re-spawning the runner. On run, a successful
 * gate is recorded so the next invocation can skip in turn.
 *
 * Usage:
 *   node .agents/scripts/evidence-gate.js \
 *     --scope-id <storyOrEpicId> --gate <name> [--no-evidence] -- <cmd> [args...]
 *
 * Examples:
 *   node .agents/scripts/evidence-gate.js --scope-id 817 --gate lint -- npm run lint
 *   node .agents/scripts/evidence-gate.js --scope-id 817 --gate test -- npm test
 *
 * Exit codes:
 *   0 — gate passed (or skipped via evidence)
 *   N — gate failed (passes through the runner's exit code)
 *
 * `--no-evidence` forces the runner regardless of recorded state. The
 * `temp/validation-evidence-<scope-id>.json` file is gitignored — evidence
 * is a perf optimization, not a trust boundary; pre-push hooks and CI
 * continue to verify independently.
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT } from './lib/config-resolver.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import {
  hashCommandConfig,
  recordPass,
  shouldSkip,
} from './lib/validation-evidence.js';

/**
 * Split argv at the first `--` and return both halves. The wrapper consumes
 * everything before `--`; the runner receives everything after.
 *
 * Exported for testing.
 */
export function splitOnDashDash(argv) {
  const idx = argv.indexOf('--');
  if (idx === -1) return { wrapperArgs: argv, runnerArgs: [] };
  return {
    wrapperArgs: argv.slice(0, idx),
    runnerArgs: argv.slice(idx + 1),
  };
}

/**
 * Parse the wrapper-side argv (before `--`).
 *
 * Exported for testing.
 */
export function parseWrapperArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'scope-id': { type: 'string' },
      gate: { type: 'string' },
      'no-evidence': { type: 'boolean', default: false },
      cwd: { type: 'string' },
    },
    strict: false,
  });
  const scopeId = Number.parseInt(values['scope-id'] ?? '', 10);
  return {
    scopeId: Number.isNaN(scopeId) || scopeId <= 0 ? null : scopeId,
    gate: values.gate ?? null,
    useEvidence: values['no-evidence'] !== true,
    cwd: values.cwd ?? PROJECT_ROOT,
  };
}

function resolveHeadShaDefault(cwd, gitSpawnFn) {
  const res = gitSpawnFn(cwd, 'rev-parse', 'HEAD');
  if (res.status !== 0) return null;
  const sha = (res.stdout || '').trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Runner-shaped entry-point: takes the parsed wrapper args + runner args and
 * executes the gate. Pure-ish (modulo IO) — all side-effects are routed via
 * the injection hooks so tests can stub `gitSpawn`, `spawnSync`, and the
 * evidence store without touching disk or spawning processes.
 *
 * Exported for tests + the CLI `main()`.
 *
 * @param {object} params
 * @param {number}   params.scopeId      — Story / Epic ID (positive integer).
 * @param {string}   params.gate         — Logical gate name (`lint`, `test`, …).
 * @param {boolean}  params.useEvidence  — When false, force the runner.
 * @param {string}   params.cwd          — Working directory passed to spawn.
 * @param {string[]} params.runnerArgs   — `[cmd, ...args]` from after `--`.
 * @param {object}   [deps]              — Optional injection hooks (tests).
 * @param {Function} [deps.gitSpawnFn]   — Stub for `gitSpawn`.
 * @param {Function} [deps.spawnFn]      — Stub for `spawnSync`.
 * @param {Function} [deps.shouldSkipFn] — Stub for `shouldSkip`.
 * @param {Function} [deps.recordPassFn] — Stub for `recordPass`.
 * @param {object}   [deps.logger]       — Logger-shaped object (info/error/warn/fatal).
 * @returns {{ status: number, skipped: boolean }} Outcome summary. `status`
 *   is the runner's exit code (0 = pass), `skipped` is true when evidence
 *   short-circuited the runner.
 */
export async function runEvidenceGate(params, deps = {}) {
  const {
    gitSpawnFn = gitSpawn,
    spawnFn = spawnSync,
    shouldSkipFn = shouldSkip,
    recordPassFn = recordPass,
    logger = Logger,
  } = deps;
  const { scopeId, gate, useEvidence, cwd, runnerArgs } = params ?? {};

  if (!scopeId || !gate || !runnerArgs || runnerArgs.length === 0) {
    logger.fatal(
      'Usage: node evidence-gate.js --scope-id <id> --gate <name> [--no-evidence] -- <cmd> [args...]',
    );
    return { status: 1, skipped: false };
  }

  const [cmd, ...cmdArgs] = runnerArgs;
  const configHash = hashCommandConfig({ cmd, args: cmdArgs, cwd });
  const headSha = useEvidence ? resolveHeadShaDefault(cwd, gitSpawnFn) : null;

  if (useEvidence && headSha) {
    const verdict = shouldSkipFn(
      {
        storyId: scopeId,
        gateName: gate,
        currentSha: headSha,
        configHash,
      },
      { cwd },
    );
    if (verdict.skip) {
      const ts = verdict.record?.timestamp ?? 'n/a';
      logger.info(
        `[evidence-gate] ⏭ ${gate} skipped (evidence match: SHA=${headSha.slice(0, 7)}, recorded ${ts})`,
      );
      return { status: 0, skipped: true };
    }
  }

  const startedAt = Date.now();
  logger.info(`[evidence-gate] ▶ ${gate} → ${cmd} ${cmdArgs.join(' ')}`);
  const result = spawnFn(cmd, cmdArgs, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const status = result.status ?? 1;
  if (status !== 0) {
    process.exitCode = status;
    logger.error(`[evidence-gate] ✖ ${gate} failed (exit ${status})`);
    return { status, skipped: false };
  }

  logger.info(`[evidence-gate] ✓ ${gate} passed`);
  if (useEvidence && headSha) {
    try {
      recordPassFn(
        {
          storyId: scopeId,
          gateName: gate,
          sha: headSha,
          configHash,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
        },
        { cwd },
      );
    } catch (err) {
      logger.warn?.(
        `[evidence-gate]   ⚠ failed to record evidence: ${err?.message ?? err}`,
      );
    }
  }
  return { status: 0, skipped: false };
}

async function main() {
  const { wrapperArgs, runnerArgs } = splitOnDashDash(process.argv.slice(2));
  const args = parseWrapperArgs(wrapperArgs);
  await runEvidenceGate({ ...args, runnerArgs });
}

runAsCli(import.meta.url, main, { source: 'evidence-gate' });
