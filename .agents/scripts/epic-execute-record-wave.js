#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-execute-record-wave.js — record one wave's per-Story returns,
 * advance the `epic-run-state` checkpoint, and re-render the unified
 * `epic-run-progress` rollup on the Epic.
 *
 * The slash-command (`/deliver`) calls this CLI once per wave, after
 * its host-level Agent-tool fan-out drains. It is the only writer of the
 * `epic-run-progress` structured comment for the wave-completion path —
 * there is no separate `/wave-execute` skill, no `wave-run-progress`
 * comment, and no separate rollup CLI. The host LLM owns wave dispatch;
 * this CLI owns the post-wave persistence and operator-facing summary.
 *
 *   1. Parse / reconcile / verify the per-Story returns.
 *   2. Aggregate the wave's terminal status (complete | blocked | failed).
 *   3. Splice the wave outcome into `state.waves[]`, advance
 *      `state.currentWave` on `complete`, and re-write the checkpoint.
 *   4. Re-render `epic-run-progress` from `state.waves[]`.
 *   5. Print the next action for the slash-command (`dispatch-next` |
 *      `finalize` | `halt-blocked` | `halt-failed`).
 *
 * The implementation is split across three modules so the parent stays a
 * thin runner shell:
 *
 *   - `lib/orchestration/wave-record-projection.js` — pure projection
 *     helpers (status aggregation, rollup-row shaping, next-record
 *     splicing, next-action classification). Re-exported from this file
 *     so existing callers see an unchanged public surface.
 *   - `lib/orchestration/wave-record-io.js` — impure helpers (ticket
 *     verification, manifest title lookup, returns reconciliation).
 *   - `lib/orchestration/wave-record-notifications.js` — curated webhook
 *     emit chain for the wave boundary.
 */

import { readFileSync } from 'node:fs';

import { defineFlags } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { getRunners } from './lib/config/runners.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import * as epicRunStateStore from './lib/orchestration/epic-run-state-store.js';
import { upsertEpicRunProgress } from './lib/orchestration/epic-runner/progress-reporter/composition.js';
import {
  emitStoryDispatchEnd,
  storyStatusToDispatchOutcome,
} from './lib/orchestration/lifecycle/emit-story-dispatch-end.js';
import {
  loadManifestTitleMap,
  resolveResolvedResults,
  verifyWaveResults,
} from './lib/orchestration/wave-record-io.js';
import { emitWaveBoundaryNotifications } from './lib/orchestration/wave-record-notifications.js';
import {
  projectWaveRecord,
  resolveConcurrencyCap,
  selectInputFlag,
  validateEpicWave,
  validateResults,
  validateResultsReturnsXor,
} from './lib/orchestration/wave-record-projection.js';
import { createProvider } from './lib/provider-factory.js';
import { notify } from './notify.js';

export {
  loadManifestTitleMap,
  normalizeReturns,
  resolveResolvedResults,
  verifyWaveResults,
} from './lib/orchestration/wave-record-io.js';
// Re-export the pure projection surface so tests and downstream consumers
// can keep importing from `epic-execute-record-wave.js` after the extract.
export {
  aggregateWaveStatus,
  classifyParsedReturn,
  classifyWaveOutcome,
  countDoneStories,
  resolveConcurrencyCap,
  STORY_STATUS_TO_ROW_STATE,
  selectInputFlag,
  toRollupRow,
  VALID_RESULT_STATUSES,
  VALID_STORY_STATUSES,
  validateEpicWave,
  validateResults,
  validateResultsReturnsXor,
  validateReturnsEntry,
} from './lib/orchestration/wave-record-projection.js';

const HELP = `Usage: node .agents/scripts/epic-execute-record-wave.js \\
  --epic <epicId> --wave <waveIndex> [--concurrency-cap <N>] \\
  (--returns @<file>|<inline-json> | --results @<file>|<inline-json>)

Records the wave's per-Story outcomes, advances the epic-run-state
checkpoint, and upserts the unified epic-run-progress rollup on the Epic.
Prints the next action for the /deliver slash command.
`;

