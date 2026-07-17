#!/usr/bin/env node

/**
 * stories-wave-tick.js — continuous ready-set planner for the standalone
 * `/deliver` story-list path.
 *
 * Thin **adapter** over the path-agnostic ready-set scheduling core
 * (`lib/wave-runner/ready-set.js#selectReadySet`). It emits the set of
 * Stories safe to dispatch **on this beat** — a Story becomes dispatchable
 * the instant its own dependencies are done, under the same global
 * concurrency cap and the same file-overlap co-dispatch guard
 * `lib/wave-runner/ready-set.js` applies everywhere. There is no wave barrier: this no longer batches
 * Stories into fully-draining waves; it selects continuously.
 *
 * The previous static wave-batch plan (group N must fully drain before
 * group N+1 opens, via `Graph.js#assignLayers`) is gone. The scheduling
 * kernel — adjacency derivation, the done-predicate classifier, the
 * eligibility rule, and the overlap guard — lives once in `selectReadySet`;
 * this file only gathers input, resolves the cap, and renders the envelope.
 *
 * **Two modes, one kernel.**
 *
 *   - **Probe mode** (`--stories <csv> --probe-live [--dispatched <csv>]`) is
 *     the canonical `/deliver` beat: the graph, the done set, and the in-flight
 *     count are resolved from **live state** via `lib/wave-runner/live-probe.js`.
 *     The caller supplies ids, so there is no accounting to hand-maintain
 *     across beats — the seed-the-first-beat's-`--done` footgun the workflow
 *     used to warn about is structurally impossible rather than merely
 *     documented. `--dispatched` is the one fact live state cannot yet report
 *     ("I spawned this id; its label has not appeared"); it is additive and
 *     live-state-filtered, never authoritative (Story #4601).
 *   - **Flag mode** (`--dag`/`--dag-file` + `--done`/`--in-flight`) keeps the
 *     caller-supplied contract byte-compatible for tests and hand-driven
 *     runs. The two are mutually exclusive: honouring a supplied `--done`
 *     under `--probe-live` would silently reintroduce exactly the
 *     hand-maintained state probe mode retires.
 *
 * Usage:
 *   node .agents/scripts/stories-wave-tick.js --stories 101,102 --probe-live
 *   node .agents/scripts/stories-wave-tick.js --dag '<json>'
 *   node .agents/scripts/stories-wave-tick.js --dag-file <path>
 *   node .agents/scripts/stories-wave-tick.js --dag '<json>' --concurrency 5
 *   node .agents/scripts/stories-wave-tick.js --dag '<json>' --done 101,103 --in-flight 1
 *
 * DAG input format (JSON):
 *   Array of { id: number, dependsOn: number[] } objects where id is a Story
 *   ticket number and dependsOn lists Story IDs that must complete first.
 *
 * Output: one JSON object on stdout with shape:
 *   {
 *     kind: 'stories-ready-set',
 *     ready: number[],          // Story IDs safe to dispatch on this beat
 *     totalStories: number,
 *     concurrencyCap: number,
 *     inFlight: number,
 *     cycleError: string | null,
 *     wedged: { reason, stories: [{ id, unmetBlockers }] } | null
 *   }
 *
 * Probe mode adds fields the caller can no longer compute for itself:
 * `done: number[]` (the resolved done set, in-set ∪ satisfied foreign
 * blockers), `epilogueDue: boolean` (true exactly when every listed Story
 * is done — the run-end signal for `plan-run-epilogue.js`), and `blocked:
 * number[]` + `blockedReason: string|null` (Story #4601 — the `agent::blocked`
 * HITL pause, which ends the loop rather than being polled).
 *
 * The standalone loop calls this once per beat and dispatches the returned
 * `ready` set (already capped at `concurrencyCap − inFlight` by the core).
 * Under `--probe-live` each beat re-reads reality, so the run is complete
 * when `epilogueDue` is true; under flag mode the caller re-supplies `--done`
 * and `--in-flight` itself, and the run is complete when every Story is in
 * `--done` and `ready` is empty.
 *
 * The per-beat concurrency cap is resolved from the same config seam
 * `/deliver` uses — `resolveConfig` + `getRunners` reading
 * `delivery.deliverRunner.concurrencyCap` (default 3) — so a
 * `.agentrc.local.json` override is honored. A `--concurrency <n>` CLI flag
 * overrides the config-resolved value for that run only. This shares one
 * deterministic config source (`delivery.deliverRunner.concurrencyCap`) and
 * one scheduling kernel with every `/deliver` multi-Story invocation.
 *
 * Exit codes: 0 ok · 1 input error · 2 dependency cycle (`cycleError`) ·
 * 3 wedged (`wedged`) — ready is empty, nothing is in flight, and undone
 * Stories are waiting on blockers that are not done · 4 blocked (`blocked`) —
 * a Story carries `agent::blocked`. A cycle is a self-referential DAG the
 * operator must fix; a wedge is a well-formed DAG whose gates cannot be
 * satisfied from the supplied `--done` set (usually a blocker outside the
 * delivered set that has not landed); a block is the protocol's HITL pause,
 * where a human owes a decision no beat can supply. All three are distinct
 * from the ordinary `ready: []` that means "waiting on in-flight work" — and
 * that distinction is the point: each of them previously presented AS that
 * ordinary empty set, so the loop polled a state that could never improve.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { getRunners, resolveConfig } from './lib/config-resolver.js';
import { detectCycle } from './lib/Graph.js';
import { Logger } from './lib/Logger.js';
import { AGENT_LABELS } from './lib/label-constants.js';
import { parseIds } from './lib/orchestration/resolve-stories.js';
import { buildStoryAdjacency } from './lib/story-adjacency.js';
import {
  createProbeContext,
  probeLiveState,
  validateProbeFlags,
} from './lib/wave-runner/live-probe.js';
import { selectReadySet } from './lib/wave-runner/ready-set.js';

/**
 * Exit code for a wedged run — deliberately distinct from the cycle exit (2)
 * so a caller can tell "your DAG is self-referential" from "your DAG is fine
 * but its gates can never be satisfied from this `--done` set".
 */
