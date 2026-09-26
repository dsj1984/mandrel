#!/usr/bin/env node

/**
 * stories-wave-tick.js — continuous ready-set planner for the standalone
 * `/mandrel-deliver` story-list path: a thin adapter over
 * `lib/wave-runner/ready-set.js#planReadySet` (no wave barrier; a Story is
 * dispatchable the instant its own dependencies are done).
 *
 * Probe mode (`--stories --probe-live`) derives graph, done set and in-flight
 * count from live state; flag mode (`--dag` + `--done`/`--in-flight`) takes
 * them from the caller. They are mutually exclusive: a supplied `--done` under
 * probe mode would reintroduce hand-maintained state. `--dispatched` is
 * additive and live-state-filtered, never authoritative.
 *
 * The cap comes from `delivery.deliverRunner.concurrencyCap`; `--concurrency`
 * overrides it, except that worktree isolation off clamps it to 1 (a shared
 * checkout makes concurrent workers contend for HEAD). `capPrecedence` names
 * the winning source so no override is silent.
 *
 * Exit codes (see HELP): 0 ok, 1 input error, 2 cycle, 3 wedged, 4 blocked.
 * Each non-zero case is distinct from the ordinary `ready: []` that means
 * "waiting on in-flight work", so the loop never polls a state that cannot
 * improve.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import {
  getPaths,
  getRunners,
  getWorktreeIsolation,
  resolveConfig,
  resolveWorktreeEnabled,
} from './lib/config-resolver.js';
import { detectCycle } from './lib/Graph.js';
import { Logger } from './lib/Logger.js';
import { AGENT_LABELS } from './lib/label-constants.js';
import { parseIds } from './lib/orchestration/resolve-stories.js';
import { buildStoryAdjacency } from './lib/story-adjacency.js';
import { expandIdList } from './lib/util/parse-id-list.js';
import { OVERLAP_SOURCES } from './lib/wave-runner/footprint.js';
import {
  createProbeContext,
  probeLiveState,
  validateProbeFlags,
} from './lib/wave-runner/live-probe.js';
import {
  GUARD_MODES,
  planReadySet,
  WITHHOLD_SCOPES,
} from './lib/wave-runner/ready-set.js';

/** Wedged run: a well-formed DAG whose gates cannot be satisfied from `--done`. */
export const WEDGED_EXIT_CODE = 3;

/**
 * A Story carries `agent::blocked` — the HITL pause no beat can clear.
 * Probe mode only: flag-mode nodes carry no labels.
 */
export const BLOCKED_EXIT_CODE = 4;

