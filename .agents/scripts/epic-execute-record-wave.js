#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-execute-record-wave.js — record one recorder beat's per-Story
 * returns, splice each Story's terminal status into the `epic-run-state`
 * checkpoint's flat per-Story `stories` map, and re-render the unified
 * `epic-run-progress` rollup on the Epic.
 *
 * Story #4155 (Epic #4151) — the Epic `/deliver` runtime cut over from the
 * wave-batch scheduler to the continuous ready-set core. This recorder lost
 * its wave semantics with it: there is no `--wave` flag, no wave-level
 * status aggregation, no `currentWave` advance, and no `waves[]` history. The
 * tick (`lib/wave-runner/tick.js`) re-derives readiness from live labels on
 * every beat, so the checkpoint only records terminal Story outcomes (for the
 * auto-merge predicate, branch cleanup, and the operator rollup). The
 * recorder also emits one `story.dispatch.end` per recorded Story so the
 * tick's ledger-derived in-flight set and the `--check-idle` watchdog can
 * clear the dispatch start/end pairing.
 *
 *   1. Parse / reconcile / verify the per-Story returns.
 *   2. Record each Story's terminal status onto the checkpoint `stories` map.
 *   3. Emit `story.dispatch.end` per recorded Story.
 *   4. Re-render `epic-run-progress` from the checkpoint `stories` map.
 *   5. Print the next action for the slash-command (`dispatch-next` |
 *      `halt-blocked` | `halt-failed`).
 *
 * The implementation is split across three modules so the parent stays a
 * thin runner shell:
 *
 *   - `lib/orchestration/wave-record-projection.js` — pure helpers
 *     (per-Story validation / normalization, rollup-row shaping). Re-exported
 *     from this file so existing callers see an unchanged public surface.
 *   - `lib/orchestration/wave-record-io.js` — impure helpers (ticket
 *     verification, manifest title lookup, returns reconciliation).
 *   - `lib/orchestration/wave-record-notifications.js` — curated webhook
 *     emit chain for the recorder beat.
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
import { emitRecordNotifications } from './lib/orchestration/wave-record-notifications.js';
import {
  selectInputFlag,
  validateEpic,
  validateResults,
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
  classifyParsedReturn,
  normalizeReturnsPure,
  STORY_STATUS_TO_ROW_STATE,
  selectInputFlag,
  toRollupRow,
  VALID_STORY_STATUSES,
  validateEpic,
  validateResults,
  validateReturnsEntry,
} from './lib/orchestration/wave-record-projection.js';

