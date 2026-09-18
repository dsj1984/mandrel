/**
 * `delivery.ci` accessor + framework defaults — Story #4356 (Epic #4355).
 *
 * Surviving knob: `autoMerge` (default `"trust-ci"`) selects the merge posture — `"trust-ci"` merges once
 * required checks pass, `"strict"` additionally requires a clean review gate.
 *
 * Story #5096 added `blockOnAdvisoryFailure` (default `true`) and
 * `advisoryAllowlist` (default `[]`). GitHub native auto-merge waits on
 * REQUIRED contexts only, so a red ADVISORY gate would otherwise be merged
 * straight past; these knobs own mandrel's side of that decision. Set
 * `blockOnAdvisoryFailure: false` to restore the pre-#5096 behaviour verbatim,
 * or list a job name in `advisoryAllowlist` to exempt just that one.
 *
 * Story #5266 added `rerunAdvisory`, **default `0`**. It is the number of
 * times close may re-run a failed advisory workflow run before blocking on it.
 * Zero is the deliberate default and not a placeholder: a rerun spends the
 * consumer's CI minutes and mutates GitHub state, and close must never do
 * either unasked. Raise it (or pass `--rerun-advisory <n>`) on a repository
 * whose advisory scans time out transiently.
 *
 * Retired (no production readers on v2 Story-only delivery): `earlyPr`
 * (Epic early-PR warmup) and `requireChecks` (AutomergePredicate escape hatch
 * whose listener was never landed). Story #5382 folded the never-set
 * `watch.*` poll-loop keys into `WATCH_DEFAULTS` in `pr-watch-with-update.js`,
 * whose CLI flags still override them per invocation.
 */

export const CI_DELIVERY_DEFAULTS = Object.freeze({
  autoMerge: 'trust-ci',
  blockOnAdvisoryFailure: true,
  advisoryAllowlist: Object.freeze([]),
  rerunAdvisory: 0,
});

/**
 * Per-knob validators for the scalar `delivery.ci` settings. A value that
 * fails its own test is not an instruction to guess — it degrades to the
 * framework default beside it in {@link CI_DELIVERY_DEFAULTS}, which is why
 * the two objects are keyed alike and read as a pair.
 */
const CI_KNOB_VALIDATORS = Object.freeze({
  autoMerge: (value) => value === 'trust-ci' || value === 'strict',
  blockOnAdvisoryFailure: (value) => typeof value === 'boolean',
  // Story #5266 — a negative or non-integer allowance spends nothing.
  rerunAdvisory: (value) => Number.isInteger(value) && value >= 0,
});

/**
 * Read the merged `delivery.ci` block, applying framework defaults for any
 * field the operator omitted. Accepts the full resolved config, the bare
 * delivery bag, or the bare ci bag.
 *
 * @param {object | null | undefined} config
 * @returns {{ autoMerge: 'trust-ci' | 'strict', blockOnAdvisoryFailure: boolean,
 *   advisoryAllowlist: string[], rerunAdvisory: number }}
 */
export function getCiDelivery(config) {
  const ci = config?.delivery?.ci ?? config?.ci ?? config ?? {};
  const knobs = {};
  for (const [key, isValid] of Object.entries(CI_KNOB_VALIDATORS)) {
    knobs[key] = isValid(ci[key]) ? ci[key] : CI_DELIVERY_DEFAULTS[key];
  }
  return {
    ...knobs,
    advisoryAllowlist: Array.isArray(ci.advisoryAllowlist)
      ? ci.advisoryAllowlist.filter(
          (entry) => typeof entry === 'string' && entry,
        )
      : [...CI_DELIVERY_DEFAULTS.advisoryAllowlist],
  };
}
