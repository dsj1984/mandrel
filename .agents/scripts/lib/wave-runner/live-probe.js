/**
 * lib/wave-runner/live-probe.js — the state-probing adapter that feeds the
 * ready-set kernel from live GitHub state.
 *
 * `selectReadySet` (`./ready-set.js`) is deliberately a pure, side-effect-free
 * kernel: callers hand it the live Story records, the done set, and the
 * in-flight count, and it decides. Until now the only adapter was the
 * flag-driven one (`stories-wave-tick.js --dag/--done/--in-flight`), which
 * pushed the *gathering* of those inputs onto the caller — in practice onto
 * the host LLM following `/deliver`'s prose, re-seeding `--done` and counting
 * `--in-flight` by hand every beat. That is hand-maintained accounting on the
 * one correctness-critical path where a mistake silently wedges a run (a
 * dropped foreign blocker) or double-dispatches a Story (a miscounted slot).
 *
 * This module closes that gap by **probing** the same facts the host was
 * transcribing:
 *
 *   - **done** — an `agent::done` label OR a closed issue, the same predicate
 *     `classifyStory` already applies, evaluated over live state rather than a
 *     `--done` CSV the caller maintained across beats. Foreign blockers
 *     (outside the delivered set) are resolved too, which is what makes
 *     cross-run delivery work: a blocker that merged weeks ago in another run
 *     is simply done.
 *   - **in-flight** — derived from live `agent::executing` / `agent::closing`
 *     labels, **unioned with the ids the host says it has dispatched**
 *     (`--dispatched`). The label alone is not sufficient: the kernel's
 *     contract counts "executing / closing / dispatched-not-yet-labelled" as
 *     in-flight, and there is still a window between the host spawning a
 *     sub-agent and that sub-agent's `single-story-init.js` publishing the
 *     `agent::executing` label. Story #4620 shrank that window sharply — the
 *     flip now lands before the multi-minute worktree install rather than
 *     after it — but it is not zero (init still runs the lease acquire and a
 *     branch fetch first), so a label-only derivation could still re-emit a
 *     just-dispatched Story in the next beat's `ready[]` and dispatch it a
 *     second time onto the same branch (Story #4601). `--dispatched` closes
 *     the residual window; foreign runs are covered by the assignee lease
 *     (see `deriveForeignHeld`).
 *   - **blocked** — the ids carrying `agent::blocked`. `classifyStory` has
 *     always returned this class; nothing consumed it, so a blocked Story was
 *     neither done, ready, nor in-flight and the beat reported a permanent
 *     "waiting" (Story #4601).
 *
 * It is an **adapter, not a kernel change**: it gathers inputs and hands them
 * to `selectReadySet` unchanged. The kernel stays pure and flag-driven, and
 * the legacy flag mode stays byte-compatible.
 *
 * The graph resolution is **not** reimplemented here — it reuses
 * `resolve-stories.js`'s machinery wholesale (body `depends_on` ∪ native
 * `blocked_by` edges, foreign-blocker resolution, `files[]` footprints), so
 * the probe and `/deliver`'s step-1 resolution cannot disagree about what
 * depends on what.
 *
 * @module lib/wave-runner/live-probe
 */

import {
  fetchStories,
  readNativeEdges,
  resolveForeignDone,
  resolveStoriesProvider,
} from '../../resolve-stories.js';
import { AGENT_LABELS } from '../label-constants.js';
import { buildStoriesEnvelope } from '../orchestration/resolve-stories.js';
import {
  currentOwner,
  normalizeOperatorHandle,
} from '../orchestration/ticket-lease.js';
import { classifyStory, storyIdOf } from './ready-set.js';

