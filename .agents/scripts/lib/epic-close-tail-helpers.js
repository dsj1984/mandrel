// .agents/scripts/lib/epic-close-tail-helpers.js
/**
 * Epic close-tail helpers (Story #2319 / Task #2329).
 *
 * `closePlanningArtifacts` and `verifyAndRecoverEpicClose` were lifted
 * out of the 1075-line `epic-deliver-finalize.js` legacy CLI when that
 * file collapsed to an emit shim. They are still consumed by
 * `epic-close.js` (the post-merge close-tail entry point) and are
 * tested in tree under `tests/epic-close-preflight.test.js` and
 * `tests/scripts/epic-close-planning-artifacts.test.js`.
 *
 * The functions are not lifecycle-bus listeners — they are ordinary
 * provider-driven helpers that the `epic-close` CLI invokes after
 * the operator merges the Epic PR. The lifecycle-bus close-tail
 * chain (`Finalizer`, `Watcher`, `AutomergePredicate`,
 * `AutomergeArmer`, `Cleaner`) runs earlier and owns its own
 * side effects.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { runEpicMode as defaultRunEpicMode } from '../analyze-execution.js';
import { epicPerfReportJsonPath } from './config/temp-paths.js';
import { Logger } from './Logger.js';
import {
  STATE_LABELS,
  transitionTicketState,
} from './orchestration/ticketing.js';

/**
 * Close the Epic's linked PRD and Tech Spec planning artifacts.
 *
 * The cascade walker in `lib/orchestration/ticketing/bulk.js` does not
 * recurse upward into the Epic (and historically excluded planning
 * tickets), so without this helper the PRD / Tech Spec stay
 * `agent::executing` (or whatever they were set to during planning)
 * forever. Beyond cosmetics, leaving planning tickets open as native
 * sub-issues of the Epic suppresses GitHub's PR-driven auto-close on
 * the Epic itself when sub-issue parent-close rules apply — closing
 * them here is what lets the `Closes #${epicId}` footer actually fire.
 *
 * Best-effort: a failure on one ticket logs a warn and is reported in
 * the result envelope; it never blocks the PR from opening.
 *
 * @param {{
 *   epicId: number,
 *   epic: { linkedIssues?: { prd?: number|null, techSpec?: number|null, acceptanceSpec?: number|null } } | null,
 *   provider: object,
 *   logger?: object,
 *   transitionFn?: typeof transitionTicketState,
 * }} args
 * @returns {Promise<{
 *   prd: { id: number|null, status: 'closed'|'skipped'|'failed', detail?: string },
 *   techSpec: { id: number|null, status: 'closed'|'skipped'|'failed', detail?: string },
 *   acceptanceSpec: { id: number|null, status: 'closed'|'skipped'|'failed', detail?: string },
 * }>}
 */
export async function closePlanningArtifacts({
  epicId,
  epic,
  provider,
  logger = Logger,
  transitionFn = transitionTicketState,
} = {}) {
  // Seed the result with the canonical key order so downstream callers
  // (and the JSON envelope) get prd → techSpec → acceptanceSpec regardless
  // of which transition settles first under Promise.all.
  const result = {
    prd: { id: null, status: 'skipped' },
    techSpec: { id: null, status: 'skipped' },
    acceptanceSpec: { id: null, status: 'skipped' },
  };
  const prdId = epic?.linkedIssues?.prd ?? null;
  const techSpecId = epic?.linkedIssues?.techSpec ?? null;
  const acceptanceSpecId = epic?.linkedIssues?.acceptanceSpec ?? null;

  const entries = [
    ['prd', prdId],
    ['techSpec', techSpecId],
    ['acceptanceSpec', acceptanceSpecId],
  ];

  // Dispatch all three transitions concurrently. Each branch resolves to a
  // { kind, value } tuple so we can re-assemble the result in canonical
  // key order after `Promise.all` settles. cascade:false avoids walking up
  // the parent chain — the Epic is closed by GitHub when the operator
  // merges the PR (or by the recovery path below), not by a cascade.
  const settled = await Promise.all(
    entries.map(async ([kind, id]) => {
      if (!Number.isInteger(id) || id <= 0) {
        return {
          kind,
          value: { id: null, status: 'skipped', detail: 'no-link' },
        };
      }
      try {
        await transitionFn(provider, id, STATE_LABELS.DONE, { cascade: false });
        logger.info?.(
          `[epic-close-tail] Closed planning artifact ${kind} #${id} for Epic #${epicId}.`,
        );
        return { kind, value: { id, status: 'closed' } };
      } catch (err) {
        const detail = err?.message ?? String(err);
        logger.warn?.(
          `[epic-close-tail] Failed to close planning artifact ${kind} #${id}: ${detail}`,
        );
        return { kind, value: { id, status: 'failed', detail } };
      }
    }),
  );
  for (const { kind, value } of settled) {
    result[kind] = value;
  }
  return result;
}

