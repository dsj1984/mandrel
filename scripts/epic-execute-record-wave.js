#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-execute-record-wave.js — record one wave's per-Story returns,
 * advance the `epic-run-state` checkpoint, and re-render the unified
 * `epic-run-progress` rollup on the Epic.
 *
 * The slash-command (`/epic-deliver`) calls this CLI once per wave, after
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

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineFlags } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { getRunners } from './lib/config/runners.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { Checkpointer } from './lib/orchestration/epic-runner/checkpointer.js';
import {
  emitEpicBlocked,
  emitEpicProgress,
  emitEpicStarted,
  emitEpicUnblocked,
  upsertEpicRunProgress,
} from './lib/orchestration/epic-runner/progress-reporter.js';
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
import { notify } from './notify.js';

const HELP = `Usage: node .agents/scripts/epic-execute-record-wave.js \\
  --epic <epicId> --wave <waveIndex> [--concurrency-cap <N>] \\
  (--returns @<file>|<inline-json> | --results @<file>|<inline-json>)

Records the wave's per-Story outcomes, advances the epic-run-state
checkpoint, and upserts the unified epic-run-progress rollup on the Epic.
Prints the next action for the /epic-deliver slash command.
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
/**
 * Pure validator for a single `--returns[]` entry. Throws the same
 * `TypeError`s the outer loop used to throw inline, returning a
 * `{ storyId, returnText }` pair on success. Extracted so `normalizeReturns`
 * can route each entry through the same validate → parse → reconcile path
 * without nesting four conditionals deep.
 */
export function validateReturnsEntry(entry, idx) {
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
  let returnText;
  if (typeof entry.returnText === 'string') {
    returnText = entry.returnText;
  } else if (entry.returnText == null) {
    returnText = '';
  } else {
    returnText = JSON.stringify(entry.returnText);
  }
  return { storyId, returnText };
}

/**
 * Pure helper: classify a parsed sub-agent return for a known `storyId`.
 * Returns either `{ ok: true, value }` (use the parsed envelope as-is) or
 * `{ ok: false, error }` (caller must reconcile from GitHub and record a
 * parse failure with the message).
 */
export function classifyParsedReturn(parsed, storyId) {
  if (parsed.ok && Number(parsed.value.storyId) === storyId) {
    return { ok: true, value: parsed.value };
  }
  const error = parsed.ok
    ? `parsed envelope storyId ${parsed.value.storyId} disagrees with expected ${storyId}`
    : parsed.error;
  return { ok: false, error };
}

export async function normalizeReturns({ provider, returns } = {}) {
  if (!Array.isArray(returns)) {
    throw new TypeError(
      'epic-execute-record-wave: --returns must be a JSON array of { storyId, returnText } objects',
    );
  }
  const results = [];
  const parseFailures = [];
  for (const [idx, entry] of returns.entries()) {
    const { storyId, returnText } = validateReturnsEntry(entry, idx);
    const parsed = parseStoryAgentReturn(returnText);
    const classified = classifyParsedReturn(parsed, storyId);
    if (classified.ok) {
      results.push(classified.value);
      continue;
    }
    const reconciled = await reconcileStoryFromGitHub({ provider, storyId });
    results.push(reconciled);
    parseFailures.push({ storyId, error: classified.error, returnText });
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
 * stale cache cannot mask the discrepancy. A network failure during
 * verification cannot prove the claim either way, so the row is
 * downgraded to `failed` and a `verify-error` discrepancy is recorded —
 * an unverifiable `done` must not let the wave aggregate to `complete`,
 * which is what callers read as "GitHub agrees everything is done."
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
      const message = err?.message ?? String(err);
      discrepancies.push({
        storyId: r.storyId,
        claimed: 'done',
        actual: 'verify-error',
        verifyError: message,
      });
      verified.push({ ...r, status: 'failed', verifyError: message });
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
/**
 * Build the notify-bound closure used by the curated webhook emitters. When
 * a test passes `injectedNotify`, we route through it verbatim; otherwise
 * thread `orchestration` + `provider` into the default `notify` so the
 * downstream hook layer has everything it needs.
 */
function buildNotifyFn(injectedNotify, config, provider) {
  if (injectedNotify) return injectedNotify;
  return (ticketId, payload, opts = {}) =>
    notify(ticketId, payload, {
      orchestration: config.orchestration,
      provider,
      ...opts,
    });
}

/** Pure: count Stories already marked `done` across every recorded wave. */
export function countDoneStories(waves) {
  return waves.reduce(
    (acc, w) =>
      acc +
      (Array.isArray(w.stories)
        ? w.stories.filter((s) => s?.state === 'done').length
        : 0),
    0,
  );
}

/**
 * Fire the curated webhook events for a wave boundary. Each emit is
 * fire-and-forget (the emit helpers swallow webhook misconfiguration), but
 * we still serialise them so the order matches the wave-loop emits in
 * `lib/orchestration/epic-runner/phases/iterate-waves.js` for the host-LLM
 * driven /epic-deliver path.
 */
async function emitWaveBoundaryNotifications({
  injectedNotify,
  config,
  provider,
  epicId,
  wave,
  status,
  priorWaves,
  nextWaves,
  titleById,
  totalWaves,
  nextCurrentWave,
  verified,
  blockedStoryIds,
}) {
  const notifyFn = buildNotifyFn(injectedNotify, config, provider);
  const totalStoriesEstimate = titleById.size;
  const doneStoriesSoFar = countDoneStories(nextWaves);
  const priorWaveRecord = priorWaves.find(
    (w) => Number(w?.index) === Number(wave),
  );
  if (priorWaves.length === 0 && wave === 0) {
    await emitEpicStarted({
      notify: notifyFn,
      epicId,
      totalWaves,
      totalStories: totalStoriesEstimate,
      logger: Logger,
    });
  }
  if (status === 'complete') {
    await emitCompleteWaveNotifications({
      notifyFn,
      epicId,
      priorWaveRecord,
      doneStoriesSoFar,
      totalStoriesEstimate,
      nextCurrentWave,
      totalWaves,
    });
    return;
  }
  await emitFailingWaveNotifications({
    notifyFn,
    epicId,
    status,
    blockedStoryIds,
    verified,
    doneStoriesSoFar,
    totalStoriesEstimate,
    nextCurrentWave,
    totalWaves,
  });
}

/** Emit the unblocked-then-progress pair for a `complete` wave. */
async function emitCompleteWaveNotifications({
  notifyFn,
  epicId,
  priorWaveRecord,
  doneStoriesSoFar,
  totalStoriesEstimate,
  nextCurrentWave,
  totalWaves,
}) {
  const resumedFromHalt =
    priorWaveRecord &&
    (priorWaveRecord.status === 'blocked' ||
      priorWaveRecord.status === 'failed');
  if (resumedFromHalt) {
    await emitEpicUnblocked({
      notify: notifyFn,
      epicId,
      resolvedBlocker: {
        reason:
          priorWaveRecord.status === 'blocked'
            ? 'story_blocked'
            : 'story_failed',
      },
      logger: Logger,
    });
  }
  await emitEpicProgress({
    notify: notifyFn,
    epicId,
    done: doneStoriesSoFar,
    total: totalStoriesEstimate,
    currentWave: nextCurrentWave,
    totalWaves,
    phase: 'iterate-waves',
    openBlockers: [],
    logger: Logger,
  });
  // The `epic-complete` webhook used to fire here, at the post-final-wave
  // / pre-finalize boundary. That preceded `gh pr create` by minutes — the
  // operator got an "Epic complete" ping with no PR to click. The fire
  // moved to `epic-deliver-finalize.js`, which emits it after the PR URL
  // is captured. See that script for the new emit point.
}

/** Emit blocked + progress (with open-blocker context) for a non-complete wave. */
async function emitFailingWaveNotifications({
  notifyFn,
  epicId,
  status,
  blockedStoryIds,
  verified,
  doneStoriesSoFar,
  totalStoriesEstimate,
  nextCurrentWave,
  totalWaves,
}) {
  const reason = status === 'blocked' ? 'story_blocked' : 'story_failed';
  const failingStoryId =
    blockedStoryIds[0] ?? verified.find((r) => r.status === 'failed')?.storyId;
  await emitEpicBlocked({
    notify: notifyFn,
    epicId,
    reason,
    storyId: failingStoryId,
    logger: Logger,
  });
  await emitEpicProgress({
    notify: notifyFn,
    epicId,
    done: doneStoriesSoFar,
    total: totalStoriesEstimate,
    currentWave: nextCurrentWave,
    totalWaves,
    phase: 'iterate-waves',
    openBlockers: [{ reason, storyId: failingStoryId }],
    logger: Logger,
  });
}

/** Validate the core `{ epicId, wave }` invariants. Throws on bad input. */
export function validateEpicWave(epicId, wave) {
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
}

/** Validate the `results`/`returns` XOR. Throws on bad input. */
export function validateResultsReturnsXor(results, returns) {
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
}

/** Resolve the effective concurrency cap, honouring CLI > checkpoint > config. */
export function resolveConcurrencyCap(
  concurrencyCapOverride,
  existing,
  deliverRunner,
) {
  const cap =
    concurrencyCapOverride ??
    Number(existing.concurrencyCap) ??
    Number(deliverRunner.concurrencyCap) ??
    1;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new RangeError(
      `runEpicExecuteRecordWave: resolved concurrencyCap "${cap}" must be a positive integer; ` +
        'pass --concurrency-cap or set `orchestration.runners.deliverRunner.concurrencyCap`.',
    );
  }
  return cap;
}

/**
 * Parse / reconcile the per-Story returns (or pass `results` through). Posts
 * a single rolled-up friction comment listing every malformed return on
 * failure — non-fatal if the post itself fails.
 *
 * @returns {Promise<{ resolvedResults: Array, parseFailures: Array }>}
 */
async function resolveResolvedResults({
  provider,
  epicId,
  wave,
  results,
  returns,
}) {
  if (returns == null) {
    return { resolvedResults: results, parseFailures: [] };
  }
  const normalized = await normalizeReturns({ provider, returns });
  if (normalized.parseFailures.length > 0) {
    try {
      const body = renderMalformedReturnsFriction({
        epicId,
        wave,
        failures: normalized.parseFailures,
      });
      await postStructuredComment(provider, epicId, 'friction', body);
    } catch (err) {
      Logger.error(
        `[epic-execute-record-wave] Failed to post malformed-return friction on Epic #${epicId}: ${err?.message ?? err}`,
      );
    }
  }
  return {
    resolvedResults: normalized.results,
    parseFailures: normalized.parseFailures,
  };
}

