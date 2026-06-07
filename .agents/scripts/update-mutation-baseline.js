#!/usr/bin/env node
/**
 * update-mutation-baseline.js — Refresh `baselines/mutation.json` from a
 * fresh Stryker run (Story #1736, Task #1752 + #1753).
 *
 * Reads the configured mutation gate (`delivery.quality.gates.mutation`),
 * invokes the Stryker runner from `lib/mutation/stryker-runner.js`, and
 * atomically rewrites the baseline file with the new per-workspace
 * mutation scores. Preserves the configured `tolerancePct` (from the
 * gate's `tolerance.value`) so the file is self-contained — consumers
 * don't need to read `.agentrc.json` to interpret the baseline.
 *
 * Exit codes:
 *   0 — baseline refreshed (didChange true) or no change (didChange false)
 *   0 — Stryker skipped (no config) with an explanatory line on stderr
 *   1 — Stryker invocation failed
 *
 * The refresh is intentionally non-fatal when Stryker is not configured:
 * the operator can run `npx stryker init` and re-invoke this script.
 *
 * DORMANT BY DESIGN (Story #3665). This script and the rest of the
 * mutation-testing surface ship built-but-unwired: Mandrel declares no
 * `delivery.quality.gates.mutation` block and no `stryker.conf.*`, so the
 * gate never enters the `check-baselines` pipeline and this refresh
 * self-skips (no Stryker config detected). The dormancy is an evaluated,
 * intentional opt-in — not an oversight. A spike (Story #3665) concluded
 * DEFER on activation. The essential rationale, preserved here so it does
 * not depend on a point-in-time writeup:
 *
 *   - Cost model: a full `.agents/scripts` Stryker baseline is a
 *     tens-of-minutes-to-multi-hour job even under `coverageAnalysis:
 *     'perTest'` at `concurrency: 8`. Stryker reruns the affected test set
 *     once per mutant (~5,000–6,500 mutants over ~19k effective LOC), and
 *     Mandrel's tests live in a sibling `tests/` tree (not colocated with
 *     source), so there is no cheap per-source-file partition for `perTest`
 *     to exploit. Activation therefore belongs on a nightly `schedule`
 *     (never per-PR), with PR-time `check-baselines` consuming the
 *     nightly-produced baseline as a read-only ratchet.
 *   - Baseline-shape fit: the kernel/check side keys mutation rows by
 *     `path` (`lib/baselines/kinds/mutation.js` — per-file rows + per-
 *     component rollup, the right fit for this single-package repo), but
 *     this refresh writer (`lib/mutation/baseline-snapshot.js`) emits a
 *     workspace-keyed `{ workspaces: { '*': score } }` snapshot that
 *     collapses to one repo-wide number with zero per-file resolution.
 *     The two shapes do not agree; activation must first reconcile this
 *     writer to emit the kernel's path-keyed `rows[]`/`rollup` envelope.
 *   - Prerequisites: a `node --test` Stryker runner integration (no
 *     first-party `@stryker-mutator` plugin exists for the Node built-in
 *     runner), the shape reconciliation above, and nightly CI plumbing —
 *     together an Epic-sized effort, not a config flip.
 *
 * Re-evaluate (promote to an activation Epic) when a coverage-gamed
 * regression ships, the project migrates to a test runner with first-party
 * Stryker support, or an operator opts in for a specific high-risk subtree.
 */

import path from 'node:path';

import { resolveDiffScope } from './lib/baselines/diff-scope-cli.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  getQuality,
  PROJECT_ROOT,
  resolveConfig,
} from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  DEFAULT_BASELINE_PATH,
  DEFAULT_TOLERANCE_PCT,
  writeBaseline,
} from './lib/mutation/baseline-snapshot.js';
import { runStryker } from './lib/mutation/stryker-runner.js';

/**
 * Resolve the mutation gate config relevant to baseline refresh.
 *
 * @param {object} config Canonical resolved config (`resolveConfig()` output).
 * @returns {{ baselinePath: string, tolerancePct: number, strykerConfigPath: string | null }}
 */
