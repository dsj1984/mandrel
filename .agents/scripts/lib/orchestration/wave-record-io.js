/**
 * wave-record-io.js — impure helpers for the record-wave CLI: ticket
 * verification, manifest title lookup, returns reconciliation, and the
 * dispatch-manifest refresh hop.
 *
 * These functions all hit the provider and are intentionally kept out of
 * `wave-record-projection.js`, which is the pure projection layer. The
 * parent CLI imports both modules and threads the I/O results through
 * the projection.
 *
 * Every entry point here is fire-and-forget on the "best-effort" surfaces
 * (manifest lookup, dispatch-manifest refresh) and explicit-throw on the
 * authoritative ones (`verifyWaveResults` and `resolveResolvedResults`
 * decide what `complete` actually means after the network call lands).
 *
 * Story #3026 — `refreshDispatchManifest` replaced the historical
 * `refreshLocalManifest` subprocess spawn. The refresh runs in-process
 * through `resolveAndDispatch` + the pure `renderManifest` helper, then
 * upserts the `dispatch-manifest` structured comment so the Epic ticket
 * stays in sync with on-disk state without paying the per-wave
 * `node dispatcher.js --dry-run` cold-start cost.
 */

import { renderManifestFromManifest } from '../presentation/dispatch-manifest-render.js';
import { persistManifest } from '../presentation/manifest-persistence.js';
import { Logger } from '../Logger.js';
import { resolveAndDispatch } from './dispatch-engine.js';
import {
  reconcileStoryFromGitHub,
  renderMalformedReturnsFriction,
} from './epic-runner/sub-agent-return.js';
import { parseFencedJsonComment } from './structured-comment-parser.js';
import {
  findStructuredComment,
  postStructuredComment,
  upsertStructuredComment,
} from './ticketing.js';
import { normalizeReturnsPure } from './wave-record-projection.js';

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
 * Parse / reconcile the per-Story returns (or pass `results` through). Posts
 * a single rolled-up friction comment listing every malformed return on
 * failure — non-fatal if the post itself fails.
 *
 * @returns {Promise<{ resolvedResults: Array, parseFailures: Array }>}
 */
export async function resolveResolvedResults({
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
 * Re-render the dispatch manifest from live GitHub state and upsert the
 * `dispatch-manifest` structured comment on the Epic.
 *
 * Story #3026 — runs in-process through `resolveAndDispatch` + the pure
 * `renderManifest` helper. The historical subprocess spawn of
 * `dispatcher.js <epicId> --dry-run` is gone: it cost a Node cold start
 * and a full `.agents/` module graph re-import on every wave tick, and
 * produced the same comment body the helper now renders directly.
 *
 * `temp/epic-<id>/manifest.{md,json}` is still re-persisted so the
 * operator-facing on-disk view stays current — the wave-runner
 * architecture (Epic #1182) replaced the dispatcher's per-wave refresh
 * loop and without this hop the manifest is frozen at planning time.
 *
 * The function is fail-soft at the persist + upsert boundary so a
 * transient GitHub blip cannot block the wave loop; the
 * `resolveAndDispatch` call itself throws as before because that signals
 * "we cannot read the Epic at all".
 *
 * @param {{
 *   epicId: number,
 *   provider?: object,
 *   dispatch?: typeof resolveAndDispatch,
 *   upsertComment?: typeof upsertStructuredComment,
 *   persist?: typeof persistManifest,
 * }} opts
 * @returns {Promise<{
 *   epicId: number,
 *   body: string,
 *   posted: boolean,
 *   reason?: string,
 * }>}
 */
export async function refreshDispatchManifest({
  epicId,
  provider,
  dispatch = resolveAndDispatch,
  upsertComment = upsertStructuredComment,
  persist = persistManifest,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'refreshDispatchManifest: epicId must be a positive integer',
    );
  }
  const manifest = await dispatch({
    ticketId: epicId,
    dryRun: true,
    provider,
  });
  try {
    persist(manifest);
  } catch (err) {
    Logger.warn(
      `[wave-record-io] Non-fatal: could not persist manifest for Epic #${epicId} — ${err?.message ?? 'unknown error'}`,
    );
  }
  const body = renderManifestFromManifest(manifest);
  if (!provider || typeof provider.postComment !== 'function') {
    return { epicId, body, posted: false, reason: 'no-provider' };
  }
  try {
    await upsertComment(provider, epicId, 'dispatch-manifest', body);
    return { epicId, body, posted: true };
  } catch (err) {
    const message = err?.message ?? String(err);
    Logger.warn(
      `[wave-record-io] Non-fatal: could not upsert dispatch-manifest comment for Epic #${epicId} — ${message}`,
    );
    return { epicId, body, posted: false, reason: message };
  }
}