export const WEDGED_EXIT_CODE = 3;

/**
 * Exit code for a run holding an `agent::blocked` Story — distinct from the
 * cycle (2) and wedge (3) exits because the remediation is categorically
 * different: a cycle is a malformed DAG and a wedge is an unlanded blocker,
 * whereas this is the protocol's one runtime HITL pause. A human must decide
 * something before any beat can help. Probe-mode only: flag-mode nodes carry
 * no labels, so nothing there can classify blocked.
 */
export const BLOCKED_EXIT_CODE = 4;

const HELP = `Usage:
  node .agents/scripts/stories-wave-tick.js --stories <csv> --probe-live [--dispatched <csv>] [--concurrency <n>]
  node .agents/scripts/stories-wave-tick.js --dag '<json>' | --dag-file <path> [--concurrency <n>] [--done <csv>] [--in-flight <n>]

Continuous ready-set planner for standalone Story delivery. Emits the set of
Stories safe to dispatch on this beat — a Story is dispatchable the instant
its own dependencies are done — plus the resolved per-beat concurrency cap
and the same file-overlap guard as selectReadySet.

Two modes:
  --probe-live  Resolve the graph and derive done / in-flight from LIVE state
                (the canonical /deliver beat). Nothing is hand-maintained
                across beats. Mutually exclusive with --dag/--dag-file/--done/
                --in-flight. Adds "done" and "epilogueDue" to the envelope.
  --dag         Legacy flag mode: the caller supplies the graph and the run
                progress. Kept for tests and hand-driven runs.

Input DAG format (JSON array):
  [{ "id": 101, "dependsOn": [] }, { "id": 102, "dependsOn": [101] }]

Each entry must include:
  id         - Story ticket number (positive integer)
  dependsOn  - Array of Story IDs that must complete before this Story runs

Options:
  --stories <csv>    Story ids to deliver (probe mode). The graph, the done
                     set, and the in-flight count are resolved from live
                     state — no --done / --in-flight bookkeeping.
  --probe-live       Enable probe mode. Requires --stories.
  --dispatched <csv> Probe mode only. Ids you have SPAWNED this run. Unioned
                     into the live-derived in-flight set, then filtered by
                     live state, so it closes the init window: a Story reads
                     agent::ready for the 3-6 minutes single-story-init.js
                     takes to flip agent::executing, and without this it is
                     dispatched a second time onto the same branch. Append
                     every id you dispatch and never remove one — a stale id
                     that has since gone done is dropped automatically, so
                     over-supplying is free and forgetting is the only error.
  --concurrency <n>  Override the per-beat concurrency cap for this run only.
                     Must be a positive integer. When omitted, the cap is
                     resolved from delivery.deliverRunner.concurrencyCap in
                     .agentrc.json / .agentrc.local.json (default 3).
  --done <csv>       Comma-separated Story IDs already completed this run.
                     Their dependents become eligible; they are never
                     re-dispatched. Defaults to empty.
  --in-flight <n>    Count of Stories already occupying a slot (dispatched
                     but not yet done). Subtracted from the cap to compute
                     remaining capacity. Non-negative integer; defaults to 0.

Output envelope:
  {
    "kind": "stories-ready-set",
    "ready": [101],
    "totalStories": 2,
    "concurrencyCap": 3,
    "inFlight": 0,
    "cycleError": null,
    "wedged": null
  }

Exit codes:
  0 - Success, ready set emitted
  1 - Invalid input (missing/malformed DAG, invalid --concurrency/--in-flight/--done)
  2 - Cycle detected in dependency graph
  3 - Wedged: ready is empty, nothing is in flight, and undone Stories are
      waiting on blockers that are not done. Distinct from an ordinary empty
      ready set (which means "waiting on in-flight work") and from a cycle.
  4 - Blocked: a Story carries agent::blocked (probe mode only). The HITL
      pause — no beat can clear it. STOP the loop; do not poll.
`;

