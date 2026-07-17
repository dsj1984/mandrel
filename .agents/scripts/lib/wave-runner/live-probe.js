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
 *     labels rather than a `--in-flight <n>` the caller incremented.
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
import { buildStoriesEnvelope } from '../orchestration/resolve-stories.js';
import { classifyStory } from './ready-set.js';

/**
 * Count the Stories that currently occupy a dispatch slot.
 *
 * `classifyStory` folds `agent::executing` and `agent::closing` into one
 * `executing` class — both are in-flight, and neither may be re-dispatched.
 * Deriving this from live labels (rather than a caller-maintained counter) is
 * the whole point of probe mode: a host that miscounts a slot either
 * over-dispatches past the cap or starves the run.
 *
 * @param {Array<{labels?: string[], state?: string}>} storyRecords
 * @returns {number}
 */
function deriveInFlight(storyRecords) {
  return storyRecords.filter((rec) => classifyStory(rec) === 'executing')
    .length;
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
 * @returns {{ provider: object, owner: string|undefined, repo: string|undefined }}
 */
export function createProbeContext({
  resolveProvider = resolveStoriesProvider,
} = {}) {
  const { provider, config } = resolveProvider();
  return { provider, owner: config?.github?.owner, repo: config?.github?.repo };
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
 *   inFlight: number
 * }>}
 */
export async function probeLiveState({
  ids,
  provider,
  owner,
  repo,
  native = true,
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
  return {
    nodes: envelope.dag.map((node) => ({
      ...node,
      labels: labelsById.get(node.id) ?? [],
    })),
    doneIds: new Set(envelope.done),
    inFlight: deriveInFlight(stories),
  };
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
 * @param {object} flags
 * @param {boolean} [flags.probeLive]
 * @param {string} [flags.stories]
 * @param {string} [flags.dag]
 * @param {string} [flags.dagFile]
 * @param {string} [flags.done]
 * @param {string} [flags.inFlight]
 * @returns {string|null} An error message, or `null` when the flags are valid.
 */
export function validateProbeFlags({
  probeLive,
  stories,
  dag,
  dagFile,
  done,
  inFlight,
} = {}) {
  if (!probeLive) {
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
