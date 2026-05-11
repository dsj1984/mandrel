/**
 * Auto-merge predicate for `/epic-deliver` Phase 7.5.
 *
 * Decides whether the operator's "click merge" button is doing real work or
 * just rubber-stamping a clean run. When *every* signal is clean, the auto-
 * merge path fires `gh pr merge --squash --delete-branch`; otherwise the
 * workflow falls back to the operator-merges-button path so a human inspects
 * the surface area before promoting to `main`.
 *
 * Signal sources (all produced today, no new emit sites required):
 *
 *   1. `epic-run-state` checkpoint (`Checkpointer`):
 *      - `manualInterventions` length === 0
 *      - every wave's `status === "complete"`
 *      - no story envelope carries a `blockerCommentId`
 *
 *   2. `code-review` structured comment (markdown, posted by
 *      `epic-code-review.js`):
 *      - regex-parsed `🔴 Critical Blocker: N` and `🟠 High Risk: N` bullets
 *        must both report `0`
 *
 *   3. `retro` (or `retro-partial`) structured comment (markdown, posted by
 *      `retro-runner.js`):
 *      - body contains the compact-mode "🟢 Clean sprint" sentinel line
 *
 * Returns a verdict envelope the caller can either act on programmatically
 * (auto-merge CLI) or relay verbatim to the operator (workflow tail).
 */

import { findStructuredComment } from './ticketing.js';

export const CLEAN_SPRINT_MARKER = '🟢 Clean sprint';

/**
 * Regex-parse the rendered severity bullets on the code-review markdown
 * body. Pure. Exported for tests.
 *
 * @param {string} body
 * @returns {{ critical: number|null, high: number|null, medium: number|null, suggestion: number|null }}
 */
export function parseSeverityCounts(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return { critical: null, high: null, medium: null, suggestion: null };
  }
  const match = (re) => {
    const m = body.match(re);
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    critical: match(/🔴\s*Critical Blocker:\s*(\d+)/i),
    high: match(/🟠\s*High Risk:\s*(\d+)/i),
    medium: match(/🟡\s*Medium Risk:\s*(\d+)/i),
    suggestion: match(/🟢\s*Suggestion:\s*(\d+)/i),
  };
}

/**
 * Pure verdict-from-signals function. Composes the three signal sources into
 * a single `{ clean, reasons[] }` envelope. Exported for tests.
 *
 * @param {{
 *   state: object|null,
 *   codeReview: { body: string }|null,
 *   retro: { body: string }|null,
 * }} input
 * @returns {{
 *   clean: boolean,
 *   reasons: string[],
 *   signals: {
 *     manualInterventions: number,
 *     waveStatuses: string[],
 *     storyBlockers: number,
 *     severity: { critical: number|null, high: number|null, medium: number|null, suggestion: number|null },
 *     retroCompact: boolean,
 *     codeReviewFound: boolean,
 *     retroFound: boolean,
 *     stateFound: boolean,
 *   },
 * }}
 */
