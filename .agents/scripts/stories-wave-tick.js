#!/usr/bin/env node

/**
 * stories-wave-tick.js — continuous ready-set planner for the standalone
 * `/mandrel-deliver` story-list path.
 *
 * Thin **adapter** over the path-agnostic ready-set scheduling core
 * (`lib/wave-runner/ready-set.js#planReadySet`). It emits the set of
 * Stories safe to dispatch **on this beat** — a Story becomes dispatchable
 * the instant its own dependencies are done, under the same global
 * concurrency cap and the same file-overlap co-dispatch guard
 * `lib/wave-runner/ready-set.js` applies everywhere. There is no wave barrier: this no longer batches
 * Stories into fully-draining waves; it selects continuously.
 *
 * The previous static wave-batch plan (group N must fully drain before
 * group N+1 opens, via `Graph.js#assignLayers`) is gone. The scheduling
 * kernel — adjacency derivation, the done-predicate classifier, the
 * eligibility rule, and the overlap guard — lives once in `planReadySet`;
 * this file only gathers input, resolves the cap, and renders the envelope.
 *
 * **Two modes, one kernel.**
 *
 *   - **Probe mode** (`--stories <csv> --probe-live [--dispatched <csv>]`) is
 *     the canonical `/mandrel-deliver` beat: the graph, the done set, and the in-flight
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
 *     wedged: { reason, stories: [{ id, unmetBlockers }] } | null,
 *     inFlightReservation: { available, withheld: [{ id, blockedBy, reason, source, paths }], note },
 *     footprintGuard: { mode, withheld: [{ id, blockedBy, scope, source, paths }], advisory, note }
 *   }
 *
 * `inFlightReservation` reports the cross-beat half of the co-dispatch guard
 * (Story #4950 made it reserve; Story #5313 narrowed the footprint back to
 * the declared `changes[]`). Under
 * `--probe-live` the in-flight Stories' own records are handed to the kernel,
 * so a candidate sharing a CONCRETE path with a Story dispatched on an EARLIER
 * beat is withheld and named here with its blocker and a `reason`
 * (`in-flight-earlier-beat` or `foreign-lease`). A glob / UNKNOWN footprint
 * reserves nothing across beats — it would withhold the whole run for one
 * blocker's entire implementation window — while still serializing its own
 * beat (Story #4960). Flag mode carries a count and no records, so it reports
 * `available: false` rather than an empty — and therefore indistinguishable —
 * result.
 *
 * `footprintGuard` reports the **beat-local** half, which until Story #5044 was
 * reported nowhere: a same-beat overlap skip was a bare `continue` inside
 * `planReadySet`, so the Story vanished from `ready[]` with no field anywhere
 * naming the collision. Every entry in either report now also carries the
 * colliding `paths` and a `source` tag — `declared-overlap`, the one class
 * left since Story #5313: both Stories' `changes[]` named the path (intended
 * serialization: two Stories really do rewrite the same generated baseline)
 * or one declared a glob. `mode` names the `footprintGuard` config value;
 * under `advisory` the collisions are detected and listed in `advisory[]` but
 * dispatch follows the declared `depends_on` edges alone.
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
 * `/mandrel-deliver` uses — `resolveConfig` + `getRunners` reading
 * `delivery.deliverRunner.concurrencyCap` (default 3) — so a
 * `.agentrc.local.json` override is honored. A `--concurrency <n>` CLI flag
 * overrides the config-resolved value for that run only, and the envelope's
 * `capPrecedence` names which source won so the override is never silent
 * (Story #4875). This shares one
 * deterministic config source (`delivery.deliverRunner.concurrencyCap`) and
 * one scheduling kernel with every `/mandrel-deliver` multi-Story invocation.
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
import { getPaths, getRunners, resolveConfig } from './lib/config-resolver.js';
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

/**
 * Why a reservation withheld a Story. Machine-readable companion to the
 * operator-facing `note`, so a consumer never has to parse prose to tell an
 * earlier-beat blocker from a foreign-lease one (Story #4960).
 */
