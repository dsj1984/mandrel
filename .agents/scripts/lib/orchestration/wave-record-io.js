/**
 * wave-record-io.js — impure helpers for the record-wave CLI: ticket
 * verification, manifest title lookup, and returns reconciliation.
 *
 * These functions all hit the provider and are intentionally kept out of
 * `wave-record-projection.js`, which is the pure projection layer. The
 * parent CLI imports both modules and threads the I/O results through
 * the projection.
 *
 * Every entry point here is fire-and-forget on the "best-effort" surfaces
 * (manifest title lookup) and explicit-throw on the authoritative ones
 * (`verifyWaveResults` and `resolveResolvedResults` decide what `complete`
 * actually means after the network call lands).
 *
 * Story #3909 — the per-wave dispatch-manifest refresh hop
 * (`refreshDispatchManifest`) was deleted. It re-ran the full dispatch
 * pipeline (re-fetch every ticket, recompute waves) on every wave tick
 * only to re-render the `dispatch-manifest` comment, which nothing reads
 * for control flow — `loadManifestTitleMap` reads it for rollup-row titles,
 * and those are fixed at plan time. The manifest is now written once at
 * `epic-deliver-prepare` time and left frozen; the surviving operator-facing
 * surface is the `epic-run-progress` rollup the record-wave CLI re-renders.
 */

import { Logger } from '../Logger.js';
import { concurrentMap } from '../util/concurrent-map.js';
import {
  reconcileStoryFromGitHub,
  renderMalformedReturnsFriction,
} from './epic-runner/sub-agent-return.js';
import { parseFencedJsonComment } from './structured-comment-parser.js';
import { findStructuredComment, postStructuredComment } from './ticketing.js';
import { normalizeReturnsPure } from './wave-record-projection.js';

/**
 * Default cap for {@link verifyWaveResults}. Mirrors the default for
 * `delivery.deliverRunner.verifyConcurrencyCap` in `.agentrc.json`
 * (Epic #3019 Tech Spec §1.4 / Story #3024).
 */
const DEFAULT_VERIFY_CONCURRENCY_CAP = 4;

/**
 * Normalize raw `--returns` payload (per-Story sub-agent return texts) into
 * the same shape `validateResults` produces. Entries that fail to parse are
 * reconciled from GitHub and recorded as parse failures; the caller posts a
 * single rolled-up friction comment listing every failure.
 *
 * @param {{ provider: object, returns: Array<{ storyId: number, returnText: string }> }} args
 */
export async function normalizeReturns({ provider, returns } = {}) {
  return normalizeReturnsPure({
    returns,
    reconcile: ({ storyId }) => reconcileStoryFromGitHub({ provider, storyId }),
  });
}

/**
 * Verify a single result row: pass-through when the row is not claiming
 * `done`, otherwise re-fetch the ticket and emit either the verified row
 * (label/state agrees) or a `{ verified, discrepancy }` pair when the
 * claim disagrees with GitHub. Network failures surface as
 * `verify-error` discrepancies — they cannot prove the claim either way
 * so the row is downgraded to `failed`.
 *
 * Extracted as a per-row mapper so {@link verifyWaveResults} can run the
 * verifications through {@link concurrentMap} under a bounded cap.
 *
 * @param {object} r
 * @param {{ getTicket: Function }} provider
 * @returns {Promise<{ verified: object, discrepancy: object|null }>}
 */
