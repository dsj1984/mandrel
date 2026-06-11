/**
 * Epic snapshot phase — fetch Epic ticket and enforce the acceptance-spec
 * start gate.
 *
 * Auto-close is now the default for `/deliver` (the human PR-merge is
 * the gate); no per-Epic label snapshot is required.
 *
 * Acceptance-spec start gate (relaxed): an Epic may be delivered when
 * *either* the operator has explicitly waived the acceptance-spec
 * requirement via the `acceptance::n-a` label, *or* a
 * `context::acceptance-spec` ticket is linked to the Epic. The ticket's
 * GitHub state (open / closed) is **not** checked — presence is
 * sufficient, matching the PRD and Tech Spec contract. The reviewer's
 * OK during /plan Phase 7 is the approval signal, not a manual
 * ticket-close action. This still refuses to launch Epics that skipped
 * the /plan Phase 7 acceptance-spec authoring step (or didn't
 * waive), surfacing the gap at delivery time rather than letting Story
 * dispatch race ahead without a spec at all.
 */

import { parseLinkedIssues } from '../../../issue-link-parser.js';
import { ACCEPTANCE_NA } from '../../../label-constants.js';
import { discoverOpenStories } from './build-wave-dag.js';

/**
 * Run the snapshot phase.
 *
 * Fetch the Epic ticket, assert the acceptance-spec start gate, and emit
 * `epic.snapshot.start` at entry and `epic.snapshot.end` at exit via the
 * lifecycle bus. After the Epic #2880 / Story #2898 hard cutover the bus
 * is the sole mutator of phase state — production wiring (see
 * `createEpicRunnerCollaborators`) always supplies a bus, and named
 * listeners on the bus (LabelTransitioner, StructuredCommentPoster, …)
 * own every state side effect. The phase return shape (`{ ...state, epic }`)
 * is the function's contract with the runner pipeline; it is not a parallel
 * state write.
 *
 * The `bus` parameter is still defensively typed as optional because unit
 * fixtures occasionally pass `{}` as the collaborator bag (e.g. the
 * acceptance-spec gate tests under `tests/epic-runner/`); those callers
 * skip the emit but still exercise the gate logic. Production cannot
 * reach the `!bus` branch.
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
 * Enumerate the Story IDs owned by an Epic. Delegates to
 * `discoverOpenStories` so the snapshot.end payload and the wave DAG
 * input set never disagree — both enumerate the Epic's direct Story
 * children and exclude closed reverse-referenced tickets.
 *
 * Returns a sorted array of positive integers (sort order makes the
 * ledger record deterministic across runs and platform iteration
 * quirks, which is what AC-3 / resume determinism depends on).
 */
async function discoverStoryIds({ epicId, provider }) {
  const stories = await discoverOpenStories({ epicId, provider });
  const ids = stories
    .map((t) => Number(t.id ?? t.number))
    .filter((id) => Number.isInteger(id) && id > 0);
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * Refuse to launch /deliver when the acceptance-spec precondition has
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
        'Run /plan Phase 7 to author an acceptance-spec, or apply the acceptance::n-a label to the Epic to opt out.',
    );
  }
}
