#!/usr/bin/env node

/**
 * story-handoff.js — the story-worker's whole post-implementation tail in one
 * command: preflight (lint + quality-preview) → merge origin/<base> → the one
 * credited run → `--seat-missing` baseline seating → push + remote-ref check
 * → held Story-scope review. Prints one JSON envelope on stdout.
 *
 * Exit 0 `ready` (hand off) · 2 `fix-required` (fix, commit, re-run; labels
 * untouched) · 1 `blocked` (flips agent::blocked + posts friction) or a usage
 * error. Idempotent: a re-run on an unchanged tree spawns no suite, seats
 * nothing, pushes nothing and recomputes no review. Never runs close, opens a
 * PR, or writes any other label.
 *
 * @see .agents/scripts/lib/orchestration/story-handoff.js
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { runStoryHandoff } from './lib/orchestration/story-handoff.js';
import { createProvider } from './lib/provider-factory.js';
import { computeStoryReviewDeposit } from './story-review-compute.js';

const USAGE = {
  invocation:
    'node .agents/scripts/story-handoff.js --story <id> [--cwd <workCwd>]',
  summary:
    "Run the story-worker's post-implementation tail — preflight, base merge, the one credited run, baseline seating, push and held review — and print one envelope: ready (exit 0), fix-required (exit 2) or blocked (exit 1).",
  flags: [
    ['--story <id>', 'Story issue number; the branch is story-<id>.'],
    ['--cwd <path>', "The Story's worktree (default: the current directory)."],
  ],
  notes: [
    'Exit codes:\n  0  ready — hand off\n  2  fix-required — fix, commit, re-run (labels untouched)\n  1  blocked — agent::blocked + friction comment, or a usage error',
  ],
};

/**
 * @param {string[]} argv
 * @returns {{ storyId: number|null, cwd: string|null }}
 */
function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      cwd: { type: 'string' },
    },
    strict: false,
  });
  const storyId = Number.parseInt(values.story ?? '', 10);
  return {
    storyId: Number.isInteger(storyId) && storyId > 0 ? storyId : null,
    cwd: values.cwd ?? null,
  };
}

/**
 * @param {string[]} [argv]
 * @param {{
 *   resolveConfigImpl?: typeof resolveConfig,
 *   runHandoffImpl?: typeof runStoryHandoff,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   cwd?: string,
 * }} [deps]
 * @returns {Promise<{ envelope: object, exitCode: number }>}
 */
export async function runStoryHandoffCli(
  argv = process.argv.slice(2),
  deps = {},
) {
  const {
    resolveConfigImpl = resolveConfig,
    runHandoffImpl = runStoryHandoff,
    stdout = process.stdout,
    stderr = process.stderr,
    cwd: defaultCwd = process.cwd(),
  } = deps;
  const { storyId, cwd } = parseArgv(argv);
  if (!storyId) {
    throw new Error(
      'story-handoff: --story <id> is required (a positive integer).',
    );
  }
  const workCwd = cwd ?? defaultCwd;
  const config = resolveConfigImpl({ cwd: workCwd });
  const outcome = await runHandoffImpl(
    { storyId, cwd: workCwd, config },
    {
      computeReview: computeStoryReviewDeposit,
      createProviderFn: createProvider,
      progress: (tag, msg) => stderr.write(`[story-handoff] [${tag}] ${msg}\n`),
    },
  );
  stdout.write(`${JSON.stringify(outcome.envelope, null, 2)}\n`);
  return outcome;
}

async function main() {
  const { exitCode } = await runStoryHandoffCli();
  return exitCode;
}

runAsCli(import.meta.url, main, {
  source: 'story-handoff',
  propagateExitCode: true,
  errorPrefix: '[story-handoff] ❌ Fatal error',
  usage: USAGE,
});
