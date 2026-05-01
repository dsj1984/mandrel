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

function resolveHeadSha(cwd) {
  const res = gitSpawn(cwd, 'rev-parse', 'HEAD');
  if (res.status !== 0) return null;
  const sha = (res.stdout || '').trim();
  return sha.length > 0 ? sha : null;
}

async function main() {
  const { wrapperArgs, runnerArgs } = splitOnDashDash(process.argv.slice(2));
  const args = parseWrapperArgs(wrapperArgs);

  if (!args.scopeId || !args.gate || runnerArgs.length === 0) {
    Logger.fatal(
      'Usage: node evidence-gate.js --scope-id <id> --gate <name> [--no-evidence] -- <cmd> [args...]',
    );
  }

  const [cmd, ...cmdArgs] = runnerArgs;
  const configHash = hashCommandConfig({
    cmd,
    args: cmdArgs,
    cwd: args.cwd,
  });
  const headSha = args.useEvidence ? resolveHeadSha(args.cwd) : null;

  if (args.useEvidence && headSha) {
    const verdict = shouldSkip(
      {
        storyId: args.scopeId,
        gateName: args.gate,
        currentSha: headSha,
        configHash,
      },
      { cwd: args.cwd },
    );
    if (verdict.skip) {
      const ts = verdict.record?.timestamp ?? 'n/a';
      Logger.info(
        `[evidence-gate] ⏭ ${args.gate} skipped (evidence match: SHA=${headSha.slice(0, 7)}, recorded ${ts})`,
      );
      return;
    }
  }

  const startedAt = Date.now();
  Logger.info(`[evidence-gate] ▶ ${args.gate} → ${cmd} ${cmdArgs.join(' ')}`);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: args.cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const status = result.status ?? 1;
  if (status !== 0) {
    process.exitCode = status;
    Logger.error(`[evidence-gate] ✖ ${args.gate} failed (exit ${status})`);
    return;
  }

  Logger.info(`[evidence-gate] ✓ ${args.gate} passed`);
  if (args.useEvidence && headSha) {
    try {
      recordPass(
        {
          storyId: args.scopeId,
          gateName: args.gate,
          sha: headSha,
          configHash,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
        },
        { cwd: args.cwd },
      );
    } catch (err) {
      Logger.warn?.(
        `[evidence-gate]   ⚠ failed to record evidence: ${err?.message ?? err}`,
      );
    }
  }
}

runAsCli(import.meta.url, main, { source: 'evidence-gate' });