/**
 * Identify the Stories that currently occupy a dispatch slot, as an id set.
 *
 * Two sources, unioned — which is exactly the kernel's stated contract
 * ("executing / closing / dispatched-not-yet-labelled"):
 *
 *   1. **Live labels.** `classifyStory` folds `agent::executing` and
 *      `agent::closing` into one `executing` class — both are in-flight and
 *      neither may be re-dispatched.
 *   2. **`dispatched`** — ids the host has spawned. This closes the residual
 *      init window: between the host spawning a sub-agent and that agent's
 *      `single-story-init.js` publishing `agent::executing`, a dispatched Story
 *      still reads `agent::ready` and a label-only derivation hands it back as
 *      ready. Story #4620 moved the flip ahead of the worktree install, so the
 *      window is now short rather than minutes-long, but `--dispatched` still
 *      covers it deterministically.
 *
 * `dispatched` is deliberately **not** the `--done`-style accounting probe
 * mode retired. Three properties keep it from becoming one:
 *
 *   - **It is a set union, not a counter.** Re-passing an id that has since
 *     picked up its `agent::executing` label cannot double-count a slot.
 *   - **Live state overrules the claim.** An id the host still lists but that
 *     now classifies `done` (or `blocked`) is dropped, so a stale entry can
 *     never occupy a slot forever and starve the run.
 *   - **Therefore the host's correct strategy is monotonic append**: pass
 *     every id you have dispatched this run and never reason about removing
 *     one. There is no drop-a-slot decision to get wrong — the probe subtracts
 *     reality from the claim. Forgetting an id degrades to the pre-#4601
 *     behaviour rather than to something worse.
 *
 * Ids outside the probed set are ignored: they are not part of this run and
 * must not consume its cap.
 *
 * @param {Array<{id?: number, number?: number, labels?: string[], state?: string}>} storyRecords
 * @param {Iterable<number>} [dispatched] Ids the host has spawned.
 * @returns {Set<number>} In-flight Story ids.
 */
function deriveInFlightIds(storyRecords, dispatched = []) {
  const claimed = new Set(dispatched);
  const inFlight = new Set();
  for (const rec of storyRecords) {
    const id = storyIdOf(rec);
    if (id === null) continue;
    const cls = classifyStory(rec);
    if (cls === 'executing' || (claimed.has(id) && cls === 'ready')) {
      inFlight.add(id);
    }
  }
  return inFlight;
}

/**
 * The ids carrying `agent::blocked`.
 *
 * `classifyStory` has always returned a `blocked` class, but no adapter
 * consumed it: a blocked Story was never done, never ready, and never counted
 * in-flight, so `detectWedge` dropped it (its "undone work with no unmet
 * blockers would have been dispatched" invariant is precisely what probe mode
 * broke) and the beat reported exit 0 / `ready: []` / `wedged: null` forever.
 * `/deliver` reads that as "waiting", so the `agent::blocked` HITL pause — the
 * one runtime gate in the protocol — was never surfaced to the operator.
 *
 * @param {Array<{id?: number, number?: number, labels?: string[], state?: string}>} storyRecords
 * @returns {number[]} Blocked Story ids, ascending.
 */
function deriveBlockedIds(storyRecords) {
  return storyRecords
    .filter((rec) => classifyStory(rec) === 'blocked')
    .map((rec) => storyIdOf(rec))
    .filter((id) => id !== null)
    .sort((a, b) => a - b);
}

/**
 * Identify Stories claimed by a **different** operator's lease.
 *
 * The Story lease rides the ticket's assignees (`ticket-lease.js`): the sole
 * assignee is the operator driving that Story's run. `single-story-init.js`
 * takes the lease at init, but flips `agent::executing` only after a 3–6 minute
 * worktree install — so for that whole window a Story another operator is
 * actively delivering still reads `agent::ready` with no in-flight label. A
 * label-only probe classifies it `ready` and hands it to this run, which then
 * dispatches into a guaranteed init failure (the fail-closed lease refuses a
 * foreign assignee) mid-batch. Reading the assignee lets the probe withhold it
 * up front and report who holds it instead.
 *
 * Only Stories that would otherwise be `ready` are considered — a `done`,
 * `blocked`, or already-`executing` Story is handled by its own class, and a
 * self-held assignee is this run's own claim and never withholds.
 *
 * When `self` is unresolved (no `github.operatorHandle`), foreign cannot be
 * told from self, so this returns empty and warns once: the probe is a
 * read-only path that must not fail closed, and init's lease acquire remains
 * the backstop.
 *
 * @param {Array<{id?: number, number?: number, labels?: string[], state?: string, assignees?: string[]}>} storyRecords
 * @param {string|null|undefined} self  Resolved bare operator login for this run.
 * @param {(msg: string) => void} [warn]
 * @returns {Map<number, string>} Foreign-held Story id → holder login.
 */
