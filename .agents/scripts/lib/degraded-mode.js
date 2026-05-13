/**
 * Shared helper for the explicit-degraded contract used by soft-failing gates.
 *
 * Tech Spec #819 §"Degraded-mode contract (Story 3)" — three soft-fail sites
 * (select-audits diff-timeout, lint-baseline JSON-parse, baseline-refresh
 * guardrail git-diff) historically returned a silent zero/empty result. The
 * new contract is:
 *
 *   { ok: false, degraded: true, reason: <code>, detail: <human> }
 *
 * with a non-zero CLI exit so the operator/agent has explicit visibility, OR
 * a hard-fail closed when `--gate-mode` / `MANDREL_GATE_MODE=1` is set
 * (CI invocations).
 */

/**
 * Build the canonical degraded envelope.
 *
 * @param {string} reason  Machine-readable code (e.g. `GIT_DIFF_TIMEOUT`).
 * @param {string} [detail] Human-readable explanation for operators.
 * @returns {{ ok: false, degraded: true, reason: string, detail: string }}
 */
export function degraded(reason, detail = '') {
  return { ok: false, degraded: true, reason, detail };
}

/**
 * True when `value` carries the degraded envelope shape.
 */
export function isDegraded(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      value.ok === false &&
      value.degraded === true &&
      typeof value.reason === 'string',
  );
}

/**
 * Decide whether the caller is running in gate-mode (hard-fail closed) based
 * on argv and env. CI invocations set `--gate-mode` or
 * `MANDREL_GATE_MODE=1`; local invocations leave both unset.
 */
export function isGateMode({ argv = process.argv, env = process.env } = {}) {
  if (Array.isArray(argv) && argv.includes('--gate-mode')) return true;
  if (env && env.MANDREL_GATE_MODE === '1') return true;
  return false;
}

/**
 * In gate-mode, throw a hard-fail Error keyed to `reason`. Otherwise return
 * the degraded envelope. Centralises the if-gate-mode branch so each site has
 * a single call site.
 *
 * @param {string} reason
 * @param {string} [detail]
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ ok: false, degraded: true, reason: string, detail: string }}
 */
export function softFailOrThrow(reason, detail = '', opts) {
  if (isGateMode(opts)) {
    const err = new Error(`[gate-mode] hard-fail: ${reason}: ${detail}`);
    err.code = reason;
    err.degraded = true;
    throw err;
  }
  return degraded(reason, detail);
}
