#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-execute-record-wave.js — advance the `epic-run-state` checkpoint after
 * one wave's Agent-tool fan-out completes.
 *
 * The operator pipes the wave-execute result JSON into this CLI, which:
 *
 *   1. Reads the existing `epic-run-state` comment via `Checkpointer.read()`.
 *      A missing checkpoint is fatal — `epic-execute-prepare.js` must run
 *      first so the autoClose snapshot, totalWaves, and concurrencyCap are
 *      pinned to the run's authoritative value.
 *   2. Appends the wave outcome `{ index, status, stories, completedAt }` to
 *      `state.waves[]`. The `index` recorded is the canonical zero-based
 *      wave number from the input `wave` argument; `--wave 0` records the
 *      first wave's outcome.
 *   3. Bumps `state.currentWave` to `wave + 1` and re-writes the checkpoint
 *      so a resume after a halt picks up at the correct wave boundary.
 *   4. Classifies the next action via the truth table from
 *      `/epic-execute` Steps 4 & 6:
 *        - `complete` + more waves remaining → `dispatch-next`
 *        - `complete` + last wave           → `finalize`
 *        - `blocked`                        → `halt-blocked`
 *        - `failed`                         → `halt-failed`
 *
 * Stdout: `{ epicId, wave, recorded: true, nextAction, remainingWaves }`.
 *
 * Usage:
 *   node .agents/scripts/epic-execute-record-wave.js \
 *     --epic <id> --wave <N> --result @<file>            (file mode)
 *   node .agents/scripts/epic-execute-record-wave.js \
 *     --epic <id> --wave <N> --result '<inline-json>'    (inline mode)
 *
 * The result JSON shape mirrors `wave-execute` output:
 *
 *   {
 *     "status": "complete" | "blocked" | "failed",
 *     "stories": [
 *       { "storyId": <number>, "status": "done"|"blocked"|"failed", ... }
 *     ]
 *   }
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Checkpointer } from './lib/orchestration/epic-runner/checkpointer.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-execute-record-wave.js \\
  --epic <epicId> --wave <waveIndex> --result @<file-or-inline-json>