const RESERVATION_REASONS = Object.freeze({
  EARLIER_BEAT: 'in-flight-earlier-beat',
  FOREIGN_LEASE: 'foreign-lease',
});

/**
 * Describe this beat's in-flight footprint reservation for the envelope
 * (Story #4950).
 *
 * The reservation needs the in-flight Stories' **records** — their footprints
 * — not just how many there are, so its availability is a property of the
 * mode rather than of the run:
 *
 *   - **Probe mode** hands over the records `live-probe.js` already fetched,
 *     so `inFlightRecords` is an array (possibly empty) and reservation is
 *     `available: true`.
 *   - **Flag mode** (`--dag` + `--in-flight <n>`) supplies a graph and a
 *     count; no node carries a label, so nothing there can even classify as
 *     in-flight. There is no footprint to reserve against, and selection is
 *     unchanged from before #4950. Saying so explicitly is the point: a
 *     silently-absent guard reads exactly like a guard that found nothing.
 *
 * A reservation is held either by a Story **this run** dispatched on an
 * earlier beat or by one **another operator's lease** holds — `live-probe.js`
 * folds both into the in-flight set, and they reserve identically but read
 * very differently to an operator. Reporting a foreign-held peer as "still in
 * flight from an earlier beat" is simply false: this run never dispatched it
 * and no later beat of this run will clear it. `foreignHeldIds` splits the two
 * so each carries its own reason (Story #4960).
 *
 * Each entry also carries the **colliding paths** and an
 * `OVERLAP_SOURCES` tag (Story #5044). A withhold that names no path is one an
 * operator cannot act on, and `declared-overlap` vs `scraped-overlap` is the
 * difference between "these two Stories both declared this generated baseline,
 * serializing them is the point" and "one Story's body happened to mention a
 * path the other declared" — the same unfilled slot for two very different
 * reasons.
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
 * Report the **beat-local** half of the footprint guard, plus the guard mode
 * itself (Story #5044).
 *
 * Until now a same-beat overlap skip was an anonymous `continue` inside
 * `planReadySet`: the Story simply did not appear in `ready[]` and no field
 * anywhere said why. That is the same unexplained-unfilled-slot failure the
 * cross-beat `inFlightReservation` report was built to remove, left standing on
 * the other half of the guard — and it is how a plan whose siblings collided
 * only on machine-generated footer text ran fully serial without leaving a
 * trace to notice.
 *
 * `withheld` and `advisory` are disjoint by construction: under `enforce` every
 * detection withheld, under `advisory` none did. Reporting them as separate
 * lists rather than one flagged list means a consumer counting withheld
 * dispatches never has to inspect a boolean to get the count right.
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
 * Render the operator-facing note for the beat-local guard, naming the
 * colliding path(s) for every entry. `null` when the guard neither withheld nor
 * waved anything through.
 *
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
 * Render the operator-facing reservation note, one sentence per reason class
 * present. Neither class is a failure or a wedge, but they clear by different
 * events, so each names its own.
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
 * Parse a comma-separated list of Story IDs — singles or `A-B` dash ranges —
 * into a deduped set of positive integers. Empty / absent input yields an
 * empty set. Rejects any token that is not a positive integer or a valid
 * range, so a typo never silently drops a dependency gate (`--done`) or a
 * held dispatch slot (`--dispatched`).
 *
 * Ranges are accepted here for the same reason `--stories` accepts them: an
 * operator delivering `4922-4926` writes the dispatched set back the same way.
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
 * Mirrors the `/mandrel-deliver` multi-Story seam (`helpers/deliver-story.md`): resolve the
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
export function resolveConcurrencyCap(opts = {}) {
  return resolveCapPrecedence(opts).cap;
}

/**
 * Resolve the per-beat cap **and the precedence that produced it** (Story
 * #4875).
 *
 * `--concurrency` wins over `delivery.deliverRunner.concurrencyCap`, and that
 * is the intended contract — a flag an operator typed for one run should not be
 * outranked by a checked-in default. What was wrong is that it won *silently*:
 * the envelope reported a single `concurrencyCap` number with no record of
 * which source set it, so a run at 8 when the project configured 3 was
 * indistinguishable from a project configured at 8. A reader could not tell an
 * override from a default, and an override that ran the repo above its own
 * configured ceiling left no trace at all.
 *
 * So the flag still wins, but never quietly: the source is named, the
 * configured value is carried alongside the requested one, and a request that
 * exceeds the configured cap is called out as such. Reporting rather than
 * refusing is deliberate — the configured cap is a project default, not a
 * safety limit, and refusing a deliberate operator escalation would trade a
 * silent override for a silent stall.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]      Repo root for config resolution.
 * @param {object} [opts.config]   Pre-resolved config (test injection).
 * @param {number} [opts.override] Validated positive integer from
 *                                 `--concurrency`.
 * @returns {{
 *   cap: number,
 *   source: 'flag'|'config',
 *   configuredCap: number,
 *   requestedCap: number|null,
 *   exceedsConfigured: boolean,
 *   note: string,
 * }}
 */