/**
 * Build the exit-1 input-error result. Shared by both modes so a malformed
 * `--concurrency` reports identically whether it arrived alongside `--dag` or
 * `--probe-live`.
 *
 * @param {string} message
 * @param {number|null} [concurrencyCap]
 * @param {number} [inFlightValue]
 * @returns {{ envelope: object, exitCode: 1 }}
 */
function inputErrorResult(message, concurrencyCap = null, inFlightValue = 0) {
  return {
    envelope: {
      kind: 'stories-ready-set',
      ready: [],
      totalStories: 0,
      concurrencyCap,
      inFlight: inFlightValue,
      cycleError: null,
      wedged: null,
      inputError: message,
    },
    exitCode: 1,
  };
}

/**
 * Parse and validate the raw DAG input array.
 *
 * Each entry must carry `{ id, dependsOn }`. An optional `files` string
 * array (the canonical footprint shape) is preserved and forwarded to the
 * ready-set core so the file-overlap co-dispatch guard the Epic path uses is
 * genuinely active on the standalone path too: two ready Stories that
 * declare an intersecting footprint are never dispatched onto parallel
 * `story-<id>` branches in the same beat.
 *
 * @param {unknown} raw Parsed JSON value from --dag or --dag-file.
 * @returns {{ nodes: Array<{id: number, dependsOn: number[], files?: string[]}>, error: string|null }}
 */