function deriveForeignHeld(storyRecords, self, warn) {
  const held = new Map();
  if (!self) {
    warn?.(
      '[live-probe] github.operatorHandle is unset (or the shipped ' +
        '@[USERNAME] placeholder), so a foreign lease cannot be told from ' +
        'this run’s own claim — skipping assignee-based withholding. ' +
        'Set your handle in .agentrc.local.json to de-conflict concurrent ' +
        'runs at probe time; init’s lease still refuses a foreign claim.',
    );
    return held;
  }
  for (const rec of storyRecords) {
    const id = storyIdOf(rec);
    if (id === null || classifyStory(rec) !== 'ready') continue;
    const owner = currentOwner(rec.assignees);
    if (owner && owner !== self) held.set(id, owner);
  }
  return held;
}

/**
 * Resolve the provider + repo coordinates the probe reads through.
 *
 * Shares `resolve-stories.js`'s provider seam, so probe mode authenticates and
 * targets exactly the same repo `/deliver`'s resolution step does. Tests
 * inject a stub provider instead of calling this.
 *
 * @param {object} [deps]
 * @param {Function} [deps.resolveProvider] Injection seam for tests.
 * @returns {{ provider: object, owner: string|undefined, repo: string|undefined, self: string|null }}
 */
export function createProbeContext({
  resolveProvider = resolveStoriesProvider,
} = {}) {
  const { provider, config } = resolveProvider();
  return {
    provider,
    owner: config?.github?.owner,
    repo: config?.github?.repo,
    // Bare login this run claims leases under. Normalised (leading `@` stripped,
    // `@[USERNAME]` placeholder → null) so it compares against the bare assignee
    // logins GitHub returns; `null` disables assignee-based withholding.
    self: normalizeOperatorHandle(config?.github?.operatorHandle),
  };
}

/**
 * Probe live state for a set of Story ids and return the exact inputs
 * `selectReadySet` consumes.
 *
 * Mirrors `resolve-stories.js`'s two-pass envelope build: a provisional pass
 * yields the DAG whose foreign dependency ids are then resolved against live
 * issue state, and the second pass folds those satisfied foreign blockers into
 * `done[]`. Skipping that pass would withhold any Story whose blocker landed
 * outside the delivered set — the cross-run wedge the resolver exists to fix.
 *
 * @param {object} args
 * @param {number[]} args.ids            Story ids in the run.
 * @param {object} args.provider         GitHub provider (stubbed in tests).
 * @param {string} [args.owner]
 * @param {string} [args.repo]
 * @param {boolean} [args.native=true]   Read native `blocked_by` edges.
 * @param {number[]} [args.dispatched=[]] Ids the host has spawned but may not
 *   yet have observed labelled `agent::executing` (see `deriveInFlightIds`).
 * @param {string|null} [args.self]     Resolved bare operator login for this
 *   run, used to withhold Stories another operator's lease holds
 *   (`deriveForeignHeld`). Absent/unresolved → assignee-based withholding is
 *   skipped (the probe never fails closed).
 * @param {(msg: string) => void} [args.warn]
 * Each returned node carries its **live labels**. That is load-bearing, not
 * decoration: `selectReadySet` classifies from labels, so a node stripped of
 * them reads as `ready` and an `agent::executing` Story gets re-dispatched
 * onto a second branch while its first run is still going. The resolver's DAG
 * projection (`{id, dependsOn, files}`) drops labels because flag mode's
 * caller tracked in-flight itself; probe mode must put them back.
 *
 * @returns {Promise<{
 *   nodes: Array<{id: number, dependsOn: number[], files: string[], labels: string[]}>,
 *   doneIds: Set<number>,
 *   inFlight: number,
 *   blockedIds: number[],
 *   foreignHeld: Array<{id: number, holder: string}>
 * }>}
 */
export async function probeLiveState({
  ids,
  provider,
  owner,
  repo,
  native = true,
  dispatched = [],
  self,
  warn,
}) {
  const stories = await fetchStories(provider, ids);
  const nativeEdges = native
    ? await readNativeEdges({ provider, stories, owner, repo })
    : new Map();

  const provisional = buildStoriesEnvelope({ stories, nativeEdges, warn });
  const foreignDone = await resolveForeignDone({
    provider,
    dag: provisional.dag,
    inSetIds: new Set(stories.map((s) => s.id)),
  });
  const envelope = buildStoriesEnvelope({
    stories,
    nativeEdges,
    foreignDone,
    warn: () => {},
  });

  const labelsById = new Map(stories.map((s) => [s.id, s.labels ?? []]));
  const inFlightIds = deriveInFlightIds(stories, dispatched);
  // A Story another operator's lease holds occupies a (global) dispatch slot
  // just like an in-flight one: fold it into the in-flight set so it is both
  // withheld (via the projected label) and excluded from a false wedge, but
  // never dispatched by this run.
  const foreignHeld = deriveForeignHeld(stories, self, warn);
  for (const id of foreignHeld.keys()) inFlightIds.add(id);
  return {
    nodes: envelope.dag.map((node) => ({
      ...node,
      labels: projectInFlightLabels(
        labelsById.get(node.id) ?? [],
        inFlightIds.has(node.id),
      ),
    })),
    doneIds: new Set(envelope.done),
    inFlight: inFlightIds.size,
    blockedIds: deriveBlockedIds(stories),
    foreignHeld: [...foreignHeld].map(([id, holder]) => ({ id, holder })),
  };
}

