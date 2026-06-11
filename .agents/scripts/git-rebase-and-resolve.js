#!/usr/bin/env node
/* node:coverage ignore file -- rebase CLI; conflict-resolution heuristics over real git state, testing would assert only the mock structure */

/**
 * git-rebase-and-resolve.js — Rebase pipeline for `/git-merge-pr` Step 2.5.
 *
 * `/git-merge-pr` previously embedded the rebase retry loop as prose in
 * markdown: "rebase onto base → if conflicts, follow the template → stage and
 * continue → force-push". That works right up until the LLM forgets one of
 * the steps (the force-push with `--force-with-lease`, the abort on
 * cascading conflicts, the continue after each resolved batch).
 *
 * This script runs the rebase, reports the outcome in structured form, and
 * — when a conflict stops the rebase — leaves the working tree in the
 * conflicted state so the caller can apply manual resolutions and invoke
 * `--continue` (delegating back to git's native flow rather than trying to
 * automate conflict merging, which is a problem for judgment not scripting).
 *
 * Usage:
 *   node .agents/scripts/git-rebase-and-resolve.js --onto <base> [--head <branch>] [--continue] [--abort] [--json]
 *
 * Modes:
 *   (default)     — `git fetch origin`, checkout head, `git rebase <onto>`.
 *   --continue    — `git rebase --continue` after resolutions are staged.
 *   --abort       — `git rebase --abort` to bail cleanly.
 *
 * Output (always JSON when --json, otherwise human-readable):
 *   {
 *     outcome: 'clean' | 'conflict' | 'aborted' | 'continued',
 *     head, onto,
 *     conflictedFiles: [...],
 *     stderr: "...",
 *   }
 *
 * Exit codes:
 *   0 — clean rebase or continue that completed.
 *   1 — conflict state (caller must resolve then invoke --continue).
 *   2 — usage / git error.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { PROJECT_ROOT } from './lib/project-root.js';

function currentBranch(cwd) {
  const res = gitSpawn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  return res.status === 0 ? res.stdout.trim() : null;
}

function listConflictedFiles(cwd) {
  const res = gitSpawn(cwd, 'diff', '--name-only', '--diff-filter=U');
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Perform a rebase and classify the outcome. Pure seam: callers inject a
 * `git` runner for tests.
 *
 * @param {{
 *   onto: string,
 *   head?: string,
 *   cwd?: string,
 *   git?: { spawn: (cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string } },
 * }} opts
 */
export function runRebase({
  onto,
  head,
  cwd = PROJECT_ROOT,
  git = { spawn: gitSpawn },
}) {
  if (!onto) throw new Error('[rebase] --onto is required.');

  const fetch = git.spawn(cwd, 'fetch', 'origin');
  if (fetch.status !== 0) {
    return {
      outcome: 'error',
      head: head ?? null,
      onto,
      conflictedFiles: [],
      stderr: fetch.stderr ?? '',
    };
  }

  if (head) {
    const checkout = git.spawn(cwd, 'checkout', head);
    if (checkout.status !== 0) {
      return {
        outcome: 'error',
        head,
        onto,
        conflictedFiles: [],
        stderr: checkout.stderr ?? '',
      };
    }
    git.spawn(cwd, 'pull', 'origin', head);
  }

  const rebase = git.spawn(cwd, 'rebase', onto);
  if (rebase.status === 0) {
    return {
      outcome: 'clean',
      head: head ?? currentBranch(cwd),
      onto,
      conflictedFiles: [],
      stderr: '',
    };
  }

  // Non-zero exit: likely conflict. Enumerate the unmerged files so the caller
  // can route to the conflict-template procedure.
  const conflicted = listConflictedFiles(cwd);
  return {
    outcome: conflicted.length > 0 ? 'conflict' : 'error',
    head: head ?? currentBranch(cwd),
    onto,
    conflictedFiles: conflicted,
    stderr: rebase.stderr ?? '',
  };
}

export function continueRebase({
  cwd = PROJECT_ROOT,
  git = { spawn: gitSpawn },
}) {
  const res = git.spawn(cwd, 'rebase', '--continue');
  if (res.status === 0) {
    return { outcome: 'continued', conflictedFiles: [], stderr: '' };
  }
  return {
    outcome: 'conflict',
    conflictedFiles: listConflictedFiles(cwd),
    stderr: res.stderr ?? '',
  };
}

export function abortRebase({ cwd = PROJECT_ROOT, git = { spawn: gitSpawn } }) {
  const res = git.spawn(cwd, 'rebase', '--abort');
  return {
    outcome: res.status === 0 ? 'aborted' : 'error',
    stderr: res.stderr ?? '',
  };
}

/**
 * Pure: parse argv into the normalized rebase-action option bag.
 *
 * @param {string[]} argv
 * @returns {{ onto?: string, head?: string, continueFlag: boolean, abortFlag: boolean, json: boolean }}
 */
export function parseRebaseArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      onto: { type: 'string' },
      head: { type: 'string' },
      continue: { type: 'boolean', default: false },
      abort: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    strict: false,
  });
  return {
    onto: values.onto,
    head: values.head,
    continueFlag: values.continue === true,
    abortFlag: values.abort === true,
    json: values.json === true,
  };
}

/** Pure: did the rebase end in a clean / non-failure outcome? */
export function isCleanRebaseOutcome(outcome) {
  return (
    outcome === 'clean' || outcome === 'continued' || outcome === 'aborted'
  );
}

/** Pure: render the human-facing output lines for a rebase result. */
export function renderRebaseHumanLines(result) {
  const lines = [`[rebase] outcome: ${result.outcome}`];
  if (result.conflictedFiles?.length > 0) {
    lines.push(`[rebase] conflicted files (${result.conflictedFiles.length}):`);
    for (const f of result.conflictedFiles) lines.push(`  - ${f}`);
  }
  return lines;
}

/**
 * Pure: dispatch the parsed args to the matching rebase action. Throws when
 * the implicit-rebase path was selected without `--onto`. Exported for tests.
 */
export function selectRebaseAction(args) {
  if (args.abortFlag) return { kind: 'abort' };
  if (args.continueFlag) return { kind: 'continue' };
  if (!args.onto) {
    return {
      kind: 'usage-error',
      message:
        'Usage: node git-rebase-and-resolve.js --onto <base> [--head <branch>] [--json]',
    };
  }
  return { kind: 'rebase', onto: args.onto, head: args.head };
}

function runSelectedAction(action, cwd) {
  if (action.kind === 'abort') return abortRebase({ cwd });
  if (action.kind === 'continue') return continueRebase({ cwd });
  return runRebase({ onto: action.onto, head: action.head, cwd });
}

function emitRebaseHuman(result) {
  for (const line of renderRebaseHumanLines(result)) Logger.info(line);
  if (result.stderr?.trim()) Logger.error(result.stderr.trim());
}

/* node:coverage ignore next */
async function main() {
  const args = parseRebaseArgs(process.argv.slice(2));
  const action = selectRebaseAction(args);
  if (action.kind === 'usage-error') throw new Error(action.message);
  const result = runSelectedAction(action, PROJECT_ROOT);
  if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else emitRebaseHuman(result);
  if (!isCleanRebaseOutcome(result.outcome)) process.exit(1);
}

runAsCli(import.meta.url, main, { source: 'git-rebase-and-resolve' });