const HELP = `Usage:
  node .agents/scripts/stories-wave-tick.js --stories <csv> --probe-live [--dispatched <csv>] [--concurrency <n>]
  node .agents/scripts/stories-wave-tick.js --dag '<json>' | --dag-file <path> [--concurrency <n>] [--done <csv>] [--in-flight <n>]

Continuous ready-set planner for standalone Story delivery. Emits the set of
Stories safe to dispatch on this beat — a Story is dispatchable the instant
its own dependencies are done — plus the resolved per-beat concurrency cap
and the same file-overlap guard as planReadySet.

Two modes:
  --probe-live  Resolve the graph and derive done / in-flight from LIVE state
                (the canonical /mandrel-deliver beat). Nothing is hand-maintained
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
  --stories <csv>    Story ids to deliver (probe mode). Singles or inclusive
                     A-B ranges (101,104-107). The graph, the done set, and
                     the in-flight count are resolved from live state — no
                     --done / --in-flight bookkeeping.
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
                     .agentrc.json / .agentrc.local.json (default 3). The flag
                     WINS over the configured value, and the envelope's
                     capPrecedence records that it did — including when the
                     request exceeds the configured cap.
                     ONE EXCEPTION: when worktree isolation resolves off
                     (CLAUDE_CODE_REMOTE=true, AP_WORKTREE_ENABLED=false, or
                     delivery.worktreeIsolation.enabled: false), the cap is
                     clamped to 1 and the clamp outranks this flag — every
                     Story would otherwise run in the same checkout and two
                     workers would contend for HEAD. capPrecedence reports
                     source "worktree-clamp" with the requested value.
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
    "capPrecedence": {
      "cap": 3,
      "source": "config",
      "configuredCap": 3,
      "requestedCap": null,
      "exceedsConfigured": false,
      "note": "..."
    },
    "inFlight": 0,
    "cycleError": null,
    "wedged": null,
    "inFlightReservation": {
      "available": true,
      "withheld": [
        {
          "id": 4951,
          "blockedBy": 4949,
          "reason": "in-flight-earlier-beat",
          "source": "declared-overlap",
          "paths": ["lib/shared.js"]
        }
      ],
      "note": "..."
    },
    "footprintGuard": {
      "mode": "enforce",
      "withheld": [
        {
          "id": 4952,
          "blockedBy": 4951,
          "scope": "beat",
          "source": "declared-overlap",
          "paths": ["lib/other.js"]
        }
      ],
      "advisory": [],
      "note": "..."
    }
  }

inFlightReservation names each Story withheld this beat because its file
footprint overlaps one still IN FLIGHT from an earlier beat, together with the
blocking id — so an unfilled slot is explained rather than mysterious. It needs
the in-flight Stories' footprints, which only --probe-live has: under --dag the
report is { available: false } and selection de-conflicts within the beat only.

footprintGuard names each Story withheld from THIS beat by a peer already
admitted on it — the half that used to be an unreported skip — and every
entry in either report carries the colliding paths plus a source tag
(declared-overlap: both changes[] declarations named the path, or one declared
a glob — the text scrape that used to widen this was retired in Story #5313).
Its "mode" echoes
delivery.deliverRunner.footprintGuard: under "advisory" the collisions are
detected and listed in "advisory" but never withhold, and dispatch follows the
declared depends_on edges alone.

crossRunOverlaps (probe mode only) is ADVISORY: each probed Story that is
ready or in flight and shares a concrete path with an open Story in flight in
ANOTHER session (outside --stories) — { id, otherId, holder, paths } — plus one
stderr warning line per pair. It never withholds, reorders or delays dispatch
and never changes the exit code; it uses the same concrete-path rule as
inFlightReservation. When the outside query fails the envelope carries
crossRunOverlapProbe: "unavailable" and crossRunOverlapProbeReason instead of
the list, so "no overlap" is never inferred from a failed read.

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
      capPrecedence: null,
      inFlight: inFlightValue,
      cycleError: null,
      wedged: null,
      inFlightReservation: null,
      footprintGuard: null,
      inputError: message,
    },
    exitCode: 1,
  };
}

/** Machine-readable reason a reservation withheld a Story. */
const RESERVATION_REASONS = Object.freeze({
  EARLIER_BEAT: 'in-flight-earlier-beat',
  FOREIGN_LEASE: 'foreign-lease',
});

/**
 * Report the cross-beat footprint reservation. It needs the in-flight
 * Stories' records, which only probe mode has; flag mode reports
 * `available: false` explicitly, since an absent guard reads like one that
 * found nothing. Foreign-lease holders get their own reason because no beat
 * of this run clears them.
 *
 * @param {object[]|null|undefined} inFlightRecords
 * @param {Array<{id: number, blockedBy: number, source?: string, paths?: string[]}>} withheld
 * @param {Iterable<number>} [foreignHeldIds] Ids held by a foreign lease.
 * @returns {{ available: boolean, withheld: Array<{id: number, blockedBy: number, reason: string, source: string, paths: string[], attribution: object[]}>, note: string|null }}
 */
export function buildReservationReport(
  inFlightRecords,
  withheld,
  foreignHeldIds = [],
) {
  if (!Array.isArray(inFlightRecords)) {
    return {
      available: false,
      withheld: [],
      note:
        'In-flight footprint reservation is UNAVAILABLE this beat: flag mode ' +
        'supplies a dependency graph and an --in-flight count, never the ' +
        'in-flight Stories themselves, so there are no footprints to reserve ' +
        'against. Selection is unchanged (same-beat de-confliction only). ' +
        'Use --probe-live to reserve in-flight footprints.',
    };
  }
  if (withheld.length === 0) {
    return { available: true, withheld: [], note: null };
  }
  const foreign = new Set(foreignHeldIds);
  const classified = withheld.map((w) => ({
    id: w.id,
    blockedBy: w.blockedBy,
    reason: foreign.has(w.blockedBy)
      ? RESERVATION_REASONS.FOREIGN_LEASE
      : RESERVATION_REASONS.EARLIER_BEAT,
    source: w.source ?? OVERLAP_SOURCES.DECLARED,
    paths: w.paths ?? [],
  }));
  return {
    available: true,
    withheld: classified,
    note: reservationNote(classified),
  };
}

/**
 * Report the beat-local half of the footprint guard and its mode. `withheld`
 * and `advisory` are disjoint: under `enforce` every detection withheld,
 * under `advisory` none did.
 *
 * @param {Array<object>} footprintWithholds The kernel's complete ledger.
 * @param {'enforce'|'advisory'} mode
 * @returns {{ mode: string, withheld: object[], advisory: object[], note: string|null }}
 */
export function buildFootprintGuardReport(footprintWithholds, mode) {
  const ledger = Array.isArray(footprintWithholds) ? footprintWithholds : [];
  const project = ({ id, blockedBy, scope, source, paths }) => ({
    id,
    blockedBy,
    scope,
    source,
    paths,
  });
  const beat = ledger
    .filter((w) => w.scope === WITHHOLD_SCOPES.BEAT && w.enforced)
    .map(project);
  const advisory = ledger.filter((w) => !w.enforced).map(project);
  return {
    mode,
    withheld: beat,
    advisory,
    note: footprintGuardNote(beat, advisory, mode),
  };
}

/**
 * @param {object[]} beat
 * @param {object[]} advisory
 * @param {string} mode
 * @returns {string|null}
 */
function footprintGuardNote(beat, advisory, mode) {
  const detail = (entries) =>
    entries
      .map(
        (w) =>
          `#${w.id} ← #${w.blockedBy} on ${w.paths.join(', ')} (${w.source})`,
      )
      .join('; ');
  if (beat.length > 0) {
    return (
      `${beat.length} Story(ies) withheld from THIS beat because their file ` +
      `footprint overlaps a peer already admitted on it — ${detail(beat)}. ` +
      `Each is still eligible and re-admits on a later beat once its peer ` +
      `lands. Both Stories declared every colliding path in changes[] (or ` +
      `one declared a glob): since Story #5313 the guard reads declarations ` +
      `only, never the Story text.`
    );
  }
  if (advisory.length > 0) {
    return (
      `footprintGuard is '${mode}': ${advisory.length} footprint collision(s) ` +
      `were detected and NOT enforced — ${detail(advisory)}. Dispatch followed ` +
      `the declared depends_on edges alone. Set ` +
      `delivery.deliverRunner.footprintGuard: 'enforce' to serialize these.`
    );
  }
  return null;
}