/**
 * Project the in-flight fact onto a node's labels, synthesizing
 * `agent::executing` for a Story that is dispatched but not yet labelled.
 *
 * This is the load-bearing half of the dispatch-window fix, and it is why
 * `inFlight` alone is not enough. The two inputs do **different** jobs inside
 * `selectReadySet`:
 *
 *   - `inFlight` is only a **count**. It reserves capacity (`slots = cap −
 *     inFlight`) and nothing more.
 *   - **Eligibility is decided per-record by `classifyStory`**, from labels.
 *
 * So a dispatched-but-unlabelled Story counted only via `inFlight` still
 * classifies `ready`, stays eligible, and — whenever a slot remains — is
 * admitted to the very same beat that reserved a slot for it. It would be
 * re-dispatched onto its own live branch, with the miscount merely reshaped
 * rather than fixed. Handing the kernel the label makes it apply the rule it
 * already has, and keeps the kernel itself untouched: the adapter's job is to
 * supply the input the kernel's contract ("executing / closing / dispatched-
 * not-yet-labelled") already specifies.
 *
 * @param {string[]} labels    The Story's live labels.
 * @param {boolean} inFlight   Whether the Story occupies a dispatch slot.
 * @returns {string[]} Labels, with `agent::executing` added when needed.
 */
function projectInFlightLabels(labels, inFlight) {
  if (!inFlight || classifyStory({ labels }) === 'executing') return labels;
  return [...labels, AGENT_LABELS.EXECUTING];
}

/**
 * Validate the mode-selecting flags, keeping probe mode and the legacy
 * flag mode mutually exclusive.
 *
 * The exclusion is not pedantry: `--probe-live` derives `done` and `in-flight`
 * from live state, so honouring a caller-supplied `--done` alongside it would
 * silently reintroduce the hand-maintained accounting probe mode exists to
 * retire — and quietly disagree with reality when the two differ.
 *
 * `--dispatched` is the deliberate exception, and it is **additive rather than
 * authoritative**: it does not replace the derived in-flight set, it is unioned
 * into it and then filtered by live state (see `deriveInFlightIds`). It carries
 * the one fact the host knows and GitHub does not yet — "I spawned this id, the
 * label has not appeared yet" — so it cannot disagree with reality the way an
 * authoritative `--in-flight <n>` could. `--in-flight` therefore stays excluded.
 *
 * @param {object} flags
 * @param {boolean} [flags.probeLive]
 * @param {string} [flags.stories]
 * @param {string} [flags.dag]
 * @param {string} [flags.dagFile]
 * @param {string} [flags.done]
 * @param {string} [flags.inFlight]
 * @param {string} [flags.dispatched]
 * @returns {string|null} An error message, or `null` when the flags are valid.
 */
export function validateProbeFlags({
  probeLive,
  stories,
  dag,
  dagFile,
  done,
  inFlight,
  dispatched,
} = {}) {
  if (!probeLive) {
    if (dispatched != null) {
      return '--dispatched requires --probe-live (it augments the live-derived in-flight set; flag mode uses --in-flight <n>)';
    }
    return stories
      ? '--stories requires --probe-live (it names the run to probe from live state)'
      : null;
  }
  const conflicting = [
    dag ? '--dag' : null,
    dagFile ? '--dag-file' : null,
    done != null ? '--done' : null,
    inFlight != null ? '--in-flight' : null,
  ].filter(Boolean);
  if (conflicting.length > 0) {
    return (
      `--probe-live is mutually exclusive with ${conflicting.join(', ')}: it resolves the graph ` +
      `and derives done / in-flight from live state. Drop the flag(s), or use the legacy flag mode.`
    );
  }
  if (!stories) {
    return '--probe-live requires --stories <csv> of Story ids';
  }
  return null;
}