const HELP = `Usage: node .agents/scripts/epic-execute-record-wave.js \\
  --epic <epicId> \\
  (--returns @<file>|<inline-json> | --results @<file>|<inline-json>)

Records this recorder beat's per-Story outcomes onto the epic-run-state
checkpoint's flat per-Story status map and upserts the unified
epic-run-progress rollup on the Epic. Prints the next action for the
/deliver slash command.
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
 * Classify the recorder beat's next action from the verified rows. Pure.
 * Any failed Story → `halt-failed`; else any blocked Story → `halt-blocked`;
 * else → `dispatch-next` (the host re-ticks to pick up the next ready set).
 *
 * @param {Array<{ status: string }>} verified
 * @returns {{ status: 'complete'|'blocked'|'failed', nextAction: string, blockedStoryIds: number[] }}
 */
export function classifyRecordOutcome(verified) {
  const rows = Array.isArray(verified) ? verified : [];
  const failed = rows.some((r) => r.status === 'failed');
  const blockedStoryIds = rows
    .filter((r) => r.status === 'blocked')
    .map((r) => r.storyId);
  if (failed) {
    return { status: 'failed', nextAction: 'halt-failed', blockedStoryIds };
  }
  if (blockedStoryIds.length > 0) {
    return { status: 'blocked', nextAction: 'halt-blocked', blockedStoryIds };
  }
  return { status: 'complete', nextAction: 'dispatch-next', blockedStoryIds };
}

/**
 * End-to-end record beat. DI-friendly: tests pass `injectedProvider` and a
 * fully-formed `results` (or `returns`) array to skip real network reads.
 *
 * @param {{
 *   epicId: number,
 *   results?: unknown,
 *   returns?: unknown,
 *   cwd?: string,
 *   injectedProvider?: object,
 *   injectedConfig?: object,
 *   injectedNotify?: (ticketId: number, payload: object) => Promise<void>,
 *   now?: () => Date,
 * }} args
 */
export async function runEpicExecuteRecordWave({
  epicId,
  results,
  returns,
  cwd,
  injectedProvider,
  injectedConfig,
  injectedNotify,
  now = () => new Date(),
} = {}) {
  validateEpic(epicId);
  if (results == null && returns == null) {
    throw new TypeError(
      'runEpicExecuteRecordWave: either `results` or `returns` is required',
    );
  }
  if (results != null && returns != null) {
    throw new TypeError(
      'runEpicExecuteRecordWave: pass `results` OR `returns`, not both',
    );
  }

  const config = injectedConfig ?? resolveConfig({ cwd });
  const provider = injectedProvider ?? createProvider(config);

  const existing = await epicRunStateStore.read({ provider, epicId });
  if (!existing) {
    throw new Error(
      `runEpicExecuteRecordWave: no epic-run-state checkpoint found on Epic #${epicId}; ` +
        'run `node .agents/scripts/epic-deliver-prepare.js --epic <id>` first.',
    );
  }
  const firstRecord = !hasRecordedStory(existing.stories);

  const deliverRunner = getRunners(config).deliverRunner ?? {};

  // 1. Parse / reconcile the per-Story returns.
  const { resolvedResults, parseFailures } = await resolveResolvedResults({
    provider,
    epicId,
    results,
    returns,
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

  // 4. Record each Story's terminal status onto the checkpoint `stories`
  //    map. Recorded serially so the upserts do not race the same comment.
  let state = existing;
  for (const row of verified) {
    state = await epicRunStateStore.recordStoryStatus({
      provider,
      epicId,
      storyId: row.storyId,
      status: row.status,
      title: titleById.get(row.storyId),
      blockerCommentId: row.blockerCommentId,
    });
  }

  // 5. Emit one `story.dispatch.end` per recorded Story. Closes the
  //    start/end pairing the tick reconciler and the `--check-idle`
  //    watchdog use to derive in-flight Stories. Best-effort: a failed
  //    append must not block the loop.
  emitWaveDispatchEnds({ epicId, verified, config });

  // 6. Re-render the unified `epic-run-progress` rollup from the checkpoint
  //    `stories` map. The single operator-facing summary.
  const { body: renderedBody } = await upsertEpicRunProgress({
    provider,
    epicId,
    stories: state.stories,
    startedAt: existing.startedAt,
    now,
  });

  const { status, nextAction, blockedStoryIds } =
    classifyRecordOutcome(verified);

  // 7. Fire the curated webhook events for this recorder beat. Each helper
  //    is fire-and-forget — webhook misconfig or a transient Slack outage
  //    must not block the loop.
  await emitRecordNotifications({
    injectedNotify,
    defaultNotify: notify,
    config,
    provider,
    epicId,
    firstRecord,
    stories: state.stories,
    verified,
    blockedStoryIds,
  });

  const envelope = {
    epicId,
    recorded: true,
    status,
    stories: verified.map((r) => ({ id: r.storyId, status: r.status })),
    blockedStoryIds,
    nextAction,
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
 * Whether the checkpoint's per-Story `stories` map already carries a
 * non-`pending` (recorded) status — used to fire `epic-started` exactly
 * once, on the first recorder beat. Pure helper.
 *
 * @param {Record<string, { status?: string }>|undefined} stories
 * @returns {boolean}
 */
function hasRecordedStory(stories) {
  const map = stories && typeof stories === 'object' ? stories : {};
  for (const rec of Object.values(map)) {
    if (rec?.status && rec.status !== 'pending') return true;
  }
  return false;
}

/**
 * Append one `story.dispatch.end` lifecycle record per recorded Story
 * (Story #3900). Each emit is independent and best-effort: a single failed
 * append is logged and swallowed so one bad record never aborts the loop.
 * The Story status taxonomy (`done`/`blocked`/`failed`) maps directly onto
 * the `story.dispatch.end` outcome enum.
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
 * render → exit.
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
  const resolveInput = deps.resolveRecordInput ?? resolveRecordInput;
  const runner = deps.runRecordWave ?? runEpicExecuteRecordWave;
  const envelope = await runner({
    epicId: values.epicId,
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
