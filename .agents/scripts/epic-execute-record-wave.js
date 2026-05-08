#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-execute-record-wave.js — record one wave's per-Story returns,
 * advance the `epic-run-state` checkpoint, and re-render the unified
 * `epic-run-progress` rollup on the Epic.
 *
 * The slash-command (`/epic-execute`) calls this CLI once per wave, after
 * its host-level Agent-tool fan-out drains. It is the only writer of the
 * `epic-run-progress` structured comment for the wave-completion path —
 * there is no separate `/wave-execute` skill, no `wave-run-progress`
 * comment, and no separate rollup CLI. The host LLM owns wave dispatch;
 * this CLI owns the post-wave persistence and operator-facing summary.
 *
 *   1. Parse / reconcile / verify the per-Story returns.
 *      - `--returns` (raw sub-agent text) goes through `parseStoryAgentReturn`
 *        and reconciles parse failures from GitHub. A single rolled-up
 *        friction comment lists every malformed child.
 *      - `--results` accepts already-parsed `/story-execute` return objects.
 *      - `done` claims are verified against the live ticket label
 *        (`agent::done` or `state: closed`); any unverified claim is
 *        downgraded to `failed`.
 *   2. Aggregate the wave's terminal status:
 *        - `complete` iff every Story returned `done`.
 *        - `blocked`  iff at least one `blocked` and no `failed`.
 *        - `failed`   iff at least one `failed`.
 *   3. Append the wave outcome to `state.waves[]` (replacing any prior
 *      record at the same index — re-runs are idempotent), bump
 *      `state.currentWave` on `complete`, and re-write the checkpoint.
 *   4. Re-render `epic-run-progress` from `state.waves[]` (cross-looking
 *      titles from the dispatch-manifest) and upsert the comment in place.
 *   5. Print the next action for the slash-command:
 *        - `complete` + more waves → `dispatch-next`
 *        - `complete` + last wave  → `finalize`
 *        - `blocked`               → `halt-blocked`
 *        - `failed`                → `halt-failed`
 *
 * Usage:
 *   node .agents/scripts/epic-execute-record-wave.js \
 *     --epic <id> --wave <N> [--concurrency-cap <N>] \
 *     (--returns @<file>|<inline> | --results @<file>|<inline>)
 *
 * Two input modes:
 *
 *   --returns   The raw per-Story sub-agent return texts, as a JSON array
 *               of `{ storyId, returnText }` pairs. Each entry is parsed
 *               through `parseStoryAgentReturn`; entries that don't match
 *               the contract are reconciled from GitHub and a friction
 *               comment is posted on the Epic naming each malformed child.
 *               Prefer this mode — the wave is guaranteed to surface a
 *               non-`complete` status if any child return failed to parse.
 *
 *   --results   The validated array of `/story-execute` return objects.
 *               Use this only when the host LLM has already verified each
 *               sub-agent's text matches the canonical envelope.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { getRunners } from './lib/config/runners.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Checkpointer } from './lib/orchestration/epic-runner/checkpointer.js';
import { upsertEpicRunProgress } from './lib/orchestration/epic-runner/progress-reporter.js';
import {
  parseStoryAgentReturn,
  reconcileStoryFromGitHub,
  renderMalformedReturnsFriction,
} from './lib/orchestration/epic-runner/sub-agent-return.js';
import { parseFencedJsonComment } from './lib/orchestration/structured-comment-parser.js';
import {
  findStructuredComment,
  postStructuredComment,
} from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-execute-record-wave.js \\
  --epic <epicId> --wave <waveIndex> [--concurrency-cap <N>] \\
  (--returns @<file>|<inline-json> | --results @<file>|<inline-json>)