/**
 * Verify the Epic ticket reached `state: 'closed'` after the PR-driven
 * auto-close window. If it is still open, transition it explicitly via
 * `transitionTicketState`. Returns a structured envelope so callers can
 * surface "primary auto-close worked" vs "recovery fired" in audit logs.
 *
 * Failures are non-fatal — a recovery attempt that throws leaves the
 * Epic open and is reported in the envelope; the operator can re-run
 * `/epic-close` or close manually.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   logger?: object,
 *   transitionFn?: typeof transitionTicketState,
 * }} args
 * @returns {Promise<{
 *   status: 'already-closed'|'recovered'|'still-open'|'check-failed',
 *   priorState?: string,
 *   detail?: string,
 * }>}
 */
export async function verifyAndRecoverEpicClose({
  epicId,
  provider,
  logger = Logger,
  transitionFn = transitionTicketState,
} = {}) {
  let snapshot;
  try {
    if (typeof provider.invalidateTicket === 'function') {
      try {
        provider.invalidateTicket(epicId);
      } catch {
        // best-effort cache invalidation
      }
    }
    snapshot = await provider.getTicket(epicId);
  } catch (err) {
    const detail = err?.message ?? String(err);
    logger.warn?.(
      `[epic-close-tail] Epic #${epicId} close-verify read failed: ${detail}`,
    );
    return { status: 'check-failed', detail };
  }
  if (snapshot?.state === 'closed') {
    return { status: 'already-closed', priorState: 'closed' };
  }
  logger.warn?.(
    `[epic-close-tail] Epic #${epicId} still open after PR finalize — applying recovery transition to agent::done.`,
  );
  try {
    await transitionFn(provider, epicId, STATE_LABELS.DONE, { cascade: false });
    return { status: 'recovered', priorState: snapshot?.state ?? 'open' };
  } catch (err) {
    const detail = err?.message ?? String(err);
    logger.warn?.(
      `[epic-close-tail] Epic #${epicId} recovery transition failed: ${detail}`,
    );
    return {
      status: 'still-open',
      priorState: snapshot?.state ?? 'open',
      detail,
    };
  }
}

/**
 * Invoke `analyze-execution.runEpicMode` from the close tail and persist
 * the resulting `epic-perf-report` payload to
 * `temp/epic-<id>/epic-perf-report.json` (Epic #3019 / Story #3029 /
 * Task #3040). The analyzer already upserts the structured comment on
 * the Epic; this helper exists so the report is also reachable on disk
 * without a provider round-trip, and so the `epic-handoff` close
 * comment can link to it by relative path.
 *
 * Friction-not-fatal contract: any throw from the analyzer, the
 * filesystem write, or the cwd lookup is caught, logged as a `warn`,
 * and surfaced in the result envelope. The close tail must still
 * complete in that case — the report is observability output, not a
 * gating signal. Callers should record the failure (e.g. via the
 * friction lifecycle event) but MUST NOT throw.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   config?: object,
 *   cwd?: string,
 *   logger?: object,
 *   analyzeFn?: typeof defaultRunEpicMode,
 *   writeFileFn?: (p: string, data: string, encoding: string) => Promise<void>,
 *   mkdirFn?: (p: string, opts: object) => Promise<unknown>,
 *   now?: () => Date,
 * }} args
 * @returns {Promise<{
 *   status: 'ok'|'failed',
 *   path: string|null,
 *   commentId: number|null,
 *   payload: object|null,
 *   detail?: string,
 * }>}
 */
export async function emitEpicPerfReport({
  epicId,
  provider,
  config,
  cwd,
  logger = Logger,
  analyzeFn = defaultRunEpicMode,
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir,
  now,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'emitEpicPerfReport: epicId is required (positive integer).',
    );
  }
  if (!provider) {
    throw new TypeError('emitEpicPerfReport: provider is required.');
  }

  let result;
  try {
    result = await analyzeFn({
      epicId,
      provider,
      config,
      cwd,
      logger,
      ...(typeof now === 'function' ? { now } : {}),
    });
  } catch (err) {
    const detail = err?.message ?? String(err);
    logger.warn?.(
      `[epic-close-tail] emitEpicPerfReport: analyze-execution threw for Epic #${epicId} (non-fatal): ${detail}`,
    );
    return {
      status: 'failed',
      path: null,
      commentId: null,
      payload: null,
      detail,
    };
  }

  const target = epicPerfReportJsonPath(epicId, config);
  try {
    await mkdirFn(path.dirname(target), { recursive: true });
    await writeFileFn(
      target,
      `${JSON.stringify(result?.payload ?? {}, null, 2)}\n`,
      'utf8',
    );
  } catch (err) {
    const detail = err?.message ?? String(err);
    logger.warn?.(
      `[epic-close-tail] emitEpicPerfReport: failed to persist ${target} (non-fatal): ${detail}`,
    );
    return {
      status: 'failed',
      path: target,
      commentId: result?.commentId ?? null,
      payload: result?.payload ?? null,
      detail,
    };
  }

  logger.info?.(
    `[epic-close-tail] Persisted epic-perf-report.json at ${target} for Epic #${epicId}.`,
  );
  return {
    status: 'ok',
    path: target,
    commentId: result?.commentId ?? null,
    payload: result?.payload ?? null,
  };
}
