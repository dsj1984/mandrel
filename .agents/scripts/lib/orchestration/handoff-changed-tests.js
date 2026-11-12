/**
 * handoff-changed-tests.js — the `ci` posture's changed-tests guard:
 * `project.commands.testChanged` run before the deferral settles, with no
 * lock and no credit.
 */

import { resolveTestChangedCommand } from '../close-validation/test-delta.js';
import { TIMEOUT_EXIT_CODE } from '../process-group.js';
import { isOverBudgetExit } from './handoff-gates.js';

/** Why a guard exit other than 0 or 76 stops the handoff. */
function guardFailure(raw, status) {
  return status === TIMEOUT_EXIT_CODE
    ? `changed-tests guard timed out (exit ${status}) — usually host contention; re-run the handoff`
    : `changed-tests guard \`${raw}\` failed (exit ${status}) — fix the failing tests, commit, re-run`;
}

/** A guard exit as `{ stop }`, else the `note` the deferral detail carries. */
function settleGuard(ctx, name, { status, raw, extra }) {
  if (status === 0) {
    ctx.state.changedTestsHead = ctx.head;
    return { note: '; changed-tests guard passed', extra };
  }
  if (isOverBudgetExit(status)) {
    return {
      note: `; changed-tests guard skipped (over budget, exit ${status})`,
      extra,
    };
  }
  const detail = guardFailure(raw, status);
  return {
    stop: {
      name,
      outcome: 'failed',
      detail,
      stop: 'fix-required',
      cause: 'changed-tests',
      ...extra,
    },
  };
}

/**
 * Run `testChanged` unless unset or already passed at HEAD.
 *
 * @param {{ config: object, head: string, state: object, depositor: string }} ctx
 * @param {string} name
 * @param {{ run: (cmd: object) => Promise<{ status: number, evidencePath: string }>, signal: AbortSignal }} guard
 * @returns {Promise<{ stop?: object, note?: string, extra?: object }>}
 */
export async function changedTestsGuard(ctx, name, guard) {
  const testChanged = resolveTestChangedCommand(ctx.config);
  if (testChanged.disabled) return { note: '' };
  if (ctx.state.changedTestsHead === ctx.head) {
    return {
      note: `; changed-tests guard already passed at ${ctx.head.slice(0, 12)}`,
    };
  }
  const { status, evidencePath } = await guard.run(testChanged);
  const extra = { evidencePath, depositor: ctx.depositor };
  if (!guard.signal.aborted) {
    return settleGuard(ctx, name, { status, raw: testChanged.raw, extra });
  }
  const detail =
    'aborted: the held review found a CRITICAL mid-guard; no deferral';
  return { stop: { name, outcome: 'aborted', detail, ...extra } };
}