export function parseDag(raw) {
  if (!Array.isArray(raw)) {
    return { nodes: null, error: 'DAG input must be a JSON array' };
  }
  if (raw.length === 0) {
    return { nodes: [], error: null };
  }
  const nodes = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') {
      return {
        nodes: null,
        error: `DAG entry at index ${i} must be an object`,
      };
    }
    const id = entry.id;
    if (!Number.isInteger(id) || id <= 0) {
      return {
        nodes: null,
        error: `DAG entry at index ${i} must have a positive integer "id"`,
      };
    }
    const dependsOn = entry.dependsOn;
    if (!Array.isArray(dependsOn)) {
      return {
        nodes: null,
        error: `DAG entry at index ${i} (id=${id}) must have a "dependsOn" array`,
      };
    }
    for (let j = 0; j < dependsOn.length; j++) {
      const dep = dependsOn[j];
      if (!Number.isInteger(dep) || dep <= 0) {
        return {
          nodes: null,
          error: `DAG entry at index ${i} (id=${id}): dependsOn[${j}] must be a positive integer`,
        };
      }
    }
    const node = { id, dependsOn: [...dependsOn] };
    if (entry.files !== undefined) {
      if (
        !Array.isArray(entry.files) ||
        entry.files.some((f) => typeof f !== 'string')
      ) {
        return {
          nodes: null,
          error: `DAG entry at index ${i} (id=${id}): "files" must be an array of strings`,
        };
      }
      node.files = [...entry.files];
    }
    nodes.push(node);
  }
  return { nodes, error: null };
}

/**
 * Parse a comma-separated list of Story IDs into a deduped set of positive
 * integers. Empty / absent input yields an empty set. Rejects any token that
 * is not a positive integer so a typo never silently drops a dependency gate
 * (`--done`) or a held dispatch slot (`--dispatched`).
 *
 * @param {string|undefined} raw
 * @param {string} flag Flag name, for the error message.
 * @returns {{ ids: Set<number>|null, error: string|null }}
 */
export function parseIdCsv(raw, flag) {
  if (raw == null || raw === '') {
    return { ids: new Set(), error: null };
  }
  const ids = new Set();
  for (const token of String(raw).split(',')) {
    const trimmed = token.trim();
    if (trimmed === '') continue;
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num <= 0) {
      return {
        ids: null,
        error: `${flag} must be a comma-separated list of positive integers, got "${trimmed}"`,
      };
    }
    ids.add(num);
  }
  return { ids, error: null };
}

/**
 * Parse the `--done` CSV of already-completed Story IDs (flag mode).
 *
 * @param {string|undefined} raw
 * @returns {{ ids: Set<number>|null, error: string|null }}
 */
export function parseDoneIds(raw) {
  return parseIdCsv(raw, '--done');
}

/**
 * Parse the raw `--in-flight` value into a non-negative integer. Absent
 * input defaults to 0. Rejects negatives and non-integers.
 *
 * @param {unknown} raw
 * @returns {{ value: number|null, error: string|null }}
 */
export function parseInFlight(raw) {
  if (raw == null) {
    return { value: 0, error: null };
  }
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(num) || num < 0) {
    return {
      value: null,
      error: `--in-flight must be a non-negative integer, got "${raw}"`,
    };
  }
  return { value: num, error: null };
}

/**
 * Validate a raw `--concurrency` value into a positive integer.
 *
 * Accepts a number or a numeric string (from the CLI). Rejects anything that
 * is not a positive integer (zero, negative, fractional, non-numeric).
 *
 * @param {unknown} raw
 * @returns {{ value: number|null, error: string|null }}
 */
export function parseConcurrencyOverride(raw) {
  if (raw == null) {
    return { value: null, error: null };
  }
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(num) || num <= 0) {
    return {
      value: null,
      error: `--concurrency must be a positive integer, got "${raw}"`,
    };
  }
  return { value: num, error: null };
}

/**
 * Resolve the per-beat concurrency cap.
 *
 * Mirrors the `/deliver` multi-Story seam (`helpers/deliver-story.md`): resolve the
 * project config (which deep-merges `.agentrc.local.json` over `.agentrc.json`)
 * then read `delivery.deliverRunner.concurrencyCap` via `getRunners` (default
 * 3). An explicit `override` (the `--concurrency <n>` CLI flag) wins over
 * config for that run only.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]       Repo root for config resolution.
 * @param {object} [opts.config]    Pre-resolved config (injected by tests so
 *                                   they never depend on a real `.agentrc`).
 * @param {number} [opts.override]  Validated positive integer from
 *                                   `--concurrency`; wins over config.
 * @returns {number} The resolved positive-integer concurrency cap.
 */
