/**
 * behind-recovery.js — one bounded `BEHIND` → `gh pr update-branch` step,
 * shared by both merge loops; callers own probing, budget and wording.
 */

const BEHIND_MERGE_STATE = 'BEHIND';

/**
 * Failure is a throw or a resolved `{ ok: false }`; anything else succeeds.
 *
 * @param {() => Promise<unknown>} updateBranch
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function settleUpdate(updateBranch) {
  try {
    const result = await updateBranch();
    if (result && typeof result === 'object' && result.ok === false) {
      return { ok: false, detail: String(result.detail ?? 'update-failed') };
    }
    return { ok: true, detail: '' };
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
}

/**
 * Not-BEHIND is checked before the budget so an up-to-date PR never reports
 * an exhausted budget; an unreadable probe never licenses a write.
 *
 * @param {object} args
 * @param {string|undefined|null} args.mergeStateStatus
 * @param {number} [args.updatesUsed=0]
 * @param {number} [args.maxUpdates=0]
 * @param {() => Promise<unknown>} args.updateBranch
 * @param {(args: { maxUpdates: number }) => void} [args.onBudgetSpent]
 * @param {(args: { updatesUsed: number, maxUpdates: number }) => void} [args.onUpdated]
 * @param {(detail: string) => void} [args.onUpdateFailed]
 * @returns {Promise<{
 *   attempted: boolean,
 *   updated: boolean,
 *   outcome: 'not-behind'|'budget-spent'|'updated'|'update-failed',
 * }>}
 *   `updated` means terminal check outcomes must be re-polled.
 */
export async function applyBehindUpdate({
  mergeStateStatus,
  updatesUsed = 0,
  maxUpdates = 0,
  updateBranch,
  onBudgetSpent,
  onUpdated,
  onUpdateFailed,
}) {
  if (mergeStateStatus !== BEHIND_MERGE_STATE) {
    return { attempted: false, updated: false, outcome: 'not-behind' };
  }
  if (updatesUsed >= maxUpdates) {
    onBudgetSpent?.({ maxUpdates });
    return { attempted: false, updated: false, outcome: 'budget-spent' };
  }

  const settled = await settleUpdate(updateBranch);
  if (!settled.ok) {
    onUpdateFailed?.(settled.detail);
    return { attempted: true, updated: false, outcome: 'update-failed' };
  }
  onUpdated?.({ updatesUsed, maxUpdates });
  return { attempted: true, updated: true, outcome: 'updated' };
}
