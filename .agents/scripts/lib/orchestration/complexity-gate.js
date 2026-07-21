/**
 * lib/orchestration/complexity-gate.js — plan-time ceremony-lite routing gate.
 *
 * A **deterministic, conservative** complexity gate that routes a planning seed
 * onto either the full two-session plan/deliver ceremony (`full`) or a collapsed
 * ceremony-lite path (`lite`). It exists because the full ceremony imposes a
 * large fixed cost premium on genuinely trivial single-artifact scopes with no
 * measured quality gain (Story #4683): the bench cohort spent ~52 turns on a
 * hello-world scope a bare control delivered in ~6, and no path existed to opt
 * trivial scopes out.
 *
 * ## What "lite" changes and — critically — what it never changes
 *
 * The lite route collapses the **advisory ceremony** only: the plan/deliver
 * session split, the fresh-context critic ceremony, and the Tech-Spec authoring
 * that a one-artifact scope does not earn. It **never** relaxes a non-negotiable.
 * {@link LITE_PATH_INVARIANTS} is the machine-readable contract that the lite
 * path still produces a Story ticket, still lands via a PR to `main`, still runs
 * every repo quality gate, and still honours `rules/security-baseline.md`. Those
 * gates run in `single-story-close.js` regardless of route; the gate cannot and
 * does not switch them off. Every `lite` decision carries this frozen object on
 * its `preserves` field so a downstream reader can assert the invariants held.
 *
 * ## Conservative by construction — full on any doubt
 *
 * The gate is total and pure: seed text + resolved config in, decision out. It
 * routes `lite` **only** when every trivial-scope signal agrees; every other
 * case — an empty/unreadable seed, a seed above the word ceiling, a seed
 * enumerating more than one candidate artifact, or the gate disabled by config —
 * falls to `full`. Being wrong toward `full` costs a session; being wrong toward
 * `lite` would skip ceremony a real capability slice needs, so the tie always
 * breaks to `full`.
 *
 * ## Threshold + operator override
 *
 * {@link DEFAULT_COMPLEXITY_GATE} is the single source of truth for the
 * threshold. Operators tune it (or disable the gate entirely) via
 * `planning.complexityGate` in `.agentrc.json`:
 *
 *   - `enabled`      (default `true`)  — `false` forces every seed to `full`.
 *   - `maxSeedWords` (default `60`)    — seed prose word ceiling for `lite`.
 *   - `maxArtifacts` (default `1`)     — enumerated-artifact ceiling for `lite`.
 *
 * Resolution clamps every field toward the conservative default: a malformed or
 * negative ceiling falls back to the framework default rather than widening the
 * lite path.
 *
 * @typedef {'lite'|'full'} ComplexityRoute
 */

/**
 * Framework defaults for the plan-time complexity gate. The threshold SSOT —
 * the config schema mirror and the configuration reference both cite these
 * numbers rather than restating divergent ones.
 */
const DEFAULT_COMPLEXITY_GATE = Object.freeze({
  enabled: true,
  maxSeedWords: 60,
  maxArtifacts: 1,
});

/**
 * The non-negotiables the ceremony-lite path preserves. This is the
 * contract behind Story #4683 AC-2: collapsing ceremony never means dropping
 * the Story ticket, the PR-to-`main` landing, the repo quality gates, or the
 * security baseline. Attached verbatim to every `lite` decision's `preserves`
 * field; a downstream consumer (or contract test) asserts against it.
 */
const LITE_PATH_INVARIANTS = Object.freeze({
  storyTicket: true,
  prToMain: true,
  repoGates: true,
  securityBaseline: true,
});

