#!/usr/bin/env node

/**
 * reconcile-sub-issues.js — operator-facing manual-repair surface for
 * silent sub-issue link gaps (Story #2063).
 *
 * Walks every child of an Epic whose body footer carries `parent: #N`
 * and verifies the native GitHub sub-issue API link is present.
 * Re-establishes any missing link by calling `addSubIssue`, which
 * retries transient errors internally. The same routine runs
 * automatically inside `runDecomposePhase`; this CLI exists so
 * operators can repair Epics that landed during a window where the
 * safety net was absent (the spec-flow rewrite in Story #1498 dropped
 * the call, surfaced via Epic #1994 on 2026-05-16).
 *
 * Usage:
 *   node .agents/scripts/reconcile-sub-issues.js --epic <id>
 *
 * Exits 0 when every expected link is present (`failed === 0`),
 * non-zero with a per-child reason summary when any link could not
 * be established.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { createProvider } from './lib/provider-factory.js';

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string', short: 'e' },
    },
    strict: false,
  });
  const epicId = Number.parseInt(values.epic ?? '', 10);
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new Error(
      '[reconcile-sub-issues] --epic <id> is required (positive integer).',
    );
  }
  return { epicId };
}

export async function runReconcileSubIssuesCli(argv, deps = {}) {
  const { epicId } = parseCliArgs(argv);
  const config = deps.config ?? resolveConfig();
  const provider =
    deps.provider ?? createProvider(config.orchestration ?? null);

  if (typeof provider.reconcileSubIssueLinks !== 'function') {
    throw new Error(
      '[reconcile-sub-issues] provider does not implement reconcileSubIssueLinks().',
    );
  }

  Logger.info(
    `[reconcile-sub-issues] Reconciling sub-issue API links for Epic #${epicId}...`,
  );
  const result = await provider.reconcileSubIssueLinks(epicId);
  const { totalExpected, alreadyLinked, reconciled, failed, failures } = result;

  if (failed === 0) {
    const note = reconciled > 0 ? ` (${reconciled} reconciled)` : '';
    Logger.info(
      `[reconcile-sub-issues] ✅ linked ${alreadyLinked + reconciled}/${totalExpected} sub-issues${note}`,
    );
    return result;
  }

  for (const failure of failures) {
    Logger.error(
      `[reconcile-sub-issues] gap: parent #${failure.parentId} ← child #${failure.childId}: ${failure.reason}`,
    );
  }
  throw new Error(
    `[reconcile-sub-issues] ${failed}/${totalExpected} link(s) could not be established (linked=${alreadyLinked}, reconciled=${reconciled}).`,
  );
}

runAsCli(import.meta.url, () =>
  runReconcileSubIssuesCli(process.argv.slice(2)),
);
