#!/usr/bin/env node

/**
 * apply-quality-bootstrap.js — Story #4171
 * (refactor(mandrel-update): extract the quality-bootstrap heredoc into a
 * tested script)
 *
 * Replaces the inline `node -e "Promise.all([...])"` heredoc that Step 3.5 of
 * the `/mandrel-update` workflow used to carry. That shape was fragile in three
 * ways: it broke across shells (PowerShell vs bash quoting / backticks), it
 * had no test so it silently drifted when the two helper signatures moved, and
 * it could not be invoked or dry-run independently.
 *
 * The script runs one install against the consumer repo root:
 * `applyQualityBootstrap` — copies the code-quality-guardrails helper,
 * installs the `.husky/pre-commit` quality:preview line, backfills the
 * `quality:preview` / `quality:watch` npm scripts, seeds the
 * `delivery.quality.autoRefresh` default, and prunes a
 * committed pre-v2 `baselines/epic/` tree.
 *
 * Story #5007 retired the second step. `migrateBaselinesLayout` relocated
 * per-Epic ratchet snapshots into `temp/epic/<id>/baselines/` on the contract
 * that `/mandrel-deliver` reaps that namespace on merge — a mechanism the Story-only
 * v2 model deleted, so the migration moved dead data into a namespace no code
 * path writes, reads, or reaps. Its one residual hygiene value (getting the
 * committed `baselines/epic/` tree out of version control) survives as
 * `pruneLegacyEpicBaselines`, the quality install's fifth step.
 *
 * The helper is idempotent by contract — a second run reports `no-change` /
 * `already-present` / `absent` on every install path — so this wrapper is safe
 * to re-run. It prints `{ quality }` JSON to stdout.
 *
 * The effectful work is a thin pure function (`applyBootstrapAndMigration`)
 * that takes the helper and the project root, so the test suite can drive it
 * against a tmp directory without spawning a child process. The CLI wrapper
 * wires the real helper and `process.cwd()`.
 */

import { applyQualityBootstrap } from './lib/bootstrap/quality-bootstrap.js';
import { runAsCli } from './lib/cli-utils.js';

/**
 * Run the quality-bootstrap install against `projectRoot`, returning the
 * `{ quality }` envelope. Pure relative to its injected helper: the default
 * helper touches the filesystem under `projectRoot`, but tests can pass a stub
 * to exercise the composition in isolation.
 *
 * @param {object} options
 * @param {string} options.projectRoot Absolute consumer repo root.
 * @param {typeof applyQualityBootstrap} [options.applyQualityBootstrap]
 * @returns {{ quality: object }}
 */
export function applyBootstrapAndMigration({
  projectRoot,
  applyQualityBootstrap: applyQuality = applyQualityBootstrap,
}) {
  return { quality: applyQuality({ projectRoot }) };
}

async function main() {
  const projectRoot = process.cwd();
  const result = applyBootstrapAndMigration({ projectRoot });
  // Use process.stdout.write (not console.log) per the no-console
  // enforcement boundary.
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'apply-quality-bootstrap',
  propagateExitCode: true,
  usage: {
    invocation: 'node .agents/scripts/apply-quality-bootstrap.js',
    summary:
      'Install the quality-gate surface into the consumer repo (guardrails helper, pre-commit line, npm scripts, config defaults, legacy baselines/epic prune). Idempotent; prints { quality } JSON to stdout.',
    flags: [],
  },
});
