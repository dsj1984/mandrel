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
 * This script runs the two Epic #1386 quality-gate installs in order against
 * the consumer repo root:
 *
 *   1. `applyQualityBootstrap` — copies the code-quality-guardrails helper,
 *      installs the `.husky/pre-commit` quality:preview line, backfills the
 *      `quality:preview` / `quality:watch` npm scripts, and seeds the
 *      `delivery.quality.{codingGuardrails,autoRefresh}` defaults.
 *   2. `migrateBaselinesLayout` — relocates per-Epic baseline snapshots into
 *      the `temp/epic/<id>/baselines/` namespace.
 *
 * Both helpers are idempotent by contract — a second run reports `no-change`
 * on every install path — so this wrapper is safe to re-run. It prints the
 * **same JSON result shape** the heredoc did: `{ quality, baselines }` to
 * stdout, so any tooling that parsed the old output keeps working.
 *
 * The effectful work is a thin pure function (`applyBootstrapAndMigration`)
 * that takes the two helpers and the project root, so the test suite can
 * drive it against a tmp directory without spawning a child process. The CLI
 * wrapper wires the real helpers and `process.cwd()`.
 */

import path from 'node:path';
import { migrateBaselinesLayout } from './lib/bootstrap/baselines-layout-migration.js';
import { applyQualityBootstrap } from './lib/bootstrap/quality-bootstrap.js';
import { runAsCli } from './lib/cli-utils.js';

/**
 * Run the quality-bootstrap install and the baselines-layout migration
 * against `projectRoot`, returning the combined `{ quality, baselines }`
 * envelope. Pure relative to its injected helpers: the default helpers touch
 * the filesystem under `projectRoot`, but tests can pass stubs to exercise
 * the composition in isolation.
 *
 * @param {object} options
 * @param {string} options.projectRoot Absolute consumer repo root.
 * @param {typeof applyQualityBootstrap} [options.applyQualityBootstrap]
 * @param {typeof migrateBaselinesLayout} [options.migrateBaselinesLayout]
 * @returns {{ quality: object, baselines: object }}
 */
export function applyBootstrapAndMigration({
  projectRoot,
  applyQualityBootstrap: applyQuality = applyQualityBootstrap,
  migrateBaselinesLayout: migrateBaselines = migrateBaselinesLayout,
}) {
  const quality = applyQuality({ projectRoot });
  const baselines = migrateBaselines({
    baselinesDir: path.join(projectRoot, 'baselines'),
    repoRoot: projectRoot,
  });
  return { quality, baselines };
}

async function main() {
  const projectRoot = process.cwd();
  const result = applyBootstrapAndMigration({ projectRoot });
  // Mirror the retired heredoc's output: pretty-printed `{ quality, baselines }`
  // to stdout. Use process.stdout.write (not console.log) per the no-console
  // enforcement boundary.
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'apply-quality-bootstrap',
  propagateExitCode: true,
});