export function resolveConcurrencyCap({ cwd, config, override } = {}) {
  if (override != null) {
    return override;
  }
  const resolved = config ?? resolveConfig({ cwd });
  const { deliverRunner } = getRunners(resolved);
  return deliverRunner.concurrencyCap;
}

/**
 * Build the per-beat ready-set envelope from a validated DAG.
 *
 * Maps each operator-DAG node onto a Story record the ready-set core
 * understands (`{ id, dependsOn }`), tags any node already in the done set
 * as `agent::done` so the core's classifier excludes it from the dispatch
 * set **and** counts it as a satisfied dependency, then delegates the
 * scheduling decision to `selectReadySet`. A cyclic operator DAG is a
 * planning error (the core would silently never schedule the cycle), so we
 * detect it up front via the shared `detectCycle` kernel and short-circuit
 * with a `cycleError` and exit code 2.
 *
 * @param {Array<{id: number, dependsOn: number[]}>} nodes
 * @param {object} args
 * @param {number} args.concurrencyCap Resolved per-beat concurrency cap.
 * @param {Set<number>} [args.doneIds] Story IDs already completed this run.
 * @param {number} [args.inFlight]     Stories already occupying a slot.
 * @returns {{
 *   envelope: {
 *     kind: 'stories-ready-set',
 *     ready: number[],
 *     totalStories: number,
 *     concurrencyCap: number,
 *     inFlight: number,
 *     cycleError: string|null
 *   },
 *   exitCode: number
 * }}
 */
export function buildReadySetEnvelope(
  nodes,
  { concurrencyCap, doneIds = new Set(), inFlight = 0 },
) {
  const totalStories = nodes.length;

  const base = {
    kind: 'stories-ready-set',
    ready: [],
    totalStories,
    concurrencyCap,
    inFlight,
    cycleError: null,
    wedged: null,
  };

  if (totalStories === 0) {
    return { envelope: base, exitCode: 0 };
  }

  // Cycle detection before scheduling — a cycle is a planning error the
  // operator must fix. dropForeign:false preserves the operator-DAG contract
  // (a dependency on an id outside the supplied set is honored, not pruned),
  // matching the same builder seam selectReadySet uses internally.
  const adjacency = buildStoryAdjacency(nodes, { dropForeign: false });
  const cycle = detectCycle(adjacency);
  if (cycle) {
    return {
      envelope: {
        ...base,
        cycleError: `Dependency cycle detected: ${cycle.join(' → ')}. Fix the depends_on declarations before running /deliver.`,
      },
      exitCode: 2,
    };
  }

  // Map DAG nodes → Story records. Tag done nodes as agent::done so the
  // core's classifier (a) excludes them from the dispatch set and (b) folds
  // them into the satisfied-dependency set, making their dependents eligible.
  // Forward any declared file footprint so the core's overlap guard fires.
  const records = nodes.map((node) => {
    const rec = {
      id: node.id,
      dependsOn: node.dependsOn,
      // A node's own live labels (probe mode) are preserved so the core's
      // classifier withholds an in-flight `agent::executing` / `agent::closing`
      // Story rather than re-dispatching it onto a second branch. Flag-mode
      // nodes carry none — `parseDag` accepts no labels — so this is inert
      // there and the legacy contract is unchanged.
      labels: doneIds.has(node.id) ? [AGENT_LABELS.DONE] : (node.labels ?? []),
    };
    if (node.files !== undefined) rec.files = node.files;
    return rec;
  });

  const ready = selectReadySet({
    stories: records,
    doneIds,
    inFlight,
    globalCap: concurrencyCap,
  }).map((rec) => rec.id);

  // Wedge detection (Story #4540). `ready: []` is normal while work is in
  // flight — the loop is simply waiting. But ready-empty AND nothing in
  // flight AND undone Stories remaining means no beat can ever make
  // progress: the run is stuck, and the previous behaviour was to return
  // exit 0 with an empty ready set forever, indistinguishable from
  // "waiting". Name the stuck ids and their unmet blockers.
  //
  // Distinct from `cycleError`/exit 2: a cycle is a self-referential DAG,
  // whereas this is a DAG whose gates are real but unsatisfiable from the
  // supplied `done` set (typically a blocker outside the delivered set that
  // has not landed).
  const wedge = detectWedge({ nodes, doneIds, ready, inFlight });
  if (wedge) {
    return {
      envelope: { ...base, ready, wedged: wedge },
      exitCode: WEDGED_EXIT_CODE,
    };
  }

  return { envelope: { ...base, ready, wedged: null }, exitCode: 0 };
}