Advances the epic-run-state checkpoint with the just-completed wave's outcome
and prints the next action for the /epic-execute slash command.
`;

const VALID_RESULT_STATUSES = new Set(['complete', 'blocked', 'failed']);

/**
 * Classify the wave outcome into the next operator action. Pure helper —
 * exported so tests can pin each branch without touching the provider.
 *
 * @param {{ resultStatus: string, currentWave: number, totalWaves: number }} args
 * @returns {{ nextAction: 'dispatch-next'|'halt-blocked'|'halt-failed'|'finalize', remainingWaves: number }}
 */
export function classifyWaveOutcome({ resultStatus, currentWave, totalWaves }) {
  const remainingWaves = Math.max(
    0,
    Number(totalWaves) - (Number(currentWave) + 1),
  );
  if (resultStatus === 'blocked') {
    return { nextAction: 'halt-blocked', remainingWaves };
  }
  if (resultStatus === 'failed') {
    return { nextAction: 'halt-failed', remainingWaves };
  }
  if (resultStatus === 'complete') {
    return {
      nextAction: remainingWaves > 0 ? 'dispatch-next' : 'finalize',
      remainingWaves,
    };
  }
  throw new RangeError(
    `classifyWaveOutcome: resultStatus "${resultStatus}" must be one of: ${[...VALID_RESULT_STATUSES].join(', ')}`,
  );
}

/**
 * End-to-end record-wave. DI-friendly: tests pass `injectedProvider` and a
 * fully-formed `result` object to skip the real network/file-system reads.
 *
 * @param {{
 *   epicId: number,
 *   wave: number,
 *   result: { status: string, stories?: object[] } | null | undefined,
 *   autoClose?: boolean,
 *   cwd?: string,
 *   injectedProvider?: object,
 *   injectedConfig?: object,
 *   now?: () => Date,
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   wave: number,
 *   recorded: true,
 *   nextAction: 'dispatch-next'|'halt-blocked'|'halt-failed'|'finalize',
 *   remainingWaves: number,
 * }>}
 */
export async function runEpicExecuteRecordWave({
  epicId,
  wave,
  result,
  cwd,
  injectedProvider,
  injectedConfig,
  now = () => new Date(),
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicExecuteRecordWave: --epic must be a positive integer',
    );
  }
  if (!Number.isInteger(wave) || wave < 0) {
    throw new TypeError(
      'runEpicExecuteRecordWave: --wave must be a non-negative integer',
    );
  }
  if (!result || typeof result !== 'object') {
    throw new TypeError(
      'runEpicExecuteRecordWave: --result must be a JSON object',
    );
  }
  const resultStatus = String(result.status ?? '');
  if (!VALID_RESULT_STATUSES.has(resultStatus)) {
    throw new RangeError(
      `runEpicExecuteRecordWave: result.status "${resultStatus}" must be one of: ${[...VALID_RESULT_STATUSES].join(', ')}`,
    );
  }

  const provider =
    injectedProvider ??
    createProvider((injectedConfig ?? resolveConfig({ cwd })).orchestration);

  const checkpointer = new Checkpointer({ provider, epicId });
  const existing = await checkpointer.read();
  if (!existing) {
    throw new Error(
      `runEpicExecuteRecordWave: no epic-run-state checkpoint found on Epic #${epicId}; ` +
        'run `node .agents/scripts/epic-execute-prepare.js --epic <id>` first.',
    );
  }

  const totalWaves = Number(existing.totalWaves ?? 0);

  // Append (or replace) this wave's record. Replacement covers the resume
  // path where the operator re-runs record-wave for a wave that had been
  // recorded previously — the checkpoint must remain idempotent.
  const priorWaves = Array.isArray(existing.waves) ? existing.waves : [];
  const stories = Array.isArray(result.stories) ? result.stories : [];
  const newRecord = {
    index: wave,
    status: resultStatus,
    stories,
    completedAt: now().toISOString(),
  };
  const filtered = priorWaves.filter((w) => Number(w?.index) !== Number(wave));
  const nextWaves = [...filtered, newRecord].sort(
    (a, b) => Number(a.index) - Number(b.index),
  );

  const nextCurrentWave =
    resultStatus === 'complete'
      ? Math.min(totalWaves, wave + 1)
      : Number(existing.currentWave ?? wave);

  await checkpointer.write({
    ...existing,
    currentWave: nextCurrentWave,
    totalWaves,
    waves: nextWaves,
  });

  const { nextAction, remainingWaves } = classifyWaveOutcome({
    resultStatus,
    currentWave: wave,
    totalWaves,
  });

  return {
    epicId,
    wave,
    recorded: true,
    nextAction,
    remainingWaves,
  };
}

/**
 * Resolve the `--result` argument: either an inline JSON string or a path
 * prefixed with `@` (mirrors `gh api` and the curl convention). Exposed for
 * tests so the file-mode branch can be exercised without a real fs.
 *
 * @param {string} raw
 * @param {{ readFileImpl?: typeof readFileSync }} [opts]
 */
export function resolveResultArg(raw, { readFileImpl = readFileSync } = {}) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TypeError('--result is required');
  }
  const text = raw.startsWith('@') ? readFileImpl(raw.slice(1), 'utf8') : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `--result is not valid JSON: ${err.message ?? err}. ` +
        'Pass either an inline JSON object or `@<path>` pointing at a JSON file.',
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      wave: { type: 'string' },
      result: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }
  const epicId = Number.parseInt(values.epic ?? '', 10);
  const wave = Number.parseInt(values.wave ?? '', 10);
  if (Number.isNaN(epicId) || epicId <= 0) {
    console.error(
      '[epic-execute-record-wave] ERROR: --epic <epicId> is required.',
    );
    console.error(HELP);
    process.exit(2);
  }
  if (Number.isNaN(wave) || wave < 0) {
    console.error(
      '[epic-execute-record-wave] ERROR: --wave <index> is required (>= 0).',
    );
    console.error(HELP);
    process.exit(2);
  }

  const result = resolveResultArg(values.result);
  const out = await runEpicExecuteRecordWave({ epicId, wave, result });
  console.log(JSON.stringify(out, null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-execute-record-wave' });
