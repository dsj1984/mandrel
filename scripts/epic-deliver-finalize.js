#!/usr/bin/env node
/* node:coverage ignore file */
/**
 * epic-deliver-finalize.js — Phase F shim (Story #2319 / Task #2329).
 *
 * Story #2319 collapsed this 1075-line legacy CLI to a pure emit shim.
 * The Finalizer listener (subscribed to `acceptance.reconcile.ok`) now
 * owns the FF check + push + `gh pr create` flow at runtime; the
 * `AcceptanceReconciler` listener owns the inline acceptance-spec
 * reconciliation invocation that previously lived in this CLI. This
 * shim exists so any out-of-band operator invocation re-enters the
 * close-tail chain at the canonical entry event (`epic.close.end`).
 *
 * The file shell is kept (deletion is Epic D-2's job) so the
 * `.agents/scripts/epic-deliver-finalize.js` path remains a valid CLI
 * entry point. Per the Epic #2306 acceptance, this shim:
 *   - has fewer than 50 source lines,
 *   - contains exactly one `bus.emit` call,
 *   - imports no acceptance-spec-reconciler module (the inline call
 *     site previously at line 953 is gone).
 *
 * Usage:
 *   node .agents/scripts/epic-deliver-finalize.js --epic <epicId>
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { createBus } from './lib/orchestration/lifecycle/bus.js';

export async function runEpicDeliverFinalize({ epicId, bus } = {}) {
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new TypeError('runEpicDeliverFinalize: --epic requires positive int');
  }
  await (bus ?? createBus()).emit('epic.close.end', { epicId });
  return { epicId, emitted: 'epic.close.end' };
}

async function main() {
  const { values } = parseArgs({
    options: { epic: { type: 'string' } },
    strict: true,
  });
  const epicId = Number.parseInt(values.epic ?? '', 10);
  return runEpicDeliverFinalize({ epicId });
}

runAsCli(import.meta, main);
