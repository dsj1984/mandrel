#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * wave-record.js — record per-wave Story outcomes and aggregate the wave's
 * terminal status.
 *
 * `/wave-execute` Steps 4–5 historically asked the operator (or sub-agent)
 * to "compose the rows yourself, call `upsertWaveRunProgress`, then count
 * the statuses to derive `complete` / `blocked` / `failed`." This CLI is
 * the imperative form: feed in the per-Story `/story-execute` return
 * objects, get back a single `{ status, blockedStoryIds }` summary plus an
 * idempotently-upserted `wave-run-progress` comment on the Epic.
 *
 * Aggregation rules (canonical from the wave-execute contract):
 *   - `status === 'complete'`  iff every Story returned `done`.
 *   - `status === 'blocked'`   iff at least one Story returned `blocked`
 *                              and none returned `failed`.
 *   - `status === 'failed'`    iff at least one Story returned `failed`.
 *
 * CLI:
 *   --epic <id>              Epic ticket id (required).
 *   --wave <n>               Wave number (required).
 *   --concurrency-cap <n>    Concurrency cap to record on the comment.
 *   --results @<file>        Path to a JSON file with the per-Story results.
 *   --results <inline-json>  Inline JSON array of per-Story results.
 *
 * Stdout: a single JSON envelope:
 *   {
 *     epicId, wave,
 *     status: 'complete' | 'blocked' | 'failed',
 *     stories: [{ id, status }],
 *     blockedStoryIds: [number],
 *     renderedBody: string,
 *   }
 *
 * `renderedBody` is the markdown body that was upserted onto the Epic
 * ticket — `/wave-execute` relays it as a chat message after fan-out so the
 * operator (and the parent `/epic-execute`) sees the same per-Story table
 * the cross-wave rollup will read.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { getRunners } from './lib/config/runners.js';
