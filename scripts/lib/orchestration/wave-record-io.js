/**
 * wave-record-io.js — impure helpers for the record-wave CLI: ticket
 * verification, manifest title lookup, returns reconciliation, and the
 * dispatcher refresh hop.
 *
 * These functions all hit the provider (or spawn a subprocess) and are
 * intentionally kept out of `wave-record-projection.js`, which is the pure
 * projection layer. The parent CLI imports both modules and threads the
 * I/O results through the projection.
 *
 * Every entry point here is fire-and-forget on the "best-effort" surfaces
 * (manifest lookup, dispatcher refresh) and explicit-throw on the
 * authoritative ones (`verifyWaveResults` and `resolveResolvedResults`
 * decide what `complete` actually means after the network call lands).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Logger } from '../Logger.js';
import {
  reconcileStoryFromGitHub,
  renderMalformedReturnsFriction,
} from './epic-runner/sub-agent-return.js';
import { parseFencedJsonComment } from './structured-comment-parser.js';
import { findStructuredComment, postStructuredComment } from './ticketing.js';
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
 * Re-render `temp/epic-<id>/manifest.{md,json}` from live GitHub state.
 *
 * Spawns `dispatcher.js <epicId> --dry-run` in a subprocess so the existing
 * fetch-Epic / build-manifest / persist-manifest pipeline runs end-to-end
 * without coupling this CLI to the dispatcher internals. Stdout/stderr are
 * piped to a single buffer so failures can be logged but never pollute
 * this script's JSON envelope output.
 *
 * @param {{ epicId: number, dispatcherPath?: string, runner?: typeof spawn, scriptsDir?: string }} opts
 * @returns {Promise<void>}
 */
export async function refreshLocalManifest({
  epicId,
  dispatcherPath,
  runner = spawn,
  scriptsDir,
}) {
  // `lib/orchestration/wave-record-io.js` lives two directories below
  // `.agents/scripts/`, so resolve the dispatcher relative to that root
  // unless the caller injected an explicit override.
  const baseDir =
    scriptsDir ?? fileURLToPath(new URL('../../', import.meta.url));
  const dispatcher = dispatcherPath ?? path.join(baseDir, 'dispatcher.js');
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
