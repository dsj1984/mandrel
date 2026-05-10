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
 * In-process wrapper that the renamed deliver-runner consumes.
 *
 * @param {{
 *   epicId: number,
 *   provider?: object,
 *   logger?: { info?: Function, warn?: Function, error?: Function, fatal?: Function, createProgress?: Function },
 *   baseBranch?: string|null,
 *   scopeLint?: 'changed-only'|'off',
 *   storyId?: number|null,
 *   useEvidence?: boolean,
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

  const result = await runner(args, deps);

  // No-changes / invalid runs cannot block the deliver pipeline (no diff to
  // critique); surface the status and a non-halting envelope. The deliver
  // runner treats `status: 'invalid'` as a precondition failure separately.
  if (result.status !== 'ok') {
    return {
      status: result.status,
      severity: result.severity,
      report: result.report,
      posted: result.posted ?? false,
      halted: false,
      blockerReason: null,
    };
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

  return {
    status: 'ok',
    severity,
    report: result.report,
    posted: result.posted === true,
    halted,
    blockerReason,
  };
}
