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
  branchLastCommitAt,
  branchTipSha,
  classifyLatestPr,
  probeAllPrs,
  probeContentEquivalent,
  probeLatestPr,
  probeMergedPr,
  refExists,
} from './lib/orchestration/git-cleanup/phases/git-probes.js';
import { probeAncestry } from './lib/orchestration/git-cleanup/phases/merged-tip.js';
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
  renderNotMergedSkipLine,
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
  branchLastCommitAt,
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
  probeAncestry,
  probeContentEquivalent,
  probeLatestPr,
  probeMergedPr,
  refExists,
  renderDeferredLine,
  renderDryRun,
  renderExecutionLine,
  renderExecutionSummary,
  renderLatestPrSkipLine,
  renderNotMergedSkipLine,
  renderPruneLine,
  stashRefIndex,
};

async function main() {
  const { exitCode } = await runCleanup();
  process.exit(exitCode);
}

runAsCli(import.meta.url, main, {
  source: 'git-cleanup',
  usage: {
    invocation:
      'node .agents/scripts/git-cleanup.js [--execute] [--yes] [--json] [phase flags] [filters]',
    summary:
      'Tidy the local checkout in four phases — fast-forward the base branch, prune stale remote refs, reap merged branches, triage stashes. Dry-run unless --execute.',
    flags: [
      ['--execute', 'Perform the mutations (default is a dry run).'],
      ['--dry-run', 'Force a dry run even alongside --execute.'],
      ['--yes', 'Skip the interactive confirmation prompts.'],
      ['--json', 'Emit the plan/result envelope as JSON.'],
      ['--remote', 'Also delete the matching remote branches.'],
      ['--fast-forward-main', 'Run only the fast-forward-base phase.'],
      ['--prune-remotes', 'Run only the prune-remotes phase.'],
      ['--branches', 'Run only the merged-branch reap phase.'],
      ['--stashes', 'Run only the stash-triage phase.'],
      [
        '--include <glob>',
        'Only consider branches matching the glob (repeatable).',
      ],
      [
        '--exclude <glob>',
        'Never consider branches matching the glob (repeatable).',
      ],
      ['--drop-stashes <ref>', 'Stash ref approved for dropping (repeatable).'],
      [
        '--include-content-merged',
        'Under --yes, also delete remote refs detected only by content-equivalence.',
      ],
      ['--base <branch>', 'Base branch (default: project.baseBranch).'],
      ['--cwd <path>', 'Repository root (default: process cwd).'],
    ],
    notes: ['With no phase flag, every phase runs in order.'],
  },
});
