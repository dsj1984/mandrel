#!/usr/bin/env node
/* node:coverage ignore file -- multi-phase repo-cleanup CLI; thin shell over `git` + `gh` */

/**
 * Thin CLI shell over the `lib/orchestration/git-cleanup/phases/` pipeline.
 *
 * Exit codes: 0 clean or dry-run, 1 a phase failed, 2 nothing to do.
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