export function deriveAutoMergeVerdict({ state, codeReview, retro }) {
  const reasons = [];

  // 1. State signals — interventions, wave statuses, story blockers.
  const interventionCount = Array.isArray(state?.manualInterventions)
    ? state.manualInterventions.length
    : 0;
  if (!state) {
    reasons.push(
      'epic-run-state checkpoint missing — cannot certify clean run',
    );
  } else if (interventionCount > 0) {
    reasons.push(
      `manual interventions recorded (${interventionCount}): ${state.manualInterventions
        .map((i) => i.reason)
        .slice(0, 3)
        .join('; ')}${interventionCount > 3 ? '; …' : ''}`,
    );
  }

  const waves = Array.isArray(state?.waves) ? state.waves : [];
  const waveStatuses = waves.map((w) => w.status ?? 'unknown');
  const nonCompleteWaves = waveStatuses.filter((s) => s !== 'complete');
  if (nonCompleteWaves.length > 0) {
    reasons.push(
      `${nonCompleteWaves.length} wave(s) not complete (statuses: ${nonCompleteWaves.join(', ')})`,
    );
  }

  let storyBlockers = 0;
  for (const w of waves) {
    if (!Array.isArray(w.stories)) continue;
    for (const s of w.stories) {
      if (
        s &&
        typeof s.blockerCommentId === 'string' &&
        s.blockerCommentId.length > 0
      ) {
        storyBlockers += 1;
      }
      if (s?.status && s.status !== 'done') {
        storyBlockers += 1;
      }
    }
  }
  if (storyBlockers > 0) {
    reasons.push(
      `${storyBlockers} story-level blocker(s) recorded in run-state`,
    );
  }

  // 2. Code-review signals.
  const codeReviewFound = !!codeReview && typeof codeReview.body === 'string';
  const severity = codeReviewFound
    ? parseSeverityCounts(codeReview.body)
    : { critical: null, high: null, medium: null, suggestion: null };
  if (!codeReviewFound) {
    reasons.push('code-review structured comment not found on Epic');
  } else {
    if (severity.critical === null || severity.high === null) {
      reasons.push('code-review severity bullets could not be parsed');
    } else {
      if (severity.critical > 0) {
        reasons.push(
          `code-review has ${severity.critical} 🔴 Critical Blocker(s)`,
        );
      }
      if (severity.high > 0) {
        reasons.push(
          `code-review has ${severity.high} 🟠 High Risk finding(s)`,
        );
      }
    }
  }

  // 3. Retro signals.
  const retroFound = !!retro && typeof retro.body === 'string';
  const retroCompact = retroFound
    ? retro.body.includes(CLEAN_SPRINT_MARKER)
    : false;
  if (!retroFound) {
    reasons.push('retro structured comment not found on Epic');
  } else if (!retroCompact) {
    reasons.push(
      'retro is not compact (full retro indicates friction / parked / hotfixes)',
    );
  }

  return {
    clean: reasons.length === 0,
    reasons,
    signals: {
      manualInterventions: interventionCount,
      waveStatuses,
      storyBlockers,
      severity,
      retroCompact,
      codeReviewFound,
      retroFound,
      stateFound: !!state,
    },
  };
}

/**
 * IO-bound entry. Loads all three signal sources from the structured-comment
 * surface on the Epic ticket and hands them to `deriveAutoMergeVerdict`. DI-
 * friendly via the `findCommentFn` and `checkpointerFactory` hooks.
 *
 * @param {{
 *   provider: object,
 *   epicId: number,
 *   findCommentFn?: typeof findStructuredComment,
 *   checkpointerFactory: (deps: { provider: object, epicId: number }) => { read: () => Promise<object|null> },
 * }} opts
 * @returns {Promise<{ clean: boolean, reasons: string[], signals: object }>}
 */
export async function evaluateAutoMergePredicate({
  provider,
  epicId,
  findCommentFn = findStructuredComment,
  checkpointerFactory,
}) {
  if (!provider)
    throw new TypeError('evaluateAutoMergePredicate: provider required');
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'evaluateAutoMergePredicate: epicId must be a positive integer',
    );
  }
  if (typeof checkpointerFactory !== 'function') {
    throw new TypeError(
      'evaluateAutoMergePredicate: checkpointerFactory is required',
    );
  }

  const checkpointer = checkpointerFactory({ provider, epicId });
  const [state, codeReview, retro] = await Promise.all([
    checkpointer.read(),
    findCommentFn(provider, epicId, 'code-review'),
    (async () => {
      const primary = await findCommentFn(provider, epicId, 'retro');
      if (primary) return primary;
      return findCommentFn(provider, epicId, 'retro-partial');
    })(),
  ]);

  return deriveAutoMergeVerdict({ state, codeReview, retro });
}