/**
 * Coerce a candidate ceiling into a non-negative integer, falling back to the
 * framework default for anything malformed. Non-numbers, non-finite values, and
 * negatives all fall back — a stray `-1` or `NaN` must never widen the lite path
 * (the gate fails conservative, toward `full`).
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeCeiling(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

/**
 * Resolve the effective complexity-gate config, shallow-overlaying an operator
 * `planning.complexityGate` block onto {@link DEFAULT_COMPLEXITY_GATE}. Accepts
 * the full resolved config, the bare `planning` bag, or the bare
 * `complexityGate` bag, mirroring the tolerant unwrap the other routing
 * accessors use. Module-private: exposed only through the resolved `threshold`
 * on {@link buildComplexityRouteSignal}'s output, so there is no test-only
 * export to leave production-dead.
 *
 * @param {object | null | undefined} config
 * @returns {{ enabled: boolean, maxSeedWords: number, maxArtifacts: number }}
 */
function resolveComplexityGate(config) {
  const raw =
    config?.planning?.complexityGate ?? config?.complexityGate ?? config ?? {};
  const bag = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled:
      typeof bag.enabled === 'boolean'
        ? bag.enabled
        : DEFAULT_COMPLEXITY_GATE.enabled,
    maxSeedWords: normalizeCeiling(
      bag.maxSeedWords,
      DEFAULT_COMPLEXITY_GATE.maxSeedWords,
    ),
    maxArtifacts: normalizeCeiling(
      bag.maxArtifacts,
      DEFAULT_COMPLEXITY_GATE.maxArtifacts,
    ),
  };
}

/**
 * Count top-level enumerated items (`- `, `* `, `1. `) in a free-form seed —
 * the same shape the scope-triage and delivery-shape signals read as candidate
 * capabilities. Each enumerated line is one predicted artifact; a seed with two
 * or more is a multi-capability scope that must take the full path.
 *
 * @param {string} text
 * @returns {number}
 */
function countSeedArtifacts(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line)).length;
}

/**
 * Build the advisory complexity-route signal for a planning seed. Deterministic,
 * total, and conservative (see the module header): every trivial-scope signal
 * must agree for a `lite` decision; everything else routes `full`.
 *
 * The result is folded into the `/plan` context envelope as `complexityRoute`,
 * so the workflow reads one field instead of re-deriving the decision. Every
 * `lite` decision carries {@link LITE_PATH_INVARIANTS} on `preserves`.
 *
 * @param {{ seedText?: string, config?: object }} [args]
 * @returns {{
 *   route: ComplexityRoute,
 *   reasons: string[],
 *   threshold: { enabled: boolean, maxSeedWords: number, maxArtifacts: number },
 *   preserves: typeof LITE_PATH_INVARIANTS,
 *   advisory: true,
 * }}
 */
export function buildComplexityRouteSignal({ seedText = '', config } = {}) {
  const threshold = resolveComplexityGate(config);
  const advisory = /** @type {const} */ (true);
  const preserves = LITE_PATH_INVARIANTS;
  const decide = (route, reason) => ({
    route,
    reasons: [reason],
    threshold,
    preserves,
    advisory,
  });

  if (!threshold.enabled) {
    return decide(
      'full',
      'complexity gate disabled (planning.complexityGate.enabled=false) — full plan/deliver ceremony',
    );
  }

  const text = typeof seedText === 'string' ? seedText : '';
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return decide(
      'full',
      'empty seed — triviality cannot be judged; conservative full path',
    );
  }

  const artifactCount = countSeedArtifacts(text);
  if (artifactCount > threshold.maxArtifacts) {
    return decide(
      'full',
      `seed enumerates ${artifactCount} candidate artifacts (> maxArtifacts ${threshold.maxArtifacts}) — multi-capability scope takes the full path`,
    );
  }

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > threshold.maxSeedWords) {
    return decide(
      'full',
      `seed is ${wordCount} words (> maxSeedWords ${threshold.maxSeedWords}) — not a trivial scope; full path`,
    );
  }

  return decide(
    'lite',
    `trivial single-artifact scope (${wordCount} words ≤ ${threshold.maxSeedWords}, ${artifactCount} enumerated artifact(s) ≤ ${threshold.maxArtifacts}) — collapsed ceremony-lite path; non-negotiables preserved`,
  );
}
