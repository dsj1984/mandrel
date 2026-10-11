/**
 * `clean-git.js` `main()`: argv, base-branch resolution, the four phases, and
 * the optional JSON envelope.
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

const DEFAULT_DEPS = Object.freeze({
  runFastForwardPhase,
  runPrunePhase,
  runBranchPhase,
  runStashPhase,
  resolveConfig,
  write: (text) => process.stdout.write(text),
});

function resolveBaseBranch(cwd, override, deps) {
  if (override) return override;
  try {
    const cfg = deps.resolveConfig({ cwd });
    return cfg?.project?.baseBranch || 'main';
  } catch {
    return 'main';
  }
}

async function runActivePhases(opts, cwd, baseBranch, deps) {
  const out = {
    fastForward: null,
    prune: null,
    branchesPlan: null,
    branchesResult: null,
    stashes: null,
  };
  if (opts.phases.fastForwardMain) {
    out.fastForward = await deps.runFastForwardPhase(opts, cwd, baseBranch);
  }
  if (opts.phases.pruneRemotes) {
    out.prune = await deps.runPrunePhase(opts, cwd);
  }
  if (opts.phases.branches) {
    const r = await deps.runBranchPhase(opts, cwd, baseBranch);
    out.branchesPlan = r.plan;
    out.branchesResult = r.result;
  }
  if (opts.phases.stashes) {
    out.stashes = await deps.runStashPhase(opts, cwd);
  }
  return out;
}

function maybeEmitJson(opts, baseBranch, phaseResults, deps) {
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
  deps.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Run the full multi-phase pipeline and return the operator-facing
 * envelope plus the resolved exit code. The CLI shell wraps this in
 * `runAsCli(...)` and applies `process.exit(envelope.exitCode)` at the
 * harness boundary so library code stays free of direct `process.exit`
 * calls (see `tests/enforcement/process-exit.test.js`).
 *
 * @param {{ argv?: string[], deps?: Partial<typeof DEFAULT_DEPS> }} [args]
 *   `deps` overrides the phase drivers, config resolver and stdout writer.
 */
export async function runCleanup({
  argv = process.argv.slice(2),
  deps = {},
} = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const opts = parseCleanupArgs(argv);
  const cwd = path.resolve(opts.cwd ?? PROJECT_ROOT);
  const baseBranch = resolveBaseBranch(cwd, opts.base, d);
  const phaseResults = await runActivePhases(opts, cwd, baseBranch, d);
  maybeEmitJson(opts, baseBranch, phaseResults, d);
  return { exitCode: computeExitCode(phaseResults) };
}
