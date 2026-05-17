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
import { ACCEPTANCE_NA, TYPE_LABELS } from '../../../label-constants.js';

/**
 * Run the snapshot phase.
 *
 * Behavior is unchanged from the pre-lifecycle-bus path: fetch the Epic
 * ticket and assert the acceptance-spec start gate. When the collaborator
 * factory provides a `bus`, the phase ALSO emits `epic.snapshot.start` at
 * entry and `epic.snapshot.end` at exit. The legacy code path remains
 * the source of truth for runner state (parallel writes — Story #2233
 * proves the bus contract end-to-end without cutting over yet). When no
 * `bus` is provided (e.g. unit fixtures that pass `{}` as collaborators),
 * emits are skipped silently for backward compatibility.
 *
 * `epic.snapshot.end` carries the enumerated story IDs the Epic owns
 * (matching the schema at `.agents/schemas/lifecycle/epic.snapshot.end.schema.json`).
 * This makes the snapshot record self-describing on disk: a reader of
 * `temp/epic-<id>/lifecycle.ndjson` can recover the dispatch set without
 * re-querying the provider.
 */
export async function runSnapshotPhase(ctx, collaborators, state) {
  const { epicId, provider } = ctx;
  const bus = collaborators?.bus ?? null;
  if (bus) {
    await bus.emit('epic.snapshot.start', { epicId });
  }
  const epic = await provider.getTicket(epicId);
  assertAcceptanceSpecGate({ epic, epicId });
  let storyIds = [];
  if (bus) {
    storyIds = await discoverStoryIds({ epicId, provider });
    await bus.emit('epic.snapshot.end', { epicId, storyIds });
  }
  return { ...state, epic };
}

/**
 * Enumerate the Story IDs owned by an Epic. Mirrors the filter used by
 * `runBuildWaveDagPhase` so the snapshot.end payload and the wave DAG
 * input set never disagree. Foreign / non-Story descendants are dropped.
 *
 * Returns a sorted array of positive integers (sort order makes the
 * ledger record deterministic across runs and platform iteration
 * quirks, which is what AC-3 / resume determinism depends on).
 */
async function discoverStoryIds({ epicId, provider }) {
  const descendants = (await provider.getSubTickets(epicId)) ?? [];
  const ids = descendants
    .filter((t) => (t.labels ?? []).includes(TYPE_LABELS.STORY))
    .map((t) => Number(t.id ?? t.number))
    .filter((id) => Number.isInteger(id) && id > 0);
  return [...new Set(ids)].sort((a, b) => a - b);
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