async function verifySingleResult(r, provider) {
  if (r.status !== 'done') {
    return { verified: r, discrepancy: null };
  }
  let ticket;
  try {
    ticket = await provider.getTicket(r.storyId, { fresh: true });
  } catch (err) {
    const message = err?.message ?? String(err);
    return {
      verified: { ...r, status: 'failed', verifyError: message },
      discrepancy: {
        storyId: r.storyId,
        claimed: 'done',
        actual: 'verify-error',
        verifyError: message,
      },
    };
  }
  const labels = ticket?.labels ?? [];
  const isDone = labels.includes('agent::done') || ticket?.state === 'closed';
  if (isDone) {
    return { verified: r, discrepancy: null };
  }
  const actualLabel =
    labels.find((l) => typeof l === 'string' && l.startsWith('agent::')) ??
    'unknown';
  return {
    verified: { ...r, status: 'failed' },
    discrepancy: { storyId: r.storyId, claimed: 'done', actual: actualLabel },
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
 * Story #3024 — verification runs through {@link concurrentMap} under a
 * bounded cap (default 4, override via
 * `delivery.deliverRunner.verifyConcurrencyCap`). Per-row failures are
 * captured inside the mapper so one Story's `getTicket` throw cannot
 * abort the whole wave — the per-row try/catch lives in
 * {@link verifySingleResult} and turns into a `verify-error`
 * discrepancy rather than a rejected mapper. Input order is preserved
 * (mapper-index → output-index), matching the previous serial behaviour.
 *
 * @param {{
 *   provider: { getTicket?: Function },
 *   results: Array<object>,
 *   concurrencyCap?: number,
 * }} args
 */
export async function verifyWaveResults({
  provider,
  results,
  concurrencyCap,
} = {}) {
  if (!provider || typeof provider.getTicket !== 'function') {
    return { verified: results ?? [], discrepancies: [] };
  }
  const cap =
    Number.isInteger(concurrencyCap) && concurrencyCap >= 1
      ? concurrencyCap
      : DEFAULT_VERIFY_CONCURRENCY_CAP;
  const rows = results ?? [];
  const outcomes = await concurrentMap(
    rows,
    (r) => verifySingleResult(r, provider),
    { concurrency: cap },
  );
  const verified = [];
  const discrepancies = [];
  for (const out of outcomes) {
    verified.push(out.verified);
    if (out.discrepancy) discrepancies.push(out.discrepancy);
  }
  return { verified, discrepancies };
}

/**
 * Best-effort cross-look of the dispatch-manifest titles. Failure to read
 * or parse the manifest is non-fatal — empty title is acceptable.
 *
 * @param {{ provider: object, epicId: number }} args
 */
export async function loadManifestTitleMap({ provider, epicId }) {
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
 * Extract the Story IDs planned for `wave` from the checkpoint `plan`
 * (`Story[][]` indexed by wave). Returns `[]` when the plan is missing or
 * the wave index is out of range. Pure helper — exported for unit tests.
 *
 * Story #3907 — the wave-complete livelock recovery (below) keys off this:
 * when mode B records a wave with **no** child returns (the host crashed
 * after the children finished but before `record-wave` ran), every Story in
 * `plan[wave]` is reconciled from GitHub so the wave can record and
 * `currentWave` can advance instead of returning `wave-complete` for the same
 * index forever.
 *
 * @param {object} existing Checkpoint state.
 * @param {number} wave
 * @returns {number[]}
 */
export function planStoryIdsForWave(existing, wave) {
  const plan = Array.isArray(existing?.plan) ? existing.plan : [];
  const entries = Array.isArray(plan[wave]) ? plan[wave] : [];
  const ids = [];
  for (const entry of entries) {
    const id =
      typeof entry === 'number'
        ? entry
        : Number(entry?.id ?? entry?.storyId ?? entry?.number);
    if (Number.isInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}

/**
 * Parse / reconcile the per-Story returns (or pass `results` through). Posts
 * a single rolled-up friction comment listing every malformed return on
 * failure — non-fatal if the post itself fails.
 *
 * Story #3907 — mode B with an **empty** `returns` array is the
 * wave-complete-livelock recovery path: the host crashed after the wave's
 * children finished but before `record-wave` ran, so no return text survives.
 * Rather than recording an empty (falsely-`complete`) wave, every Story in
 * `plan[wave]` is reconciled from GitHub via {@link reconcileStoryFromGitHub}
 * so the recorded wave reflects the live ticket state. This requires the
 * caller to thread the checkpoint `existing` so the wave's planned Story set
 * is known; without it the empty array degrades to the previous behaviour.
 *
 * @returns {Promise<{ resolvedResults: Array, parseFailures: Array }>}
 */
export async function resolveResolvedResults({
  provider,
  epicId,
  wave,
  results,
  returns,
  existing,
}) {
  if (returns == null) {
    return { resolvedResults: results, parseFailures: [] };
  }
  if (Array.isArray(returns) && returns.length === 0 && existing) {
    const ids = planStoryIdsForWave(existing, wave);
    if (ids.length > 0) {
      const resolvedResults = await concurrentMap(
        ids,
        (storyId) => reconcileStoryFromGitHub({ provider, storyId }),
        { concurrency: DEFAULT_VERIFY_CONCURRENCY_CAP },
      );
      Logger.warn(
        `[wave-record-io] Wave ${wave} recorded with no child returns; ` +
          `reconciled ${ids.length} Story(ies) from GitHub (livelock recovery).`,
      );
      return { resolvedResults, parseFailures: [] };
    }
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