/**
 * Identify a run that cannot progress: nothing dispatchable, nothing in
 * flight, work remaining.
 *
 * @param {{ nodes: object[], doneIds: Set<number>, ready: number[], inFlight: number }} args
 * @returns {{ reason: string, stories: Array<{ id: number, unmetBlockers: number[] }> }|null}
 */
export function detectWedge({ nodes, doneIds, ready, inFlight }) {
  if (ready.length > 0 || inFlight > 0) return null;
  const undone = nodes.filter((n) => !doneIds.has(n.id));
  if (undone.length === 0) return null;

  const stories = undone
    .map((n) => ({
      id: n.id,
      unmetBlockers: (n.dependsOn ?? []).filter((dep) => !doneIds.has(dep)),
    }))
    .filter((s) => s.unmetBlockers.length > 0);

  // Undone work with no unmet blockers would have been dispatched; if that
  // is the whole set, the cap or in-flight accounting explains the empty
  // ready set rather than a wedge.
  if (stories.length === 0) return null;

  const detail = stories
    .map((s) => `#${s.id} ← ${s.unmetBlockers.map((d) => `#${d}`).join(', ')}`)
    .join('; ');
  return {
    reason:
      `No Story can be dispatched: nothing is in flight and ${stories.length} ` +
      `Story(ies) are waiting on blockers that are not done — ${detail}. ` +
      `A blocker outside the delivered set must land first, or be included in --ids.`,
    stories,
  };
}

/**
 * Core logic: parse DAG input, resolve the concurrency cap, validate, and
 * compute the per-beat ready set via the shared scheduling core.
 *
 * Exported for unit tests; the CLI `main` function is a thin wrapper. Tests
 * inject `config` so they never depend on a real `.agentrc`.
 *
 * @param {object} args
 * @param {string} [args.dagJson]      Raw JSON string from --dag.
 * @param {string} [args.dagFile]      Path to a JSON file from --dag-file.
 * @param {string|number} [args.concurrency] Raw --concurrency override.
 * @param {string} [args.done]         Raw --done CSV of completed Story IDs.
 * @param {string|number} [args.inFlight] Raw --in-flight count.
 * @param {string} [args.cwd]          Repo root for config resolution.
 * @param {object} [args.config]       Pre-resolved config (test injection).
 * @returns {{
 *   envelope: {kind: string, ready: number[], totalStories: number, concurrencyCap: number, inFlight: number, cycleError: string|null},
 *   exitCode: number
 * }}
 */
export function runStoriesWaveTick({
  dagJson,
  dagFile,
  concurrency,
  done,
  inFlight,
  cwd,
  config,
} = {}) {
  // Validate the --concurrency override before resolving config so an invalid
  // value fails fast with exit code 1 regardless of DAG validity.
  const { value: override, error: concurrencyError } =
    parseConcurrencyOverride(concurrency);
  if (concurrencyError) {
    return inputErrorResult(concurrencyError);
  }

  const { value: inFlightValue, error: inFlightError } =
    parseInFlight(inFlight);
  if (inFlightError) {
    return inputErrorResult(inFlightError);
  }

  const { ids: doneIds, error: doneError } = parseDoneIds(done);
  if (doneError) {
    return inputErrorResult(doneError, null, inFlightValue);
  }

  const concurrencyCap = resolveConcurrencyCap({ cwd, config, override });

  let rawJson;

  if (dagFile) {
    try {
      rawJson = readFileSync(dagFile, 'utf8');
    } catch (err) {
      return inputErrorResult(
        `Could not read DAG file "${dagFile}": ${err.message}`,
        concurrencyCap,
        inFlightValue,
      );
    }
  } else if (dagJson) {
    rawJson = dagJson;
  } else {
    return inputErrorResult(
      'Either --dag <json> or --dag-file <path> is required',
      concurrencyCap,
      inFlightValue,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return inputErrorResult(
      `Invalid JSON: ${err.message}`,
      concurrencyCap,
      inFlightValue,
    );
  }

  const { nodes, error: parseError } = parseDag(parsed);
  if (parseError) {
    return inputErrorResult(parseError, concurrencyCap, inFlightValue);
  }

  return buildReadySetEnvelope(nodes, {
    concurrencyCap,
    doneIds,
    inFlight: inFlightValue,
  });
}

/**
 * Probe mode: resolve the graph and the run's progress from **live state**,
 * then run the same scheduling kernel the flag mode does.
 *
 * This is the flag-free beat. The caller supplies only the Story ids it was
 * asked to deliver; `done` and `inFlight` are probed rather than transcribed,
 * which is what makes the `/deliver` loop's old seed-the-first-beat footgun
 * structurally impossible instead of merely documented.
 *
 * The envelope is the flag mode's, plus three probe-only fields the caller can
 * no longer compute for itself:
 *   - `done` — the resolved done set (in-set ∪ satisfied foreign blockers).
 *   - `epilogueDue` — true exactly when every listed Story is done, which is
 *     the run-end signal for `plan-run-epilogue.js`.
 *   - `blocked` — ids carrying `agent::blocked` (Story #4601). Non-empty means
 *     the loop must END, not poll: see `BLOCKED_EXIT_CODE`.
 *
 * @param {object} args
 * @param {string} args.stories        Raw `--stories` CSV of Story ids.
 * @param {string|number} [args.concurrency] Raw `--concurrency` override.
 * @param {string} [args.dispatched]   Raw `--dispatched` CSV of ids the host
 *   has spawned but may not yet have observed labelled.
 * @param {string} [args.cwd]          Repo root for config resolution.
 * @param {object} [args.config]       Pre-resolved config (test injection).
 * @param {Function} [args.probe]      Probe seam (test injection).
 * @param {Function} [args.context]    Provider-context seam (test injection).
 * @returns {Promise<{ envelope: object, exitCode: number }>}
 */
export async function runProbedStoriesWaveTick({
  stories,
  concurrency,
  dispatched,
  cwd,
  config,
  probe = probeLiveState,
  context = createProbeContext,
} = {}) {
  const { value: override, error: concurrencyError } =
    parseConcurrencyOverride(concurrency);
  if (concurrencyError) {
    return inputErrorResult(concurrencyError);
  }

  let ids;
  try {
    ids = parseIds(stories);
  } catch (err) {
    return inputErrorResult(err.message);
  }

  const { ids: dispatchedIds, error: dispatchedError } = parseIdCsv(
    dispatched,
    '--dispatched',
  );
  if (dispatchedError) {
    return inputErrorResult(dispatchedError);
  }

  const concurrencyCap = resolveConcurrencyCap({ cwd, config, override });

  let probed;
  try {
    const { provider, owner, repo, self } = context();
    probed = await probe({
      ids,
      provider,
      owner,
      repo,
      self,
      dispatched: [...dispatchedIds],
      warn: (m) => Logger.warn(m),
    });
  } catch (err) {
    // A failed probe must never degrade into "nothing is ready" — that is
    // indistinguishable from a healthy waiting beat and would silently stall
    // the run. Fail loud with the input-error contract instead.
    return inputErrorResult(
      `Could not probe live state: ${err?.message ?? err}`,
      concurrencyCap,
    );
  }

  const {
    nodes,
    doneIds,
    inFlight,
    blockedIds = [],
    foreignHeld = [],
  } = probed;
  const { envelope, exitCode } = buildReadySetEnvelope(nodes, {
    concurrencyCap,
    doneIds,
    inFlight,
  });

  const done = [...doneIds].sort((a, b) => a - b);
  const epilogueDue =
    nodes.length > 0 && nodes.every((node) => doneIds.has(node.id));
  return {
    envelope: {
      ...envelope,
      done,
      epilogueDue,
      blocked: blockedIds,
      blockedReason: blockedReasonFor(blockedIds),
      // Stories another operator's lease holds — withheld from dispatch this
      // beat (folded into in-flight) and surfaced so the run can report
      // "#<id> held by @<holder>" instead of dispatching into an init refusal.
      foreignHeld,
      foreignHeldReason: foreignHeldReasonFor(foreignHeld),
    },
    // A blocked Story outranks the scheduler's own verdict — including a
    // wedge, whose named blockers are moot while a human owes a decision.
    // A cycle (2) does not yield: a self-referential DAG is a planning error
    // that must be fixed before any of this run's state means anything.
    exitCode:
      blockedIds.length > 0 && !envelope.cycleError
        ? BLOCKED_EXIT_CODE
        : exitCode,
  };
}

/**
 * Render the operator-facing reason for a blocked run, or `null` when nothing
 * is blocked.
 *
 * @param {number[]} blockedIds
 * @returns {string|null}
 */
function blockedReasonFor(blockedIds) {
  if (blockedIds.length === 0) return null;
  const list = blockedIds.map((id) => `#${id}`).join(', ');
  return (
    `${blockedIds.length} Story(ies) carry agent::blocked — ${list}. ` +
    `agent::blocked is the protocol's HITL pause: no beat can clear it and ` +
    `the loop must stop rather than poll. Read each Story's friction comment ` +
    `(gh issue view <id> --comments), resolve the blocker, then flip it back ` +
    `with: node .agents/scripts/update-ticket-state.js --ticket <id> --state agent::ready`
  );
}

/**
 * Render the operator-facing note for Stories held by another operator's
 * lease, or `null` when none are held.
 *
 * These are not errors and not a wedge: the holder's run is progressing
 * normally, this run simply must not join it on the same branch. The Story
 * stays withheld and re-probes each beat, so it dispatches on its own the
 * moment the holder's lease clears (their run lands or is stolen).
 *
 * @param {Array<{id: number, holder: string}>} foreignHeld
 * @returns {string|null}
 */
function foreignHeldReasonFor(foreignHeld) {
  if (!Array.isArray(foreignHeld) || foreignHeld.length === 0) return null;
  const list = foreignHeld
    .map((h) => `#${h.id} held by @${h.holder}`)
    .join(', ');
  return (
    `${foreignHeld.length} Story(ies) are held by another operator's lease — ` +
    `${list}. They are withheld this beat, not failed: the holder's run owns ` +
    `the branch and worktree. This run picks each up automatically once that ` +
    `lease clears (their run lands, or you --steal it after confirming it is dead).`
  );
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dag: { type: 'string' },
      'dag-file': { type: 'string' },
      stories: { type: 'string' },
      'probe-live': { type: 'boolean' },
      dispatched: { type: 'string' },
      concurrency: { type: 'string' },
      done: { type: 'string' },
      'in-flight': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const flagError = validateProbeFlags({
    probeLive: values['probe-live'],
    stories: values.stories,
    dag: values.dag,
    dagFile: values['dag-file'],
    done: values.done,
    inFlight: values['in-flight'],
    dispatched: values.dispatched,
  });

  const { envelope, exitCode } = flagError
    ? inputErrorResult(flagError)
    : values['probe-live']
      ? await runProbedStoriesWaveTick({
          stories: values.stories,
          concurrency: values.concurrency,
          dispatched: values.dispatched,
        })
      : runStoriesWaveTick({
          dagJson: values.dag,
          dagFile: values['dag-file'],
          concurrency: values.concurrency,
          done: values.done,
          inFlight: values['in-flight'],
        });

  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);

  if (exitCode !== 0) {
    Logger.error(
      `stories-wave-tick: ${
        envelope.inputError ??
        envelope.cycleError ??
        envelope.blockedReason ??
        envelope.wedged?.reason ??
        'error'
      }`,
    );
    process.exitCode = exitCode;
  }
}

runAsCli(import.meta.url, () => main(process.argv.slice(2)), {
  source: 'stories-wave-tick',
});
