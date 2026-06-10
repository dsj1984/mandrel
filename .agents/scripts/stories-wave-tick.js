#!/usr/bin/env node

/**
 * stories-wave-tick.js — DAG/wave engine for the top-level /story-deliver workflow.
 *
 * Consumes an operator-supplied dependency DAG of standalone Story IDs and
 * emits ordered execution waves. Analogous to wave-tick.js but for standalone
 * Stories (not Epic-manifest tasks).
 *
 * Usage:
 *   node .agents/scripts/stories-wave-tick.js --dag '<json>'
 *   node .agents/scripts/stories-wave-tick.js --dag-file <path>
 *   node .agents/scripts/stories-wave-tick.js --dag '<json>' --concurrency 5
 *
 * DAG input format (JSON):
 *   Array of { id: number, dependsOn: number[] } objects where id is a Story
 *   ticket number and dependsOn lists Story IDs that must complete first.
 *
 * Output: one JSON object on stdout with shape:
 *   {
 *     kind: 'stories-wave-plan',
 *     waves: Array<{ waveIndex: number, stories: number[] }>,
 *     totalStories: number,
 *     concurrencyCap: number,
 *     cycleError: string | null
 *   }
 *
 * The per-wave concurrency cap is resolved from the same config seam
 * `/epic-deliver` uses — `resolveConfig` + `getRunners` reading
 * `delivery.deliverRunner.concurrencyCap` (default 3) — so a
 * `.agentrc.local.json` override is honored. A `--concurrency <n>` CLI flag
 * overrides the config-resolved value for that run only. This puts both the
 * standalone (`/story-deliver`) and Epic (`/epic-deliver`) delivery paths on
 * one deterministic config source.
 *
 * On cycle detection, exits with code 2 and sets cycleError in the envelope.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { getRunners, resolveConfig } from './lib/config-resolver.js';
import { assignLayers, detectCycle } from './lib/Graph.js';
import { Logger } from './lib/Logger.js';

const HELP = `Usage: node .agents/scripts/stories-wave-tick.js --dag '<json>' | --dag-file <path> [--concurrency <n>]

DAG/wave engine for standalone Story delivery. Consumes a dependency graph
of Story IDs and emits ordered execution waves plus a resolved per-wave
concurrency cap.

Input DAG format (JSON array):
  [{ "id": 101, "dependsOn": [] }, { "id": 102, "dependsOn": [101] }]

Each entry must include:
  id         - Story ticket number (positive integer)
  dependsOn  - Array of Story IDs that must complete before this Story runs

Options:
  --concurrency <n>  Override the per-wave concurrency cap for this run only.
                     Must be a positive integer. When omitted, the cap is
                     resolved from delivery.deliverRunner.concurrencyCap in
                     .agentrc.json / .agentrc.local.json (default 3).

Output envelope:
  {
    "kind": "stories-wave-plan",
    "waves": [{ "waveIndex": 0, "stories": [101] }, ...],
    "totalStories": 2,
    "concurrencyCap": 3,
    "cycleError": null
  }

Exit codes:
  0 - Success, waves emitted
  1 - Invalid input (missing/malformed DAG, invalid --concurrency)
  2 - Cycle detected in dependency graph
`;

/**
 * Parse and validate the raw DAG input array.
 *
 * @param {unknown} raw Parsed JSON value from --dag or --dag-file.
 * @returns {{ nodes: Array<{id: number, dependsOn: number[]}>, error: string|null }}
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
    nodes.push({ id, dependsOn: [...dependsOn] });
  }
  return { nodes, error: null };
}

/**
 * Build an adjacency map from parsed DAG nodes.
 * Returns Map<id, id[]> where each id maps to its dependencies.
 *
 * @param {Array<{id: number, dependsOn: number[]}>} nodes
 * @returns {Map<number, number[]>}
 */
export function buildAdjacency(nodes) {
  const adjacency = new Map();
  for (const node of nodes) {
    adjacency.set(node.id, [...node.dependsOn]);
  }
  return adjacency;
}

/**
 * Resolve the per-wave concurrency cap.
 *
 * Mirrors the `/epic-deliver` seam (`epic-deliver-prepare.js`): resolve the
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
 * Compute the wave plan from a validated adjacency map.
 *
 * Uses detectCycle from Graph.js to validate the DAG before computing
 * layers via assignLayers. Returns the wave envelope, carrying the resolved
 * per-wave `concurrencyCap` so the `/story-deliver` workflow dispatches
 * `min(wave.stories.length, concurrencyCap)` from a deterministic field rather
 * than from recalled prose.
 *
 * @param {Map<number, number[]>} adjacency
 * @param {number} concurrencyCap Resolved per-wave concurrency cap.
 * @returns {{
 *   kind: 'stories-wave-plan',
 *   waves: Array<{waveIndex: number, stories: number[]}>,
 *   totalStories: number,
 *   concurrencyCap: number,
 *   cycleError: string|null
 * }}
 */