Records the wave's per-Story outcomes, advances the epic-run-state
checkpoint, and upserts the unified epic-run-progress rollup on the Epic.
Prints the next action for the /epic-execute slash command.
`;

const VALID_RESULT_STATUSES = new Set(['complete', 'blocked', 'failed']);

/** Per-Story return statuses we accept off /story-execute sub-agents. */
const VALID_STORY_STATUSES = new Set(['done', 'blocked', 'failed']);

/**
 * Story status → rollup-row state. Post-fan-out every Story is in a
 * terminal state, so we only emit the three terminal forms here.
 */
const STORY_STATUS_TO_ROW_STATE = {
  done: 'done',
  blocked: 'blocked',
  failed: 'failed',
};

/**
 * Validate and normalize an inbound `--results` array into the per-Story
 * shape the rest of the pipeline consumes.
 *
 * @param {unknown} raw
 */
export function validateResults(raw) {
  if (!Array.isArray(raw)) {
    throw new TypeError(
      'epic-execute-record-wave: --results must be a JSON array of per-Story result objects',
    );
  }
  return raw.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(
        `epic-execute-record-wave: results[${idx}] must be an object; got ${typeof entry}`,
      );
    }
    const storyId = Number(entry.storyId ?? entry.id);
    if (!Number.isInteger(storyId) || storyId <= 0) {
      throw new TypeError(
        `epic-execute-record-wave: results[${idx}].storyId must be a positive integer; got ${JSON.stringify(entry.storyId)}`,
      );
    }
    const status = String(entry.status ?? '');
    if (!VALID_STORY_STATUSES.has(status)) {
      throw new RangeError(
        `epic-execute-record-wave: results[${idx}].status "${status}" must be one of: ${[...VALID_STORY_STATUSES].join(', ')}`,
      );
    }
    const out = { storyId, status };
    if (typeof entry.phase === 'string') out.phase = entry.phase;
    if (Number.isInteger(entry.tasksDone)) out.tasksDone = entry.tasksDone;
    if (Number.isInteger(entry.tasksTotal)) out.tasksTotal = entry.tasksTotal;
    if (entry.blockerCommentId != null) {
      out.blockerCommentId = String(entry.blockerCommentId);
    }
    return out;
  });
}

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
 * Normalize raw `--returns` payload (per-Story sub-agent return texts) into
 * the same shape `validateResults` produces. Entries that fail to parse are
 * reconciled from GitHub and recorded as parse failures; the caller posts a
 * single rolled-up friction comment listing every failure.
 *
 * @param {{ provider: object, returns: Array<{ storyId: number, returnText: string }> }} args
 */
export async function normalizeReturns({ provider, returns } = {}) {
  if (!Array.isArray(returns)) {
    throw new TypeError(
      'epic-execute-record-wave: --returns must be a JSON array of { storyId, returnText } objects',
    );
  }
  const results = [];
  const parseFailures = [];
  for (const [idx, entry] of returns.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(
        `epic-execute-record-wave: returns[${idx}] must be an object; got ${typeof entry}`,
      );
    }
    const storyId = Number(entry.storyId ?? entry.id);
    if (!Number.isInteger(storyId) || storyId <= 0) {
      throw new TypeError(
        `epic-execute-record-wave: returns[${idx}].storyId must be a positive integer; got ${JSON.stringify(entry.storyId)}`,
      );
    }
    const returnText =
      typeof entry.returnText === 'string'
        ? entry.returnText
        : entry.returnText == null
          ? ''
          : JSON.stringify(entry.returnText);

    const parsed = parseStoryAgentReturn(returnText);
    if (parsed.ok && Number(parsed.value.storyId) === storyId) {
      results.push(parsed.value);
      continue;
    }

    const reconciled = await reconcileStoryFromGitHub({ provider, storyId });
    results.push(reconciled);
    parseFailures.push({
      storyId,
      error: parsed.ok
        ? `parsed envelope storyId ${parsed.value.storyId} disagrees with expected ${storyId}`
        : parsed.error,
      returnText,
    });
  }
  return { results, parseFailures };
}

/**
 * Aggregate validated per-Story rows into the wave-level outcome. Pure.
 *
 * @param {Array<{ storyId: number, status: string }>} results
 */
export function aggregateWaveStatus(results) {
  const rows = Array.isArray(results) ? results : [];
  const failed = rows.filter((r) => r.status === 'failed');
  const blocked = rows.filter((r) => r.status === 'blocked');
  let status;
  if (failed.length > 0) {
    status = 'failed';
  } else if (blocked.length > 0) {
    status = 'blocked';
  } else {
    status = 'complete';
  }
  return {
    status,
    blockedStoryIds: blocked.map((r) => r.storyId),
  };
}

/**
 * Re-fetch each Story's actual ticket state and downgrade any
 * `status: 'done'` claim whose ticket has not actually reached
 * `agent::done` (or `state: 'closed'`). Returns the verified rows plus
 * a list of discrepancies for friction reporting.
 *
 * Verification reads each Story ticket fresh (`{ fresh: true }`) so a
 * stale cache cannot mask the discrepancy. Network failures during
 * verification are non-fatal — the original claim is preserved and a
 * `verifyError` is recorded so the caller can surface it without
 * aborting the wave.
 *
 * @param {{ provider: { getTicket?: Function }, results: Array<object> }} args
 */
export async function verifyWaveResults({ provider, results } = {}) {
  if (!provider || typeof provider.getTicket !== 'function') {
    return { verified: results ?? [], discrepancies: [] };
  }
  const verified = [];
  const discrepancies = [];
  for (const r of results ?? []) {
    if (r.status !== 'done') {
      verified.push(r);
      continue;
    }
    let ticket;
    try {
      ticket = await provider.getTicket(r.storyId, { fresh: true });
    } catch (err) {
      verified.push({ ...r, verifyError: err?.message ?? String(err) });
      continue;
    }
    const labels = ticket?.labels ?? [];
    const isDone = labels.includes('agent::done') || ticket?.state === 'closed';
    if (isDone) {
      verified.push(r);
      continue;
    }
    const actualLabel =
      labels.find((l) => typeof l === 'string' && l.startsWith('agent::')) ??
      'unknown';
    discrepancies.push({
      storyId: r.storyId,
      claimed: 'done',
      actual: actualLabel,
    });
    verified.push({ ...r, status: 'failed' });
  }
  return { verified, discrepancies };
}

/**
 * Best-effort cross-look of the dispatch-manifest titles. Failure to read
 * or parse the manifest is non-fatal — empty title is acceptable.
 *
 * @param {{ provider: object, epicId: number }} args
 */
async function loadManifestTitleMap({ provider, epicId }) {
  try {
    const comment = await findStructuredComment(
      provider,
      epicId,
      'dispatch-manifest',
    );
    if (!comment) return new Map();
    const payload = parseFencedJsonComment(comment);
    if (!payload || !Array.isArray(payload.stories)) return new Map();
    return new Map(
      payload.stories
        .map((s) => [Number(s.storyId ?? s.id), String(s.title ?? '')])
        .filter(([id]) => Number.isFinite(id)),
    );
  } catch {
    return new Map();
  }
}

/**
 * Classify the wave outcome into the next operator action. Pure helper —
 * exported so tests can pin each branch without touching the provider.
 *
 * @param {{ resultStatus: string, currentWave: number, totalWaves: number }} args
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
 * Build the rollup-row shape the unified `epic-run-progress` writer
 * consumes. Returns `{ id, title, state, tasksDone?, tasksTotal?,
 * blockerCommentId? }`.
 */
function toRollupRow(verified, titleById) {
  const row = {
    id: verified.storyId,
    title: titleById.get(verified.storyId) ?? '',
    state: STORY_STATUS_TO_ROW_STATE[verified.status] ?? 'unknown',
  };
  if (Number.isInteger(verified.tasksDone)) row.tasksDone = verified.tasksDone;
  if (Number.isInteger(verified.tasksTotal))
    row.tasksTotal = verified.tasksTotal;
  if (verified.status === 'blocked' && verified.blockerCommentId != null) {
    row.blockerCommentId = String(verified.blockerCommentId);
  }
  return row;
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
  const provider = injectedProvider ?? createProvider(config.orchestration);

  const checkpointer = new Checkpointer({ provider, epicId });
  const existing = await checkpointer.read();
  if (!existing) {
    throw new Error(
      `runEpicExecuteRecordWave: no epic-run-state checkpoint found on Epic #${epicId}; ` +
        'run `node .agents/scripts/epic-execute-prepare.js --epic <id>` first.',
    );
  }

  const totalWaves = Number(existing.totalWaves ?? 0);
  const epicRunner = getRunners(config).epicRunner ?? {};
  const concurrencyCap =
    concurrencyCapOverride ??
    Number(existing.concurrencyCap) ??
    Number(epicRunner.concurrencyCap) ??
    1;
  if (!Number.isInteger(concurrencyCap) || concurrencyCap < 1) {
    throw new RangeError(
      `runEpicExecuteRecordWave: resolved concurrencyCap "${concurrencyCap}" must be a positive integer; ` +
        'pass --concurrency-cap or set `orchestration.runners.epicRunner.concurrencyCap`.',
    );
  }

  // 1. Parse / reconcile the per-Story returns.
  let parseFailures = [];
  let resolvedResults;
  if (returns != null) {
    const normalized = await normalizeReturns({ provider, returns });
    resolvedResults = normalized.results;
    parseFailures = normalized.parseFailures;
    if (parseFailures.length > 0) {
      try {
        const body = renderMalformedReturnsFriction({
          epicId,
          wave,
          failures: parseFailures,
        });
        await postStructuredComment(provider, epicId, 'friction', body);
      } catch (err) {
        console.error(
          `[epic-execute-record-wave] Failed to post malformed-return friction on Epic #${epicId}: ${err?.message ?? err}`,
        );
      }
    }
  } else {
    resolvedResults = results;
  }

  const validated = validateResults(resolvedResults);

  // 2. Verify every `done` claim against the live ticket label.
  const { verified, discrepancies } = await verifyWaveResults({
    provider,
    results: validated,
  });

  // 3. Aggregate the wave-level status.
  const { status, blockedStoryIds } = aggregateWaveStatus(verified);

  // 4. Cross-look manifest titles for the rollup rows.
  const titleById = await loadManifestTitleMap({ provider, epicId });
  const rollupRows = verified.map((r) => toRollupRow(r, titleById));

  // 5. Append (or replace) this wave's record on the checkpoint. Replacing
  //    covers the resume path where the operator re-runs record-wave for a
  //    wave that had been recorded previously — the checkpoint must remain
  //    idempotent.
  const priorWaves = Array.isArray(existing.waves) ? existing.waves : [];
  const newRecord = {
    index: wave,
    status,
    concurrencyCap,
    stories: rollupRows,
    completedAt: now().toISOString(),
  };
  const filtered = priorWaves.filter((w) => Number(w?.index) !== Number(wave));
  const nextWaves = [...filtered, newRecord].sort(
    (a, b) => Number(a.index) - Number(b.index),
  );

  const nextCurrentWave =
    status === 'complete'
      ? Math.min(totalWaves, wave + 1)
      : Number(existing.currentWave ?? wave);

  await checkpointer.write({
    ...existing,
    currentWave: nextCurrentWave,
    totalWaves,
    waves: nextWaves,
  });

  // 6. Re-render the unified `epic-run-progress` rollup from the checkpoint
  //    state. This is the only operator-facing summary — there is no
  //    separate per-wave structured comment.
  const rollupWaves = nextWaves.map((w) => ({
    wave: Number(w.index),
    concurrencyCap: Number(w.concurrencyCap) || concurrencyCap,
    stories: Array.isArray(w.stories) ? w.stories : [],
  }));
  const { body: renderedBody } = await upsertEpicRunProgress({
    provider,
    epicId,
    waves: rollupWaves,
    currentWave: nextCurrentWave,
    totalWaves,
    startedAt: existing.startedAt,
    now,
  });

  // 7. Classify next action for the slash command.
  const { nextAction, remainingWaves } = classifyWaveOutcome({
    resultStatus: status,
    currentWave: wave,
    totalWaves,
  });

  const envelope = {
    epicId,
    wave,
    recorded: true,
    status,
    stories: verified.map((r) => ({ id: r.storyId, status: r.status })),
    blockedStoryIds,
    nextAction,
    remainingWaves,
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
 * Resolve the parsed `--results` / `--returns` argv into the input shape
 * `runEpicExecuteRecordWave` expects.
 *
 * @param {{ resultsRaw?: string, returnsRaw?: string }} parsed
 */
export function resolveRecordInput(parsed) {
  const hasResults = Boolean(parsed?.resultsRaw);
  const hasReturns = Boolean(parsed?.returnsRaw);
  if (hasResults && hasReturns) {
    throw new TypeError(
      'epic-execute-record-wave: pass --results OR --returns, not both',
    );
  }
  if (!hasResults && !hasReturns) {
    throw new TypeError(
      'epic-execute-record-wave: --results or --returns is required',
    );
  }
  return hasResults
    ? { results: parseInputArg(parsed.resultsRaw, { flag: '--results' }) }
    : { returns: parseInputArg(parsed.returnsRaw, { flag: '--returns' }) };
}

/**
 * Parse argv into the runner contract.
 *
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      wave: { type: 'string' },
      'concurrency-cap': { type: 'string' },
      results: { type: 'string' },
      returns: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  return {
    help: Boolean(values.help),
    epicId: Number.parseInt(values.epic ?? '', 10),
    wave: Number.parseInt(values.wave ?? '', 10),
    concurrencyCap: values['concurrency-cap']
      ? Number.parseInt(values['concurrency-cap'], 10)
      : undefined,
    resultsRaw: values.results,
    returnsRaw: values.returns,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!Number.isInteger(parsed.epicId) || parsed.epicId <= 0) {
    console.error(
      '[epic-execute-record-wave] ERROR: --epic <epicId> is required.',
    );
    console.error(HELP);
    process.exit(2);
  }
  if (!Number.isInteger(parsed.wave) || parsed.wave < 0) {
    console.error(
      '[epic-execute-record-wave] ERROR: --wave <index> is required (>= 0).',
    );
    console.error(HELP);
    process.exit(2);
  }
  const out = await runEpicExecuteRecordWave({
    epicId: parsed.epicId,
    wave: parsed.wave,
    concurrencyCap: parsed.concurrencyCap,
    ...resolveRecordInput(parsed),
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'epic-execute-record-wave' });