export function resolveMutationGate(config) {
  const quality = getQuality(config);
  const gate = quality.gates?.mutation ?? {};
  const baselinePath =
    typeof gate.baselinePath === 'string' && gate.baselinePath.length > 0
      ? gate.baselinePath
      : DEFAULT_BASELINE_PATH;
  const tol = gate.tolerance;
  const tolerancePct =
    tol &&
    typeof tol === 'object' &&
    Number.isFinite(tol.value) &&
    tol.value >= 0
      ? tol.value
      : DEFAULT_TOLERANCE_PCT;
  const strykerConfigPath =
    typeof gate.strykerConfigPath === 'string' &&
    gate.strykerConfigPath.length > 0
      ? gate.strykerConfigPath
      : null;
  return { baselinePath, tolerancePct, strykerConfigPath };
}

/**
 * @param {{
 *   cwd?: string,
 *   runStrykerFn?: typeof runStryker,
 *   writeBaselineFn?: typeof writeBaseline,
 *   resolveConfigFn?: typeof resolveConfig,
 *   logger?: { info?: (m: string) => void, warn?: (m: string) => void, error?: (m: string) => void },
 * }} [opts]
 * @returns {Promise<{ status: 0 | 1, didChange: boolean, skipped: boolean, reason?: string, baselinePath: string }>}
 */
export async function refreshMutationBaseline({
  cwd = PROJECT_ROOT,
  runStrykerFn = runStryker,
  writeBaselineFn = writeBaseline,
  resolveConfigFn = resolveConfig,
  logger = Logger,
} = {}) {
  const config = resolveConfigFn({ cwd });
  const gate = resolveMutationGate(config);
  const absBaseline = path.isAbsolute(gate.baselinePath)
    ? gate.baselinePath
    : path.resolve(cwd, gate.baselinePath);

  logger.info?.(`[mutation] refreshing baseline → ${gate.baselinePath}`);
  const runResult = await runStrykerFn({
    cwd,
    configPath: gate.strykerConfigPath,
  });
  if (runResult.skipped) {
    logger.info?.(
      `[mutation] skipped — ${runResult.reason ?? 'runner reported skip'}`,
    );
    return {
      status: 0,
      didChange: false,
      skipped: true,
      reason: runResult.reason ?? 'runner-skip',
      baselinePath: absBaseline,
    };
  }
  if (!runResult.ok) {
    logger.error?.(
      `[mutation] Stryker invocation failed: ${runResult.error ?? 'unknown error'}`,
    );
    return {
      status: 1,
      didChange: false,
      skipped: false,
      reason: runResult.error ?? 'stryker-failed',
      baselinePath: absBaseline,
    };
  }

  const writeResult = writeBaselineFn(absBaseline, {
    tolerancePct: gate.tolerancePct,
    workspaces: runResult.byWorkspace,
  });

  if (writeResult.didChange) {
    logger.info?.(`[mutation] baseline updated at ${gate.baselinePath}`);
  } else {
    logger.info?.(`[mutation] baseline unchanged at ${gate.baselinePath}`);
  }

  return {
    status: 0,
    didChange: writeResult.didChange,
    skipped: false,
    baselinePath: absBaseline,
  };
}

async function main() {
  // Story #1974 — `--diff-scope` accepted for CLI parity with other
  // update-*-baseline scripts; no row-narrowing effect because mutation
  // baseline is workspace-keyed (not file-keyed).
  const diffScope = resolveDiffScope({ argv: process.argv.slice(2) });
  if (diffScope) {
    Logger.info(
      `[mutation] --diff-scope ${diffScope.ref}: noted (informational only).`,
    );
  }
  const result = await refreshMutationBaseline();
  if (result.status !== 0) process.exit(result.status);
}

runAsCli(import.meta.url, main, { source: 'update-mutation-baseline' });