/**
 * One sentence per reason class present; they clear by different events.
 *
 * @param {Array<{id: number, blockedBy: number, reason: string}>} withheld
 * @returns {string}
 */
function reservationNote(withheld) {
  const detail = (entries) =>
    entries.map((w) => `#${w.id} ← #${w.blockedBy}`).join('; ');
  const byBeat = withheld.filter(
    (w) => w.reason === RESERVATION_REASONS.EARLIER_BEAT,
  );
  const byLease = withheld.filter(
    (w) => w.reason === RESERVATION_REASONS.FOREIGN_LEASE,
  );
  const parts = [];
  if (byBeat.length > 0) {
    parts.push(
      `${byBeat.length} Story(ies) withheld because their file footprint ` +
        `overlaps a Story still in flight from an earlier beat — ${detail(byBeat)}. ` +
        `Each re-admits automatically on a later beat, once the Story ` +
        `reserving its files leaves the in-flight set.`,
    );
  }
  if (byLease.length > 0) {
    parts.push(
      `${byLease.length} Story(ies) withheld because their file footprint ` +
        `overlaps a Story another operator's lease holds — ${detail(byLease)}. ` +
        `No beat of THIS run clears that: the peer is the holder's work, and ` +
        `each re-admits once their lease clears (see foreignHeldReason).`,
    );
  }
  return `${parts.join(' ')} Neither is a wedge and neither is a failure.`;
}

/**
 * Validate the raw DAG array. An optional `files` footprint is forwarded so
 * the overlap guard is active in flag mode too.
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
 * Parse a CSV of ids or `A-B` ranges into a deduped set. Rejects any bad
 * token so a typo never silently drops a gate or a held slot.
 *
 * @param {string|undefined} raw
 * @param {string} flag Flag name, for the error message.
 * @returns {{ ids: Set<number>|null, error: string|null }}
 */
export function parseIdCsv(raw, flag) {
  const { ids, error } = expandIdList(raw, { flag });
  return error ? { ids: null, error } : { ids: new Set(ids), error: null };
}

