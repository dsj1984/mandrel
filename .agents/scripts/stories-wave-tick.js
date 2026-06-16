#!/usr/bin/env node

/**
 * stories-wave-tick.js — continuous ready-set planner for the standalone
 * `/deliver` story-list path.
 *
 * Thin **adapter** over the path-agnostic ready-set scheduling core
 * (`lib/wave-runner/ready-set.js#selectReadySet`). It consumes an
 * operator-supplied dependency DAG of standalone Story IDs plus the live
 * progress of the run (which Stories are done, how many are in flight) and
 * emits the set of Stories safe to dispatch **on this beat** — a Story
 * becomes dispatchable the instant its own dependencies are done, under the
 * same global concurrency cap and the same file-overlap co-dispatch guard
 * the Epic path uses. There is no wave barrier: this no longer batches
 * Stories into fully-draining waves; it selects continuously.
 *
 * The previous static wave-batch plan (group N must fully drain before
 * group N+1 opens, via `Graph.js#assignLayers`) is gone. The scheduling
 * kernel — adjacency derivation, the done-predicate classifier, the
 * eligibility rule, and the overlap guard — lives once in `selectReadySet`;
 * this file only parses input, resolves the cap, and renders the envelope.
 *
 * Usage:
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
 *     cycleError: string | null
 *   }
 *
 * The standalone loop calls this once per beat: after each Story closes it
 * re-runs with the closed Story added to `--done` and the live in-flight
 * count in `--in-flight`, dispatching the returned `ready` set (already
 * capped at `concurrencyCap − inFlight` by the core). The run is complete
 * when every Story is in `--done` and `ready` is empty.
 *
 * The per-beat concurrency cap is resolved from the same config seam
 * `/deliver` uses — `resolveConfig` + `getRunners` reading
 * `delivery.deliverRunner.concurrencyCap` (default 3) — so a
 * `.agentrc.local.json` override is honored. A `--concurrency <n>` CLI flag
 * overrides the config-resolved value for that run only. This puts both the
 * standalone (`/deliver`) and Epic (`/deliver`) delivery paths on one
 * deterministic config source **and** one scheduling kernel.
 *
 * On cycle detection, exits with code 2 and sets cycleError in the envelope.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { getRunners, resolveConfig } from './lib/config-resolver.js';
import { detectCycle } from './lib/Graph.js';
import { Logger } from './lib/Logger.js';
import { AGENT_LABELS } from './lib/label-constants.js';
import { buildStoryAdjacency } from './lib/story-adjacency.js';
import { selectReadySet } from './lib/wave-runner/ready-set.js';

const HELP = `Usage: node .agents/scripts/stories-wave-tick.js --dag '<json>' | --dag-file <path> [--concurrency <n>] [--done <csv>] [--in-flight <n>]

Continuous ready-set planner for standalone Story delivery. Consumes a
dependency graph of Story IDs plus the live run progress and emits the set
of Stories safe to dispatch on this beat — a Story is dispatchable the
instant its own dependencies are done — plus the resolved per-beat
concurrency cap and the same file-overlap guard the Epic path uses.

Input DAG format (JSON array):
  [{ "id": 101, "dependsOn": [] }, { "id": 102, "dependsOn": [101] }]

Each entry must include:
  id         - Story ticket number (positive integer)
  dependsOn  - Array of Story IDs that must complete before this Story runs

Options:
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
    "cycleError": null
  }

Exit codes:
  0 - Success, ready set emitted
  1 - Invalid input (missing/malformed DAG, invalid --concurrency/--in-flight/--done)
  2 - Cycle detected in dependency graph
`;

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
 * Parse a comma-separated `--done` list of Story IDs into a deduped set of
 * positive integers. Empty / absent input yields an empty set. Rejects any
 * token that is not a positive integer so a typo never silently drops a
 * dependency gate.
 *
 * @param {string|undefined} raw
 * @returns {{ ids: Set<number>|null, error: string|null }}
 */
export function parseDoneIds(raw) {
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
        error: `--done must be a comma-separated list of positive integers, got "${trimmed}"`,
      };
    }
    ids.add(num);
  }
  return { ids, error: null };
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
 * Mirrors the `/deliver` seam (`epic-deliver-prepare.js`): resolve the
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
      labels: doneIds.has(node.id) ? [AGENT_LABELS.DONE] : [],
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

  return { envelope: { ...base, ready }, exitCode: 0 };
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
  const inputError = (message, concurrencyCap = null, inFlightValue = 0) => ({
    envelope: {
      kind: 'stories-ready-set',
      ready: [],
      totalStories: 0,
      concurrencyCap,
      inFlight: inFlightValue,
      cycleError: null,
      inputError: message,
    },
    exitCode: 1,
  });

  // Validate the --concurrency override before resolving config so an invalid
  // value fails fast with exit code 1 regardless of DAG validity.
  const { value: override, error: concurrencyError } =
    parseConcurrencyOverride(concurrency);
  if (concurrencyError) {
    return inputError(concurrencyError);
  }

  const { value: inFlightValue, error: inFlightError } =
    parseInFlight(inFlight);
  if (inFlightError) {
    return inputError(inFlightError);
  }

  const { ids: doneIds, error: doneError } = parseDoneIds(done);
  if (doneError) {
    return inputError(doneError, null, inFlightValue);
  }

  const concurrencyCap = resolveConcurrencyCap({ cwd, config, override });

  let rawJson;

  if (dagFile) {
    try {
      rawJson = readFileSync(dagFile, 'utf8');
    } catch (err) {
      return inputError(
        `Could not read DAG file "${dagFile}": ${err.message}`,
        concurrencyCap,
        inFlightValue,
      );
    }
  } else if (dagJson) {
    rawJson = dagJson;
  } else {
    return inputError(
      'Either --dag <json> or --dag-file <path> is required',
      concurrencyCap,
      inFlightValue,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return inputError(
      `Invalid JSON: ${err.message}`,
      concurrencyCap,
      inFlightValue,
    );
  }

  const { nodes, error: parseError } = parseDag(parsed);
  if (parseError) {
    return inputError(parseError, concurrencyCap, inFlightValue);
  }

  return buildReadySetEnvelope(nodes, {
    concurrencyCap,
    doneIds,
    inFlight: inFlightValue,
  });
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dag: { type: 'string' },
      'dag-file': { type: 'string' },
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

  const { envelope, exitCode } = runStoriesWaveTick({
    dagJson: values.dag,
    dagFile: values['dag-file'],
    concurrency: values.concurrency,
    done: values.done,
    inFlight: values['in-flight'],
  });

  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);

  if (exitCode !== 0) {
    Logger.error(
      `stories-wave-tick: ${envelope.inputError ?? envelope.cycleError ?? 'error'}`,
    );
    process.exitCode = exitCode;
  }
}

runAsCli(import.meta.url, () => main(process.argv.slice(2)), {
  source: 'stories-wave-tick',
});
