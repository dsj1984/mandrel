/**
 * Adapter that probes live GitHub state (done, in-flight, blocked, foreign
 * leases) into `planReadySet`'s inputs, so no caller hand-maintains them. Graph
 * resolution reuses `resolve-stories.js` so the probe cannot disagree with
 * `/mandrel-deliver`'s resolution about dependencies.
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
 * In-flight ids: live executing/closing labels ∪ host-`dispatched` ids still
 * reading `ready` (the window before init publishes `agent::executing`).
 * `dispatched` is a set union overruled by live state (a done/blocked id is
 * dropped), so the host should append monotonically and never remove. Ids
 * outside the probed set are ignored. The claimed-but-`ready` subset is also
 * returned as `unlabelled`: a slow init and a spawn that never started look
 * identical here, so it is surfaced for the operator, not acted on.
 *
 * @param {Array<{id?: number, number?: number, labels?: string[], state?: string}>} storyRecords
 * @param {Iterable<number>} [dispatched]
 * @returns {{inFlight: Set<number>, unlabelled: Set<number>}}
 */
function deriveInFlightIds(storyRecords, dispatched = []) {
  const claimed = new Set(dispatched);
  const byClass = { executing: new Set(), ready: new Set() };
  for (const rec of storyRecords) {
    const id = storyIdOf(rec);
    if (id === null) continue;
    const cls = classifyStory(rec);
    if (cls === 'executing' || (claimed.has(id) && cls === 'ready')) {
      byClass[cls].add(id);
    }
  }
  return {
    inFlight: new Set([...byClass.executing, ...byClass.ready]),
    unlabelled: byClass.ready,
  };
}

/**
 * Ids carrying `agent::blocked`, ascending. Reported explicitly because a
 * blocked Story is neither done, ready nor in-flight, and would otherwise
 * read as an endless "waiting" that hides the HITL pause.
 *
 * @param {Array<{id?: number, number?: number, labels?: string[], state?: string}>} storyRecords
 * @returns {number[]}
 */
function deriveBlockedIds(storyRecords) {
  return storyRecords
    .filter((rec) => classifyStory(rec) === 'blocked')
    .map((rec) => storyIdOf(rec))
    .filter((id) => id !== null)
    .sort((a, b) => a - b);
}

/**
 * `ready` Stories whose assignee lease belongs to another operator: they can
 * read `ready` while that operator's init is still running, and dispatching
 * them would hit init's fail-closed lease mid-batch. With `self` unresolved
 * this warns and returns empty (a read-only probe must not fail closed; init
 * remains the backstop).
 *
 * @param {Array<{id?: number, number?: number, labels?: string[], state?: string, assignees?: string[]}>} storyRecords
 * @param {string|null|undefined} self  Bare operator login for this run.
 * @param {(msg: string) => void} [warn]
 * @returns {Map<number, string>} Story id → holder login.
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
 * Provider + repo coordinates, via `resolve-stories.js`'s provider seam.
 *
 * @param {object} [deps]
 * @param {Function} [deps.resolveProvider]
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
    // Bare login (placeholder → null, which disables lease withholding).
    self: normalizeOperatorHandle(config?.github?.operatorHandle),
  };
}

/**
 * Probe live state into `planReadySet`'s inputs. Two-pass envelope build: the
 * second pass folds foreign blockers that are done into `done[]`, or a Story
 * blocked by work landed outside the set would wedge. Nodes carry live labels
 * because the kernel classifies from them; without them an executing Story is
 * re-dispatched.
 *
 * @param {object} args
 * @param {number[]} args.ids
 * @param {object} args.provider
 * @param {string} [args.owner]
 * @param {string} [args.repo]
 * @param {boolean} [args.native=true]   Read native `blocked_by` edges.
 * @param {number[]} [args.dispatched=[]]
 * @param {string|null} [args.self]
 * @param {(msg: string) => void} [args.warn]
 * @returns {Promise<{
 *   nodes: Array<{id: number, dependsOn: number[], files: string[], body: string, labels: string[]}>,
 *   inFlightRecords: Array<{id: number, dependsOn: number[], files: string[], body: string, labels: string[]}>,
 *   doneIds: Set<number>,
 *   inFlight: number,
 *   blockedIds: number[],
 *   stalledDispatch: number[],
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
  // The `agent::*` guard is an admission check; a just-dispatched Story is
  // legitimately unlabelled until init flips it, so a per-beat probe allows it.
  const stories = await fetchStories(provider, ids, { allowUnlabelled: true });
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
  // Bodies are consumed in-process only; the beat envelope stays a list of ids.
  const bodyById = new Map(stories.map((s) => [s.id, s.body ?? '']));
  const { inFlight: inFlightIds, unlabelled } = deriveInFlightIds(
    stories,
    dispatched,
  );
  // A foreign-held Story counts as in flight: withheld, and not a false wedge.
  const foreignHeld = deriveForeignHeld(stories, self, warn);
  for (const id of foreignHeld.keys()) inFlightIds.add(id);
  const nodes = envelope.dag.map((node) => ({
    ...node,
    body: bodyById.get(node.id) ?? '',
    labels: projectInFlightLabels(
      labelsById.get(node.id) ?? [],
      inFlightIds.has(node.id),
    ),
  }));
  return {
    nodes,
    // Records (not just a count) so the kernel can reserve their footprints.
    inFlightRecords: nodes.filter((node) => inFlightIds.has(node.id)),
    doneIds: new Set(envelope.done),
    inFlight: inFlightIds.size,
    blockedIds: deriveBlockedIds(stories),
    // Reported, never released. A foreign lease outranks the claim, so one
    // Story never carries two recoveries.
    stalledDispatch: [...unlabelled]
      .filter((id) => !foreignHeld.has(id))
      .sort((a, b) => a - b),
    foreignHeld: [...foreignHeld].map(([id, holder]) => ({ id, holder })),
  };
}

/**
 * Synthesize `agent::executing` for a dispatched-but-unlabelled Story. The
 * `inFlight` count only reserves capacity; eligibility is per-record from
 * labels, so without this the Story stays `ready` and is re-dispatched.
 *
 * @param {string[]} labels
 * @param {boolean} inFlight
 * @returns {string[]}
 */
function projectInFlightLabels(labels, inFlight) {
  if (!inFlight || classifyStory({ labels }) === 'executing') return labels;
  return [...labels, AGENT_LABELS.EXECUTING];
}

/**
 * Keep `--probe-live` exclusive of the flag-mode inputs it derives from live
 * state (`--done`, `--in-flight`, ...), which could otherwise disagree with
 * reality. `--dispatched` is allowed because it is additive and filtered by
 * live state.
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