/**
 * Parse a `--results` / `--returns` argv value, supporting both `@<file>`
 * and inline JSON. `flag` controls which CLI name appears in error messages.
 *
 * @param {string} value
 * @param {{ readFile?: (path: string) => string, flag?: string }} [deps]
 */
export function parseInputArg(value, deps = {}) {
  const flag = deps.flag ?? '--results';
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `epic-execute-record-wave: ${flag} is required (use \`@<file>\` or an inline JSON array).`,
    );
  }
  const reader = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  let raw;
  if (value.startsWith('@')) {
    const filePath = value.slice(1);
    if (!filePath) {
      throw new TypeError(
        `epic-execute-record-wave: ${flag} @<file> requires a path after \`@\`.`,
      );
    }
    raw = reader(filePath);
  } else {
    raw = value;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SyntaxError(
      `epic-execute-record-wave: ${flag} value is not valid JSON: ${err.message}`,
    );
  }
}

/**
 * End-to-end record-wave. DI-friendly: tests pass `injectedProvider` and a
 * fully-formed `results` (or `returns`) array to skip real network reads.
 *
 * @param {{
 *   epicId: number,
 *   wave: number,
 *   results?: unknown,
 *   returns?: unknown,
 *   concurrencyCap?: number,
 *   cwd?: string,
 *   injectedProvider?: object,
 *   injectedConfig?: object,
 *   injectedNotify?: (ticketId: number, payload: object) => Promise<void>,
 *   now?: () => Date,
 * }} args
 */
