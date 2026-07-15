/**
 * cli.js — `main()` entry point for git-cleanup (Story #2466).
 *
 * Owns argv parsing, base-branch resolution, fan-out across the four
 * cleanup phases, and the optional JSON envelope emission. Per-phase
 * orchestrators (`runFastForwardPhase` etc.) live in
 * `phase-drivers.js`; interactive prompts in `prompts.js`.
 *
 * @module lib/orchestration/git-cleanup/phases/cli
 */

import path from 'node:path';

import { PROJECT_ROOT, resolveConfig } from '../../../config-resolver.js';
import { parseCleanupArgs } from './parse-args.js';
import {
  runBranchPhase,
  runFastForwardPhase,
  runPrunePhase,
  runStashPhase,
} from './phase-drivers.js';
import { buildJsonEnvelope, computeExitCode } from './render.js';

/* node:coverage ignore next */
function resolveBaseBranch(cwd, override) {
  if (override) return override;
  try {
    const cfg = resolveConfig({ cwd });
    return cfg?.project?.baseBranch || 'main';
  } catch {
    return 'main';
  }
}

/* node:coverage ignore next */
async function runActivePhases(opts, cwd, baseBranch) {
  const out = {
    fastForward: null,
    prune: null,
    branchesPlan: null,
    branchesResult: null,
    stashes: null,
  };
  if (opts.phases.fastForwardMain) {
    out.fastForward = await runFastForwardPhase(opts, cwd, baseBranch);
  }
  if (opts.phases.pruneRemotes) {
    out.prune = await runPrunePhase(opts, cwd);
  }
  if (opts.phases.branches) {
    const r = await runBranchPhase(opts, cwd, baseBranch);
    out.branchesPlan = r.plan;
    out.branchesResult = r.result;
  }
  if (opts.phases.stashes) {
    out.stashes = await runStashPhase(opts, cwd);
  }
  return out;
}

/* node:coverage ignore next */
function maybeEmitJson(opts, baseBranch, phaseResults) {
  if (!opts.json) return;
  const envelope = buildJsonEnvelope({
    dryRun: opts.dryRun,
    baseBranch,
    plan: phaseResults.branchesPlan ?? { candidates: [], skipped: [] },
    result: phaseResults.branchesResult,
    fastForward: phaseResults.fastForward,
    prune: phaseResults.prune,
    stashes: phaseResults.stashes,
  });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Run the full multi-phase pipeline and return the operator-facing
 * envelope plus the resolved exit code. The CLI shell wraps this in
 * `runAsCli(...)` and applies `process.exit(envelope.exitCode)` at the
 * harness boundary so library code stays free of direct `process.exit`
 * calls (see `tests/enforcement/process-exit.test.js`).
 */
/* node:coverage ignore next */
export async function runCleanup() {
  const opts = parseCleanupArgs(process.argv.slice(2));
  const cwd = path.resolve(opts.cwd ?? PROJECT_ROOT);
  const baseBranch = resolveBaseBranch(cwd, opts.base);
  const phaseResults = await runActivePhases(opts, cwd, baseBranch);
  maybeEmitJson(opts, baseBranch, phaseResults);
  return {
    exitCode: computeExitCode({
      branchesPlan: phaseResults.branchesPlan,
      branchesResult: phaseResults.branchesResult,
      fastForward: phaseResults.fastForward,
      prune: phaseResults.prune,
      stashes: phaseResults.stashes,
    }),
  };
}
