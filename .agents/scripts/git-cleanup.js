#!/usr/bin/env node
/* node:coverage ignore file -- multi-phase repo-cleanup CLI; thin shell over `git` + `gh` */

/**
 * git-cleanup.js — Story #2466 thin CLI shell over the multi-phase
 * cleanup pipeline.
 *
 * The pipeline lives under `lib/orchestration/git-cleanup/phases/`:
 *
 *   1. parse-args   — argv → normalized opts bag (`parseCleanupArgs`).
 *   2. filters      — pure glob + protected-branch helpers.
 *   3. git-probes   — every `gitSpawn` / `gh` subprocess wrapper plus
 *                     small parsers (`probeMergedPr`, etc).
 *   4. branches     — merged-branch reap (`planCleanup`,
 *                     `executeCleanup`).
 *   5. fast-forward — fast-forward-main phase.
 *   6. prune        — prune-remotes phase + `parsePrunedRefs`.
 *   7. stashes      — stash triage (`parseStashList`, `planStashes`,
 *                     `executeStashes`, `stashRefIndex`,
 *                     `buildAllowlistDecider`).
 *   8. render       — operator-facing renderers + `buildJsonEnvelope`,
 *                     `computeExitCode`.
 *   9. cli          — interactive prompts + per-phase drivers + `main`.
 *
 * Public CLI surface, named exports, and exit codes are byte-identical
 * to the pre-refactor implementation. See the original module docstring
 * (preserved below) for the operator-facing flag + phase contract.
 *
 * Phases (selectable, run sequentially when no narrowing flag set):
 *   1. fast-forward-main — `git fetch origin <base>` → `git merge --ff-only`.
 *   2. prune-remotes     — `git fetch --prune <remote>`.
 *   3. branches          — enumerate merged local branches via `gh pr list`
 *                          + `git branch --merged <base>` and reap.
 *   4. stashes           — `git stash list` → optional per-stash drops.
 *
 * Exit codes:
 *   0 — clean (dry-run preview, or every active phase succeeded).
 *   1 — at least one phase reported a failure.
 *   2 — every active phase produced nothing to do (informational).
 */

import { runAsCli } from './lib/cli-utils.js';
import {
  executeCleanup,
  planCleanup,
} from './lib/orchestration/git-cleanup/phases/branches.js';
import { runCleanup } from './lib/orchestration/git-cleanup/phases/cli.js';
import {
  executeFastForward,
  planFastForward,
} from './lib/orchestration/git-cleanup/phases/fast-forward.js';
import {
  buildGlobFilter,
  computeProtectedReason,
  computeProtectedSet,
} from './lib/orchestration/git-cleanup/phases/filters.js';
import {
  branchTipSha,
  classifyLatestPr,
  probeAllPrs,
  probeLatestPr,
  probeMergedPr,
} from './lib/orchestration/git-cleanup/phases/git-probes.js';
import { parseCleanupArgs } from './lib/orchestration/git-cleanup/phases/parse-args.js';
import {
  executePrune,
  parsePrunedRefs,
} from './lib/orchestration/git-cleanup/phases/prune.js';
import {
  buildJsonEnvelope,
  computeExitCode,
  renderDeferredLine,
  renderDryRun,
  renderExecutionLine,
  renderExecutionSummary,
  renderLatestPrSkipLine,
  renderPruneLine,
} from './lib/orchestration/git-cleanup/phases/render.js';
import {
  buildAllowlistDecider,
  executeStashes,
  parseStashList,
  planStashes,
  stashRefIndex,
} from './lib/orchestration/git-cleanup/phases/stashes.js';

// Public surface preserved for tests + `single-story-sweep.js`.
export {
  branchTipSha,
  buildAllowlistDecider,
  buildGlobFilter,
  buildJsonEnvelope,
  classifyLatestPr,
  computeExitCode,
  computeProtectedReason,
  computeProtectedSet,
  executeCleanup,
  executeFastForward,
  executePrune,
  executeStashes,
  parseCleanupArgs,
  parsePrunedRefs,
  parseStashList,
  planCleanup,
  planFastForward,
  planStashes,
  probeAllPrs,
  probeLatestPr,
  probeMergedPr,
  renderDeferredLine,
  renderDryRun,
  renderExecutionLine,
  renderExecutionSummary,
  renderLatestPrSkipLine,
  renderPruneLine,
  stashRefIndex,
};

async function main() {
  const { exitCode } = await runCleanup();
  process.exit(exitCode);
}

runAsCli(import.meta.url, main, { source: 'git-cleanup' });