export async function runEpicExecuteRecordWave({
  epicId,
  wave,
  results,
  returns,
  concurrencyCap: concurrencyCapOverride,
  cwd,
  injectedProvider,
  injectedConfig,
  injectedNotify,
  now = () => new Date(),
} = {}) {
  validateEpicWave(epicId, wave);
  validateResultsReturnsXor(results, returns);

  const config = injectedConfig ?? resolveConfig({ cwd });
  const provider = injectedProvider ?? createProvider(config);

  const existing = await epicRunStateStore.read({ provider, epicId });
  if (!existing) {
    throw new Error(
      `runEpicExecuteRecordWave: no epic-run-state checkpoint found on Epic #${epicId}; ` +
        'run `node .agents/scripts/epic-deliver-prepare.js --epic <id>` first.',
    );
  }

  const deliverRunner = getRunners(config).deliverRunner ?? {};
  const concurrencyCap = resolveConcurrencyCap(
    concurrencyCapOverride,
    existing,
    deliverRunner,
  );

  // 1. Parse / reconcile the per-Story returns. `existing` is threaded so the
  //    wave-complete-livelock recovery (Story #3907) can reconcile every
  //    Story in `plan[wave]` from GitHub when mode B records a wave with no
  //    child returns.
  const { resolvedResults, parseFailures } = await resolveResolvedResults({
    provider,
    epicId,
    wave,
    results,
    returns,
    existing,
  });

  const validated = validateResults(resolvedResults);

  // 2. Verify every `done` claim against the live ticket label.
  const { verified, discrepancies } = await verifyWaveResults({
    provider,
    results: validated,
    concurrencyCap: deliverRunner.verifyConcurrencyCap,
  });

  // 3. Cross-look manifest titles for the rollup rows.
  const titleById = await loadManifestTitleMap({ provider, epicId });

  // 4. Project the post-wave-record state. Pure: aggregates the wave
  //    status, splices this wave's record into the prior list, derives
  //    nextCurrentWave, and classifies the slash-command next action.
  const projection = projectWaveRecord({
    wave,
    verified,
    existing,
    concurrencyCap,
    titleById,
    now,
  });

  // 5. Persist the projected checkpoint.
  await epicRunStateStore.write({
    provider,
    epicId,
    state: {
      ...existing,
      currentWave: projection.nextCurrentWave,
      totalWaves: projection.totalWaves,
      waves: projection.nextWaves,
    },
  });

  // 5a. Emit one `story.dispatch.end` per recorded Story (Story #3900).
  //     Closes the start/end pairing the wave-tick reconciler and the
  //     `--check-idle` watchdog use to derive in-flight Stories. Before this
  //     the only producer was `wave-session.js`, which the host-LLM driven
  //     /deliver path never imports — so every dispatched Story stayed
  //     "in-flight" forever and completed Stories tripped the watchdog.
  //     Best-effort: a failed append must not block the wave loop.
  emitWaveDispatchEnds({ epicId, verified, config });

  // 6. Re-render the unified `epic-run-progress` rollup from the checkpoint
  //    state. This is the only operator-facing summary — there is no
  //    separate per-wave structured comment.
  const { body: renderedBody } = await upsertEpicRunProgress({
    provider,
    epicId,
    waves: projection.rollupWaves,
    currentWave: projection.nextCurrentWave,
    totalWaves: projection.totalWaves,
    startedAt: existing.startedAt,
    now,
  });

  // 7. Fire the curated webhook events for this wave boundary. Mirrors the
  //    wave-loop emits in `lib/orchestration/epic-runner/phases/iterate-waves.js`
  //    for the host-LLM driven /deliver path (which does not pass
  //    through `runEpic`). Each helper is fire-and-forget — webhook
  //    misconfig or a transient Slack outage must not block the wave loop.
  await emitWaveBoundaryNotifications({
    injectedNotify,
    defaultNotify: notify,
    config,
    provider,
    epicId,
    wave,
    status: projection.status,
    priorWaves: projection.priorWaves,
    nextWaves: projection.nextWaves,
    titleById,
    totalWaves: projection.totalWaves,
    nextCurrentWave: projection.nextCurrentWave,
    verified,
    blockedStoryIds: projection.blockedStoryIds,
  });

  // Note (Story #3909): the per-wave dispatch-manifest refresh hop was
  // deleted. It re-ran the full dispatch pipeline (re-fetch every ticket,
  // recompute waves) on every tick only to re-render a comment nothing reads
  // for control flow. The manifest is written once at prepare time; the
  // surviving operator-facing surface is the `epic-run-progress` rollup
  // re-rendered above.

  const envelope = {
    epicId,
    wave,
    recorded: true,
    status: projection.status,
    stories: verified.map((r) => ({ id: r.storyId, status: r.status })),
    blockedStoryIds: projection.blockedStoryIds,
    nextAction: projection.nextAction,
    remainingWaves: projection.remainingWaves,
    renderedBody,
  };
  if (discrepancies.length > 0) {
    envelope.discrepancies = discrepancies;
  }
  if (parseFailures.length > 0) {
    envelope.parseFailures = parseFailures.map((f) => ({
      storyId: f.storyId,
      error: f.error,
    }));
  }
  return envelope;
}

/**
 * Append one `story.dispatch.end` lifecycle record per recorded Story
 * (Story #3900). Each emit is independent and best-effort: a single failed
 * append is logged and swallowed so one bad record never aborts the wave
 * loop. The Story status taxonomy (`done`/`blocked`/`failed`) maps directly
 * onto the `story.dispatch.end` outcome enum.
 *
 * Exported for unit testing.
 *
 * @param {{
 *   epicId: number,
 *   verified: Array<{ storyId: number, status: string }>,
 *   config?: object,
 *   emit?: typeof emitStoryDispatchEnd,
 * }} args
 * @returns {number} count of records successfully appended.
 */
export function emitWaveDispatchEnds({
  epicId,
  verified,
  config,
  emit = emitStoryDispatchEnd,
}) {
  let emitted = 0;
  for (const result of verified ?? []) {
    const storyId = result?.storyId;
    const status = result?.status;
    if (!Number.isInteger(storyId) || storyId <= 0) continue;
    try {
      emit({
        epicId,
        storyId,
        outcome: storyStatusToDispatchOutcome(status),
        config,
      });
      emitted += 1;
    } catch (err) {
      Logger.warn(
        `[record-wave] Non-fatal: could not emit story.dispatch.end for Story #${storyId} — ${err?.message ?? 'unknown error'}`,
      );
    }
  }
  return emitted;
}