export function computeStoriesWavePlan(adjacency, concurrencyCap) {
  const totalStories = adjacency.size;

  if (totalStories === 0) {
    return {
      kind: 'stories-wave-plan',
      waves: [],
      totalStories: 0,
      concurrencyCap,
      cycleError: null,
    };
  }

  // Detect cycles before computing layers — a cycle is a planning error.
  const cycle = detectCycle(adjacency);
  if (cycle) {
    return {
      kind: 'stories-wave-plan',
      waves: [],
      totalStories,
      concurrencyCap,
      cycleError: `Dependency cycle detected: ${cycle.join(' → ')}. Fix the depends_on declarations before running /story-deliver.`,
    };
  }

  // Assign layers (wave indices) via Graph.js — wave 0 = roots (no deps).
  const layers = assignLayers(adjacency);

  // Group story IDs by wave index, sort deterministically within each wave.
  const waveMap = new Map();
  for (const [storyId, waveIndex] of layers.entries()) {
    if (!waveMap.has(waveIndex)) waveMap.set(waveIndex, []);
    waveMap.get(waveIndex).push(storyId);
  }

  const maxWave = Math.max(...waveMap.keys());
  const waves = [];
  for (let i = 0; i <= maxWave; i++) {
    const stories = (waveMap.get(i) ?? []).sort((a, b) => a - b);
    if (stories.length > 0) {
      waves.push({ waveIndex: i, stories });
    }
  }

  return {
    kind: 'stories-wave-plan',
    waves,
    totalStories,
    concurrencyCap,
    cycleError: null,
  };
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
 * Core logic: parse DAG input, resolve the concurrency cap, validate, and
 * compute the wave plan.
 *
 * Exported for unit tests; the CLI `main` function is a thin wrapper. Tests
 * inject `config` so they never depend on a real `.agentrc`.
 *
 * @param {object} args
 * @param {string} [args.dagJson]      Raw JSON string from --dag.
 * @param {string} [args.dagFile]      Path to a JSON file from --dag-file.
 * @param {string|number} [args.concurrency] Raw --concurrency override.
 * @param {string} [args.cwd]          Repo root for config resolution.
 * @param {object} [args.config]       Pre-resolved config (test injection).
 * @returns {{
 *   envelope: {kind: string, waves: object[], totalStories: number, concurrencyCap: number, cycleError: string|null},
 *   exitCode: number
 * }}
 */
export function runStoriesWaveTick({
  dagJson,
  dagFile,
  concurrency,
  cwd,
  config,
} = {}) {
  // Validate the --concurrency override before resolving config so an invalid
  // value fails fast with exit code 1 regardless of DAG validity.
  const { value: override, error: concurrencyError } =
    parseConcurrencyOverride(concurrency);
  if (concurrencyError) {
    const envelope = {
      kind: 'stories-wave-plan',
      waves: [],
      totalStories: 0,
      concurrencyCap: null,
      cycleError: null,
      inputError: concurrencyError,
    };
    return { envelope, exitCode: 1 };
  }

  const concurrencyCap = resolveConcurrencyCap({ cwd, config, override });

  let rawJson;

  if (dagFile) {
    try {
      rawJson = readFileSync(dagFile, 'utf8');
    } catch (err) {
      const envelope = {
        kind: 'stories-wave-plan',
        waves: [],
        totalStories: 0,
        concurrencyCap,
        cycleError: null,
        inputError: `Could not read DAG file "${dagFile}": ${err.message}`,
      };
      return { envelope, exitCode: 1 };
    }
  } else if (dagJson) {
    rawJson = dagJson;
  } else {
    const envelope = {
      kind: 'stories-wave-plan',
      waves: [],
      totalStories: 0,
      concurrencyCap,
      cycleError: null,
      inputError: 'Either --dag <json> or --dag-file <path> is required',
    };
    return { envelope, exitCode: 1 };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    const envelope = {
      kind: 'stories-wave-plan',
      waves: [],
      totalStories: 0,
      concurrencyCap,
      cycleError: null,
      inputError: `Invalid JSON: ${err.message}`,
    };
    return { envelope, exitCode: 1 };
  }

  const { nodes, error: parseError } = parseDag(parsed);
  if (parseError) {
    const envelope = {
      kind: 'stories-wave-plan',
      waves: [],
      totalStories: 0,
      concurrencyCap,
      cycleError: null,
      inputError: parseError,
    };
    return { envelope, exitCode: 1 };
  }

  const adjacency = buildAdjacency(nodes);
  const envelope = computeStoriesWavePlan(adjacency, concurrencyCap);

  // Cycle detection → exit code 2
  if (envelope.cycleError) {
    return { envelope, exitCode: 2 };
  }

  return { envelope, exitCode: 0 };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dag: { type: 'string' },
      'dag-file': { type: 'string' },
      concurrency: { type: 'string' },
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
