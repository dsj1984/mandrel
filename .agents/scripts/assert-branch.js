#!/usr/bin/env node

/* node:coverage ignore file */

/**
 * assert-branch.js — Pre-commit Branch Guard
 *
 * Exits non-zero if the current git branch does not match `--expected`.
 * Intended to be invoked immediately before `git add`/`git commit` in any
 * workflow where multiple agents share a working directory. Prevents the
 * parallel-story contention bug where one agent's `git add` sweeps another
 * agent's WIP after a concurrent `git checkout`.
 *
 * Usage:
 *   node .agents/scripts/assert-branch.js --expected <branch-name>
 *
 * Exit codes:
 *   0 — Current branch matches expected.
 *   1 — Mismatch (stderr explains) or invocation error.
 */

import { fileURLToPath } from 'node:url';

import { PROJECT_ROOT } from './lib/config-resolver.js';
import { gitSpawn } from './lib/git-utils.js';

import { Logger } from './lib/Logger.js';
export function assertBranch(expected, { cwd = PROJECT_ROOT } = {}) {
  if (!expected || typeof expected !== 'string') {
    return { ok: false, reason: 'missing --expected <branch>' };
  }
  const result = gitSpawn(cwd, 'branch', '--show-current');
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `git branch --show-current failed: ${result.stderr}`,
    };
  }
  const actual = result.stdout;
  if (actual !== expected) {
    return {
      ok: false,
      reason: `branch mismatch — expected "${expected}", on "${actual}". Another agent may have switched the working directory. STOP: do not commit.`,
      actual,
      expected,
    };
  }
  return { ok: true, actual, expected };
}

function parseArgs(argv) {
  let expected = null;
  let cwd = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--expected' && i + 1 < argv.length) {
      expected = argv[i + 1];
      i++;
    } else if (argv[i] === '--cwd' && i + 1 < argv.length) {
      cwd = argv[i + 1];
      i++;
    }
  }
  return { expected, cwd };
}

// cli-opt-out: synchronous CLI with bespoke main-guard; runAsCli's async-main pattern doesn't fit.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { expected, cwd: flagCwd } = parseArgs(process.argv.slice(2));
  // Worktree-aware: hooks invoked inside a per-story worktree must guard the
  // worktree's HEAD, not the main checkout. Resolution precedence:
  //   --cwd <path>  >  AGENT_WORKTREE_ROOT env  >  PROJECT_ROOT (main checkout)
  // Flag wins so operators can override even when the env var leaked from a
  // parent shell.
  const cwd = flagCwd || process.env.AGENT_WORKTREE_ROOT || PROJECT_ROOT;
  const result = assertBranch(expected, { cwd });
  if (!result.ok) {
    Logger.error(`[assert-branch] ${result.reason}`);
    process.exit(1);
  }
  Logger.info(`[assert-branch] ✅ on ${result.actual}`);
}