/**
 * @param {string|undefined} raw
 * @returns {{ ids: Set<number>|null, error: string|null }}
 */
export function parseDoneIds(raw) {
  return parseIdCsv(raw, '--done');
}

/**
 * @param {unknown} raw Absent defaults to 0.
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
 * Cap when worktree isolation resolves off — a safety floor, so it outranks
 * even an explicit `--concurrency`.
 */
export const WORKTREE_DISABLED_CONCURRENCY_CAP = 1;

/**
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
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {object} [opts.config] Pre-resolved config (test injection).
 * @param {number} [opts.override] Validated `--concurrency`.
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {number}
 */
export function resolveConcurrencyCap(opts = {}) {
  return resolveCapPrecedence(opts).cap;
}

/**
 * Resolve the per-beat cap and the precedence that produced it. The flag wins
 * over config but never silently: a request above the configured cap is
 * reported, not refused (the configured cap is a default, not a safety
 * limit). The worktree clamp outranks both.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {object} [opts.config]   Pre-resolved config (test injection).
 * @param {number} [opts.override] Validated `--concurrency`.
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{
 *   cap: number,
 *   source: 'flag'|'config'|'worktree-clamp',
 *   configuredCap: number,
 *   requestedCap: number|null,
 *   exceedsConfigured: boolean,
 *   note: string,
 * }}
 */
export function resolveCapPrecedence({ cwd, config, override, env } = {}) {
  const resolved = config ?? resolveConfig({ cwd });
  const { deliverRunner } = getRunners(resolved);
  const configuredCap = deliverRunner.concurrencyCap;
  const requested =
    override == null
      ? {
          cap: configuredCap,
          source: 'config',
          configuredCap,
          requestedCap: null,
          exceedsConfigured: false,
          note: `cap ${configuredCap} from delivery.deliverRunner.concurrencyCap (no --concurrency given)`,
        }
      : {
          cap: override,
          source: 'flag',
          configuredCap,
          requestedCap: override,
          exceedsConfigured: override > configuredCap,
          note:
            override > configuredCap
              ? `cap ${override} from --concurrency, which OVERRIDES and EXCEEDS the configured delivery.deliverRunner.concurrencyCap ${configuredCap} — this run is deliberately above the project default`
              : `cap ${override} from --concurrency, which overrides the configured delivery.deliverRunner.concurrencyCap ${configuredCap}`,
        };

  return resolveWorktreeClamp({ requested, config: resolved, env });
}

/**
 * Apply the worktree-isolation floor. Keyed off `resolveWorktreeEnabled` so
 * every route to isolation-off is covered. The config is normalised through
 * `getWorktreeIsolation` first: a raw read of an omitted block is `false` and
 * would clamp as if isolation had been disabled. The clamp record is emitted
 * even when the requested cap was already 1, so sequentiality is attributable.
 *
 * @param {object} args
 * @param {{cap: number, source: string, configuredCap: number, requestedCap: number|null, exceedsConfigured: boolean, note: string}} args.requested
 * @param {object|null} [args.config]
 * @param {NodeJS.ProcessEnv} [args.env]
 * @returns {typeof args.requested}
 */
export function resolveWorktreeClamp({ requested, config, env } = {}) {
  const worktreeEnabled = resolveWorktreeEnabled(
    {
      config: { delivery: { worktreeIsolation: getWorktreeIsolation(config) } },
    },
    env ?? process.env,
  );
  if (worktreeEnabled) return requested;

  const from =
    requested.source === 'flag'
      ? '--concurrency'
      : 'delivery.deliverRunner.concurrencyCap';
  return {
    cap: WORKTREE_DISABLED_CONCURRENCY_CAP,
    source: 'worktree-clamp',
    configuredCap: requested.configuredCap,
    requestedCap: requested.cap,
    // The escalation never took effect.
    exceedsConfigured: false,
    note: `cap clamped to ${WORKTREE_DISABLED_CONCURRENCY_CAP} because worktree isolation resolved OFF — requested ${requested.cap} from ${from}. Concurrent dispatch shares one checkout without per-Story worktrees, so two workers would contend for HEAD; this floor outranks an explicit --concurrency.`,
  };
}

/**
 * `tempRoot` is the configured one, not a hardcoded `temp/`, so the overlap
 * guard excludes the project's actual scratch root.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {object} [opts.config]
 * @returns {{ footprintGuard: 'enforce'|'advisory', tempRoot: string }}
 */