export function resolveCapPrecedence({ cwd, config, override } = {}) {
  const resolved = config ?? resolveConfig({ cwd });
  const { deliverRunner } = getRunners(resolved);
  const configuredCap = deliverRunner.concurrencyCap;
  if (override == null) {
    return {
      cap: configuredCap,
      source: 'config',
      configuredCap,
      requestedCap: null,
      exceedsConfigured: false,
      note: `cap ${configuredCap} from delivery.deliverRunner.concurrencyCap (no --concurrency given)`,
    };
  }
  const exceedsConfigured = override > configuredCap;
  return {
    cap: override,
    source: 'flag',
    configuredCap,
    requestedCap: override,
    exceedsConfigured,
    note: exceedsConfigured
      ? `cap ${override} from --concurrency, which OVERRIDES and EXCEEDS the configured delivery.deliverRunner.concurrencyCap ${configuredCap} — this run is deliberately above the project default`
      : `cap ${override} from --concurrency, which overrides the configured delivery.deliverRunner.concurrencyCap ${configuredCap}`,
  };
}

/**
 * Resolve the two footprint-guard inputs from the same config seam the cap
 * comes from (Story #5044).
 *
 * `tempRoot` is threaded rather than hardcoded because the evidence scrape must
 * exclude the project's *configured* scratch root: a consumer that sets
 * `project.paths.tempRoot: '.scratch'` would otherwise have every sibling
 * citing a report under it collide, which is the exact defect this Story
 * removes for the default `temp/`.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]     Repo root for config resolution.
 * @param {object} [opts.config]  Pre-resolved config (test injection).
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
 * Build the per-beat ready-set envelope from a validated DAG.
 *
 * Maps each operator-DAG node onto a Story record the ready-set core
 * understands (`{ id, dependsOn }`), tags any node already in the done set
 * as `agent::done` so the core's classifier excludes it from the dispatch
 * set **and** counts it as a satisfied dependency, then delegates the
 * scheduling decision to `planReadySet`. A cyclic operator DAG is a
 * planning error (the core would silently never schedule the cycle), so we
 * detect it up front via the shared `detectCycle` kernel and short-circuit
 * with a `cycleError` and exit code 2.
 *
 * @param {Array<{id: number, dependsOn: number[]}>} nodes
 * @param {object} args
 * @param {number} args.concurrencyCap Resolved per-beat concurrency cap.
 * @param {object|null} [args.capPrecedence] The {@link resolveCapPrecedence}
 *   record explaining which source set the cap.
 * @param {Set<number>} [args.doneIds] Story IDs already completed this run.
 * @param {number} [args.inFlight]     Stories already occupying a slot.
 * @param {object[]|null} [args.inFlightRecords] Records for the Stories
 *   already in flight, so the kernel reserves their footprints instead of
 *   merely counting them (Story #4950). `null` (flag mode) means reservation
 *   is structurally unavailable — see {@link buildReservationReport}.
 * @param {number[]} [args.foreignHeldIds] Ids among `inFlightRecords` that a
 *   **foreign operator's lease** holds rather than this run's own earlier
 *   beat, so a withholding against one is reported for what it is
 *   (Story #4960). Flag mode has no lease view and passes none.
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
    // Which source set `concurrencyCap`, and whether it outranks the project's
    // configured value (Story #4875). Never omitted on a resolved beat: a
    // missing precedence record is what made a silent override possible.
    capPrecedence,
    inFlight,
    cycleError: null,
    wedged: null,
    // Whether this beat could reserve the in-flight Stories' footprints, and
    // which Stories a reservation withheld (Story #4950). Never omitted on a
    // resolved beat: an absent report reads exactly like an empty one.
    inFlightReservation: buildReservationReport(inFlightRecords, []),
    // The beat-local half of the same guard, plus the mode it ran in (Story
    // #5044). Also never omitted: a same-beat skip used to be reported nowhere
    // at all, which is precisely how an evidence-widening artifact could
    // serialize a whole run unnoticed.
    footprintGuard: buildFootprintGuardReport([], footprintGuard),
  };

  if (totalStories === 0) {
    return { envelope: base, exitCode: 0 };
  }

  // Cycle detection before scheduling — a cycle is a planning error the
  // operator must fix. dropForeign:false preserves the operator-DAG contract
  // (a dependency on an id outside the supplied set is honored, not pruned),
  // matching the same builder seam planReadySet uses internally.
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
    // Probe-mode nodes carry the Story body so the overlap guard can widen a
    // declared footprint from the paths the Story's own text names (Story
    // #4875). Flag-mode nodes carry none — `parseDag` accepts no body — so
    // this is inert there and the legacy contract is unchanged.
    if (typeof node.body === 'string') rec.body = node.body;
    return rec;
  });

  const { selected, footprintWithholds, guardMode } = planReadySet({
    stories: records,
    doneIds,
    inFlight,
    globalCap: concurrencyCap,
    // Flag mode has no in-flight records at all; `?? []` keeps the kernel's
    // contract (an array) while `base.inFlightReservation` reports that the
    // reservation itself was unavailable rather than merely empty.
    inFlightRecords: inFlightRecords ?? [],
    footprintGuard,
    tempRoot,
  });
  const ready = selected.map((rec) => rec.id);
  // The cross-beat report reads the enforced in-flight slice of the kernel's
  // ledger rather than the legacy `withheldByInFlight` list, so it carries the
  // colliding paths and the overlap source through to the operator.
  const reservation = buildReservationReport(
    inFlightRecords,
    footprintWithholds.filter(
      (w) => w.scope === WITHHOLD_SCOPES.IN_FLIGHT && w.enforced,
    ),
    foreignHeldIds,
  );
  const guardReport = buildFootprintGuardReport(footprintWithholds, guardMode);

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

  const capPrecedence = resolveCapPrecedence({ cwd, config, override });
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
 * Probe mode: resolve the graph and the run's progress from **live state**,
 * then run the same scheduling kernel the flag mode does.
 *
 * This is the flag-free beat. The caller supplies only the Story ids it was
 * asked to deliver; `done` and `inFlight` are probed rather than transcribed,
 * which is what makes the `/mandrel-deliver` loop's old seed-the-first-beat footgun
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

  const capPrecedence = resolveCapPrecedence({ cwd, config, override });
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
    inFlightRecords = [],
  } = probed;
  const { envelope, exitCode } = buildReadySetEnvelope(nodes, {
    concurrencyCap,
    capPrecedence,
    doneIds,
    inFlight,
    // Probe mode is the only mode that HAS the in-flight Stories' records, so
    // it is the only mode that can reserve their footprints (Story #4950).
    inFlightRecords,
    // ...and the only mode that can tell a foreign lease-holder apart from
    // this run's own earlier-beat dispatch (Story #4960).
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
