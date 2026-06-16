/**
 * wave-record-projection.js — pure helpers for the per-Story status
 * recorder CLI (`epic-execute-record-wave.js`).
 *
 * Story #4155 (Epic #4151) — the Epic `/deliver` runtime cut over from the
 * wave-batch scheduler to the continuous ready-set core. The post-dispatch
 * persistence shrank with it: there is no longer a wave-level aggregation
 * (`aggregateWaveStatus`), a `currentWave` advance (`nextCurrentWave`), a
 * next-action classifier (`classifyWaveOutcome`), or a `projectWaveRecord`
 * splice into a `waves[]` history. The recorder now writes each returned
 * Story's **terminal status** into the checkpoint's flat per-Story `stories`
 * map and re-renders the operator rollup from that map.
 *
 * Every export here is pure: no network I/O, no filesystem reads, no
 * spawning. The parent CLI handles the impure work (provider calls,
 * checkpoint reads/writes, webhook emits) and threads the resolved inputs
 * through these helpers.
 *
 * Group the exports by responsibility:
 *
 *   - Input validation: `validateResults`, `validateReturnsEntry`,
 *     `classifyParsedReturn`, `validateEpic`, `selectInputFlag`.
 *   - Normalization: `normalizeReturnsPure`.
 *   - Projection: `toRollupRow`.
 */

import { parseStoryAgentReturn } from './epic-runner/sub-agent-return.js';

/** Per-Story return statuses we accept off `/deliver` sub-agents. */
export const VALID_STORY_STATUSES = new Set(['done', 'blocked', 'failed']);

/**
 * Story status → rollup-row state. Post-fan-out every Story is in a
 * terminal state, so we only emit the three terminal forms here.
 */
export const STORY_STATUS_TO_ROW_STATE = {
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
    if (entry.blockerCommentId != null) {
      out.blockerCommentId = String(entry.blockerCommentId);
    }
    return out;
  });
}

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

/**
 * Build the rollup-row shape the unified `epic-run-progress` writer
 * consumes. Returns `{ id, title, state, blockerCommentId? }`.
 */
export function toRollupRow(verified, titleById) {
  const row = {
    id: verified.storyId,
    title: titleById.get(verified.storyId) ?? '',
    state: STORY_STATUS_TO_ROW_STATE[verified.status] ?? 'unknown',
  };
  if (verified.status === 'blocked' && verified.blockerCommentId != null) {
    row.blockerCommentId = String(verified.blockerCommentId);
  }
  return row;
}

/** Validate the core `{ epicId }` invariant. Throws on bad input. */
export function validateEpic(epicId) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicExecuteRecordWave: --epic must be a positive integer',
    );
  }
}

/**
 * Pure helper: enforce the XOR contract between `--results` and `--returns`.
 * Throws on "neither" / "both"; otherwise returns the chosen flag name so
 * the CLI can route to `parseInputArg` with a single branch.
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

/**
 * Normalize a return-text array into the parsed-results shape, returning the
 * envelopes that parsed cleanly and a list of failures for entries that
 * disagreed with their expected `storyId` or were not envelope-shaped. This
 * is the pure half of `normalizeReturns` in the CLI; the impure half
 * (`reconcileStoryFromGitHub` on each failure) is bound by the caller via
 * the `reconcile` dependency.
 *
 * Tests pin the success path without binding `reconcile`; the CLI binds it
 * to the network helper.
 *
 * @param {object} args
 * @param {Array<{ storyId: number, returnText: string }>} args.returns
 * @param {(args: { storyId: number }) => Promise<object> | object} [args.reconcile]
 *   Optional async hook used to fetch a fallback row when parsing fails. If
 *   omitted, parse failures push a placeholder `{ storyId, status: 'failed' }`
 *   row so the caller can still record without I/O.
 */
export async function normalizeReturnsPure({ returns, reconcile } = {}) {
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
    const fallback = reconcile
      ? await reconcile({ storyId })
      : { storyId, status: 'failed' };
    results.push(fallback);
    parseFailures.push({ storyId, error: classified.error, returnText });
  }
  return { results, parseFailures };
}