/**
 * Re-render `temp/epic-<id>/manifest.{md,json}` from live GitHub state.
 *
 * Spawns `dispatcher.js <epicId> --dry-run` in a subprocess so the existing
 * fetch-Epic / build-manifest / persist-manifest pipeline runs end-to-end
 * without coupling this CLI to the dispatcher internals. Stdout/stderr are
 * piped to a single buffer so failures can be logged but never pollute
 * this script's JSON envelope output.
 *
 * @param {{ epicId: number, dispatcherPath?: string, runner?: typeof spawn }} opts
 * @returns {Promise<void>}
 */
export async function refreshLocalManifest({
  epicId,
  dispatcherPath,
  runner = spawn,
}) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const dispatcher = dispatcherPath ?? path.join(scriptDir, 'dispatcher.js');
  await new Promise((resolve, reject) => {
    const child = runner(
      process.execPath,
      [dispatcher, String(epicId), '--dry-run'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `dispatcher.js --dry-run exited ${code}; stderr: ${stderr.slice(0, 500)}`,
          ),
        );
      }
    });
  });
}

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
  const provider = injectedProvider ?? createProvider(config.orchestration);

  const checkpointer = new Checkpointer({ provider, epicId });
  const existing = await checkpointer.read();
  if (!existing) {
    throw new Error(
      `runEpicExecuteRecordWave: no epic-run-state checkpoint found on Epic #${epicId}; ` +
        'run `node .agents/scripts/epic-deliver-prepare.js --epic <id>` first.',
    );
  }

  const totalWaves = Number(existing.totalWaves ?? 0);
  const deliverRunner = getRunners(config).deliverRunner ?? {};
  const concurrencyCap = resolveConcurrencyCap(
    concurrencyCapOverride,
    existing,
    deliverRunner,
  );

  // 1. Parse / reconcile the per-Story returns.
  const { resolvedResults, parseFailures } = await resolveResolvedResults({
    provider,
    epicId,
    wave,
    results,
    returns,
  });

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

  // 8. Fire the curated webhook events for this wave boundary. Mirrors the
  //    wave-loop emits in `lib/orchestration/epic-runner/phases/iterate-waves.js`
  //    for the host-LLM driven /epic-deliver path (which does not pass
  //    through `runEpic`). Each helper is fire-and-forget — webhook
  //    misconfig or a transient Slack outage must not block the wave loop.
  await emitWaveBoundaryNotifications({
    injectedNotify,
    config,
    provider,
    epicId,
    wave,
    status,
    priorWaves,
    nextWaves,
    titleById,
    totalWaves,
    nextCurrentWave,
    verified,
    blockedStoryIds,
  });

  // 9. Refresh the local `temp/epic-<id>/manifest.{md,json}` so the
  //    operator-facing on-disk view reflects this wave's progress. The
  //    wave-runner architecture (Epic #1182) replaced the dispatcher's
  //    per-wave refresh loop; without this hop the manifest is frozen at
  //    planning time and shows `0/N tasks` even after Stories merge.
  //    Best-effort: failure here must not block the wave loop.
  await refreshLocalManifest({ epicId }).catch((err) => {
    Logger.warn(
      `[record-wave] Non-fatal: could not refresh local manifest for Epic #${epicId} — ${err?.message ?? 'unknown error'}`,
    );
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
/**
 * Pure helper: enforce the XOR contract between `--results` and `--returns`.
 * Throws on "neither" / "both"; otherwise returns the chosen flag name so
 * `resolveRecordInput` can route to `parseInputArg` with a single branch.
 */
export function selectInputFlag(hasResults, hasReturns) {
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
  return hasResults ? 'results' : 'returns';
}

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