export function resolveFootprintGuardSettings({ cwd, config } = {}) {
  const resolved = config ?? resolveConfig({ cwd });
  return {
    footprintGuard: getRunners(resolved).deliverRunner.footprintGuard,
    tempRoot: getPaths(resolved).tempRoot,
  };
}

/**
 * Build the per-beat envelope. A cyclic DAG is rejected up front (exit 2)
 * because the core would silently never schedule it.
 *
 * @param {Array<{id: number, dependsOn: number[]}>} nodes
 * @param {object} args
 * @param {number} args.concurrencyCap
 * @param {object|null} [args.capPrecedence]
 * @param {Set<number>} [args.doneIds]
 * @param {number} [args.inFlight]
 * @param {object[]|null} [args.inFlightRecords] `null` (flag mode) means
 *   reservation is unavailable, not empty.
 * @param {number[]} [args.foreignHeldIds] Ids held by a foreign lease.
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
  {
    concurrencyCap,
    capPrecedence = null,
    doneIds = new Set(),
    inFlight = 0,
    inFlightRecords = null,
    foreignHeldIds = [],
    footprintGuard = GUARD_MODES.ENFORCE,
    tempRoot,
  },
) {
  const totalStories = nodes.length;

  const base = {
    kind: 'stories-ready-set',
    ready: [],
    totalStories,
    concurrencyCap,
    // The reports below are never omitted: an absent report reads like an
    // empty one.
    capPrecedence,
    inFlight,
    cycleError: null,
    wedged: null,
    inFlightReservation: buildReservationReport(inFlightRecords, []),
    footprintGuard: buildFootprintGuardReport([], footprintGuard),
  };

  if (totalStories === 0) {
    return { envelope: base, exitCode: 0 };
  }

  // dropForeign:false: a dependency outside the supplied set is honored.
  const adjacency = buildStoryAdjacency(nodes, { dropForeign: false });
  const cycle = detectCycle(adjacency);
  if (cycle) {
    return {
      envelope: {
        ...base,
        cycleError: `Dependency cycle detected: ${cycle.join(' → ')}. Fix the depends_on declarations before running /mandrel-deliver.`,
      },
      exitCode: 2,
    };
  }

  // Done nodes are tagged agent::done so the core both excludes them and
  // counts them as satisfied dependencies. Probe-mode live labels are kept so
  // an in-flight Story is never re-dispatched onto a second branch.
  const records = nodes.map((node) => {
    const rec = {
      id: node.id,
      dependsOn: node.dependsOn,
      labels: doneIds.has(node.id) ? [AGENT_LABELS.DONE] : (node.labels ?? []),
    };
    if (node.files !== undefined) rec.files = node.files;
    if (typeof node.body === 'string') rec.body = node.body;
    return rec;
  });

  const { selected, footprintWithholds, guardMode } = planReadySet({
    stories: records,
    doneIds,
    inFlight,
    globalCap: concurrencyCap,
    inFlightRecords: inFlightRecords ?? [],
    footprintGuard,
    tempRoot,
  });
  const ready = selected.map((rec) => rec.id);
  const reservation = buildReservationReport(
    inFlightRecords,
    footprintWithholds.filter(
      (w) => w.scope === WITHHOLD_SCOPES.IN_FLIGHT && w.enforced,
    ),
    foreignHeldIds,
  );
  const guardReport = buildFootprintGuardReport(footprintWithholds, guardMode);

  const wedge = detectWedge({ nodes, doneIds, ready, inFlight });
  if (wedge) {
    return {
      envelope: {
        ...base,
        ready,
        wedged: wedge,
        inFlightReservation: reservation,
        footprintGuard: guardReport,
      },
      exitCode: WEDGED_EXIT_CODE,
    };
  }

  return {
    envelope: {
      ...base,
      ready,
      wedged: null,
      inFlightReservation: reservation,
      footprintGuard: guardReport,
    },
    exitCode: 0,
  };
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

  // Undone work with no unmet blockers is capacity-limited, not wedged.
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
 * Flag-mode beat.
 *
 * @param {object} args
 * @param {string} [args.dagJson]
 * @param {string} [args.dagFile]
 * @param {string|number} [args.concurrency]
 * @param {string} [args.done]
 * @param {string|number} [args.inFlight]
 * @param {string} [args.cwd]
 * @param {object} [args.config] Pre-resolved config (test injection).
 * @param {NodeJS.ProcessEnv} [args.env]
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
  env,
} = {}) {
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

  const capPrecedence = resolveCapPrecedence({ cwd, config, override, env });
  const concurrencyCap = capPrecedence.cap;

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
    capPrecedence,
    doneIds,
    inFlight: inFlightValue,
    ...resolveFootprintGuardSettings({ cwd, config }),
  });
}

/**
 * Probe-mode beat: graph and progress from live state. Adds `done`,
 * `epilogueDue` (every listed Story done — the run-end signal), `blocked`
 * (non-empty ends the loop) and `stalledDispatch` (`--dispatched` ids still
 * `agent::ready`, which only the caller can tell from a dead spawn).
 *
 * @param {object} args
 * @param {string} args.stories
 * @param {string|number} [args.concurrency]
 * @param {string} [args.dispatched]
 * @param {string} [args.cwd]
 * @param {object} [args.config]
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {Function} [args.probe]   Test seam.
 * @param {Function} [args.context] Test seam.
 * @param {(msg: string) => void} [args.warn] Stderr sink for the cross-run
 *   overlap lines. Test seam.
 * @returns {Promise<{ envelope: object, exitCode: number, records: object[] }>}
 *   `records` are the probed nodes, kept off stdout.
 */
