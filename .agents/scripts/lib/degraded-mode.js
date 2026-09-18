/**
 * Explicit-degraded contract for soft-failing gates: return the degraded
 * envelope (with a non-zero CLI exit) instead of a silent empty result, or
 * hard-fail when `--gate-mode` / `MANDREL_GATE_MODE=1` is set (CI).
 */

/**
 * @param {string} reason  Machine-readable code (e.g. `GIT_DIFF_TIMEOUT`).
 * @param {string} [detail] Human-readable explanation for operators.
 * @returns {{ ok: false, degraded: true, reason: string, detail: string }}
 */
export function degraded(reason, detail = '') {
  return { ok: false, degraded: true, reason, detail };
}

export function isDegraded(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      value.ok === false &&
      value.degraded === true &&
      typeof value.reason === 'string',
  );
}

export function isGateMode({ argv = process.argv, env = process.env } = {}) {
  if (Array.isArray(argv) && argv.includes('--gate-mode')) return true;
  if (env && env.MANDREL_GATE_MODE === '1') return true;
  return false;
}

/**
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
