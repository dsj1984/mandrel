/**
 * lib/orchestration/code-review.js — In-process Code Review module.
 *
 * Story #1155 (Epic #1142, 5.40.0) — extracts the helper-driven
 * `epic-code-review` invocation into a callable module so the renamed
 * `epic-deliver-runner.js` can run Phase D without spawning a child
 * process or routing through an LLM-driven helper.
 *
 * Public API:
 *   - `runCodeReview({ epicId, provider, logger })` →
 *       `{ status, severity, posted, report, halted, blockerReason }`.
 *
 * Behaviour:
 *   - Delegates to the existing `runEpicCodeReview` runner in
 *     `.agents/scripts/epic-code-review.js` (already exports a DI-shaped
 *     async function).
 *   - Always posts (`post: true`) so the structured `code-review` comment
 *     lands on the Epic.
 *   - Treats severity.critical > 0 as a halting blocker — the merged
 *     `/epic-deliver` runner consults `halted` and refuses to advance to
 *     Phase E (retro) when set.
 *
 * Halting on critical findings is the in-process replacement for the
 * helper's "operator must remediate before /epic-deliver" gate.
 */

import { runEpicCodeReview } from '../../epic-code-review.js';

/**
 * Story #2252 — best-effort lifecycle emit helper. Wraps `bus.emit` in a
 * try/catch so a misbehaving observability surface never blocks the
 * code-review phase. `bus: null` short-circuits to a no-op.
 */
async function emitLifecycleSafe({ bus, event, payload, logger }) {
  if (!bus || typeof bus.emit !== 'function') return;
  try {
    await bus.emit(event, payload);
  } catch (err) {
    logger?.warn?.(
      `[code-review] ⚠️ ${event} emit failed (swallowed): ${err?.message ?? err}`,
    );
  }
}

/**
 * Build the `code-review.end` payload from the runner's normalized
 * result envelope. Pure — exported indirectly so test fixtures can pin
 * the strip behavior without round-tripping through the bus.
 *
 * The runner result may carry a `report` field (full markdown body)
 * which is **NOT** included in the lifecycle payload: the schema's
 * `additionalProperties: false` already forbids it, and the body can
 * carry inline severity counts that drift from the structured
 * `severity` field. The lifecycle ledger is the structured surface;
 * the report is GitHub's surface (posted via the structured comment).
 *
 * Defense-in-depth: secret-deny-list keys (token, password, secret,
 * apiKey, webhookUrl) are stripped by `LedgerWriter` before write, so
 * even a future contributor who accidentally adds one to the runner
 * result envelope cannot leak it through the ledger. The contract test
 * verifies this stripping at the boundary.
 */
function buildCodeReviewEndPayload({ epicId, result, durationMs }) {
  const payload = {
    epicId,
    status: result.status,
  };
  if (result.severity && typeof result.severity === 'object') {
    payload.severity = {
      critical: result.severity.critical ?? 0,
      high: result.severity.high ?? 0,
      medium: result.severity.medium ?? 0,
      suggestion: result.severity.suggestion ?? 0,
    };
  }
  if (typeof result.halted === 'boolean') payload.halted = result.halted;
  if (typeof result.posted === 'boolean') payload.posted = result.posted;
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    payload.durationMs = Math.floor(durationMs);
  }
  return payload;
}

/**
 * In-process wrapper that the renamed deliver-runner consumes.
 *
 * Story #2252 — when `opts.bus` is supplied the wrapper emits
 * `code-review.start` immediately on entry and `code-review.end`
 * immediately before returning the envelope (success or halt). On
 * runner throw the helper emits `code-review.end` with the canonical
 * structure (`status: 'invalid'`) before re-throwing so the ledger
 * always carries the closing boundary.
 *
 * @param {{
 *   epicId: number,
 *   provider?: object,
 *   logger?: { info?: Function, warn?: Function, error?: Function, fatal?: Function, createProgress?: Function },
 *   baseBranch?: string|null,
 *   scopeLint?: 'changed-only'|'off',
 *   storyId?: number|null,
 *   useEvidence?: boolean,
 *   bus?: object|null,
 *   now?: () => number,
 *   runner?: typeof runEpicCodeReview,
 * }} opts
 * @returns {Promise<{
 *   status: 'ok'|'no-changes'|'invalid',
 *   severity?: { critical: number, high: number, medium: number, suggestion: number },
 *   report?: string,
 *   posted?: boolean,
 *   halted: boolean,
 *   blockerReason: string|null,
 * }>}
 */
export async function runCodeReview(opts = {}) {
  const {
    epicId,
    provider,
    logger,
    baseBranch = null,
    scopeLint = 'changed-only',
    storyId = null,
    useEvidence = true,
    bus = null,
    now = Date.now,
    runner = runEpicCodeReview,
  } = opts;

  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runCodeReview: epicId is required (positive integer).',
    );
  }

  const args = {
    epicId,
    baseBranch,
    post: true,
    scopeLint,
    storyId,
    useEvidence,
  };

  const deps = {};
  if (logger) deps.logger = logger;
  if (provider) {
    // The runner accepts a `providerFactory` that returns a provider; the
    // in-process module already has one and just hands it through.
    deps.providerFactory = () => provider;
  }

  const startedAt = typeof now === 'function' ? now() : Date.now();
  await emitLifecycleSafe({
    bus,
    event: 'code-review.start',
    payload: { epicId },
    logger,
  });

  let result;
  try {
    result = await runner(args, deps);
  } catch (err) {
    // Surface the closing boundary even on runner throw — the ledger
    // must always show a matched start/end pair. `status: 'invalid'`
    // is the canonical "could not complete" value (the runner uses it
    // for precondition failures).
    const endedAt = typeof now === 'function' ? now() : Date.now();
    await emitLifecycleSafe({
      bus,
      event: 'code-review.end',
      payload: buildCodeReviewEndPayload({
        epicId,
        result: { status: 'invalid' },
        durationMs: Math.max(0, endedAt - startedAt),
      }),
      logger,
    });
    throw err;
  }

  // No-changes / invalid runs cannot block the deliver pipeline (no diff to
  // critique); surface the status and a non-halting envelope. The deliver
  // runner treats `status: 'invalid'` as a precondition failure separately.
  if (result.status !== 'ok') {
    const envelope = {
      status: result.status,
      severity: result.severity,
      report: result.report,
      posted: result.posted ?? false,
      halted: false,
      blockerReason: null,
    };
    const endedAt = typeof now === 'function' ? now() : Date.now();
    await emitLifecycleSafe({
      bus,
      event: 'code-review.end',
      payload: buildCodeReviewEndPayload({
        epicId,
        result: envelope,
        durationMs: Math.max(0, endedAt - startedAt),
      }),
      logger,
    });
    return envelope;
  }

  const severity = result.severity ?? {
    critical: 0,
    high: 0,
    medium: 0,
    suggestion: 0,
  };
  const halted = (severity.critical ?? 0) > 0;
  const blockerReason = halted
    ? `code-review reported ${severity.critical} critical blocker(s)`
    : null;

  const envelope = {
    status: 'ok',
    severity,
    report: result.report,
    posted: result.posted === true,
    halted,
    blockerReason,
  };
  const endedAt = typeof now === 'function' ? now() : Date.now();
  await emitLifecycleSafe({
    bus,
    event: 'code-review.end',
    payload: buildCodeReviewEndPayload({
      epicId,
      result: envelope,
      durationMs: Math.max(0, endedAt - startedAt),
    }),
    logger,
  });
  return envelope;
}