export async function runProbedStoriesWaveTick({
  stories,
  concurrency,
  dispatched,
  cwd,
  config,
  env,
  probe = probeLiveState,
  context = createProbeContext,
  warn = Logger.warn,
} = {}) {
  const { value: override, error: concurrencyError } =
    parseConcurrencyOverride(concurrency);
  if (concurrencyError) {
    return inputErrorResult(concurrencyError);
  }

  let ids;
  try {
    ids = parseIds(stories, '--stories');
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

  const capPrecedence = resolveCapPrecedence({ cwd, config, override, env });
  const concurrencyCap = capPrecedence.cap;

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
    // Never degrade into "nothing is ready": that reads as a healthy wait.
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
    stalledDispatch = [],
    foreignHeld = [],
    inFlightRecords = [],
  } = probed;
  const crossRun = crossRunFields(probed);
  for (const line of crossRunWarnings(crossRun.crossRunOverlaps)) warn(line);
  const { envelope, exitCode } = buildReadySetEnvelope(nodes, {
    concurrencyCap,
    capPrecedence,
    doneIds,
    inFlight,
    inFlightRecords,
    foreignHeldIds: foreignHeld.map((h) => h.id),
    ...resolveFootprintGuardSettings({ cwd, config }),
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
      stalledDispatch,
      foreignHeld,
      foreignHeldReason: foreignHeldReasonFor(foreignHeld),
      ...crossRun,
    },
    records: nodes,
    // Blocked outranks a wedge (its blockers are moot while a human owes a
    // decision) but not a cycle, which invalidates the run's state.
    exitCode:
      blockedIds.length > 0 && !envelope.cycleError
        ? BLOCKED_EXIT_CODE
        : exitCode,
  };
}

/**
 * The probe's cross-run advisory, advisory-only: it never reaches selection or
 * the exit code. Exactly one of the two shapes passes through, so a failed
 * outside read is never flattened into an empty (reads-as-clear) list.
 *
 * @param {object} probed
 * @returns {object}
 */
function crossRunFields(probed) {
  if (Array.isArray(probed.crossRunOverlaps)) {
    return { crossRunOverlaps: probed.crossRunOverlaps };
  }
  if (probed.crossRunOverlapProbe === 'unavailable') {
    return {
      crossRunOverlapProbe: 'unavailable',
      crossRunOverlapProbeReason: probed.crossRunOverlapProbeReason ?? null,
    };
  }
  return {};
}

/**
 * One stderr line per overlapping pair.
 *
 * @param {Array<{id: number, otherId: number, holder: string|null, paths: string[]}>} [overlaps]
 * @returns {string[]}
 */
function crossRunWarnings(overlaps = []) {
  return overlaps.map(({ id, otherId, holder, paths }) => {
    const who = holder ? `held by @${holder}` : 'holder unknown';
    return (
      `stories-wave-tick: #${id} overlaps #${otherId} (in flight in another session, ${who}) ` +
      `on ${paths.join(', ')} — expect a rebase conflict at close. Advisory only; dispatch is unchanged.`
    );
  });
}

/**
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

  process.stdout.write(`${JSON.stringify(envelope)}\n`);

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
  usage: HELP,
});
