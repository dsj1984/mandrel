/** Classify a failed close gate's exit code and log it as what it was. */

import { COVERAGE_TIMEOUT_EXIT_CODE } from '../coverage-capture.js';
import { LOCK_WAIT_EXPIRED_EXIT_CODE } from '../full-suite-lock.js';
import { GATE_TIMEOUT_HINT } from './gates.js';

/** @typedef {import('./gates.js').Gate} Gate */

/**
 * Classify a non-zero gate exit and log it as what it is: `75` is an expired
 * full-suite lock wait (nothing ran), `124` a killed suite (no verdict), and
 * anything else a real failure with the gate's own hint. Returns the
 * `failed[]` entry, carrying `outcome` so callers never re-derive it; its
 * `gate.hint` is the one that fits the outcome (none when deferred), so a
 * caller replaying it never prints the failing-tests hint for a non-failure.
 *
 * @param {{ gate: Gate, status: number, cwd: string, log: (m: string) => void }} args
 * @returns {{ gate: Gate, status: number, cwd: string, outcome: 'deferred'|'timeout'|'failed' }}
 */
export function reportGateExit({ gate, status, cwd, log }) {
  if (status === LOCK_WAIT_EXPIRED_EXIT_CODE) {
    log(
      `[close-validation] ⏸ ${gate.name} deferred (exit ${status}) — the full-suite lock wait expired, so nothing ran in ${cwd}`,
    );
    const { hint: _failureHint, ...deferredGate } = gate;
    return { gate: deferredGate, status, cwd, outcome: 'deferred' };
  }
  if (status === COVERAGE_TIMEOUT_EXIT_CODE) {
    log(
      `[close-validation] ⏱ ${gate.name} timed out (exit ${status}) in ${cwd}`,
    );
    log(`[close-validation]   hint: ${GATE_TIMEOUT_HINT}`);
    return {
      gate: { ...gate, hint: GATE_TIMEOUT_HINT },
      status,
      cwd,
      outcome: 'timeout',
    };
  }
  log(`[close-validation] ✖ ${gate.name} failed (exit ${status}) in ${cwd}`);
  if (gate.hint) log(`[close-validation]   hint: ${gate.hint}`);
  return { gate, status, cwd, outcome: 'failed' };
}
