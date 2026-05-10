/**
 * Epic snapshot phase — fetch Epic ticket.
 *
 * Auto-close is now the default for `/epic-deliver` (the human PR-merge is
 * the gate); no per-Epic label snapshot is required.
 */

export async function runSnapshotPhase(ctx, _collaborators, state) {
  const { epicId, provider } = ctx;
  const epic = await provider.getTicket(epicId);
  return { ...state, epic };
}
