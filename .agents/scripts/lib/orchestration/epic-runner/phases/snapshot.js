/**
 * Epic snapshot phase — fetch Epic ticket and enforce the acceptance-spec
 * start gate.
 *
 * Auto-close is now the default for `/epic-deliver` (the human PR-merge is
 * the gate); no per-Epic label snapshot is required.
 *
 * Acceptance-spec start gate (Story #2101, AC-7): an Epic may only be
 * delivered when *either* the operator has explicitly waived the
 * acceptance-spec requirement via the `acceptance::n-a` label, *or* a
 * `context::acceptance-spec` ticket exists and is closed (i.e. approved).
 * This refuses to launch Epics that skipped the /epic-plan Phase 7
 * acceptance-spec authoring step, surfacing the precondition at delivery
 * time rather than letting Story dispatch race ahead without an approved
 * spec.
 */

import { parseLinkedIssues } from '../../../issue-link-parser.js';
import { ACCEPTANCE_NA } from '../../../label-constants.js';

export async function runSnapshotPhase(ctx, _collaborators, state) {
  const { epicId, provider } = ctx;
  const epic = await provider.getTicket(epicId);
  await assertAcceptanceSpecGate({ epic, epicId, provider });
  return { ...state, epic };
}

/**
 * Refuse to launch /epic-deliver when the acceptance-spec precondition has
 * not been satisfied. Throws a clear `Error` (per
 * orchestration-error-handling rule) so the `runAsCli` boundary maps it to
 * `process.exit(1)` with the operator-visible message intact.
 *
 * @param {{ epic: { labels?: string[], linkedIssues?: { acceptanceSpec?: number|null }|null, body?: string }, epicId: number, provider: { getTicket: Function } }} args
 */
async function assertAcceptanceSpecGate({ epic, epicId, provider }) {
  const labels = epic?.labels ?? [];
  if (labels.includes(ACCEPTANCE_NA)) return;

  const linkedIssues =
    epic?.linkedIssues ?? parseLinkedIssues(epic?.body ?? '');
  const acceptanceSpecId = linkedIssues?.acceptanceSpec ?? null;

  if (!acceptanceSpecId) {
    throw new Error(
      `[epic-deliver] Epic #${epicId} cannot launch: no context::acceptance-spec is linked and the acceptance::n-a waiver label is absent. ` +
        'Run /epic-plan Phase 7 to author and approve an acceptance-spec, or apply the acceptance::n-a label to the Epic to opt out.',
    );
  }

  const acceptanceSpec = await provider.getTicket(acceptanceSpecId);
  if (acceptanceSpec?.state !== 'closed') {
    throw new Error(
      `[epic-deliver] Epic #${epicId} cannot launch: linked acceptance-spec #${acceptanceSpecId} is still open. ` +
        'Close (approve) the acceptance-spec ticket before re-running /epic-deliver, or apply the acceptance::n-a label to waive the requirement.',
    );
  }
}