/**
 * Resolve the parsed `--results` / `--returns` argv into the input shape
 * `runEpicExecuteRecordWave` expects.
 *
 * @param {{ resultsRaw?: string, returnsRaw?: string }} parsed
 */
export function resolveRecordInput(parsed) {
  const flag = selectInputFlag(
    Boolean(parsed?.resultsRaw),
    Boolean(parsed?.returnsRaw),
  );
  if (flag === 'results') {
    return { results: parseInputArg(parsed.resultsRaw, { flag: '--results' }) };
  }
  return { returns: parseInputArg(parsed.returnsRaw, { flag: '--returns' }) };
}

/**
 * Parse argv into the runner contract.
 *
 * @param {string[]} argv
 */
export function parseArgv(argv) {
  const { values } = defineFlags(
    {
      epic: { type: 'integer', alias: 'epicId' },
      wave: { type: 'integer' },
      'concurrency-cap': { type: 'integer' },
      results: { type: 'string', alias: 'resultsRaw' },
      returns: { type: 'string', alias: 'returnsRaw' },
      help: { type: 'boolean', short: 'h' },
    },
    argv,
  );
  return values;
}

/**
 * Orchestration body of `main` extracted as a sibling exported function so
 * the validate / dispatch / envelope-shape ladder is unit-testable without
 * spawning a process. `main` becomes a thin shell: parse → call this →
 * render → exit. CLI surface unchanged (same flags, same exit codes, same
 * stdout JSON schema).
 *
 * @param {ReturnType<typeof parseArgv>} values
 * @param {{
 *   runRecordWave?: typeof runEpicExecuteRecordWave,
 *   resolveRecordInput?: typeof resolveRecordInput,
 *   help?: string,
 * }} [deps]
 * @returns {Promise<{ exitCode: number, result: object }>}
 *   `result.kind` is one of: `'help'`, `'validation-error'`, `'envelope'`.
 */
export async function runRecordWaveCli(values, deps = {}) {
  const helpText = deps.help ?? HELP;
  if (values.help) {
    return { exitCode: 0, result: { kind: 'help', text: helpText } };
  }
  if (!Number.isInteger(values.epicId) || values.epicId <= 0) {
    return {
      exitCode: 2,
      result: {
        kind: 'validation-error',
        message:
          '[epic-execute-record-wave] ERROR: --epic <epicId> is required.',
        help: helpText,
      },
    };
  }
  if (!Number.isInteger(values.wave) || values.wave < 0) {
    return {
      exitCode: 2,
      result: {
        kind: 'validation-error',
        message:
          '[epic-execute-record-wave] ERROR: --wave <index> is required (>= 0).',
        help: helpText,
      },
    };
  }
  const resolveInput = deps.resolveRecordInput ?? resolveRecordInput;
  const runner = deps.runRecordWave ?? runEpicExecuteRecordWave;
  const envelope = await runner({
    epicId: values.epicId,
    wave: values.wave,
    concurrencyCap: values.concurrencyCap,
    ...resolveInput(values),
  });
  return { exitCode: 0, result: { kind: 'envelope', envelope } };
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);
  const { exitCode, result } = await runRecordWaveCli(values);

  if (result.kind === 'help') {
    process.stdout.write(result.text);
    return;
  }
  if (result.kind === 'validation-error') {
    Logger.error(result.message);
    Logger.error(result.help);
    process.exit(exitCode);
  }
  process.stdout.write(`${JSON.stringify(result.envelope, null, 2)}\n`);
  if (exitCode !== 0) process.exit(exitCode);
}

runAsCli(import.meta.url, main, { source: 'epic-execute-record-wave' });
