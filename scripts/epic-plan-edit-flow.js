// cli-opt-out: library module — surfaces (`detectExistingSpec`, `runEditFlow`)
// are consumed by `epic-plan.js` (the actual CLI) and the test suite. This file
// has no main() because it has no CLI surface of its own.

/**
 * epic-plan-edit-flow.js — Phase 8.5 edit-in-place flow for `/epic-plan`.
 *
 * Story #1499 (Epic #1182). Extracted from `epic-plan.js` so the
 * top-level wrapper remains a thin chainer over the author-then-
 * reconcile path while the edit-in-place branch lives in its own module
 * with focused JSDoc + DI seams.
 *
 * Two surfaces are exported:
 *
 *   • `detectExistingSpec(epicId)` — pure stat probe over
 *     `.agents/epics/<id>.yaml`. Returns `{ exists, path }`. No YAML
 *     parse, no schema validation — the downstream `runEditFlow` calls
 *     into `epic-reconcile.js#runReconcile`, which validates via
 *     `loadSpec` before computing the plan.
 *   • `runEditFlow({ epicId, provider, specFilePath, apply, ... })` —
 *     drives the dry-run + HITL + apply chain through `runReconcile`
 *     with `yes: true` on the confirmed apply so the embedded gate does
 *     not double-prompt.
 *
 * The DI seams (`reconcileFn`, `confirm`, `isTty`, `stdout`, `stderr`)
 * let tests pin every branch without spawning a child process or
 * hitting a real TTY.
 */

import { existsSync as defaultExistsSync } from 'node:fs';
import {
  confirmInteractive as defaultConfirmInteractive,
  runReconcile,
} from './epic-reconcile.js';
import { Logger } from './lib/Logger.js';
import { isEmptyPlan } from './lib/orchestration/epic-spec-reconciler-ops.js';
import { specPath } from './lib/spec/loader.js';

/**
 * Resolve the on-disk spec path for `epicId` and report whether it
 * already exists. Pure file-system stat — no YAML parse, no schema
 * validation. The downstream edit flow calls `loadSpec` before doing
 * any work, so a malformed spec does not poison the routing probe.
 *
 * @param {number|string} epicId
 * @param {{ existsSync?: typeof defaultExistsSync, specPathFn?: typeof specPath, epicsDir?: string }} [opts]
 * @returns {{ exists: boolean, path: string }}
 */
export function detectExistingSpec(epicId, opts = {}) {
  const existsFn = opts.existsSync ?? defaultExistsSync;
  const specPathFn = opts.specPathFn ?? specPath;
  const filePath = specPathFn(
    epicId,
    opts.epicsDir ? { epicsDir: opts.epicsDir } : {},
  );
  return { exists: existsFn(filePath), path: filePath };
}

/**
 * Edit-in-place flow for Phase 2.5.
 *
 *   1. Compute the structural plan (dry-run) and render it.
 *   2. Empty-plan → short-circuit (no prompt, no apply).
 *   3. `apply: false` → return the dry-run envelope unchanged.
 *   4. `apply: true` → prompt the operator; on yes invoke
 *      `runReconcile` a second time with `apply: true, yes: true`.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   specFilePath: string,
 *   apply?: boolean,
 *   reconcileFn?: typeof runReconcile,
 *   confirm?: typeof defaultConfirmInteractive,
 *   isTty?: () => boolean,
 *   stdout?: (line: string) => void,
 *   stderr?: (line: string) => void,
 *   loaderOpts?: object,
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   mode: 'edit',
 *   specPath: string,
 *   applied: boolean,
 *   plan: object|null,
 *   exitCode: number,
 *   reason?: string,
 *   applyResult?: object,
 * }>}
 */
export async function runEditFlow({
  epicId,
  provider,
  specFilePath,
  apply = false,
  reconcileFn = runReconcile,
  confirm = defaultConfirmInteractive,
  isTty = () => Boolean(process.stdin.isTTY),
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  loaderOpts,
}) {
  Logger.info(
    `[epic-plan] Existing spec detected for Epic #${epicId} at ${specFilePath}. Routing through edit-in-place flow.`,
  );

  const dryRunResult = await reconcileFn(
    { epicId, dryRun: true, apply: false, explicitDelete: false, yes: false },
    { provider, stdout, stderr, loaderOpts },
  );

  if (dryRunResult.exitCode !== 0) {
    return makeEditResult({
      epicId,
      specFilePath,
      applied: false,
      plan: dryRunResult.plan ?? null,
      exitCode: dryRunResult.exitCode,
      reason: 'dry-run-failed',
    });
  }

  if (dryRunResult.plan && isEmptyPlan(dryRunResult.plan)) {
    stdout(
      `[epic-plan] No structural changes detected for Epic #${epicId}. Spec is in sync with live state.`,
    );
    return makeEditResult({
      epicId,
      specFilePath,
      applied: false,
      plan: dryRunResult.plan,
      exitCode: 0,
      reason: 'empty-diff',
    });
  }

  if (!apply) {
    return makeEditResult({
      epicId,
      specFilePath,
      applied: false,
      plan: dryRunResult.plan,
      exitCode: 0,
      reason: 'dry-run-only',
    });
  }

  if (!isTty()) {
    stderr(
      '[epic-plan] --apply requires an interactive TTY for the operator confirmation gate.',
    );
    return makeEditResult({
      epicId,
      specFilePath,
      applied: false,
      plan: dryRunResult.plan,
      exitCode: 1,
      reason: 'no-tty',
    });
  }

  stdout(
    `[epic-plan] Reviewed plan for Epic #${epicId}. Apply these structural changes?`,
  );
  const confirmed = await confirm();
  if (!confirmed) {
    stdout('[epic-plan] Edit-in-place declined by operator.');
    return makeEditResult({
      epicId,
      specFilePath,
      applied: false,
      plan: dryRunResult.plan,
      exitCode: 0,
      reason: 'declined',
    });
  }

  const applyResult = await reconcileFn(
    { epicId, dryRun: false, apply: true, explicitDelete: false, yes: true },
    { provider, stdout, stderr, loaderOpts },
  );

  return makeEditResult({
    epicId,
    specFilePath,
    applied: applyResult.exitCode === 0,
    plan: applyResult.plan ?? dryRunResult.plan,
    exitCode: applyResult.exitCode,
    applyResult: applyResult.applyResult,
    reason: applyResult.exitCode === 0 ? 'applied' : 'apply-failed',
  });
}

/**
 * Tiny constructor for the edit-flow result envelope. Exists so the
 * happy + branch paths share a single shape definition instead of
 * re-declaring keys at every `return` site.
 *
 * @param {object} params
 * @returns {object}
 */
function makeEditResult({
  epicId,
  specFilePath,
  applied,
  plan,
  exitCode,
  reason,
  applyResult,
}) {
  return {
    epicId,
    mode: 'edit',
    specPath: specFilePath,
    applied,
    plan,
    exitCode,
    ...(reason != null ? { reason } : {}),
    ...(applyResult != null ? { applyResult } : {}),
  };
}
