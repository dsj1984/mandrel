/**
 * Shared run parameters for every `fast-check` property in the suite.
 *
 * Determinism is load-bearing (the no-flaky-rerun rule): a property that
 * draws a fresh random seed per run can go red once and green on the retry,
 * which is exactly the signal this repository refuses to trust. So every
 * property runs from a pinned default seed and a bounded default run count,
 * and a failure is always reproducible from what the reporter prints (seed,
 * path, shrunk counterexample).
 *
 * Local exploration overrides both without editing a test:
 *
 *   MANDREL_FC_SEED=1 MANDREL_FC_NUM_RUNS=500 node --test <files>
 *
 * A malformed override throws rather than silently falling back: an operator
 * who asked for 5000 runs and quietly got 100 would read a green as far more
 * evidence than it is.
 */

/** Pinned default seed — any fixed integer works; this one names the Story. */
export const DEFAULT_SEED = 5424;

/** Bounded default run count, sized to keep the unit tier fast. */
export const DEFAULT_NUM_RUNS = 100;

/**
 * Parse one integer override. `undefined` / empty means "not set".
 *
 * @param {string|undefined} raw
 * @param {string} name Env var name, for the error message.
 * @param {(n: number) => boolean} valid
 * @returns {number|null}
 */
function parseOverride(raw, name, valid) {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || !valid(n)) {
    throw new Error(`[fast-check-config] ${name}=${raw} is not a valid value.`);
  }
  return n;
}

/**
 * Resolve `{ seed, numRuns }` from an environment.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{ seed: number, numRuns: number }}
 */
export function resolveRunParameters(env = process.env) {
  const seed = parseOverride(env.MANDREL_FC_SEED, 'MANDREL_FC_SEED', (n) =>
    Number.isSafeInteger(n),
  );
  const numRuns = parseOverride(
    env.MANDREL_FC_NUM_RUNS,
    'MANDREL_FC_NUM_RUNS',
    (n) => n > 0,
  );
  return {
    seed: seed ?? DEFAULT_SEED,
    numRuns: numRuns ?? DEFAULT_NUM_RUNS,
  };
}

/**
 * Parameters for `fc.assert(property, fcParams())`. `overrides` merge last,
 * for a property that must pin something extra (e.g. `examples`); a property
 * MUST NOT override `seed` — that defeats the env override.
 *
 * @param {object} [overrides]
 * @returns {{ seed: number, numRuns: number }}
 */
export function fcParams(overrides = {}) {
  return { ...resolveRunParameters(), ...overrides };
}
