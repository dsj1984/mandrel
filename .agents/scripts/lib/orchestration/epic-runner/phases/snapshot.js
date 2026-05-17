/**
 * Epic snapshot phase — fetch Epic ticket and enforce the acceptance-spec
 * start gate.
 *
 * Auto-close is now the default for `/epic-deliver` (the human PR-merge is
 * the gate); no per-Epic label snapshot is required.
 *
 * Acceptance-spec start gate (relaxed): an Epic may be delivered when
 * *either* the operator has explicitly waived the acceptance-spec
 * requirement via the `acceptance::n-a` label, *or* a
 * `context::acceptance-spec` ticket is linked to the Epic. The ticket's
 * GitHub state (open / closed) is **not** checked — presence is
 * sufficient, matching the PRD and Tech Spec contract. The reviewer's
 * OK during /epic-plan Phase 7 is the approval signal, not a manual
 * ticket-close action. This still refuses to launch Epics that skipped
 * the /epic-plan Phase 7 acceptance-spec authoring step (or didn't
 * waive), surfacing the gap at delivery time rather than letting Story
 * dispatch race ahead without a spec at all.
 */

import { parseLinkedIssues } from '../../../issue-link-parser.js';
import { ACCEPTANCE_NA } from '../../../label-constants.js';

export async function runSnapshotPhase(ctx, _collaborators, state) {
  const { epicId, provider } = ctx;
  const epic = await provider.getTicket(epicId);
  assertAcceptanceSpecGate({ epic, epicId });
  return { ...state, epic };
}

/**
 * Refuse to launch /epic-deliver when the acceptance-spec precondition has
 * not been satisfied. Throws a clear `Error` (per
 * orchestration-error-handling rule) so the `runAsCli` boundary maps it to
 * `process.exit(1)` with the operator-visible message intact.
 *
 * The gate now only checks presence (or waiver). Ticket state is
 * deliberately ignored — closure is no longer required as the approval
 * signal.
 *
 * @param {{ epic: { labels?: string[], linkedIssues?: { acceptanceSpec?: number|null }|null, body?: string }, epicId: number }} args
 */
function assertAcceptanceSpecGate({ epic, epicId }) {
  const labels = epic?.labels ?? [];
  if (labels.includes(ACCEPTANCE_NA)) return;

  const linkedIssues =
    epic?.linkedIssues ?? parseLinkedIssues(epic?.body ?? '');
  const acceptanceSpecId = linkedIssues?.acceptanceSpec ?? null;

  if (!acceptanceSpecId) {
    throw new Error(
      `[epic-deliver] Epic #${epicId} cannot launch: no context::acceptance-spec is linked and the acceptance::n-a waiver label is absent. ` +
        'Run /epic-plan Phase 7 to author an acceptance-spec, or apply the acceptance::n-a label to the Epic to opt out.',
    );
  }
}
