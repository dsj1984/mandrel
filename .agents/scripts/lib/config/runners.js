/**
 * Runner accessor (Epic #1720 Story #1739 — top-level reshape).
 *
 * Post-reshape, only `delivery.deliverRunner` and `delivery.codeReview` are
 * configurable via this accessor; everything else lives in framework-internal
 * constants exported alongside (`DEFAULT_DECOMPOSER`).
 * `delivery.epicAudit` was removed on v2 (Story-only delivery — no
 * epic-audit runner; remediation policy lives on `delivery.codeReview`).
 */

/** Hardcoded decomposer concurrency cap (was `orchestration.runners.decomposer.concurrencyCap`). */
export const DEFAULT_DECOMPOSER = Object.freeze({
  concurrencyCap: 3,
});

/**
 * Hardcoded deliver-runner defaults. Operators override via
 * `delivery.deliverRunner.*` in `.agentrc.json`.
 *
 * **Throughput tradeoff — `concurrencyCap`.**
 * The default of 3 is intentionally moderate: it keeps host-quota
 * consumption predictable for multi-Story plan-runs and avoids saturating
 * the GitHub API with concurrent label writes, while still allowing a
 * small ready-set fan-out. Operators who want strictly sequential delivery
 * should set `delivery.deliverRunner.concurrencyCap: 1`. Raising the cap
 * reduces wall-clock time where dependencies allow. See `mandrel-deliver.md` and
 * `agentrc-reference.json` `delivery.deliverRunner.concurrencyCap`.
 *
 * Story #4545 removed the sibling `verifyConcurrencyCap`: the
 * `verifyWaveResults` loop it claimed to bound never existed in the tree, and
 * its only reader was the retired execution-analysis CLI, which echoed the
 * number into a report rather than bounding anything.
 *
 * **Serialization tradeoff — `footprintGuard`.** `enforce` is the default and
 * stays it: the file-overlap guard encodes delivery-time-only knowledge (which
 * implementation windows are open, which Stories a foreign lease holds) that no
 * plan-time `depends_on` edge can carry, so demoting it by default would trade
 * a real merge-conflict class for throughput nobody asked for. `advisory`
 * detects collisions and reports every would-be withhold but lets dispatch
 * follow the declared edges alone — for runs whose ordering is fully declared
 * (Story #5044).
 */
const DEFAULT_DELIVER_RUNNER = Object.freeze({
  concurrencyCap: 3,
  footprintGuard: 'enforce',
});

/**
 * Default auto-fix loop ceilings for /mandrel-deliver code-review. Operators
 * override via `delivery.codeReview.*` in `.agentrc.json` (Story #2611,
 * Epic #2586; `autoFixSeverity` default `'medium'` per Story #4399).
 * `maxFixScopeFiles` was retired in Story #5313 — it bounded a fix by file
 * count rather than by risk.
 */
export const DEFAULT_CODE_REVIEW = Object.freeze({
  maxFixAttempts: 3,
  autoFixSeverity: 'medium',
});

/**
 * Read the merged deliver-runner block.
 *
 * @param {object | null | undefined} config
 * @returns {{
 *   deliverRunner: { concurrencyCap: number, footprintGuard: 'enforce'|'advisory' },
 *   codeReview: { maxFixAttempts: number, autoFixSeverity: 'high'|'medium' },
 *   decomposer: { concurrencyCap: number },
 * }}
 */
export function getRunners(config) {
  return {
    deliverRunner: withDefaults(
      DEFAULT_DELIVER_RUNNER,
      config?.delivery?.deliverRunner,
    ),
    codeReview: withDefaults(DEFAULT_CODE_REVIEW, config?.delivery?.codeReview),
    decomposer: DEFAULT_DECOMPOSER,
  };
}

/**
 * Overlay an operator's block onto the framework defaults — the per-key `??`
 * fallback these accessors have always applied, written once.
 *
 * Iterating the **defaults'** keys rather than the user's is what keeps the
 * returned shape closed: a key the framework does not define cannot reach a
 * consumer through here even if one somehow survived AJV, so a typo degrades to
 * the default rather than to an undefined a caller would read as configuration.
 *
 * @template {Record<string, unknown>} T
 * @param {T} defaults      Frozen framework defaults.
 * @param {object|null|undefined} user Operator block from `.agentrc`.
 * @returns {T} A fresh object; the frozen defaults are never mutated.
 */
function withDefaults(defaults, user) {
  const out = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (user?.[key] != null) out[key] = user[key];
  }
  return out;
}