import { resolveConfig } from './lib/config-resolver.js';
import { upsertWaveRunProgress } from './lib/orchestration/epic-runner/wave-run-progress-writer.js';
import { parseFencedJsonComment } from './lib/orchestration/structured-comment-parser.js';
import { findStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { notify } from './notify.js';

const HELP = `Usage: node .agents/scripts/wave-record.js \\
  --epic <EPIC_ID> --wave <N> [--concurrency-cap <N>] \\
  --results @<file>|<inline-json>

Validates the per-Story results array (the /story-execute return contract),
upserts the \`wave-run-progress\` structured comment on the Epic, and
prints the wave-level outcome envelope to stdout.
`;

/** Per-Story return statuses we accept off /story-execute sub-agents. */
const VALID_STORY_STATUSES = new Set(['done', 'blocked', 'failed']);

/**
 * Story status → wave-row state mapping. The wave-run-progress writer
 * accepts a more granular vocabulary (`in-flight`, `queued`, `unknown`) but
 * post-fan-out every Story is in a terminal state — we only emit the three
 * terminal forms.
 */
const STORY_STATUS_TO_ROW_STATE = {
  done: 'done',
  blocked: 'blocked',
  failed: 'failed',
};

/**
 * Validate and normalize the inbound results array. Pure helper — exposed
 * so tests can pin the schema without going through the comment writer.
 *
 * @param {unknown} raw
 * @returns {Array<{
 *   storyId: number,
 *   status: 'done' | 'blocked' | 'failed',
 *   phase?: string,
 *   tasksDone?: number,
 *   tasksTotal?: number,
 *   blockerCommentId?: string,
 * }>}
 */
export function validateResults(raw) {
  if (!Array.isArray(raw)) {
    throw new TypeError(
      'wave-record: --results must be a JSON array of per-Story result objects',
    );
  }
  return raw.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(
        `wave-record: results[${idx}] must be an object; got ${typeof entry}`,
      );
    }
    const storyId = Number(entry.storyId ?? entry.id);
    if (!Number.isInteger(storyId) || storyId <= 0) {
      throw new TypeError(
        `wave-record: results[${idx}].storyId must be a positive integer; got ${JSON.stringify(entry.storyId)}`,
      );
    }
    const status = String(entry.status ?? '');
    if (!VALID_STORY_STATUSES.has(status)) {
      throw new RangeError(
        `wave-record: results[${idx}].status "${status}" must be one of: ${[...VALID_STORY_STATUSES].join(', ')}`,
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
 * Parse the `--results` argv value, supporting both `@<file>` and inline
 * JSON. Returns the parsed array. Throws on read / parse error.
 *
 * @param {string} value
 * @param {{ readFile?: (path: string) => string }} [deps]
 * @returns {unknown}
 */
export function parseResultsArg(value, deps = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      'wave-record: --results is required (use `@<file>` or an inline JSON array).',
    );
  }
  const reader = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  let raw;
  if (value.startsWith('@')) {
    const filePath = value.slice(1);
    if (!filePath) {
      throw new TypeError(
        'wave-record: --results @<file> requires a path after `@`.',
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
      `wave-record: --results value is not valid JSON: ${err.message}`,
    );
  }
}

/**
 * Aggregate the validated per-Story results into the wave-level outcome.
 * Pure helper — no IO. Empty arrays collapse to `complete` (the wave-execute
 * contract treats a no-op fan-out as a complete wave).
 *
 * @param {Array<{ storyId: number, status: string }>} results
 * @returns {{ status: 'complete' | 'blocked' | 'failed', blockedStoryIds: number[] }}
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
 * `status: 'done'` entry whose ticket has not actually reached
 * `agent::done` (or `state: 'closed'`). Returns the verified rows plus a
 * list of discrepancies for friction reporting.
 *
 * Rationale (rec #5): the sub-agent return values are operator-supplied —
 * a `/wave-execute` fan-out can return `done` for a Story whose
 * `/story-execute` actually exited mid-close (worktree drift, push hook
 * failure) without flipping `agent::done`. Without this verification the
 * wave is classified `complete` and the rollup loses the regression
 * signal. Verification reads each Story ticket fresh (`{ fresh: true }`)
 * so a stale cache cannot mask the discrepancy.
 *
 * Verification failures (network / GraphQL) are non-fatal — the original
 * claim is preserved and a `verifyError` is recorded so the caller can
 * surface it without aborting the entire wave.
 *
 * @param {{
 *   provider: { getTicket: Function },
 *   results: Array<{ storyId: number, status: 'done'|'blocked'|'failed' }>,
 * }} args
 * @returns {Promise<{
 *   verified: Array<object>,
 *   discrepancies: Array<{ storyId: number, claimed: string, actual: string }>,
 * }>}
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
 * Cross-look manifest titles (best-effort) onto the result rows so the
 * wave-run-progress comment surfaces meaningful titles. Failure to read /
 * parse the manifest is non-fatal — empty title is acceptable.
 *
 * @param {{ provider: object, epicId: number }} args
 * @returns {Promise<Map<number, string>>}
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
 * End-to-end wave-record. DI-friendly: tests pass `injectedProvider` and an
 * inline `results` array.
 *
 * @param {{
 *   epicId: number,
 *   wave: number,
 *   concurrencyCap?: number,
 *   results: unknown,
 *   injectedProvider?: object,
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   wave: number,
 *   status: 'complete' | 'blocked' | 'failed',
 *   stories: Array<{ id: number, status: string }>,
 *   blockedStoryIds: number[],
 *   renderedBody: string,
 * }>}
 */
export async function runWaveRecord(args = {}) {
  const {
    epicId,
    wave,
    concurrencyCap: concurrencyCapOverride,
    results,
    injectedProvider,
  } = args;

  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('runWaveRecord: --epic must be a positive integer');
  }
  if (!Number.isInteger(wave) || wave < 0) {
    throw new TypeError('runWaveRecord: --wave must be a non-negative integer');
  }

  const validated = validateResults(results);

  const config = resolveConfig();
  const provider = injectedProvider ?? createProvider(config.orchestration);

  const epicRunner = getRunners(config).epicRunner ?? {};
  const concurrencyCap =
    concurrencyCapOverride ?? Number(epicRunner.concurrencyCap) ?? 1;
  if (!Number.isInteger(concurrencyCap) || concurrencyCap < 1) {
    throw new RangeError(
      `runWaveRecord: resolved concurrencyCap "${concurrencyCap}" must be a positive integer; ` +
        'pass --concurrency-cap or set `orchestration.runners.epicRunner.concurrencyCap`.',
    );
  }

  // Verify every `done` claim against the live ticket label before the wave
  // is classified `complete`. A sub-agent that returned `done` for a Story
  // whose ticket never reached `agent::done` is downgraded to `failed` here
  // so the wave-level rollup reflects the regression rather than silently
  // marking the wave complete.
  const { verified: verifiedResults, discrepancies } = await verifyWaveResults({
    provider,
    results: validated,
  });

  // Cross-look manifest titles when available — `wave-run-progress` rows
  // include `title` so operators can read the comment without a join.
  const titleById = await loadManifestTitleMap({ provider, epicId });

  const rows = verifiedResults.map((r) => {
    const row = {
      id: r.storyId,
      title: titleById.get(r.storyId) ?? '',
      state: STORY_STATUS_TO_ROW_STATE[r.status],
    };
    if (Number.isInteger(r.tasksDone)) row.tasksDone = r.tasksDone;
    if (Number.isInteger(r.tasksTotal)) row.tasksTotal = r.tasksTotal;
    if (r.status === 'blocked' && r.blockerCommentId != null) {
      row.blockerCommentId = String(r.blockerCommentId);
    }
    return row;
  });

  const notifyFn = injectedProvider
    ? null
    : (ticketId, payload, opts = {}) =>
        notify(ticketId, payload, {
          orchestration: config.orchestration,
          provider,
          ...opts,
        });

  const { body: renderedBody } = await upsertWaveRunProgress({
    provider,
    epicId,
    wave,
    concurrencyCap,
    stories: rows,
    notify: notifyFn,
  });

  const { status, blockedStoryIds } = aggregateWaveStatus(verifiedResults);

  const envelope = {
    epicId,
    wave,
    status,
    stories: verifiedResults.map((r) => ({ id: r.storyId, status: r.status })),
    blockedStoryIds,
    renderedBody,
  };
  if (discrepancies.length > 0) {
    envelope.discrepancies = discrepancies;
  }
  return envelope;
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
      help: { type: 'boolean' },
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
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  const results = parseResultsArg(parsed.resultsRaw);
  const envelope = await runWaveRecord({
    epicId: parsed.epicId,
    wave: parsed.wave,
    concurrencyCap: parsed.concurrencyCap,
    results,
  });
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'wave-record' });
